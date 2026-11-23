import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { projectAsset, projectAssetBytes, projectAssetPolicy } from './project-assets.mjs';

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const given = Buffer.from(a);
  const known = Buffer.from(b);
  return given.length === known.length && timingSafeEqual(given, known);
}

const assets = new Map([
  ['/project.js', 'project.js'],
  ['/invite.mjs', 'invite.mjs'],
  ['/display-name.mjs', new URL('./display-name.mjs', import.meta.url)],
  ['/join.js', 'join.js'],
  ['/browser-handoff.mjs', 'browser-handoff.mjs'],
  ['/app-bridge.mjs', 'app-bridge.mjs'],
]);
const inviteBrandAssets = new Map([
  ['/invite-brand/mark.png', 'image/png'],
  ['/invite-brand/paint.jpg', 'image/jpeg'],
  ['/invite-brand/instrument-sans.ttf', 'font/ttf'],
]);
const shellPolicy = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self' http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:*; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

async function jsonBody(req, limit = 4096) {
  if (Number(req.headers['content-length']) > limit) {
    throw Object.assign(new Error('Message exceeds limit.'), { status: 413 });
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) throw Object.assign(new Error('Message exceeds limit.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
  }
}

export async function startLocalPreviewServer({ roomId, hostBrowserToken, getTree, getRev, guestRelay, localAppUrl }) {
  const localBrowserToken = randomBytes(32).toString('base64url');
  let currentRev = getRev();
  let assetToken = randomBytes(32).toString('base64url');

  function assetPrefix() {
    const rev = getRev();
    if (rev !== currentRev) {
      currentRev = rev;
      assetToken = randomBytes(32).toString('base64url');
    }
    return `/project-assets/${roomId}/${assetToken}/${currentRev}/`;
  }

  const pointerStreams = new Set();
  let pointerPollTimer = null;
  let lastPointersJson = null;

  async function pollPointers() {
    if (pointerStreams.size === 0) return;
    try {
      const live = await guestRelay.rpc('live', hostBrowserToken);
      const snapshot = JSON.stringify({ rev: getRev(), pointers: live?.pointers || [] });
      lastPointersJson = snapshot;
      for (const res of pointerStreams) {
        if (!res.destroyed) res.write(snapshot + '\n');
      }
    } catch {}
  }

  function ensurePointerPoll() {
    if (!pointerPollTimer) {
      pointerPollTimer = setInterval(pollPointers, 800);
      pointerPollTimer.unref?.();
    }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    try {
      const port = server.address().port;
      const host = req.headers.host;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Unknown host.');
      }

      const parsedUrl = new URL(req.url, `http://127.0.0.1:${port}`);
      const path = parsedUrl.pathname;

      const isAsset = path === '/app-bridge.mjs' || path.startsWith('/project-assets/');
      const isTopLevelViewNavigation = req.method === 'GET' &&
        path === '/view/' + roomId &&
        req.headers['sec-fetch-mode'] === 'navigate' &&
        req.headers['sec-fetch-dest'] === 'document';
      if (!isAsset) {
        if (req.headers['sec-fetch-site'] === 'cross-site' && !isTopLevelViewNavigation) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end('Cross-site request blocked.');
        }
        const origin = req.headers.origin;
        if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end('Unknown origin.');
        }
      }

      if (req.method === 'GET') {
        if (path === '/view/' + roomId) {
          const data = await readFile(new URL('project.html', new URL('../web/v2/', import.meta.url)));
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': shellPolicy });
          return res.end(data);
        }
        if (path === '/app-bridge.mjs') {
          const data = await readFile(new URL('app-bridge.mjs', new URL('../web/v2/', import.meta.url)));
          res.writeHead(200, {
            'content-type': 'text/javascript; charset=utf-8',
            'content-security-policy': shellPolicy,
            'access-control-allow-origin': '*',
          });
          return res.end(data);
        }
        if (assets.has(path)) {
          const file = assets.get(path);
          const data = typeof file === 'string'
            ? await readFile(new URL(file, new URL('../web/v2/', import.meta.url)))
            : await readFile(file);
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-security-policy': shellPolicy });
          return res.end(data);
        }
        if (inviteBrandAssets.has(path)) {
          const type = inviteBrandAssets.get(path);
          const data = await readFile(new URL(path.slice(1), new URL('../web/v2/', import.meta.url)));
          res.writeHead(200, { 'content-type': type, 'content-security-policy': shellPolicy });
          return res.end(data);
        }
        if (path.startsWith(`/project-assets/${roomId}/`)) {
          const prefix = assetPrefix();
          if (path.startsWith(prefix)) {
            const tree = await getTree();
            const file = tree ? projectAsset(tree, path.slice(prefix.length)) : null;
            if (!file) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
              return res.end('Unknown project asset.');
            }
            res.removeHeader('x-frame-options');
            res.writeHead(200, {
              'content-type': file.type,
              'content-security-policy': projectAssetPolicy(`http://127.0.0.1:${port}`, prefix),
              'access-control-allow-origin': '*',
            });
            return res.end(projectAssetBytes(file));
          }
        }
      }

      const apiPrefix = `/api/rooms/${roomId}/`;
      if (path.startsWith(apiPrefix)) {
        const bearer = (req.headers.authorization || '').startsWith('Bearer ')
          ? req.headers.authorization.slice(7)
          : '';
        if (!sameSecret(bearer, localBrowserToken)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end('Room credential required.');
        }

        const routeWithQuery = req.url.slice(apiPrefix.length);
        const route = path.slice(apiPrefix.length);

        if (req.method === 'GET' && route === 'pointers') {
          res.writeHead(200, {
            'content-type': 'application/x-ndjson',
            'x-accel-buffering': 'no',
          });
          pointerStreams.add(res);
          ensurePointerPoll();
          try {
            const live = await guestRelay.rpc('live', hostBrowserToken);
            const snapshot = JSON.stringify({ rev: getRev(), pointers: live?.pointers || [] });
            res.write(snapshot + '\n');
          } catch {}
          const heartbeat = setInterval(() => {
            if (!res.destroyed) {
              pollPointers().catch(() => {});
            }
          }, 1500);
          heartbeat.unref?.();
          res.once('close', () => {
            clearInterval(heartbeat);
            pointerStreams.delete(res);
            if (pointerStreams.size === 0 && pointerPollTimer) {
              clearInterval(pointerPollTimer);
              pointerPollTimer = null;
            }
          });
          return;
        }

        if (req.method === 'GET' && route === 'config') {
          const configRes = await guestRelay.rpc('config', hostBrowserToken);
          const tree = await getTree();
          const localEntryUrl = (tree && Object.hasOwn(tree, 'index.html')) ? (assetPrefix() + 'index.html') : null;
          const rewritten = { ...configRes, entryUrl: localEntryUrl };
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify(rewritten));
        }

        if (req.method === 'POST') {
          const body = await jsonBody(req);
          const result = await guestRelay.rpc(routeWithQuery, hostBrowserToken, body);
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify(result));
        }

        if (req.method === 'GET') {
          const result = await guestRelay.rpc(routeWithQuery, hostBrowserToken);
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify(result));
        }
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (err) {
      const status = err.status || Number(/HTTP (\d+)/.exec(err.message)?.[1]) || 500;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(typeof err.body === 'object' ? err.body : { error: err.message || 'Internal error' }));
    }
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const port = server.address().port;
  return {
    browserUrl: `http://127.0.0.1:${port}/view/${roomId}#${localBrowserToken}`,
    port,
    close() {
      if (pointerPollTimer) clearInterval(pointerPollTimer);
      for (const res of pointerStreams) {
        if (!res.destroyed) res.end();
      }
      pointerStreams.clear();
      server.close();
      server.closeAllConnections?.();
    },
  };
}
