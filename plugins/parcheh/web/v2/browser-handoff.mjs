function read(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function store(key, value) {
  try { sessionStorage.setItem(key, value); return true; } catch { return false; }
}

export function restoreBrowser(link) {
  const room = link.pathname.split('/')[2];
  if (!read('parcheh:browser:' + room) || read('parcheh:invitation:' + link.pathname) !== link.hash) return false;
  location.replace('/view/' + room);
  return true;
}

export function prepareBrowserHandoff(link, onReady) {
  const room = link.pathname.split('/')[2];
  const key = 'parcheh:handoff:' + room;
  let record;
  try { record = JSON.parse(read(key)); } catch {}

  let timer;
  let ready = false;
  let endpointFamily = null;
  let privKeyPromise = null;

  async function getPrivateKey() {
    if (!record || record.invitation !== link.hash || !record.privJwk || !record.pubHex) {
      const keyPair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
      const rawPub = await crypto.subtle.exportKey('raw', keyPair.publicKey);
      const pubHex = Array.from(new Uint8Array(rawPub), b => b.toString(16).padStart(2, '0')).join('');
      const privJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
      record = { pubHex, privJwk, invitation: link.hash };
      store(key, JSON.stringify(record));
    }
    return crypto.subtle.importKey('jwk', record.privJwk, { name: 'X25519' }, false, ['deriveBits']);
  }

  async function poll() {
    try {
      if (!privKeyPromise) privKeyPromise = getPrivateKey();
      const privKey = await privKeyPromise;
      let response;
      if (endpointFamily === 'v1') {
        response = await fetch('/v1/rooms/' + room + '/handoffs/' + record.pubHex, {
          cache: 'no-store', credentials: 'omit', redirect: 'error',
        });
      } else if (endpointFamily === 'api') {
        response = await fetch('/api/rooms/' + room + '/handoffs/' + record.pubHex, {
          headers: { Authorization: 'Bearer ' + link.hash.slice(1) },
          cache: 'no-store', credentials: 'omit', redirect: 'error',
        });
      } else {
        const apiRes = await fetch('/api/rooms/' + room + '/handoffs/' + record.pubHex, {
          headers: { Authorization: 'Bearer ' + link.hash.slice(1) },
          cache: 'no-store', credentials: 'omit', redirect: 'error',
        });
        if (apiRes.status === 404) {
          const v1Res = await fetch('/v1/rooms/' + room + '/handoffs/' + record.pubHex, {
            cache: 'no-store', credentials: 'omit', redirect: 'error',
          });
          if (v1Res.status === 404 && apiRes.status === 403) {
            onReady(null, 'expired');
            return;
          }
          endpointFamily = 'v1';
          response = v1Res;
        } else {
          endpointFamily = 'api';
          response = apiRes;
        }
      }

      if (response.status === 403) {
        onReady(null, 'expired');
        return;
      }

      if (response.status === 200) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length >= 60) {
          const ephPubRaw = bytes.slice(0, 32);
          const iv = bytes.slice(32, 44);
          const ctAndTag = bytes.slice(44);

          const ephPubKey = await crypto.subtle.importKey('raw', ephPubRaw, { name: 'X25519' }, false, []);
          const sharedBits = await crypto.subtle.deriveBits({ name: 'X25519', public: ephPubKey }, privKey, 256);
          const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
          const encKey = await crypto.subtle.deriveKey(
            {
              name: 'HKDF',
              hash: 'SHA-256',
              salt: new TextEncoder().encode(room),
              info: new TextEncoder().encode('parcheh-v1:handoff:' + record.pubHex),
            },
            hkdfKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['decrypt']
          );
          const decrypted = await crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv,
              additionalData: new TextEncoder().encode('parcheh-handoff:' + room),
            },
            encKey,
            ctAndTag
          );
          const payload = JSON.parse(new TextDecoder().decode(decrypted));
          const { redirectUrl, browserToken, app } = payload;
          if (typeof browserToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(browserToken)) {
            if (!redirectUrl || new URL(redirectUrl, location.origin).origin === location.origin) {
              const saved = store('parcheh:browser:' + room, browserToken);
              store('parcheh:invitation:' + link.pathname, link.hash);
              try {
                sessionStorage.removeItem(key);
                if (app) sessionStorage.setItem('parcheh:app:' + room, app);
                else sessionStorage.removeItem('parcheh:app:' + room);
              } catch {}
              const fragment = '#' + browserToken + (app ? '&app=' + encodeURIComponent(app) : '');
              location.replace('/view/' + room + (saved ? '' : fragment));
              return;
            }
            const target = new URL(redirectUrl);
            if (['http:', 'https:'].includes(target.protocol) && ['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/view/' + room) {
              try { sessionStorage.removeItem(key); } catch {}
              location.replace(target.href);
              return;
            }
          }
        }
      }

      if (response.status === 200 || response.status === 204) {
        if (!ready) {
          ready = true;
          onReady(link.href + '&handoff=' + record.pubHex);
        }
      } else {
        ready = false;
        onReady(null, response.status === 404 ? 'unavailable' : 'retry');
      }
    } catch {
      ready = false;
      onReady(null, 'retry');
    }
    timer = setTimeout(poll, 400);
  }

  addEventListener('pagehide', () => clearTimeout(timer));
  addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  void poll();
}
