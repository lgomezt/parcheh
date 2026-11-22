import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
  checkedEntries, entriesEqual, fault, git, isIgnoreFile, localPath, treeDifference, withIgnoreRules,
} from './project-tree.mjs';

export { diffTrees, materialize, scanTree } from './project-tree.mjs';

const HEAD = 'refs/heads/room';
const FORMAT = 1;
const IDENTITY = 'parcheh <room@parcheh.invalid>';
const queues = new Map();

function atStore(storage, args, input, allowed) {
  return git(storage, ['--git-dir=.', ...args], input, allowed);
}

function identity(value, kind) {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed()
      || /[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > 256) {
    throw fault('INVALID_SUBMISSION', `Invalid ${kind}.`);
  }
  return value;
}

function submissionDigest(baseRev, changes, author) {
  const hash = createHash('sha256').update(JSON.stringify([baseRev, author]));
  for (const change of changes) hash.update(JSON.stringify(change));
  return hash.digest('hex');
}

function receipt({ rev, oid, supersededPaths }) {
  return { rev, oid, supersededPaths };
}

async function records(storage) {
  const ref = await atStore(storage, ['show-ref', '--verify', '--hash', HEAD], [], [0, 128]);
  if (ref.code === 128) return [];
  const oid = ref.bytes.toString().trim();
  const { bytes } = await atStore(storage, ['log', '--reverse', '-z', '--format=%H%x00%B', oid]);
  const fields = bytes.toString().split('\0');
  const entries = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const data = JSON.parse(fields[i + 1]);
    if (data.format !== FORMAT || data.rev !== entries.length + 1) {
      throw fault('INVALID_HISTORY', 'Project history has an unexpected revision record.');
    }
    entries.push({ ...data, oid: fields[i] });
  }
  if (entries.at(-1)?.oid !== oid) throw fault('INVALID_HISTORY', 'Project history is incomplete.');
  return entries;
}

async function readTree(storage, oid) {
  const { bytes: tree } = await atStore(storage, ['ls-tree', '-r', '-z', oid]);
  const files = [];
  const oids = new Set();
  for (const record of tree.toString().split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const [mode, type, blob] = record.slice(0, tab).split(' ');
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
      throw fault('INVALID_HISTORY', 'Project history contains an unsupported Git entry.');
    }
    files.push([record.slice(tab + 1), blob, mode === '100755']);
    oids.add(blob);
  }
  if (!files.length) return {};

  const { bytes } = await atStore(storage, ['cat-file', '--batch'], [Buffer.from([...oids].join('\n') + '\n')]);
  const blobs = new Map();
  let offset = 0;
  for (const oid of oids) {
    const newline = bytes.indexOf(10, offset);
    const [object, type, size] = bytes.subarray(offset, newline).toString().split(' ');
    const end = newline + 1 + Number(size);
    if (newline < 0 || object !== oid || type !== 'blob' || !/^\d+$/.test(size) || bytes[end] !== 10) {
      throw fault('INVALID_HISTORY', 'Project history contains a malformed Git blob.');
    }
    blobs.set(oid, bytes.subarray(newline + 1, end).toString('base64'));
    offset = end + 1;
  }
  return Object.fromEntries(files.map(([name, oid, executable]) => [name, { data: blobs.get(oid), executable }]));
}

function quotePath(name) {
  let quoted = '"';
  for (const byte of Buffer.from(name)) {
    if (byte === 34 || byte === 92) quoted += '\\' + String.fromCharCode(byte);
    else if (byte >= 32 && byte <= 126) quoted += String.fromCharCode(byte);
    else quoted += '\\' + byte.toString(8).padStart(3, '0');
  }
  return quoted + '"';
}

