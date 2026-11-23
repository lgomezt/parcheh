import { randomBytes, randomUUID } from 'node:crypto';
import {
  LANES,
  BROADCAST_SLOT,
  RELAY_CMD_SLOT,
  encodeFrame,
  decodeFrame,
  solveChallenge,
} from './relay-wire.mjs';
import {
  deriveInviteKeys,
  encryptPoster,
  sealChaCha,
  openChaCha,
  sealGroupBroadcast,
  openGroupBroadcast,
  generateEphemeralX25519,
  derivePeerSessionKeys,
} from './relay-crypto.mjs';
import { signDevicePayload, verifyDeviceSignature } from './device-identity.mjs';
import { exportPack } from './git-pack.mjs';

const CHUNK_SIZE = 48 * 1024;
const WINDOW = 8;

function toWsUrl(httpUrl, path) {
  const u = new URL(path, httpUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href;
}

function sendPacedChunks(ws, targetSlot, payloadBuffer, nextSeq, transferAcks, creditWaiters) {
  const transferIdBuf = randomBytes(16);
  const transferId = transferIdBuf.toString('hex');
  const totalChunks = Math.ceil(payloadBuffer.length / CHUNK_SIZE);
  transferAcks.set(transferId, -1);

  return (async () => {
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      while (chunkIndex - (transferAcks.get(transferId) + 1) >= WINDOW) {
        await new Promise(resolve => {
          let list = creditWaiters.get(transferId);
          if (!list) {
            list = [];
            creditWaiters.set(transferId, list);
          }
          list.push(resolve);
        });
      }

      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, payloadBuffer.length);
      const slice = payloadBuffer.subarray(start, end);

      const header = Buffer.allocUnsafe(20);
      transferIdBuf.copy(header, 0);
      header.writeUInt16BE(chunkIndex, 16);
      header.writeUInt16BE(totalChunks, 18);

      const chunkFrame = encodeFrame({
        lane: LANES.BULK,
        slot: targetSlot,
        seq: nextSeq(),
        payload: Buffer.concat([header, slice]),
      });
      ws.send(chunkFrame);
    }
  })();
}

function handleIncomingBulkChunk(payload, onComplete, sendCredit) {
  if (payload.length < 20) return;
  const transferId = payload.subarray(0, 16).toString('hex');
  const chunkIndex = payload.readUInt16BE(16);
  const totalChunks = payload.readUInt16BE(18);
  const chunkData = payload.subarray(20);

  if ((chunkIndex + 1) % 4 === 0 || (chunkIndex + 1) === totalChunks) {
    sendCredit(transferId, chunkIndex);
  }

  onComplete(transferId, chunkIndex, totalChunks, chunkData);
}

