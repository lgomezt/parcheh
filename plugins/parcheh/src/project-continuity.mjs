import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createHistory, forkHistory, openHistory, scanTree } from './project.mjs';
import { isIgnoreFile, withIgnoreRules } from './project-tree.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fingerprints(tree) {
  return Object.fromEntries(Object.entries(tree).map(([path, entry]) => [path,
    createHash('sha256').update(entry.executable ? 'x' : '-').update(entry.data).digest('hex')]));
}

async function projectKey(source) {
  const path = await realpath(source);
  const stat = await lstat(path, {bigint:true});
  return JSON.stringify([path, String(stat.dev), String(stat.ino)]);
}

export async function lockProject(home, source) {
  const key = await projectKey(source);
  const name = createHash('sha256').update(key).digest('hex');
  const lock = new DatabaseSync(join(home, 'project-lock-' + name + '.sqlite'));
  try {
    lock.exec('PRAGMA busy_timeout=150; BEGIN IMMEDIATE');
    return lock;
  } catch (error) {
    lock.close();
    if (error.errcode !== 5) throw error;
    throw Object.assign(Error('This project already has a running room on this device. Use that room, or end it before starting another.'), {code:'PROJECT_ACTIVE'});
  }
}

export async function latestRoom(home, source) {
  const file = join(home, 'project-continuity.sqlite');
  if (!await lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; })) return;
  const key = await projectKey(source);
  const db = new DatabaseSync(file, {readOnly:true});
  try {
    db.exec('PRAGMA busy_timeout=3000');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='projects'").get()) return;
    return db.prepare('SELECT id FROM projects WHERE key=?').get(key)?.id;
  } finally { db.close(); }
}

async function legacyRoom(home, id) {
  const owner = JSON.parse(await readFile(join(home, 'room-' + id + '.json'), 'utf8'));
  if (owner.room !== id || owner.host !== true) throw Error('Choose a room hosted on this device.');
  const receipt = owner.accepted;
  if (receipt != null && (!Number.isSafeInteger(receipt.rev) || receipt.rev < 1 || !/^[a-f0-9]{40}$/.test(receipt.oid))) {
    throw Error('The saved host revision is invalid. Restore the original private room backup before continuing.');
  }
  const entries = await readdir(home, {withFileTypes:true});
  const documents = [];
  const stores = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('host-')) continue;
    const [name, suffix, extra] = entry.name.split('.');
    if (!uuid.test(name.slice(5)) || extra !== undefined) continue;
    if (suffix === undefined) stores.push(name);
    if (suffix !== 'documents') continue;
    const file = join(home, entry.name, id + '.sqlite');
    if ((await lstat(file).catch(e => { if (e.code !== 'ENOENT') throw e; }))?.isFile()) documents.push(name);
  }
  const ambiguous = () => Error('Cannot identify a unique saved host history for that older room. Restore its original private host backup or choose the verified accepted project folder.');
  if (documents.length > 1 || (!documents.length && !receipt)) throw ambiguous();
  const candidates = documents.length ? documents : stores;
  const matches = [];
  for (const store of candidates) {
    if (!stores.includes(store)) throw ambiguous();
    if (receipt) {
      const history = await openHistory(join(home,store)).catch(() => { throw ambiguous(); });
      const records = await history.log();
      if (records[receipt.rev - 1]?.oid !== receipt.oid) continue;
    }
    matches.push(store);
    if (matches.length > 1) throw ambiguous();
  }
  if (matches.length !== 1) throw ambiguous();
  return {id, store:matches[0], receiptRev:receipt?.rev};
}

async function excludeIgnored(tree, rulesTree) {
  await withIgnoreRules(async rules => {
    for (const [name, entry] of Object.entries(rulesTree)) if (isIgnoreFile(name)) await rules.add(name, entry);
    for (const name of await rules.check(Object.keys(tree))) delete tree[name];
  });
}

async function mergeOriginal(head, old, current, hashes, excluded) {
  const result = new Map(Object.entries(head));
  for (const key of Object.keys(old)) if (!Object.hasOwn(current, key)) result.delete(key);
  for (const [name, entry] of Object.entries(current)) {
    if (Object.hasOwn(old, name) && old[name] === hashes[name]) continue;
    for (const key of result.keys()) {
      if (key.startsWith(name + '/') || name.startsWith(key + '/')) result.delete(key);
    }
    result.set(name, entry);
  }
  for (const name of result.keys()) {
    if (name.split('/').some((_, i, parts) => excluded.has(parts.slice(0,i+1).join('/')))) result.delete(name);
  }
  const tree = Object.fromEntries(result);
  await excludeIgnored(tree, current);
  await excludeIgnored(tree, tree);
  return tree;
}

