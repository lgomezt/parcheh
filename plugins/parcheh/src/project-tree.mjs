import { spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MiB = 1024 * 1024;
const MAX_FILE = 32 * MiB;
const MAX_TREE = 128 * MiB;
const MAX_FILES = 10_000;
const OMIT = new Set([
  '.git', '.gitmodules', '.parcheh', '.claude', '.cursor', '.codex', '.agents', '.ai',
  '.gemini', '.windsurf', '.continue', '.aider', '.mcp.json', '.vscode', '.idea',
  'agents.md', 'claude.md', 'gemini.md', '.claude.json', '.codex.json',
  '.cursorrules', '.clinerules', '.roorules', '.windsurfrules', 'copilot-instructions.md',
  '.github', '.husky', '.cargo', '.direnv',
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.terraform', '.config', '.azure',
  '.password-store', '.1password', 'keychains',
  '.netrc', '.git-credentials', '.gitconfig', '.npmrc', '.pypirc', '.yarnrc',
  '.yarnrc.yml', '.envrc', '.ds_store', 'credentials', 'secrets',
  'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt', '.cache',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.ruff_cache', '.mypy_cache',
]);

const SECRET_PATTERNS = [
  { kind: 'anthropic-api-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'openai-api-key', pattern: /\bsk-(?:proj|live|svcacct)-[A-Za-z0-9_-]{20,}/ },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { kind: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'private-key-pem', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/ },
];

const BUILD_CONFIG_PATTERN = /^(?:package\.json|(?:vite|next|postcss|tailwind|webpack|rollup|astro|svelte|nuxt)\.config\.[a-z0-9]+|Makefile|Dockerfile)$/i;

function fold(name) {
  return name.normalize('NFD').toUpperCase().toLowerCase();
}

function omittedSegment(segment) {
  const name = fold(segment).replace(/\p{Default_Ignorable_Code_Point}/gu, '');
  return OMIT.has(name)
    || /^(?:\.parcheh-|\.aider[.-]|\.cursor[.-]|\.cline[.-]|\.roo[.-]|\.windsurf[.-])/.test(name)
    || (/^\.env(?:[.-]|$)/.test(name) && !/^\.env\.(?:example|sample|template)$/.test(name))
    || /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|(?:secret|secrets|credentials)\.[^.]+)$/.test(name)
    || /\.(?:pem|key|p12|pfx|keystore)$/.test(name)
    || /\.local(?:\.[^.]+)?$/.test(name);
}

export function fault(code, message) {
  return Object.assign(new Error(message), { code });
}

function scopeLimit(kind, actual, maximum) {
  throw fault('SCOPE_LIMIT', `Project ${kind} is ${actual}. The limit is ${maximum}.`);
}

function record(value) {
  return value && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export function validatePath(name) {
  if (name.includes('\\') || name.includes('\0') || !name.isWellFormed() || Buffer.byteLength(name) > 4096
      || name.split('/').some((part) => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255)) {
    throw fault('INVALID_PATH', `Invalid project path ${JSON.stringify(name)}.`);
  }
  if (name.split('/').some(omittedSegment)) {
    throw fault('FORBIDDEN_PATH', `Project path ${JSON.stringify(name)} is excluded.`);
  }
}

function checkTreePaths(entries) {
  const files = new Set(entries.map(([name]) => name));
  const spellings = new Map();
  for (const [name] of entries) {
    let prefix = '';
    for (const part of name.split('/')) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const key = fold(prefix);
      const spelling = spellings.get(key);
      if (spelling !== undefined && spelling !== prefix) {
        throw fault('PATH_COLLISION', `Project paths collide: ${JSON.stringify(spelling)} and ${JSON.stringify(prefix)}.`);
      }
      if (prefix !== name && files.has(prefix)) {
        throw fault('PATH_COLLISION', `A file and directory share path ${JSON.stringify(prefix)}.`);
      }
      spellings.set(key, prefix);
    }
  }
}

function entryBytes(name, entry) {
  if (!record(entry) || Object.keys(entry).length !== 2 || !Object.hasOwn(entry, 'executable')
      || !Object.hasOwn(entry, 'data') || typeof entry.executable !== 'boolean' || typeof entry.data !== 'string') {
    throw fault('INVALID_ENTRY', `Invalid project entry at ${JSON.stringify(name)}.`);
  }
  if (entry.data.length > Math.ceil(MAX_FILE / 3) * 4) {
    scopeLimit(`file size at ${JSON.stringify(name)} (bytes)`, Math.floor(entry.data.length * 3 / 4), MAX_FILE);
  }
  const bytes = Buffer.from(entry.data, 'base64');
  if (bytes.toString('base64') !== entry.data) {
    throw fault('INVALID_ENTRY', `Expected canonical base64 at ${JSON.stringify(name)}.`);
  }
  if (bytes.length > MAX_FILE) scopeLimit(`file size at ${JSON.stringify(name)} (bytes)`, bytes.length, MAX_FILE);
  return bytes.length;
}

export function checkedEntries(tree, { changes = false } = {}) {
  if (!record(tree)) throw fault('INVALID_TREE', 'Expected a project tree object.');
  const entries = Object.entries(tree).sort(([a], [b]) => a < b ? -1 : Number(a > b));
  const written = [];
  let total = 0;
  for (const [name, entry] of entries) {
    validatePath(name);
    if (changes && entry === null) continue;
    total += entryBytes(name, entry);
    if (total > MAX_TREE) scopeLimit('snapshot size (bytes)', total, MAX_TREE);
    written.push([name, { data: entry.data, executable: entry.executable }]);
    if (written.length > MAX_FILES) scopeLimit('file count', written.length, MAX_FILES);
  }
  if (entries.length > MAX_FILES * 2) scopeLimit('changed path count', entries.length, MAX_FILES * 2);
  checkTreePaths(written);
  return changes ? entries.map(([name, entry]) => [name, entry && { data: entry.data, executable: entry.executable }]) : written;
}

function filesystemPath(value) {
  const absolute = path.resolve(value);
  // macOS provides these system aliases for the directories under /private.
  if (process.platform === 'darwin' && /^\/(?:tmp|var|etc)(?:\/|$)/.test(absolute)) return `/private${absolute}`;
  return absolute;
}

export async function localPath(value) {
  const absolute = filesystemPath(value);
  const resolved = await fs.realpath(absolute);
  if (resolved.normalize('NFC') !== absolute.normalize('NFC')) {
    throw fault('INVALID_ROOT', 'Choose a path without symbolic links.');
  }
  return resolved;
}

export function checkSourceRoot(root) {
  const home = filesystemPath(homedir());
  const temporary = filesystemPath(tmpdir());
  const system = ['/private/etc', '/etc', '/System', '/Library', '/Applications', '/usr', '/bin', '/sbin',
    '/proc', '/sys', '/dev', '/run', '/boot'];
  if (home === root || home.startsWith(root + '/') || root === '/' || root === temporary
      || system.some((dir) => root === dir || root.startsWith(dir + '/'))
      || ['/private/var/', '/var/'].some((dir) => root.startsWith(dir) && !root.startsWith(temporary + '/'))
      || ['/private', '/private/tmp', '/private/var', '/tmp', '/var', '/Volumes', '/Users', '/home', '/opt',
        ...['Library', 'Documents', 'Downloads', 'Desktop'].map((folder) => path.join(home, folder))].includes(root)) {
    throw fault('INVALID_ROOT', 'Choose a project folder or file instead of a shared system or home directory.');
  }
  const library = path.join(home, 'Library') + '/';
  if (root.startsWith(library) && !['CloudStorage/', 'Mobile Documents/'].some((folder) => root.startsWith(library + folder))) {
    throw fault('FORBIDDEN_PATH', 'Choose a project outside private application data.');
  }
  const parts = root.split('/').filter(Boolean);
  if (omittedSegment(parts.at(-1)) || parts.some((part) => omittedSegment(part) && !/^\.parcheh(?:-|$)/i.test(part))) {
    throw fault('FORBIDDEN_PATH', 'The chosen path is excluded from project sharing.');
  }
}

function sameFile(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
    && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

function unstable(relative) {
  return fault('UNSTABLE_SOURCE', `Project path changed while reading: ${JSON.stringify(relative || '.')}.`);
}

async function readFile(absolute, relative, observed) {
  const initial = await fs.lstat(absolute, { bigint: true });
  if (!initial.isFile() || await fs.realpath(absolute) !== absolute) throw unstable(relative);
  const file = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!sameFile(initial, before)) throw unstable(relative);
    if (before.size > BigInt(MAX_FILE)) scopeLimit(`file size at ${JSON.stringify(relative)} (bytes)`, before.size, MAX_FILE);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset);
      if (!bytesRead) throw unstable(relative);
      offset += bytesRead;
    }
    if (!sameFile(before, await fs.lstat(absolute, { bigint: true }))) throw unstable(relative);
    observed?.push([absolute, relative, before]);
    return { data: bytes.toString('base64'), executable: Boolean(before.mode & 0o111n) };
  } finally {
    await file.close();
  }
}

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

