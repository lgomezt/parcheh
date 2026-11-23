import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  generateKeyPairSync,
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import { join } from 'node:path';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function identityFromPrivateKey(privateKeyObj) {
  const privateKey = typeof privateKeyObj === 'string' ? createPrivateKey(privateKeyObj) : privateKeyObj;
  const publicKey = createPublicKey(privateKey);
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const rawPub = spkiDer.subarray(-32);
  const deviceId = createHash('sha256').update(rawPub).digest('hex');
  const privateKeyPkcs8Pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return {
    deviceId,
    hostKeyDigest: deviceId,
    publicKeyRaw: rawPub,
    publicKeyHex: rawPub.toString('hex'),
    publicKeyBase64Url: rawPub.toString('base64url'),
    publicKeySpkiDer: spkiDer,
    publicKey,
    privateKey,
    privateKeyPkcs8Pem,
  };
}

export function createMacKeychainStore({ service = 'dev.parcheh.device', account = 'ed25519-v1' } = {}) {
  const exec = promisify(execFile);
  return {
    async get() {
      try {
        const { stdout } = await exec('/usr/bin/security', [
          'find-generic-password', '-s', service, '-a', account, '-w',
        ]);
        return stdout.trim() || null;
      } catch (err) {
        if (err.code === 44 || /SecItemNotFound|The specified item could not be found/i.test(err.message || '')) {
          return null;
        }
        throw err;
      }
    },
    async set(value) {
      await exec('/usr/bin/security', [
        'add-generic-password', '-U', '-s', service, '-a', account, '-w', value,
      ]);
    },
  };
}

export async function loadOrCreateDeviceIdentity(home, { keychain = null, useKeychain = false } = {}) {
  let store = keychain;
  if (!store && useKeychain && process.platform === 'darwin') {
    store = createMacKeychainStore();
  }

  if (store) {
    try {
      const stored = await store.get();
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.privateKeyPkcs8Pem) {
          return identityFromPrivateKey(parsed.privateKeyPkcs8Pem);
        }
      }
    } catch {}
    const { privateKey } = generateKeyPairSync('ed25519');
    const identity = identityFromPrivateKey(privateKey);
    const record = {
      version: 1,
      deviceId: identity.deviceId,
      publicKeyHex: identity.publicKeyHex,
      privateKeyPkcs8Pem: identity.privateKeyPkcs8Pem,
    };
    await store.set(JSON.stringify(record));
    return identity;
  }

  const filePath = join(home, 'device-identity.json');
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.privateKeyPkcs8Pem) {
      return identityFromPrivateKey(parsed.privateKeyPkcs8Pem);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const { privateKey } = generateKeyPairSync('ed25519');
  const identity = identityFromPrivateKey(privateKey);
  const record = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyHex: identity.publicKeyHex,
    privateKeyPkcs8Pem: identity.privateKeyPkcs8Pem,
  };
  const staged = filePath + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(staged, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600, flush: true });
    await rename(staged, filePath);
  } finally {
    await rm(staged, { force: true }).catch(() => {});
  }
  return identity;
}

export function signDevicePayload(identity, payloadBuffer) {
  const key = identity?.privateKey ?? identity;
  const payload = Buffer.isBuffer(payloadBuffer) ? payloadBuffer : Buffer.from(payloadBuffer);
  return sign(null, payload, key);
}

export { verifyDeviceSignature } from './auth-tokens.mjs';

export async function loadDeviceCertificates(home, { keychain = null, useKeychain = false } = {}) {
  let store = keychain;
  if (!store && useKeychain && process.platform === 'darwin') {
    store = createMacKeychainStore({ service: 'dev.parcheh.device', account: 'certificates-v1' });
  }

  if (store) {
    try {
      const stored = await store.get();
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed.certificates)) return parsed.certificates;
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
  }

  const filePath = join(home, 'device-certificates.json');
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.certificates)) return parsed.certificates;
    if (Array.isArray(parsed)) return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return [];
}

export async function saveDeviceCertificate(home, { origin, email, certificate }, { keychain = null, useKeychain = false } = {}) {
  if (!origin || !email || !certificate) {
    throw new Error('origin, email, and certificate are required to save a device certificate.');
  }
  const normOrigin = String(origin).trim().replace(/\/+$/, '');
  const normEmail = String(email).trim().toLowerCase();

  const current = await loadDeviceCertificates(home, { keychain, useKeychain });
  const filtered = current.filter(c => !(c.origin === normOrigin && c.email.toLowerCase() === normEmail));
  const updated = [
    ...filtered,
    {
      origin: normOrigin,
      email: normEmail,
      certificate,
      savedAt: Date.now(),
    },
  ];

  let store = keychain;
  if (!store && useKeychain && process.platform === 'darwin') {
    store = createMacKeychainStore({ service: 'dev.parcheh.device', account: 'certificates-v1' });
  }

  const record = { version: 1, certificates: updated };
  if (store) {
    try {
      await store.set(JSON.stringify(record));
    } catch {}
  }

  const filePath = join(home, 'device-certificates.json');
  const staged = filePath + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(staged, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600, flush: true });
    await rename(staged, filePath);
  } finally {
    await rm(staged, { force: true }).catch(() => {});
  }
  return updated;
}