// Store private project history independently from each room’s credentials and drawing database.
export async function prepareProject(home, source, priorId, onExclude) {
  if (priorId !== undefined && (typeof priorId !== 'string' || !uuid.test(priorId))) throw Error('Enter a valid previous room ID.');
  const key = await projectKey(source);
  const excluded = new Set();
  const current = await scanTree(source, {onExclude(name,reason){ excluded.add(name); onExclude?.(name,reason); }});
  const hashes = fingerprints(current);
  const dbPath = join(home, 'project-continuity.sqlite');
  const db = new DatabaseSync(dbPath);
  let latest, previous, head, history, lineage;
  try {
    db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS projects (key TEXT PRIMARY KEY, id TEXT); CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, key TEXT, store TEXT, hashes TEXT)');
    db.exec('CREATE TABLE IF NOT EXISTS lineages (id TEXT PRIMARY KEY, store TEXT, floor INTEGER, sealedRev INTEGER, startRev INTEGER, startOid TEXT)');
    latest = db.prepare('SELECT id FROM projects WHERE key=?').get(key)?.id;
    if (priorId || latest) previous = db.prepare('SELECT * FROM rooms WHERE id=?').get(priorId || latest);
    if (previous) lineage = db.prepare('SELECT * FROM lineages WHERE id=?').get(previous.id);
  } finally { db.close(); }
  if (previous && previous.key !== key) throw Error('The previous room belongs to another project folder.');
  if (!previous && priorId) previous = await legacyRoom(home, priorId);
  let tree = current;
  if (previous) {
    history = await openHistory(join(home, lineage?.store ?? previous.store));
    if (lineage && (await history.log())[lineage.startRev-1]?.oid !== lineage.startOid) {
      throw Error('Saved project history does not match its recorded revision. Restore its private project backup.');
    }
    head = await history.head(lineage?.sealedRev ?? undefined);
    let original = hashes;
    if (previous.hashes) {
      original = JSON.parse(previous.hashes);
    } else {
      let verified = isDeepStrictEqual(head.tree,current);
      for (const rev of new Set([1, previous.receiptRev])) {
        if (!verified && rev && rev !== head.rev) verified = isDeepStrictEqual((await history.head(rev)).tree,current);
      }
      if (!verified) throw Error('This folder does not match the older room. Choose its unchanged original folder or a verified accepted project copy.');
    }
    tree = await mergeOriginal(head.tree, original, current, hashes, excluded);
  }
  let store, start, unpublishedStore, floor=lineage?.floor ?? 1;
  const originalRules = Object.fromEntries(Object.entries(current).filter(([name])=>isIgnoreFile(name)));
  return {tree, excluded, originalRules, async history(author) {
      // The SQLite pointer publishes a complete store only after the listener and
      // document recovery succeed. Changed source must never advance the old store.
      const reuse = lineage && previous.id === latest && isDeepStrictEqual(head.tree,tree);
      store = reuse ? lineage.store : 'project-' + randomUUID();
      const target = join(home, store);
      if (!previous) {
        history = await createHistory(target, tree, author);
        unpublishedStore = target;
        start = await history.head();
      }
      else {
        if (!reuse) {
          history = await forkHistory(join(home,lineage?.store ?? previous.store),target,head);
          unpublishedStore = target;
        }
        const records = (await history.log()).filter(r=>r.rev>=floor);
        if (floor>1) records[0]={paths:Object.keys((await history.head(floor)).tree),supersededPaths:[]};
        const paths = new Set(records.flatMap(r=>[...r.paths, ...r.supersededPaths]));
        const visible = Object.fromEntries([...paths].map(p=>[p,true]));
        await excludeIgnored(visible,current);
        await excludeIgnored(visible,tree);
        const narrowed = [...paths].some(name=> !Object.hasOwn(visible,name) ||
          name.split('/').some((_,i,parts)=>excluded.has(parts.slice(0,i+1).join('/'))));
        start = await history.acceptSource(head,tree,author);
        if (narrowed) floor=start.rev;
      }
      return history;
    }, async discard(){
      if (unpublishedStore) await rm(unpublishedStore,{recursive:true,force:true});
    }, get floor(){return floor;}, documents: previous && join(home, previous.store + '.documents', previous.id + '.sqlite'),
    publish(id, storage) {
      const db = new DatabaseSync(dbPath);
      try {
        db.exec('PRAGMA busy_timeout=3000; BEGIN IMMEDIATE');
        if (db.prepare('SELECT id FROM projects WHERE key=?').get(key)?.id !== latest) {
          throw Error('Another room just opened for this project. Retry to use its accepted edits.');
        }
        if (lineage && previous.id === latest) db.prepare('UPDATE lineages SET sealedRev=? WHERE id=?').run(head.rev,previous.id);
        db.prepare('INSERT INTO lineages VALUES(?,?,?,NULL,?,?)').run(id,store,floor,start.rev,start.oid);
        db.prepare('INSERT INTO rooms VALUES(?,?,?,?)').run(id,key,basename(storage),JSON.stringify(hashes));
        db.prepare('INSERT OR REPLACE INTO projects VALUES(?,?)').run(key,id);
        db.exec('COMMIT');
        unpublishedStore = undefined;
      } finally { db.close(); }
    }};
}