export async function git(cwd, args, input = [], allowed = [0]) {
  const child = spawn(gitCommand, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.excludesFile=/dev/null',
    '-c', 'core.fsync=committed,reference', ...args], { cwd, env: gitEnvironment, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const write = pipeline(Readable.from(input), child.stdin).catch((error) => {
    if (!['EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code)) throw error;
  });
  const [code] = await Promise.all([exit, write]);
  if (!allowed.includes(code)) throw new Error(`Git ${args[0]} failed: ${Buffer.concat(stderr).toString().trim()}`);
  return { code, bytes: Buffer.concat(stdout) };
}

export async function withIgnoreRules(callback) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'parcheh-ignore-'));
  try {
    await git(root, ['init', '--quiet', '--template=']);
    let hasRules = false;
    return await callback({
      async add(name, entry) {
        const absolute = path.join(root, name);
        await fs.mkdir(path.dirname(absolute), { mode: 0o700, recursive: true });
        await fs.writeFile(absolute, Buffer.from(entry.data, 'base64'), { mode: 0o600, flag: 'wx' });
        hasRules = true;
      },
      async check(names) {
        if (!hasRules || !names.length) return new Set();
        const { bytes } = await git(root, ['check-ignore', '--no-index', '-z', '--stdin'],
          [Buffer.from(names.join('\0') + '\0')], [0, 1]);
        return new Set(bytes.toString().split('\0').filter(Boolean).map((name) => name.replace(/\/$/, '')));
      },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export function isIgnoreFile(name) {
  return path.posix.basename(name) === '.gitignore';
}

function candidateName(raw) {
  const name = raw.toString('utf8');
  if (!Buffer.from(name, 'utf8').equals(raw)) {
    throw fault('INVALID_PATH', 'Project contains a filename that is not UTF-8.');
  }
  return name;
}

async function readScope(root, { baseline, onExclude, respectDraftIgnores }) {
  const entries = [];
  const observed = [];
  const excluded = [];
  let total = 0;

  function add(name, entry) {
    entries.push([name, entry]);
    if (entries.length > MAX_FILES) scopeLimit('file count', entries.length, MAX_FILES);
    total += Buffer.byteLength(entry.data, 'base64');
    if (total > MAX_TREE) scopeLimit('snapshot size (bytes)', total, MAX_TREE);
  }

  const collect = async (rules, draftRules) => {
    if (baseline) {
      for (const [name, entry] of checkedEntries(baseline)) {
        if (isIgnoreFile(name)) await rules.add(name, entry);
      }
    }

    async function walk(absolute, relative) {
      const before = await fs.lstat(absolute, { bigint: true });
      if (!before.isDirectory() || await fs.realpath(absolute) !== absolute) throw unstable(relative);
      const files = [];
      let ignoreEntry;
      const children = (await fs.readdir(absolute, { withFileTypes: true, encoding: 'buffer' }))
        .map((child) => [candidateName(child.name), child]);
      const names = new Set(children.map(([name]) => fold(name)));
      if (relative && (names.has('.git') || ['head', 'objects', 'refs'].every((name) => names.has(name)))) {
        excluded.push([relative, 'nested Git repository']);
        return;
      }
      observed.push([absolute, relative, before]);
      for (const [basename, child] of children) {
        const name = relative ? `${relative}/${basename}` : basename;
        if (omittedSegment(basename)) {
          excluded.push([name, 'excluded']);
          continue;
        }
        if (!child.isFile() && !child.isDirectory()) {
          excluded.push([name, child.isSymbolicLink() ? 'symbolic link' : 'special file']);
          continue;
        }
        validatePath(name);
        if (basename === '.gitignore' && child.isFile() && (!baseline || draftRules)) {
          ignoreEntry = await readFile(path.join(absolute, basename), name, observed);
          await (draftRules || rules).add(name, ignoreEntry);
        }
        files.push({ basename, name, directory: child.isDirectory() });
      }

      const paths = files.map(({ name, directory }) => directory ? name + '/' : name);
      const ignored = await rules.check(paths);
      const draftIgnored = draftRules ? await draftRules.check(paths) : new Set();
      for (const { basename, name, directory } of files) {
        const child = path.join(absolute, basename);
        if (basename === '.gitignore' && (ignored.has(name) || draftIgnored.has(name))) {
          throw fault('HIDDEN_IGNORE_POLICY', 'A .gitignore excludes an active ignore file. Keep that rule file visible or choose a narrower project directory.');
        }
        if (draftIgnored.has(name)) {
          excluded.push([name, 'draft gitignore']);
        } else if (ignored.has(name)) {
          excluded.push([name, 'gitignore']);
        } else if (directory) {
          await walk(child, name);
        } else {
          add(name, basename === '.gitignore' && ignoreEntry ? ignoreEntry : await readFile(child, name, observed));
        }
      }
    }

    await walk(root, '');
    for (const [absolute, relative, before] of observed) {
      if (!sameFile(before, await fs.lstat(absolute, { bigint: true }))) throw unstable(relative);
    }
    checkTreePaths(entries);
    if (onExclude) for (const exclusion of excluded) onExclude(...exclusion);
    return Object.fromEntries(entries);
  };
  return withIgnoreRules(rules => respectDraftIgnores && baseline
    ? withIgnoreRules(draftRules => collect(rules, draftRules))
    : collect(rules));
}

async function bareRepository(root) {
  try {
    return (await fs.lstat(path.join(root, 'HEAD'))).isFile()
      && (await fs.lstat(path.join(root, 'objects'))).isDirectory()
      && (await fs.lstat(path.join(root, 'refs'))).isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function scanTree(value, options = {}) {
  const absolute = filesystemPath(value);
  checkSourceRoot(absolute);
  const resolved = await localPath(absolute);
  const source = await fs.lstat(resolved);
  if (source.isFile()) {
    const name = path.basename(resolved);
    validatePath(name);
    return Object.fromEntries([[name, await readFile(resolved, name)]]);
  }
  if (!source.isDirectory() || await bareRepository(resolved)) {
    throw fault('INVALID_ROOT', 'Choose an ordinary project file or folder.');
  }
  try {
    return await readScope(resolved, options);
  } catch (error) {
    if (!['UNSTABLE_SOURCE', 'ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) throw error;
    return readScope(resolved, options);
  }
}

export async function materialize(root, tree) {
  const entries = checkedEntries(tree);
  const absolute = filesystemPath(root);
  const parent = await localPath(path.dirname(absolute));
  const target = path.join(parent, path.basename(absolute));
  await fs.mkdir(target, { mode: 0o700 });
  try {
    for (const [name, entry] of entries) {
      const destination = path.join(target, name);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const mode = entry.executable ? 0o700 : 0o600;
      const file = await fs.open(destination, 'wx', mode);
      try {
        await file.writeFile(Buffer.from(entry.data, 'base64'));
        await file.chmod(mode);
      } finally {
        await file.close();
      }
    }
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
}

export function entriesEqual(left, right) {
  return left?.data === right?.data && left?.executable === right?.executable;
}

export function treeDifference(base, edited) {
  const paths = [...new Set([...Object.keys(base), ...Object.keys(edited)])].sort();
  return Object.fromEntries(paths
    .filter((name) => !entriesEqual(Object.hasOwn(base, name) ? base[name] : null, Object.hasOwn(edited, name) ? edited[name] : null))
    .map((name) => [name, Object.hasOwn(edited, name) ? edited[name] : null]));
}

export async function diffTrees(base, edited) {
  return treeDifference(Object.fromEntries(checkedEntries(base)), Object.fromEntries(checkedEntries(edited)));
}

export function inspectTreeRisks(tree, changedPaths = Object.keys(tree)) {
  const secretWarnings = [];
  const buildConfigPaths = [];
  if (!tree || typeof tree !== 'object') return { secretWarnings, buildConfigPaths };

  const paths = [...new Set(changedPaths)].sort();
  for (const name of paths) {
    const entry = tree[name];
    if (!entry || typeof entry.data !== 'string') continue;

    const base = path.posix.basename(name);
    if (BUILD_CONFIG_PATTERN.test(base)) {
      buildConfigPaths.push(name);
    }

    if (/\.(?:example|sample|template)$/i.test(base)) continue;

    const bytes = Buffer.from(entry.data, 'base64');
    if (bytes.length > 2 * MiB) continue;

    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) continue;

    for (const { kind, pattern } of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        secretWarnings.push({ path: name, kind });
      }
    }
  }

  secretWarnings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : Number(a.kind > b.kind)));
  buildConfigPaths.sort();
  return { secretWarnings, buildConfigPaths };
}
