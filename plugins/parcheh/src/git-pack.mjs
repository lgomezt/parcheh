import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fault, validatePath } from './project-tree.mjs';

const gitCommand = existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git';
const gitEnvironment = {
  PATH: process.env.PATH,
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1',
};

async function gitExec(cwd, args, input = [], allowed = [0], extraEnv = {}) {
  const child = spawn(gitCommand, [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.excludesFile=/dev/null',
    '-c', 'core.fsync=committed,reference',
    ...args,
  ], {
    cwd,
    env: { ...gitEnvironment, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const write = pipeline(Readable.from(input), child.stdin).catch(error => {
    if (!['EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code)) throw error;
  });
  const [code] = await Promise.all([exit, write]);
  if (!allowed.includes(code)) {
    throw new Error(`Git ${args[0]} failed: ${Buffer.concat(stderr).toString().trim()}`);
  }
  return { code, bytes: Buffer.concat(stdout) };
}

export async function exportPack(bareGitDir, wantOid, haveOids = []) {
  if (!/^[0-9a-f]{40}$/.test(wantOid)) {
    throw fault('INVALID_OID', 'Invalid commit OID.');
  }
  const validHaves = [];
  for (const oid of haveOids) {
    if (typeof oid === 'string' && /^[0-9a-f]{40}$/.test(oid)) {
      const { code } = await gitExec(bareGitDir, ['--git-dir=.', 'cat-file', '-e', `${oid}^{commit}`], [], [0, 1]);
      if (code === 0) validHaves.push(oid);
    }
  }
  const stdinLines = [wantOid, ...validHaves.map(h => '^' + h)].join('\n') + '\n';
  const { bytes } = await gitExec(bareGitDir, [
    '--git-dir=.', 'pack-objects', '--stdout', '--revs', '--thin', '--delta-base-offset',
  ], [Buffer.from(stdinLines, 'utf8')]);
  return bytes;
}

export async function readBareTree(bareGitDir, oid, extraEnv = {}) {
  const { bytes: treeBytes } = await gitExec(bareGitDir, ['--git-dir=.', 'ls-tree', '-r', '-z', oid], [], [0], extraEnv);
  const files = [];
  const oids = new Set();
  for (const record of treeBytes.toString().split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const [mode, type, blob] = record.slice(0, tab).split(' ');
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
      throw fault('INVALID_HISTORY', 'Project history contains an unsupported Git entry.');
    }
    const name = record.slice(tab + 1);
    files.push([name, blob, mode === '100755']);
    oids.add(blob);
  }
  if (!files.length) return {};

  const { bytes: catBytes } = await gitExec(bareGitDir, ['--git-dir=.', 'cat-file', '--batch'], [
    Buffer.from([...oids].join('\n') + '\n'),
  ], [0], extraEnv);
  const blobs = new Map();
  let offset = 0;
  for (const blobOid of oids) {
    const newline = catBytes.indexOf(10, offset);
    const [object, type, size] = catBytes.subarray(offset, newline).toString().split(' ');
    const end = newline + 1 + Number(size);
    if (newline < 0 || object !== blobOid || type !== 'blob' || !/^\d+$/.test(size) || catBytes[end] !== 10) {
      throw fault('INVALID_HISTORY', 'Project history contains a malformed Git blob.');
    }
    blobs.set(blobOid, catBytes.subarray(newline + 1, end).toString('base64'));
    offset = end + 1;
  }
  return Object.fromEntries(files.map(([name, blobOid, executable]) => [
    name,
    { data: blobs.get(blobOid), executable },
  ]));
}

export async function importQuarantinedPack(
  bareGitDir,
  packBuffer,
  expectedOid,
  { maxPackBytes = 128 * 1024 * 1024, maxUnpackedBytes = 128 * 1024 * 1024 } = {},
) {
  if (!/^[0-9a-f]{40}$/.test(expectedOid)) {
    throw fault('INVALID_OID', 'Invalid commit OID.');
  }
  if (!Buffer.isBuffer(packBuffer) || packBuffer.length > maxPackBytes) {
    throw fault('PACK_TOO_LARGE', 'Git packfile exceeds 128 MiB limit.');
  }

  await mkdir(bareGitDir, { recursive: true, mode: 0o700 });
  if (!existsSync(join(bareGitDir, 'HEAD'))) {
    await gitExec(bareGitDir, ['init', '--bare', '--quiet', '--template=', '--initial-branch=room', '--object-format=sha1']);
  }

  const qId = 'quarantine-' + randomUUID();
  const quarantineDir = join(bareGitDir, 'objects', qId);
  await mkdir(quarantineDir, { recursive: true, mode: 0o700 });

  try {
    await writeFile(join(quarantineDir, 'incoming.pack'), packBuffer, { mode: 0o600 });
    const qEnv = {
      GIT_OBJECT_DIRECTORY: quarantineDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(bareGitDir, 'objects'),
    };

    await gitExec(bareGitDir, [
      '--git-dir=.', 'index-pack', '--stdin', '--strict', '--fix-thin', '--max-input-size=134217728',
    ], [packBuffer], [0], qEnv);

    const { bytes: revListBytes } = await gitExec(bareGitDir, ['--git-dir=.', 'rev-list', '--objects', expectedOid], [], [0], qEnv);
    const uniqueOids = new Set();
    for (const line of revListBytes.toString().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        const [objOid] = trimmed.split(' ');
        if (/^[0-9a-f]{40}$/.test(objOid)) uniqueOids.add(objOid);
      }
    }

    const { bytes: batchCheckBytes } = await gitExec(bareGitDir, [
      '--git-dir=.', 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)',
    ], [Buffer.from([...uniqueOids].join('\n') + '\n')], [0], qEnv);

    let totalUnpackedBytes = 0;
    for (const line of batchCheckBytes.toString().split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [, , objSize] = trimmed.split(' ');
      const sizeNum = Number(objSize);
      if (Number.isFinite(sizeNum)) {
        totalUnpackedBytes += sizeNum;
        if (totalUnpackedBytes > maxUnpackedBytes) {
          throw fault('PACK_BOMB', 'Unpacked Git objects exceed 128 MiB limit.');
        }
      }
    }

    const { bytes: lsTreeBytes } = await gitExec(bareGitDir, ['--git-dir=.', 'ls-tree', '-r', '-z', expectedOid], [], [0], qEnv);
    for (const entry of lsTreeBytes.toString().split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      const [mode, type] = entry.slice(0, tab).split(' ');
      if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
        throw fault('INVALID_HISTORY', 'Project history contains an unsupported Git entry.');
      }
      const entryPath = entry.slice(tab + 1);
      validatePath(entryPath);
    }

    const packDestDir = join(bareGitDir, 'objects', 'pack');
    await mkdir(packDestDir, { recursive: true, mode: 0o700 });
    const packSourceDir = existsSync(join(quarantineDir, 'pack')) ? join(quarantineDir, 'pack') : quarantineDir;
    const files = await readdir(packSourceDir);
    for (const file of files) {
      if (file.endsWith('.pack') || file.endsWith('.idx') || file.endsWith('.rev')) {
        await rename(join(packSourceDir, file), join(packDestDir, file));
      }
    }

    await gitExec(bareGitDir, ['--git-dir=.', 'update-ref', 'refs/heads/room', expectedOid]);
    return await readBareTree(bareGitDir, expectedOid);
  } finally {
    await rm(quarantineDir, { recursive: true, force: true }).catch(() => {});
  }
}
