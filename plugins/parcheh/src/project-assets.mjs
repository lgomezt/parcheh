import { extname } from 'node:path';

const mediaTypes = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}));

const privateNames = new Set([
  'api', 'backend', 'config', 'configs', 'credentials', 'node_modules', 'private',
  'secret', 'secrets', 'server', 'test', 'tests', 'fixtures',
]);
const bridge = '<script type="module" src="/app-bridge.mjs"></script>';
const doctype = /^\uFEFF?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype\s+[^>]*>/i;

export function projectAsset(tree, encodedPath) {
  let parts;
  try {
    parts = encodedPath.split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
  if (parts.some((part) => {
    const name = part.normalize('NFKC').toLowerCase();
    return !name || name.startsWith('.') || /[/\\\0]/.test(name) || privateNames.has(name)
      || /(?:^|[._-])(?:config|credentials|private|secrets?|server|backend|test|spec)(?:[._-]|$)/.test(name);
  })) return null;
  const name = parts.join('/');
  const type = mediaTypes.get(extname(name).toLowerCase());
  if (!type || !Object.hasOwn(tree, name)) return null;
  return { type, data: tree[name].data };
}

export function projectAssetPolicy(origin, prefix) {
  const ipv6 = new URL(origin).hostname.startsWith('[');
  const files = ipv6 ? "'self'" : origin + prefix;
  const scripts = ipv6 ? files : files + ' ' + origin + '/app-bridge.mjs';
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    `script-src 'unsafe-inline' ${scripts}`,
    `style-src 'unsafe-inline' ${files}`,
    `img-src data: blob: ${files}`,
    `font-src data: ${files}`,
    `connect-src ${files}`,
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

export function projectAssetBytes({ type, data }) {
  const content = Buffer.from(data, 'base64');
  if (!type.startsWith('text/html')) return content;
  const html = content.toString('utf8');
  const afterDoctype = doctype.exec(html)?.[0].length ?? Number(html.startsWith('\uFEFF'));
  return html.slice(0, afterDoctype) + bridge + html.slice(afterDoctype);
}
