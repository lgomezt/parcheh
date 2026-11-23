import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export function deriveInviteKeys(inviteSecret, roomId) {
  const secretBuf = Buffer.from(inviteSecret, 'utf8');
  const roomBuf = Buffer.from(roomId, 'utf8');
  const admitKey = Buffer.from(hkdfSync('sha256', secretBuf, roomBuf, 'parcheh-v1:admit', 32));
  const posterKey = Buffer.from(hkdfSync('sha256', secretBuf, roomBuf, 'parcheh-v1:poster', 32));
  return { admitKey, posterKey };
}

export function encryptPoster(posterKey, roomId, plainBuffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', posterKey, iv);
  cipher.setAAD(Buffer.from('parcheh-poster:' + roomId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]);
}

export function decryptPoster(posterKey, roomId, encBuffer) {
  if (!Buffer.isBuffer(encBuffer) || encBuffer.length < 28) {
    throw new Error('Encrypted poster is too short.');
  }
  const iv = encBuffer.subarray(0, 12);
  const authTag = encBuffer.subarray(encBuffer.length - 16);
  const ciphertext = encBuffer.subarray(12, encBuffer.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', posterKey, iv);
  decipher.setAAD(Buffer.from('parcheh-poster:' + roomId, 'utf8'));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function sealChaCha(key32, plaintext, aad = Buffer.alloc(0)) {
  const nonce = randomBytes(12);
  const plain = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const aadBuf = Buffer.isBuffer(aad) ? aad : Buffer.from(aad);
  const cipher = createCipheriv('chacha20-poly1305', key32, nonce, { authTagLength: 16 });
  if (aadBuf.length > 0) cipher.setAAD(aadBuf);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ciphertext]);
}

export function openChaCha(key32, sealed, aad = Buffer.alloc(0)) {
  const buf = Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed);
  if (buf.length < 28) throw new Error('Sealed payload is too short.');
  const nonce = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const aadBuf = Buffer.isBuffer(aad) ? aad : Buffer.from(aad);
  const decipher = createDecipheriv('chacha20-poly1305', key32, nonce, { authTagLength: 16 });
  if (aadBuf.length > 0) decipher.setAAD(aadBuf);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function sealGroupBroadcast(groupKey32, epoch, roomId, plaintext) {
  const plain = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const aad = Buffer.from('parcheh-group:' + roomId + ':' + epoch, 'utf8');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('chacha20-poly1305', groupKey32, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(epoch, 0);
  return Buffer.concat([header, nonce, tag, ciphertext]);
}

export function openGroupBroadcast(groupKey32, expectedEpoch, roomId, sealedFrame) {
  const buf = Buffer.isBuffer(sealedFrame) ? sealedFrame : Buffer.from(sealedFrame);
  if (buf.length < 32) throw new Error('Sealed broadcast frame is too short.');
  const epoch = buf.readUInt32BE(0);
  if (epoch !== expectedEpoch) {
    throw new Error('Broadcast epoch mismatch.');
  }
  const nonce = buf.subarray(4, 16);
  const tag = buf.subarray(16, 32);
  const ciphertext = buf.subarray(32);
  const aad = Buffer.from('parcheh-group:' + roomId + ':' + epoch, 'utf8');
  const decipher = createDecipheriv('chacha20-poly1305', groupKey32, nonce, { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function generateEphemeralX25519() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyRaw = spkiDer.subarray(-32);
  return { publicKeyRaw, privateKey };
}

export function derivePeerSessionKeys(privateKey, peerPublicKeyRaw, roomId, hostEdPubHex, guestEdPubHex) {
  const raw = Buffer.isBuffer(peerPublicKeyRaw) ? peerPublicKeyRaw : Buffer.from(peerPublicKeyRaw, 'hex');
  if (raw.length !== 32) throw new Error('Invalid peer X25519 public key length.');
  const spki = Buffer.concat([X25519_SPKI_PREFIX, raw]);
  const publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const shared = diffieHellman({ privateKey, publicKey });
  const info = Buffer.from('parcheh-v1:session:' + hostEdPubHex + ':' + guestEdPubHex, 'utf8');
  const derived = Buffer.from(hkdfSync('sha256', shared, Buffer.from(roomId, 'utf8'), info, 64));
  return {
    hostToPeerKey: derived.subarray(0, 32),
    peerToHostKey: derived.subarray(32, 64),
  };
}

export function encryptTabHandoff(tabX25519PubHex, roomId, payloadObj) {
  const raw = Buffer.from(tabX25519PubHex, 'hex');
  if (raw.length !== 32) throw new Error('Invalid tab X25519 public key length.');
  const tabPubKey = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  const { publicKeyRaw: ephPubRaw32, privateKey: ephPriv } = generateEphemeralX25519();
  const shared = diffieHellman({ privateKey: ephPriv, publicKey: tabPubKey });
  const aesKey = Buffer.from(hkdfSync('sha256', shared, Buffer.from(roomId, 'utf8'), Buffer.from('parcheh-v1:handoff:' + tabX25519PubHex, 'utf8'), 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  cipher.setAAD(Buffer.from('parcheh-handoff:' + roomId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payloadObj), 'utf8')), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([ephPubRaw32, iv, ciphertext, authTag]);
}

export function decryptTabHandoff(tabX25519PrivKey, tabX25519PubHex, roomId, encBuffer) {
  const buf = Buffer.isBuffer(encBuffer) ? encBuffer : Buffer.from(encBuffer);
  if (buf.length < 60) throw new Error('Encrypted handoff payload is too short.');
  const ephPubRaw = buf.subarray(0, 32);
  const iv = buf.subarray(32, 44);
  const ciphertext = buf.subarray(44, buf.length - 16);
  const authTag = buf.subarray(buf.length - 16);
  const ephPubKey = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, ephPubRaw]), format: 'der', type: 'spki' });
  const shared = diffieHellman({ privateKey: tabX25519PrivKey, publicKey: ephPubKey });
  const aesKey = Buffer.from(hkdfSync('sha256', shared, Buffer.from(roomId, 'utf8'), Buffer.from('parcheh-v1:handoff:' + tabX25519PubHex, 'utf8'), 32));
  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAAD(Buffer.from('parcheh-handoff:' + roomId, 'utf8'));
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}