function* importCommit(ref, parent, patch, metadata) {
  const body = JSON.stringify(metadata);
  const timestamp = Math.floor(Date.now() / 1000);
  const author = metadata.actor.replace(/[<>]/g, '_').trim();
  yield `commit ${ref}\nauthor ${author} <room@parcheh.invalid> ${timestamp} +0000\ncommitter ${IDENTITY} ${timestamp} +0000\ndata ${Buffer.byteLength(body)}\n${body}\n`;
  if (parent) yield `from ${parent}\n`;
  for (const [name, entry] of Object.entries(patch)) {
    if (entry === null) yield `D ${quotePath(name)}\n`;
  }
  for (const [name, entry] of Object.entries(patch)) {
    if (entry === null) continue;
    const data = Buffer.from(entry.data, 'base64');
    yield `M ${entry.executable ? '100755' : '100644'} inline ${quotePath(name)}\ndata ${data.length}\n`;
    yield data;
    yield '\n';
  }
  yield '\ndone\n';
}

async function publish(storage, parent, patch, metadata) {
  const stage = `refs/parcheh/staged/${randomUUID()}`;
  try {
    await atStore(storage, ['fast-import', '--quiet', '--done'], importCommit(stage, parent, patch, metadata));
    const { bytes } = await atStore(storage, ['rev-parse', stage]);
    const oid = bytes.toString().trim();
    const update = await atStore(storage, ['update-ref', HEAD, oid, parent ?? '0'.repeat(40)], [], [0, 128]);
    if (update.code) {
      if ((await records(storage)).at(-1)?.oid !== (parent ?? undefined)) return null;
      throw fault('HISTORY_WRITE', 'Git could not advance the project history.');
    }
    return { ...metadata, oid };
  } finally {
    await atStore(storage, ['update-ref', '-d', stage], [], [0, 128]);
  }
}

function inOrder(storage, execute) {
  const previous = queues.get(storage) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(execute);
  queues.set(storage, next);
  return next.finally(() => {
    if (queues.get(storage) === next) queues.delete(storage);
  });
}

function checkCandidate(base, changes) {
  const candidate = new Map(Object.entries(base));
  for (const [name, entry] of changes) {
    if (entry === null ? !candidate.has(name) : entriesEqual(candidate.get(name), entry)) {
      throw fault('INVALID_SUBMISSION', `Path ${JSON.stringify(name)} does not change in its base revision.`);
    }
    if (entry === null) candidate.delete(name);
    else candidate.set(name, entry);
  }
  checkedEntries(Object.fromEntries(candidate));
}

async function checkIgnoredPaths(baseline, changes) {
  const rules = Object.entries(baseline).filter(([name]) => isIgnoreFile(name));
  if (!rules.length) return;
  await withIgnoreRules(async (checker) => {
    for (const [name, entry] of rules) await checker.add(name, entry);
    const ignored = await checker.check(changes.map(([name]) => name));
    if (ignored.size) throw fault('FORBIDDEN_PATH', `Project path ${JSON.stringify(ignored.values().next().value)} is ignored.`);
  });
}

