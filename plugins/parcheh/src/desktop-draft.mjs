import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { scanTree, validatePath } from './project-tree.mjs';

const maxTextBytes = 512 * 1024;

export async function draftFiles(root, scope, operation, { path, content }) {
  const scan = () => scanTree(root, { baseline: scope, respectDraftIgnores: true });
  if (operation === 'list') return { paths: Object.keys(await scan()).sort() };
  validatePath(path);
  const target = join(root, path);
  const exists = async name => lstat(name).catch(e => { if (e.code !== 'ENOENT') throw e; });
  const included = await scan();
  const visible = Object.hasOwn(included, path);
  if (operation === 'read') {
    if (!visible) throw Error('Choose a file listed in this draft.');
    const bytes = Buffer.from(included[path].data, 'base64');
    if (bytes.length > maxTextBytes) throw Error('Use native file tools for files over 512 KiB.');
    return { path, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  }
  if (!visible && await exists(target)) throw Error('Choose a shared file inside the draft.');
  if (operation === 'delete' && !visible) throw Error('Choose a file listed in this draft.');
  if (operation === 'write' && Buffer.byteLength(content) > maxTextBytes) throw Error('Use native file tools for files over 512 KiB.');
  let directory = root;
  for (const segment of path.split('/').slice(0,-1)) {
    directory = join(directory, segment);
    if (!(await exists(directory))) await mkdir(directory, { mode: 0o700 });
    if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) throw Error('Choose a directory inside the draft.');
  }
  if (await realpath(dirname(target)) !== dirname(target)) throw Error('The draft folder moved.');
  if (operation === 'delete') {
    await rm(target);
  } else {
    const stage = join(directory, '.parcheh-write-' + randomUUID());
    try {
      const file = await open(stage, constants.O_WRONLY | constants.O_EXCL | constants.O_CREAT, visible && included[path].executable ? 0o700 : 0o600);
      try { await file.writeFile(content); } finally { await file.close(); }
      await rename(stage, target);
    } finally { await rm(stage, { force: true }).catch(() => {}); }
  }
  return { path };
}
