import {
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  sign,
  verify,
} from 'node:crypto';

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) || trimmed.length > 254) {
    return null;
  }
  return trimmed;
}

export function deriveIssuerKeypair(secret) {
  const seed = Buffer.from(hkdfSync('sha256', String(secret), 'parcheh-relay-auth', 'ed25519-seed', 32));
  const privDer = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const privateKey = createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const rawPub = spki.subarray(-32);
  return {
    privateKey,
    publicKey,
    publicKeyRaw: rawPub,
    publicKeyHex: rawPub.toString('hex'),
  };
}

function normalizeKeyObject(keyOrHex) {
  if (keyOrHex?.type === 'public' || keyOrHex?.type === 'private') {
    return keyOrHex;
  }
  let raw;
  if (Buffer.isBuffer(keyOrHex)) {
    raw = keyOrHex;
  } else if (typeof keyOrHex === 'string') {
    if (/^[0-9a-f]{64}$/i.test(keyOrHex)) {
      raw = Buffer.from(keyOrHex, 'hex');
    } else {
      raw = Buffer.from(keyOrHex, 'base64url');
    }
  } else {
    throw new Error('Invalid key format.');
  }
  if (raw.length === 32) {
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
    return createPublicKey({ key: spki, format: 'der', type: 'spki' });
  }
  if (raw.length === 44) {
    return createPublicKey({ key: raw, format: 'der', type: 'spki' });
  }
  throw new Error('Invalid key byte length.');
}

export function issueAuthToken(payload, privateKey) {
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadStr, 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(payloadB64, 'utf8'), privateKey);
  const sigB64 = signature.toString('base64url');
  return payloadB64 + '.' + sigB64;
}

export function verifyAuthToken(rawToken, trustedPublicKeys) {
  if (!rawToken || typeof rawToken !== 'string') {
    return { valid: false, reason: 'Missing or invalid token format.' };
  }
  const dotIndex = rawToken.indexOf('.');
  if (dotIndex <= 0 || dotIndex >= rawToken.length - 1) {
    return { valid: false, reason: 'Invalid token structure.' };
  }
  const payloadB64 = rawToken.slice(0, dotIndex);
  const sigB64 = rawToken.slice(dotIndex + 1);

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'Invalid token JSON payload.' };
  }

  if (payload.exp && Date.now() > payload.exp) {
    return { valid: false, reason: 'Token has expired.', payload };
  }

  let sigBuf;
  try {
    sigBuf = Buffer.from(sigB64, 'base64url');
  } catch {
    return { valid: false, reason: 'Invalid signature encoding.' };
  }

  const payloadBuf = Buffer.from(payloadB64, 'utf8');
  const keys = Array.isArray(trustedPublicKeys) ? trustedPublicKeys : [trustedPublicKeys];

  for (const k of keys) {
    if (!k) continue;
    try {
      const pubKey = normalizeKeyObject(k);
      const isVerified = verify(null, payloadBuf, pubKey, sigBuf);
      if (isVerified) {
        const spki = pubKey.export({ type: 'spki', format: 'der' });
        const hex = spki.subarray(-32).toString('hex');
        return { valid: true, payload, issuerPublicKeyHex: hex };
      }
    } catch {}
  }

  return { valid: false, reason: 'Signature verification failed.', payload };
}

export function issueProvisionalEmailToken({ email, expMs = 30 * 86400 * 1000 }, privateKey) {
  const norm = normalizeEmail(email);
  if (!norm) throw new Error('Invalid email address.');
  const now = Date.now();
  const payload = {
    kind: 'provisional_email',
    email: norm,
    verified: false,
    iat: now,
    exp: now + expMs,
  };
  return issueAuthToken(payload, privateKey);
}

export function issueVerifyChallengeToken({ email, devicePublicKeyHex, code, expMs = 15 * 60 * 1000 }, privateKey) {
  const norm = normalizeEmail(email);
  if (!norm) throw new Error('Invalid email address.');
  if (typeof devicePublicKeyHex !== 'string' || !/^[0-9a-f]{64}$/i.test(devicePublicKeyHex)) {
    throw new Error('Invalid devicePublicKeyHex.');
  }
  const codeHash = createHash('sha256').update(String(code).trim()).digest('hex');
  const now = Date.now();
  const payload = {
    kind: 'verify_challenge',
    email: norm,
    devicePublicKeyHex: devicePublicKeyHex.toLowerCase(),
    codeHash,
    iat: now,
    exp: now + expMs,
  };
  return issueAuthToken(payload, privateKey);
}

export function issueDeviceCertificate({ email, devicePublicKeyHex, expMs = 365 * 86400 * 1000 }, privateKey) {
  const norm = normalizeEmail(email);
  if (!norm) throw new Error('Invalid email address.');
  if (typeof devicePublicKeyHex !== 'string' || !/^[0-9a-f]{64}$/i.test(devicePublicKeyHex)) {
    throw new Error('Invalid devicePublicKeyHex.');
  }
  const now = Date.now();
  const payload = {
    kind: 'device_email_cert',
    email: norm,
    devicePublicKeyHex: devicePublicKeyHex.toLowerCase(),
    verified: true,
    iat: now,
    exp: now + expMs,
  };
  return issueAuthToken(payload, privateKey);
}

export function verifyDeviceSignature(publicKeyRawHexOrB64Url, payloadBuffer, signatureHexOrB64Url) {
  let keyObj;
  if (publicKeyRawHexOrB64Url?.type === 'public') {
    keyObj = publicKeyRawHexOrB64Url;
  } else {
    let raw;
    if (Buffer.isBuffer(publicKeyRawHexOrB64Url)) {
      raw = publicKeyRawHexOrB64Url;
    } else if (typeof publicKeyRawHexOrB64Url === 'string') {
      if (/^[0-9a-f]{64}$/i.test(publicKeyRawHexOrB64Url)) {
        raw = Buffer.from(publicKeyRawHexOrB64Url, 'hex');
      } else {
        raw = Buffer.from(publicKeyRawHexOrB64Url, 'base64url');
      }
    } else {
      throw new Error('Invalid public key format.');
    }
    if (raw.length === 32) {
      const spki = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
      keyObj = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    } else if (raw.length === 44) {
      keyObj = createPublicKey({ key: raw, format: 'der', type: 'spki' });
    } else {
      throw new Error('Invalid public key byte length.');
    }
  }

  let sig;
  if (Buffer.isBuffer(signatureHexOrB64Url)) {
    sig = signatureHexOrB64Url;
  } else if (typeof signatureHexOrB64Url === 'string') {
    if (/^[0-9a-f]{128}$/i.test(signatureHexOrB64Url)) {
      sig = Buffer.from(signatureHexOrB64Url, 'hex');
    } else {
      sig = Buffer.from(signatureHexOrB64Url, 'base64url');
    }
  } else {
    throw new Error('Invalid signature format.');
  }

  const payload = Buffer.isBuffer(payloadBuffer) ? payloadBuffer : Buffer.from(payloadBuffer);
  return verify(null, payload, keyObj, sig);
}