function atOrAfter(names, value) {
  let low = 0;
  let high = names.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (names[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

function overlay(base, head, changes) {
  const baseFiles = new Map(Object.entries(base));
  const headFiles = new Map(Object.entries(head));
  const files = new Map(headFiles);
  const knownPaths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const ordered = [...knownPaths].sort();
  const affected = new Set();
  const displaced = (name) => {
    affected.add(name);
    files.delete(name);
  };

  for (const [name, entry] of changes) {
    displaced(name);
    const prefix = name + '/';
    for (let i = atOrAfter(ordered, prefix); ordered[i]?.startsWith(prefix); i++) displaced(ordered[i]);
    if (entry === null) continue;
    for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) {
      const ancestor = name.slice(0, i);
      if (knownPaths.has(ancestor)) displaced(ancestor);
    }
  }
  for (const [name, entry] of changes) {
    if (entry !== null) files.set(name, entry);
  }

  const supersededPaths = [...affected].filter((name) => !entriesEqual(baseFiles.get(name), headFiles.get(name))
    && !entriesEqual(headFiles.get(name), files.get(name))).sort();
  const tree = Object.fromEntries(files);
  checkedEntries(tree);
  return { tree, supersededPaths };
}

function history(storage) {
  return {
    async head(rev) {
      const revisions = await records(storage);
      const entry = rev === undefined ? revisions.at(-1) : revisions[rev - 1];
      if (!entry || (rev !== undefined && entry.rev !== rev)) {
        throw fault('UNKNOWN_BASE', 'The requested project revision does not exist.');
      }
      return { rev: entry.rev, oid: entry.oid, tree: await readTree(storage, entry.oid) };
    },

    async log() {
      return (await records(storage)).map(({ format, digest, ...entry }) => entry);
    },

    async submit({ id, baseRev, changes, author }) {
      id = identity(id, 'submission ID');
      author = identity(author, 'author');
      if (!Number.isSafeInteger(baseRev) || baseRev < 1) {
        throw fault('UNKNOWN_BASE', 'The base revision does not exist.');
      }
      const patch = checkedEntries(changes, { changes: true });
      if (!patch.length) throw fault('INVALID_SUBMISSION', 'The submission contains no changes.');
      const digest = submissionDigest(baseRev, patch, author);

      return inOrder(storage, async () => {
        for (;;) {
          const revisions = await records(storage);
          const previous = revisions.find((entry) => entry.id === id);
          if (previous) {
            if (previous.digest !== digest) throw fault('ID_REUSE', 'This submission ID already belongs to a different change.');
            return receipt(previous);
          }
          const base = revisions[baseRev - 1];
          if (!base) throw fault('UNKNOWN_BASE', 'The base revision does not exist.');
          const head = revisions.at(-1);
          const baseTree = await readTree(storage, base.oid);
          checkCandidate(baseTree, patch);
          await checkIgnoredPaths(baseRev === 1 ? baseTree : await readTree(storage, revisions[0].oid), patch);
          const headTree = base.oid === head.oid ? baseTree : await readTree(storage, head.oid);
          const { tree, supersededPaths } = overlay(baseTree, headTree, patch);
          const result = await publish(storage, head.oid, treeDifference(headTree, tree), {
            format: FORMAT, rev: head.rev + 1, actor: author, id, digest, baseRev,
            paths: patch.map(([name]) => name), supersededPaths,
          });
          if (result) return receipt(result);
        }
      });
    },
  };
}

export async function openHistory(storage) {
  const target = await localPath(storage);
  const { bytes } = await atStore(target, ['rev-parse', '--is-bare-repository']);
  if (bytes.toString().trim() !== 'true' || !(await records(target)).length) {
    throw fault('INVALID_HISTORY', 'The directory does not contain a parcheh project history.');
  }
  return history(target);
}

export async function createHistory(storage, tree, author) {
  author = identity(author, 'author');
  const entries = checkedEntries(tree);
  const baseline = Object.fromEntries(entries);
  await checkIgnoredPaths(baseline, entries.filter(([name]) => !isIgnoreFile(name)));
  const parent = await localPath(path.dirname(path.resolve(storage)));
  const target = path.join(parent, path.basename(path.resolve(storage)));
  return inOrder(target, async () => {
    try {
      await fs.mkdir(target, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await openHistory(target);
      const { tree } = await existing.head(1);
      if ((await existing.log())[0].actor !== author || Object.keys(treeDifference(tree, baseline)).length) {
        throw fault('HISTORY_EXISTS', 'This location already has a different project history.');
      }
      return existing;
    }
    try {
      await git(target, ['init', '--bare', '--quiet', '--template=', '--initial-branch=room', '--object-format=sha1']);
      await publish(target, null, baseline, {
        format: FORMAT, rev: 1, actor: author, paths: entries.map(([name]) => name), supersededPaths: [],
      });
      return history(target);
    } catch (error) {
      await fs.rm(target, { recursive: true, force: true });
      throw error;
    }
  });
}