export async function attachHostRelay({
  relayOrigin,
  deviceIdentity,
  getInviteSecret,
  getReconnectSecret,
  relayBridgeSecret,
  localPort,
  onRequest,
  storage,
  onReady,
}) {
  const powRes = await fetch(`${relayOrigin}/v1/pow-challenge`);
  if (!powRes.ok) throw new Error('Relay PoW challenge failed.');
  const { challenge, difficulty } = await powRes.json();
  const powNonce = solveChallenge(challenge, difficulty);

  const roomRes = await fetch(`${relayOrigin}/v1/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      hostKeyDigest: deviceIdentity.hostKeyDigest,
      powChallenge: challenge,
      powNonce,
    }),
  });
  if (!roomRes.ok) throw new Error('Relay room creation failed.');
  const { roomId, hostTicket, expiresAt } = await roomRes.json();

  let ws = null;
  let closed = false;
  let seq = 0;
  const nextSeq = () => (seq = (seq + 1) >>> 0);

  let currentEpoch = 1;
  let currentGroupKey = randomBytes(32);

  const sessions = new Map();
  const incomingTransfers = new Map();
  const transferAcks = new Map();
  const creditWaiters = new Map();

  function wakeCredit(transferId, ackIndex) {
    const prev = transferAcks.get(transferId) ?? -1;
    if (ackIndex > prev) {
      transferAcks.set(transferId, ackIndex);
    }
    const waiters = creditWaiters.get(transferId);
    if (waiters && waiters.length > 0) {
      creditWaiters.delete(transferId);
      for (const w of waiters) w();
    }
  }

  function sendControlJson(slot, obj) {
    const buf = Buffer.from(JSON.stringify(obj), 'utf8');
    const frame = encodeFrame({ lane: LANES.CONTROL, slot, seq: nextSeq(), payload: buf });
    ws?.send(frame);
  }

  function connectWs() {
    if (closed) return;
    const wsUrl = toWsUrl(relayOrigin, `/v1/connect?room=${roomId}&role=host`);
    ws = new globalThis.WebSocket(wsUrl, ['parcheh-v1', 'ticket.' + hostTicket]);
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      onReady?.({ roomId, expiresAt });
    });

    ws.addEventListener('message', async event => {
      const raw = Buffer.from(event.data);
      const decoded = decodeFrame(raw);
      if (decoded.error) return;

      if (decoded.lane === LANES.SYSTEM) {
        try {
          const sys = JSON.parse(decoded.payload.toString('utf8'));
          if (sys.type === 'peer.detached' && sys.slotId) {
            sessions.delete(sys.slotId);
          }
        } catch {}
        return;
      }

      if (decoded.lane === LANES.CONTROL) {
        let msg;
        try {
          msg = JSON.parse(decoded.payload.toString('utf8'));
        } catch {
          return;
        }

        if (msg.type === 'bulk.credit' && msg.transferId) {
          wakeCredit(msg.transferId, msg.ackIndex);
          return;
        }

        if (msg.kind === 'hello') {
          const slot = decoded.slot;
          const rejoinId = typeof msg.rejoinMemberId === 'string' ? msg.rejoinMemberId : null;
          const secret = rejoinId ? getReconnectSecret?.(rejoinId) : getInviteSecret();
          if (!secret) {
            sendControlJson(slot, { kind: 'hello_error', status: 403, message: 'Invalid or expired invitation.' });
            sendControlJson(RELAY_CMD_SLOT, { action: 'kick', slotId: slot });
            return;
          }

          let plain;
          try {
            const { admitKey } = deriveInviteKeys(secret, roomId);
            plain = openChaCha(admitKey, Buffer.from(msg.payloadB64, 'base64'));
          } catch {
            sendControlJson(slot, { kind: 'hello_error', status: 403, message: 'Invalid or expired invitation.' });
            sendControlJson(RELAY_CMD_SLOT, { action: 'kick', slotId: slot });
            return;
          }

          let inner;
          try {
            inner = JSON.parse(plain.toString('utf8'));
          } catch {
            sendControlJson(slot, { kind: 'hello_error', status: 403, message: 'Invalid or expired invitation.' });
            sendControlJson(RELAY_CMD_SLOT, { action: 'kick', slotId: slot });
            return;
          }

          const { guestXPubHex, guestEdPubHex, nonce, timestamp, sigHex } = inner;
          const signBuf = Buffer.from(`${roomId}:${guestXPubHex}:${nonce}:${timestamp}`, 'utf8');
          if (!verifyDeviceSignature(guestEdPubHex, signBuf, sigHex)) {
            sendControlJson(slot, { kind: 'hello_error', status: 403, message: 'Invalid device signature.' });
            sendControlJson(RELAY_CMD_SLOT, { action: 'kick', slotId: slot });
            return;
          }

          const hostX = generateEphemeralX25519();
          const hostXHex = hostX.publicKeyRaw.toString('hex');
          const { hostToPeerKey, peerToHostKey } = derivePeerSessionKeys(
            hostX.privateKey,
            Buffer.from(guestXPubHex, 'hex'),
            roomId,
            deviceIdentity.publicKeyHex,
            guestEdPubHex,
          );

          const hostSignBuf = Buffer.from(`${roomId}:${guestXPubHex}:${hostXHex}:${deviceIdentity.publicKeyHex}`, 'utf8');
          const hostSigHex = signDevicePayload(deviceIdentity, hostSignBuf).toString('hex');

          const welcomeData = JSON.stringify({
            groupKeyEpoch: currentEpoch,
            groupKeyHex: currentGroupKey.toString('hex'),
          });
          const encWelcome = sealChaCha(hostToPeerKey, Buffer.from(welcomeData, 'utf8'));

          sendControlJson(slot, {
            kind: 'welcome',
            hostXPubHex: hostXHex,
            hostEdPubHex: deviceIdentity.publicKeyHex,
            sigHex: hostSigHex,
            encryptedWelcomeB64: encWelcome.toString('base64'),
          });

          sessions.set(slot, {
            hostToPeerKey,
            peerToHostKey,
            guestEdPubHex,
            memberId: rejoinId || null,
          });
          return;
        }

        if (msg.kind === 'rpc_req') {
          const session = sessions.get(decoded.slot);
          if (!session) return;
          let rpcReq;
          try {
            const dec = openChaCha(session.peerToHostKey, Buffer.from(msg.payloadB64, 'base64'));
            rpcReq = JSON.parse(dec.toString('utf8'));
          } catch {
            return;
          }

          const resPayload = await dispatchRpc(rpcReq, session);
          const sealed = sealChaCha(session.hostToPeerKey, resPayload);
          if (sealed.length <= 12 * 1024) {
            sendControlJson(decoded.slot, { kind: 'rpc_res', payloadB64: sealed.toString('base64') });
          } else {
            await sendPacedChunks(ws, decoded.slot, sealed, nextSeq, transferAcks, creditWaiters);
          }
          return;
        }
      }

      if (decoded.lane === LANES.BULK) {
        handleIncomingBulkChunk(
          decoded.payload,
          async (transferId, chunkIndex, totalChunks, chunkData) => {
            let t = incomingTransfers.get(transferId);
            if (!t) {
              t = { chunks: new Map(), totalChunks, count: 0, slot: decoded.slot };
              incomingTransfers.set(transferId, t);
            }
            if (!t.chunks.has(chunkIndex)) {
              t.chunks.set(chunkIndex, chunkData);
              t.count++;
            }
            if (t.count === t.totalChunks) {
              incomingTransfers.delete(transferId);
              const full = Buffer.concat(Array.from({ length: t.totalChunks }, (_, idx) => t.chunks.get(idx)));
              const session = sessions.get(t.slot);
              if (!session) return;
              let rpcReq;
              try {
                const dec = openChaCha(session.peerToHostKey, full);
                rpcReq = JSON.parse(dec.toString('utf8'));
              } catch {
                return;
              }
              const resPayload = await dispatchRpc(rpcReq, session);
              const sealed = sealChaCha(session.hostToPeerKey, resPayload);
              if (sealed.length <= 12 * 1024) {
                sendControlJson(t.slot, { kind: 'rpc_res', payloadB64: sealed.toString('base64') });
              } else {
                await sendPacedChunks(ws, t.slot, sealed, nextSeq, transferAcks, creditWaiters);
              }
            }
          },
          (transferId, ackIndex) => {
            sendControlJson(decoded.slot, { type: 'bulk.credit', transferId, ackIndex });
          },
        );
      }
    });

    ws.addEventListener('close', () => {
      if (!closed) {
        setTimeout(connectWs, 1000).unref?.();
      }
    });
  }

  async function dispatchRpc(rpcReq, session) {
    const { id, endpoint, memberToken, body } = rpcReq;
    if (onRequest) {
      try {
        const result = await onRequest(endpoint, memberToken, body, session?.guestEdPubHex);
        if (endpoint === 'join' && result?.memberId) {
          session.memberId = result.memberId;
        }
        return Buffer.from(JSON.stringify({ id, status: 200, headers: {}, body: result }), 'utf8');
      } catch (err) {
        return Buffer.from(JSON.stringify({
          id,
          status: err.status || 500,
          headers: {},
          body: { error: err.message },
        }), 'utf8');
      }
    }

    try {
      const port = typeof localPort === 'function' ? localPort() : (localPort || ret?.localPort);
      const cleanEndpoint = endpoint.replace(/^\//, '');
      const url = `http://127.0.0.1:${port}/api/rooms/${roomId}/${cleanEndpoint}`;
      const res = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: {
          'content-type': 'application/json',
          ...(memberToken && { authorization: `Bearer ${memberToken}` }),
          ...(relayBridgeSecret && session?.guestEdPubHex && {
            'x-parcheh-relay-bridge': relayBridgeSecret,
            'x-parcheh-peer-ed25519': session.guestEdPubHex,
          }),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      let resBody;
      const ctype = res.headers.get('content-type') || '';
      if (ctype.includes('application/json')) {
        resBody = await res.json().catch(() => null);
      } else {
        resBody = await res.text().catch(() => null);
      }

      if (cleanEndpoint.startsWith('join') && resBody?.memberId) {
        session.memberId = resBody.memberId;
      }

      return Buffer.from(JSON.stringify({
        id,
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body: resBody,
      }), 'utf8');
    } catch (err) {
      return Buffer.from(JSON.stringify({
        id,
        status: 500,
        headers: {},
        body: { error: err.message },
      }), 'utf8');
    }
  }

  connectWs();

  const ret = {
    roomId,
    hostTicket,
    expiresAt,
    async uploadPoster(pngBytes, inviteSecret) {
      if (!pngBytes || !Buffer.isBuffer(pngBytes)) return;
      const { posterKey } = deriveInviteKeys(inviteSecret, roomId);
      const enc = encryptPoster(posterKey, roomId, pngBytes);
      await fetch(`${relayOrigin}/v1/rooms/${roomId}/poster.enc`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${hostTicket}`,
          'content-type': 'application/octet-stream',
        },
        body: enc,
      });
    },
    async uploadPolicy(policy) {
      if (!policy) return;
      await fetch(`${relayOrigin}/v1/rooms/${roomId}/policy`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${hostTicket}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(policy),
      });
    },
    async broadcastRevision({ rev, oid, prevOid }) {
      const gitDir = ret.storage || storage;
      const packBuf = await exportPack(gitDir, oid, prevOid ? [prevOid] : []);
      const msg = Buffer.from(JSON.stringify({
        type: 'revision',
        rev,
        oid,
        prevOid,
        packB64: packBuf.toString('base64'),
      }), 'utf8');
      const sealed = sealGroupBroadcast(currentGroupKey, currentEpoch, roomId, msg);
      if (sealed.length <= CHUNK_SIZE) {
        const header = Buffer.allocUnsafe(20);
        randomBytes(16).copy(header, 0);
        header.writeUInt16BE(0, 16);
        header.writeUInt16BE(1, 18);
        const frame = encodeFrame({
          lane: LANES.BULK,
          slot: BROADCAST_SLOT,
          seq: nextSeq(),
          payload: Buffer.concat([header, sealed]),
        });
        ws?.send(frame);
      } else {
        await sendPacedChunks(ws, BROADCAST_SLOT, sealed, nextSeq, transferAcks, creditWaiters);
      }
    },
    rotateGroupKeyAndKick({ revokedMemberId, newEpoch }) {
      for (const [slotId, session] of sessions) {
        if (session.memberId === revokedMemberId) {
          sendControlJson(RELAY_CMD_SLOT, { action: 'kick', slotId });
          sessions.delete(slotId);
        }
      }
      currentEpoch = newEpoch;
      currentGroupKey = randomBytes(32);
      const rotateData = JSON.stringify({
        epoch: currentEpoch,
        groupKeyHex: currentGroupKey.toString('hex'),
      });
      for (const [slotId, session] of sessions) {
        const sealed = sealChaCha(session.hostToPeerKey, Buffer.from(rotateData, 'utf8'));
        sendControlJson(slotId, { kind: 'group_key_rotate', payloadB64: sealed.toString('base64') });
      }
    },
    closeRelayRoom() {
      closed = true;
      try {
        sendControlJson(RELAY_CMD_SLOT, { action: 'close' });
      } catch {}
      try {
        ws?.close(1000, 'Host closed room');
      } catch {}
    },
  };
  return ret;
}

export function connectGuestRelay({
  relayOrigin,
  roomId,
  inviteSecret,
  rejoinMemberId,
  reconnectSecret,
  deviceIdentity,
  onRevisionBroadcast,
}) {
  return new Promise((resolve, reject) => {
    const wsUrl = toWsUrl(relayOrigin, `/v1/connect?room=${roomId}&role=peer`);
    const ws = new globalThis.WebSocket(wsUrl, ['parcheh-v1']);
    ws.binaryType = 'arraybuffer';

    let closed = false;
    let seq = 0;
    const nextSeq = () => (seq = (seq + 1) >>> 0);

    let hostToPeerKey = null;
    let peerToHostKey = null;
    let currentEpoch = 1;
    let currentGroupKey = null;

    const guestX = generateEphemeralX25519();
    const nonce = randomBytes(16).toString('hex');
    const timestamp = Date.now();

    const pendingRpcs = new Map();
    const incomingTransfers = new Map();
    const transferAcks = new Map();
    const creditWaiters = new Map();
    const rawBroadcastListeners = [];

    let handshakeDone = false;

    function wakeCredit(transferId, ackIndex) {
      const prev = transferAcks.get(transferId) ?? -1;
      if (ackIndex > prev) {
        transferAcks.set(transferId, ackIndex);
      }
      const waiters = creditWaiters.get(transferId);
      if (waiters && waiters.length > 0) {
        creditWaiters.delete(transferId);
        for (const w of waiters) w();
      }
    }

    function sendControlJson(obj) {
      const buf = Buffer.from(JSON.stringify(obj), 'utf8');
      const frame = encodeFrame({ lane: LANES.CONTROL, slot: 0, seq: nextSeq(), payload: buf });
      ws.send(frame);
    }

    ws.addEventListener('open', () => {
      const handshakeSecret = (rejoinMemberId && reconnectSecret) ? reconnectSecret : inviteSecret;
      const { admitKey } = deriveInviteKeys(handshakeSecret, roomId);
      const signBuf = Buffer.from(`${roomId}:${guestX.publicKeyRaw.toString('hex')}:${nonce}:${timestamp}`, 'utf8');
      const sigHex = signDevicePayload(deviceIdentity, signBuf).toString('hex');

      const helloData = JSON.stringify({
        guestXPubHex: guestX.publicKeyRaw.toString('hex'),
        guestEdPubHex: deviceIdentity.publicKeyHex,
        nonce,
        timestamp,
        sigHex,
      });
      const sealedHello = sealChaCha(admitKey, Buffer.from(helloData, 'utf8'));
      sendControlJson({
        kind: 'hello',
        ...(rejoinMemberId && reconnectSecret ? { rejoinMemberId } : {}),
        payloadB64: sealedHello.toString('base64'),
      });
    });

    ws.addEventListener('error', err => {
      if (!handshakeDone) {
        reject(err || new Error('WebSocket connection error'));
      }
    });

    ws.addEventListener('close', event => {
      closed = true;
      if (!handshakeDone) {
        reject(new Error(`WebSocket closed before handshake: ${event.code} ${event.reason}`));
      }
      for (const [, p] of pendingRpcs) {
        p.reject(new Error('Tunnel connection closed.'));
      }
      pendingRpcs.clear();
    });

    ws.addEventListener('message', async event => {
      const raw = Buffer.from(event.data);
      const decoded = decodeFrame(raw);
      if (decoded.error) return;

      if (decoded.lane === LANES.CONTROL) {
        let msg;
        try {
          msg = JSON.parse(decoded.payload.toString('utf8'));
        } catch {
          return;
        }

        if (msg.type === 'bulk.credit' && msg.transferId) {
          wakeCredit(msg.transferId, msg.ackIndex);
          return;
        }

        if (msg.kind === 'hello_error') {
          if (!handshakeDone) {
            reject(Object.assign(new Error(msg.message || 'Invitation rejected.'), { status: msg.status || 403 }));
          }
          return;
        }

        if (msg.kind === 'welcome' && !handshakeDone) {
          const hostSignBuf = Buffer.from(`${roomId}:${guestX.publicKeyRaw.toString('hex')}:${msg.hostXPubHex}:${msg.hostEdPubHex}`, 'utf8');
          if (!verifyDeviceSignature(msg.hostEdPubHex, hostSignBuf, msg.sigHex)) {
            reject(new Error('Invalid host signature in welcome.'));
            return;
          }

          const derived = derivePeerSessionKeys(
            guestX.privateKey,
            Buffer.from(msg.hostXPubHex, 'hex'),
            roomId,
            msg.hostEdPubHex,
            deviceIdentity.publicKeyHex,
          );
          hostToPeerKey = derived.hostToPeerKey;
          peerToHostKey = derived.peerToHostKey;

          let welcomeObj;
          try {
            const dec = openChaCha(hostToPeerKey, Buffer.from(msg.encryptedWelcomeB64, 'base64'));
            welcomeObj = JSON.parse(dec.toString('utf8'));
          } catch (e) {
            reject(new Error('Failed to decrypt welcome payload.'));
            return;
          }

          currentEpoch = welcomeObj.groupKeyEpoch;
          currentGroupKey = Buffer.from(welcomeObj.groupKeyHex, 'hex');
          handshakeDone = true;

          resolve(clientInterface);
          return;
        }

        if (msg.kind === 'group_key_rotate' && hostToPeerKey) {
          try {
            const dec = openChaCha(hostToPeerKey, Buffer.from(msg.payloadB64, 'base64'));
            const rot = JSON.parse(dec.toString('utf8'));
            currentEpoch = rot.epoch;
            currentGroupKey = Buffer.from(rot.groupKeyHex, 'hex');
          } catch {}
          return;
        }

        if (msg.kind === 'rpc_res' && hostToPeerKey) {
          try {
            const dec = openChaCha(hostToPeerKey, Buffer.from(msg.payloadB64, 'base64'));
            const resObj = JSON.parse(dec.toString('utf8'));
            const p = pendingRpcs.get(resObj.id);
            if (p) {
              pendingRpcs.delete(resObj.id);
              if (resObj.status >= 400) {
                const message = resObj.body?.error ? `${resObj.body.error} (HTTP ${resObj.status}).` : `The parcheh host rejected (HTTP ${resObj.status}).`;
                p.reject(Object.assign(new Error(message), {
                  status: resObj.status,
                  body: resObj.body,
                }));
              } else {
                p.resolve(resObj.body);
              }
            }
          } catch {}
          return;
        }
      }

      if (decoded.lane === LANES.BULK) {
        handleIncomingBulkChunk(
          decoded.payload,
          (transferId, chunkIndex, totalChunks, chunkData) => {
            let t = incomingTransfers.get(transferId);
            if (!t) {
              t = { chunks: new Map(), totalChunks, count: 0 };
              incomingTransfers.set(transferId, t);
            }
            if (!t.chunks.has(chunkIndex)) {
              t.chunks.set(chunkIndex, chunkData);
              t.count++;
            }
            if (t.count === t.totalChunks) {
              incomingTransfers.delete(transferId);
              const full = Buffer.concat(Array.from({ length: t.totalChunks }, (_, idx) => t.chunks.get(idx)));

              if (currentGroupKey) {
                for (const fn of rawBroadcastListeners) {
                  try { fn(full); } catch {}
                }
                try {
                  const dec = openGroupBroadcast(currentGroupKey, currentEpoch, roomId, full);
                  const revMsg = JSON.parse(dec.toString('utf8'));
                  if (revMsg.type === 'revision') {
                    onRevisionBroadcast?.(revMsg);
                    return;
                  }
                } catch {}
              }

              if (hostToPeerKey) {
                try {
                  const dec = openChaCha(hostToPeerKey, full);
                  const resObj = JSON.parse(dec.toString('utf8'));
                  const p = pendingRpcs.get(resObj.id);
                  if (p) {
                    pendingRpcs.delete(resObj.id);
                    if (resObj.status >= 400) {
                      const message = resObj.body?.error ? `${resObj.body.error} (HTTP ${resObj.status}).` : `The parcheh host rejected (HTTP ${resObj.status}).`;
                      p.reject(Object.assign(new Error(message), {
                        status: resObj.status,
                        body: resObj.body,
                      }));
                    } else {
                      p.resolve(resObj.body);
                    }
                  }
                } catch {}
              }
            }
          },
          (transferId, ackIndex) => {
            sendControlJson({ type: 'bulk.credit', transferId, ackIndex });
          },
        );
      }
    });

    const clientInterface = {
      rpc(endpoint, memberToken, body) {
        if (closed) return Promise.reject(new Error('Relay tunnel is closed.'));
        const id = randomUUID();
        const payloadBuf = Buffer.from(JSON.stringify({ id, endpoint, memberToken, body }), 'utf8');
        const sealed = sealChaCha(peerToHostKey, payloadBuf);

        return new Promise((res, rej) => {
          pendingRpcs.set(id, {
            resolve: res,
            reject: err => {
              if (err.status) {
                const prefix = err.body?.error || `The parcheh host rejected ${endpoint}`;
                rej(Object.assign(new Error(`${prefix} (HTTP ${err.status}).`), {
                  status: err.status,
                  body: err.body,
                }));
              } else {
                rej(err);
              }
            },
          });

          if (sealed.length <= 12 * 1024) {
            sendControlJson({ kind: 'rpc_req', payloadB64: sealed.toString('base64') });
          } else {
            sendPacedChunks(ws, 0, sealed, nextSeq, transferAcks, creditWaiters).catch(rej);
          }
        });
      },
      async fetchPack(memberToken, wantOid, haveOids = []) {
        const body = await this.rpc('pack', memberToken, { wantOid, haveOids });
        return {
          rev: body.rev,
          oid: body.oid,
          packBuffer: Buffer.from(body.packBase64, 'base64'),
        };
      },
      getGroupKey() {
        return { epoch: currentEpoch, groupKey: currentGroupKey };
      },
      onClose(fn) {
        ws.addEventListener('close', fn);
      },
      onRawBroadcast(fn) {
        rawBroadcastListeners.push(fn);
      },
      close() {
        closed = true;
        try {
          ws.close();
        } catch {}
      },
    };
  });
}
