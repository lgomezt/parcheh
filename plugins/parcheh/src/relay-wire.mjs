import { createHash } from 'node:crypto';

export const LANES = Object.freeze({
  CONTROL: 0,
  PRESENCE: 1,
  BULK: 2,
  SYSTEM: 3,
});

export const BROADCAST_SLOT = 0;
export const RELAY_CMD_SLOT = 0xFFFF;

export const MAX_PAYLOAD_BYTES = Object.freeze({
  [LANES.CONTROL]: 16 * 1024,
  [LANES.PRESENCE]: 16 * 1024,
  [LANES.BULK]: 66 * 1024,
  [LANES.SYSTEM]: 16 * 1024,
});

export function encodeFrame({ lane, slot, seq = 0, payload = Buffer.alloc(0) }) {
  const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = payloadBuf.length;
  if (length > 0xFFFFFF) throw new RangeError('Payload exceeds 24-bit length limit');
  const buf = Buffer.allocUnsafe(10 + length);
  buf.writeUInt8(lane, 0);
  buf.writeUInt16BE(slot, 1);
  buf.writeUInt32BE(seq, 3);
  buf.writeUIntBE(length, 7, 3);
  if (length > 0) {
    payloadBuf.copy(buf, 10);
  }
  return buf;
}

export function decodeFrame(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 10) return { error: 'FRAME_TOO_SHORT', code: 1002 };
  const lane = buf.readUInt8(0);
  const slot = buf.readUInt16BE(1);
  const seq = buf.readUInt32BE(3);
  const length = buf.readUIntBE(7, 3);
  if (buf.length !== 10 + length) return { error: 'LENGTH_MISMATCH', code: 1002 };
  if (!Object.values(LANES).includes(lane)) return { error: 'INVALID_LANE', code: 1002 };

  const maxPayload = MAX_PAYLOAD_BYTES[lane] ?? (16 * 1024);
  if (length > maxPayload) return { error: 'PAYLOAD_TOO_LARGE', code: 1009 };

  const payload = buf.subarray(10);
  return { lane, slot, seq, length, payload };
}

export function countLeadingZeroBits(buf) {
  let zeros = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0) {
      zeros += 8;
    } else {
      zeros += Math.clz32(b) - 24;
      break;
    }
  }
  return zeros;
}

export function solveChallenge(challenge, difficulty = 14) {
  let nonce = 0;
  while (true) {
    const str = `${challenge}:${nonce}`;
    const hash = createHash('sha256').update(str).digest();
    if (countLeadingZeroBits(hash) >= difficulty) {
      return String(nonce);
    }
    nonce++;
  }
}
