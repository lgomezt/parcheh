import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { homedir, networkInterfaces } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkSourceRoot } from './project-tree.mjs';
import { draftFiles } from './desktop-draft.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const token = /^[A-Za-z0-9_-]{16,256}$/;
const isTree = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

async function existingDirectory(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(label + ' must be an absolute directory path.');
  const canonical = await realpath(path).catch(() => null);
  if (!canonical || !(await lstat(canonical)).isDirectory()) throw new Error(label + ' must be an existing directory.');
  return canonical;
}

async function authorizedDirectory(root, input, label) {
  const path = await existingDirectory(input, label);
  if (!inside(root, path)) throw new Error(label + ' must be inside the authorized workspace ' + root + '.');
  return path;
}

function reachableUrl(input, allowLanHttp) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Enter a complete parcheh URL.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const ip = isIP(hostname);
  const loopback = hostname === 'localhost' || hostname === '::1' || (ip === 4 && hostname.startsWith('127.'));
  const lan = (ip === 4 && /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(hostname)) ||
    (ip === 6 && /^f[cd]/.test(hostname));
  if (url.username || url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || (allowLanHttp && lan))))) {
    throw new Error('parcheh requires HTTPS outside loopback unless private-LAN HTTP is explicitly enabled.');
  }
  return url;
}

function parseInvite(input, allowLanHttp) {
  const url = reachableUrl(input, allowLanHttp);
  const [, prefix, room] = url.pathname.split('/');
  const secret = url.hash.slice(1);
  if (prefix !== 'r' || !uuid.test(room) || url.pathname !== '/r/' + room || url.search || !token.test(secret)) {
    throw new Error('The parcheh invitation must include its room ID and secret fragment.');
  }
  return { room, origin: url.origin, inviteSecret: secret };
}

async function rpc(origin, room, endpoint, memberToken, body) {
  const headers = { accept: 'application/json' };
  if (memberToken) headers.authorization = 'Bearer ' + memberToken;
  if (body) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetch(new URL('/api/rooms/' + room + '/' + endpoint, origin), {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(endpoint === 'editing' ? 1500 : 15_000),
    });
  } catch {
    throw new Error('Could not reach the parcheh host. Check that the host and its connection are still open.');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error('The parcheh host rejected ' + endpoint + ' (HTTP ' + response.status + ').');
  }
  return response.json().catch(() => {
    throw new Error('The parcheh host returned an unreadable ' + endpoint + ' response.');
  });
}

async function readJson(path) {
  let data;
  try {
    data = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(data);
  } catch {
    throw new Error('Could not read the private parcheh state.');
  }
}

async function writeJson(path, data) {
  const staged = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(staged, JSON.stringify(data), { flag: 'wx', mode: 0o600, flush: true });
    await rename(staged, path);
  } finally {
    await rm(staged, { force: true }).catch(() => {});
  }
}

function revision(result) {
  if (!result || !Number.isSafeInteger(result.rev) || result.rev < 1 || typeof result.oid !== 'string' || !result.oid) {
    throw new Error('The parcheh host returned an invalid revision.');
  }
  return { rev: result.rev, oid: result.oid };
}

function binding(room, origin, result, allowLanHttp, browserOrigin = origin) {
  if (result.roomId !== room || !token.test(result.memberToken) || typeof result.browserUrl !== 'string') {
    throw new Error('The parcheh host returned an invalid room membership.');
  }
  const browser = reachableUrl(result.browserUrl, allowLanHttp);
  if (browser.origin !== browserOrigin || browser.pathname !== '/view/' + room || browser.search || !token.test(browser.hash.slice(1)) || browser.hash.slice(1) === result.memberToken) {
    throw new Error('The parcheh host returned an invalid browser link.');
  }
  return { room, origin, memberToken: result.memberToken, browserUrl: browser.href };
}

function workspaceInfo(state) {
  return { room: state.room, workspace: state.accepted.path, workspaceRev: state.accepted.rev, ...revision(state.accepted) };
}

function browserView(state, hasWebEntry = state.accepted?.hasWebEntry) {
  if (state.closed) return { browserMode: 'closed', browserUrl: null };
  if (state.localAppUrl) {
    const url = new URL(state.browserUrl);
    url.hash += '&app=' + encodeURIComponent(state.localAppUrl);
    return { browserMode: 'development-server', browserUrl: url.href };
  }
  if (hasWebEntry) return { browserMode: 'project', browserUrl: state.browserUrl };
  return { browserMode: 'source-only', browserUrl: null };
}

function localAppAddress(value) {
  if (value === 'project') return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.hash) {
    throw new Error('Choose the local development server at localhost or 127.0.0.1.');
  }
  return url.href;
}

function desktopAddress() {
  const entries = Object.entries(networkInterfaces()).sort(([a],[b]) => Number(b === 'en0') - Number(a === 'en0'));
  for (const [, addresses] of entries) {
    const lan = addresses?.find(a => !a.internal && a.family === 'IPv4' && /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(a.address));
    if (lan) return lan.address;
  }
}

async function chooseMacProject() {
  if (process.platform !== 'darwin') throw Error('Select a project using a coding app that supplies workspace access.');
  try {
    const {stdout} = await promisify(execFile)('/usr/bin/osascript', [
      '-e', 'POSIX path of (choose folder with prompt "Choose the project to share in parcheh")'
    ], {timeout:120_000});
    return stdout.replace(/\r?\n$/, '');
  } catch { throw Error('Project selection was cancelled or unavailable.'); }
}

export async function openClient(env = process.env, { getRoots = async () => [], pickProject = chooseMacProject, openPreviewUrl = url => promisify(execFile)('/usr/bin/open',[url],{timeout:5000}) } = {}) {
  const desktop = env.PARCHEH_DESKTOP === '1';
  const { PARCHEH_WORKSPACE_ROOT: workspaceRoot } = env;
  const root = workspaceRoot || !desktop ? await existingDirectory(workspaceRoot, 'PARCHEH_WORKSPACE_ROOT') : null;
  const privatePath = resolve(env.PARCHEH_HOME || join(homedir(), '.parcheh'));
  if (root && inside(privatePath, root)) throw new Error('The authorized workspace must be outside PARCHEH_HOME.');
  await mkdir(privatePath, { recursive: true, mode: 0o700 });
  const stat = await lstat(privatePath);
  if (!stat.isDirectory() || stat.mode & 0o077 || stat.uid !== process.getuid()) {
    throw new Error('PARCHEH_HOME must be a directory private to your user account.');
  }
  const home = await realpath(privatePath);
  if (root && inside(home, root)) throw new Error('The authorized workspace must be outside PARCHEH_HOME.');
  const lock = desktop ? null : new DatabaseSync(join(home, 'client-lock.sqlite'));
  let managed;
  if (desktop) {
    const dir = env.PARCHEH_DESKTOP_WORKSPACES || join(home, 'workspaces');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.mode & 0o077 || info.uid !== process.getuid()) throw Error('The managed room workspace must be private to your account.');
    managed = await realpath(dir);
  }
  async function sourceRoots() {
    if (root) return [root];
    const paths = [...await getRoots(), env.CLAUDE_PROJECT_DIR].filter(Boolean);
    const roots = [];
    for (const path of paths) {
      try {
        const candidate = await existingDirectory(path, 'Project');
        checkSourceRoot(candidate);
        if (!inside(candidate, home) && !inside(home, candidate)) roots.push(candidate);
      } catch { /* A personal home or system folder cannot authorize hosting. */ }
    }
    return [...new Set(roots)];
  }
  let pickedProject;
  async function chooseSource(input) {
    const roots = await sourceRoots();
    if (desktop && !roots.length && env.PARCHEH_DESKTOP_PICKER !== '0') {
      if (!pickedProject || (input && !inside(pickedProject, resolve(input)))) {
        const selected = await existingDirectory(await pickProject(), 'Selected project');
        checkSourceRoot(selected);
        if (inside(selected,home) || inside(home,selected)) throw Error('Choose a project outside private room storage.');
        pickedProject = selected;
      }
      roots.push(pickedProject);
    }
    const chosen = input ?? (roots.length === 1 ? roots[0] : null);
    if (!chosen) throw Error('Select the project folder in your coding app to host it. A guest can join from any chat.');
    const selected = await existingDirectory(chosen, 'Source');
    if (!roots.some(base => inside(base, selected))) throw Error('Source must be inside the authorized workspace. Select the project folder in your coding app.');
    return selected;
  }
  try {
    lock?.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    lock?.close();
    if (error.errcode !== 5) throw error;
    throw new Error('Another parcheh process is using the same PARCHEH_HOME.');
  }
  const allowLanHttp = env.PARCHEH_ALLOW_LAN_HTTP === '1';
  const statePath = (room) => join(home, 'room-' + room + '.json');
  const turnPath = (state, kind) => join(home, 'turn-' + state.turn.id + '-' + kind + '.json');
  const save = (state) => writeJson(statePath(state.room), state);

  async function load(room) {
    if (!uuid.test(room)) throw new Error('Enter a parcheh room ID.');
    const state = await readJson(statePath(room));
    if (!state) throw new Error('This parcheh process has no local binding for that room.');
    await checkSavedDirectory(state.folder, 'Room folder');
    reachableUrl(state.origin, allowLanHttp);
    return state;
  }

  async function checkSavedDirectory(path, label) {
    if (path !== await existingDirectory(path, label) || ![managed,root].some(base => base && inside(base,path))) {
      throw new Error(label + ' has moved. Restore the original folder to continue.');
    }
  }

  async function chooseWorkspace(input) {
    if (desktop) return managed;
    const path = await authorizedDirectory(root, input ?? root, 'Workspace parent');
    if (inside(home, path)) throw new Error('The workspace parent must be outside PARCHEH_HOME.');
    return path;
  }

  async function createCopy(folder, prefix, tree) {
    await checkSavedDirectory(folder, 'Workspace folder');
    const stage = await mkdtemp(join(folder, prefix));
    const path = join(stage, 'source');
    const { materialize } = await import('./project.mjs');
    await materialize(path, tree);
    return path;
  }

  async function snapshot(state) {
    const remote = await rpc(state.origin, state.room, 'snapshot', state.memberToken);
    revision(remote);
    if (!isTree(remote.tree)) {
      throw new Error('The parcheh host returned an invalid project tree.');
    }
    return remote;
  }

  async function refresh(state, remote) {
    const current = revision(remote);
    if (state.accepted?.rev === current.rev && state.accepted.oid === current.oid && typeof state.accepted.hasWebEntry === 'boolean') {
      if (await realpath(state.accepted.path).catch(() => null) === state.accepted.path &&
          (await lstat(state.accepted.path)).isDirectory()) return;
    }
    if (state.accepted && current.rev < state.accepted.rev) throw new Error('The parcheh host returned an older revision.');
    const path = await createCopy(state.folder, 'rev-' + current.rev + '-', remote.tree);
    state.accepted = { ...current, path, hasWebEntry: Object.hasOwn(remote.tree, 'index.html') };
    await save(state);
  }

  async function install(state) {
    if (!state.scope) {
      const { tree } = await rpc(state.origin, state.room, 'scope', state.memberToken);
      if (!isTree(tree)) throw new Error('The parcheh host returned invalid project scope rules.');
      state.scope = tree;
    }
    await refresh(state, await snapshot(state));
    return { ...workspaceInfo(state), ...browserView(state) };
  }

  async function preview_scope({ source }) {
    const selected = await chooseSource(source);
    if (inside(selected, home) || inside(home, selected)) throw new Error('The source must exclude PARCHEH_HOME.');
    const {scanTree} = await import('./project.mjs');
    const excluded = {};
    const files = await scanTree(selected, { onExclude(_path, reason) {
      excluded[reason] = (excluded[reason] || 0) + 1;
    }});
    const names = Object.keys(files).sort();
    return {fileCount:names.length, bytes:Object.values(files).reduce((n,f)=>n+Buffer.byteLength(f.data,'base64'),0), paths:names, excluded};
  }

  async function readyView(state, local, {pointers,actions,openPreview}, progress) {
    if (pointers !== undefined || actions !== undefined) {
      const result = await configure_browser({room:state.room,pointers,actions});
      local.sharing = result.sharing;
    }
    if (desktop && process.platform === 'darwin' && env.PARCHEH_OPEN_BROWSER !== '0' && openPreview !== false &&
        local.browserUrl && (!state.openedPreview || openPreview === true)) {
      try {
        await openPreviewUrl(local.browserUrl);
        state.openedPreview = true;
        await save(state);
      } catch { /* The personal link remains available if the desktop denies opening it. */ }
    }
    progress(100,'Ready');
    return local;
  }

  async function start_room({ source, workspaceParent, displayName = 'Host', pointers, actions, openPreview }, progress = () => {}) {
    const selected = await chooseSource(source);
    if (inside(selected, home) || inside(home, selected)) throw new Error('The source must exclude PARCHEH_HOME.');
    const parent = await chooseWorkspace(workspaceParent);
    const lan = desktop && allowLanHttp && !env.PARCHEH_BIND ? desktopAddress() : null;
    const bind = env.PARCHEH_BIND || lan || '127.0.0.1';
    progress(15, 'Project selected');
    const port = Number(env.PARCHEH_PORT || 0);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PARCHEH_PORT must be a port number.');
    let publicOrigin = lan ? 'http://' + lan + ':0' : undefined;
    if (env.PARCHEH_PUBLIC_ORIGIN) {
      const url = reachableUrl(env.PARCHEH_PUBLIC_ORIGIN, allowLanHttp);
      if (url.pathname !== '/' || url.search || url.hash) throw new Error('PARCHEH_PUBLIC_ORIGIN must contain only the origin.');
      publicOrigin = url.origin;
    }
    if (!publicOrigin && !['127.0.0.1', '::1', 'localhost'].includes(bind)) {
      throw new Error('Set PARCHEH_PUBLIC_ORIGIN to the address that guests can reach.');
    }
    const { launchHost: startHost } = await import('./room-process.mjs');
    const host = await startHost({
      source: selected, displayName, storage: join(home, 'host-' + randomUUID()), bind, port, publicOrigin,
      releaseDirectory: env.PARCHEH_RELEASE_DIR || fileURLToPath(new URL('../dist/desktop/', import.meta.url)),
    });
    try {
      parseInvite(host.inviteUrl, allowLanHttp);
      const origin = reachableUrl(host.localBaseUrl ?? host.baseUrl, allowLanHttp).origin;
      const state = { ...binding(host.roomId, origin, host, allowLanHttp, host.baseUrl), host: true };
      state.folder = await mkdtemp(join(parent, '.parcheh-room-' + state.room + '-'));
      progress(60, 'Room created');
      const local = await install(state);
      return { ...await readyView(state,local,{pointers,actions,openPreview},progress), inviteUrl: host.inviteUrl };
    } catch (error) {
      await host.close().catch(() => {});
      throw error;
    }
  }

  async function join_room({ inviteUrl, workspaceParent, displayName = 'Guest-' + randomUUID().slice(0, 6), pointers, actions, openPreview }, progress = () => {}) {
    const { room, origin, inviteSecret } = parseInvite(inviteUrl, allowLanHttp);
    const parent = await chooseWorkspace(workspaceParent);
    progress(15, 'Invite checked');
    const existing = await readJson(statePath(room));
    if (existing) {
      const state = await load(room);
      if (state.origin !== origin || await realpath(join(state.folder, '..')) !== parent) {
        throw new Error('That room is already bound to a different host or workspace on this device.');
      }
      const result = !state.turn ? await install(state) : { ...workspaceInfo(state), ...browserView(state) };
      return readyView(state,result,{pointers,actions,openPreview},progress);
    }
    const pendingPath = join(home, 'join-' + room + '.json');
    const fingerprint = createHash('sha256').update(inviteUrl).digest('hex');
    let pending = await readJson(pendingPath);
    if (!pending || pending.fingerprint !== fingerprint) {
      pending = { fingerprint, displayName, requestId:randomUUID() };
      await writeJson(pendingPath, pending);
    }
    const folder = await mkdtemp(join(parent, '.parcheh-room-' + room + '-'));
    async function admit() {
      // v1 hosts do not understand requestId. Only retry an ambiguous delivery on v2.
      const request = { inviteSecret, displayName:pending.displayName, requestId:pending.requestId };
      try { return await rpc(origin, room, 'join', undefined, request); }
      catch (error) {
        if (error.message.includes('(HTTP 400)')) return rpc(origin, room, 'join', undefined, { inviteSecret, displayName });
        if (error.message.startsWith('Could not reach')) return rpc(origin, room, 'join', undefined, request);
        throw error;
      }
    }
    const member = await admit().catch(async (error) => {
      await rmdir(folder).catch(() => {});
      if (error.message.includes('(HTTP 4')) await rm(pendingPath,{force:true});
      throw error;
    });
    const state = { ...binding(room, origin, member, allowLanHttp), folder };
    await save(state);
    await rm(pendingPath, {force:true});
    progress(55, 'Joined');
    const result = await install(state);
    return readyView(state,result,{pointers,actions,openPreview},progress);
  }

  const editingTimers = new Map();
  async function signalEditing(state, active) {
    const { room, origin, memberToken, turn } = state;
    if (!turn) return;
    clearInterval(editingTimers.get(room)?.timer);
    editingTimers.delete(room);
    const send = (active) => rpc(origin, room, 'editing', memberToken, { active, turn: turn.id }).catch(() => {});
    if (active) {
      const timer = setInterval(() => send(true), 60_000);
      timer.unref();
      editingTimers.set(room, { timer, stop: () => send(false) });
    }
    await send(active);
  }

  async function begin_turn({ room }) {
    const state = await load(room);
    if (state.closed) throw new Error('This parcheh room is closed.');
    if (!state.accepted) await install(state);
    if (!state.turn) {
      const latest = await snapshot(state);
      await refresh(state, latest);
      const id = randomUUID();
      const path = await createCopy(state.folder, 'turn-' + id + '-', latest.tree);
      state.turn = { id, path, baseRev: latest.rev, baseOid: latest.oid };
      await writeJson(turnPath(state, 'base'), latest.tree);
      await save(state);
    }
    await checkSavedDirectory(state.turn.path, 'Draft workspace');
    const { id: turn, path: workspace, baseRev, baseOid } = state.turn;
    const submission = await readJson(turnPath(state, 'submission'));
    if (submission) throw new Error('This turn is sealed. Retry finish_turn before starting another edit.');
    await signalEditing(state, true);
    return { room, turn, workspace, baseRev, baseOid };
  }

  async function finish_turn({ room }) {
    const state = await load(room);
    if (state.closed) throw new Error('This parcheh room is closed.');
    if (!state.turn && !state.lastReceipt) throw new Error('Start a turn before finishing it.');
    if (state.turn) {
      const submissionPath = turnPath(state, 'submission');
      const basePath = turnPath(state, 'base');
      const { id, baseRev } = state.turn;
      let body = await readJson(submissionPath);
      if (!body) {
        await checkSavedDirectory(state.turn.path, 'Draft workspace');
        const baseline = await readJson(basePath);
        if (!baseline) throw new Error('This turn is missing its saved baseline.');
        const { scanTree, diffTrees } = await import('./project.mjs');
        const excluded = new Set();
        const edited = await scanTree(state.turn.path, {
          baseline: state.scope, respectDraftIgnores: true,
          onExclude(path, reason) { if (reason === 'draft gitignore') excluded.add(path); },
        });
        const changes = await diffTrees(baseline, edited);
        // Marking an existing file private protects its draft contents and preserves its public revision.
        for (const path of Object.keys(changes)) {
          const parts = path.split('/');
          while (parts.length) {
            if (excluded.has(parts.join('/'))) { delete changes[path]; break; }
            parts.pop();
          }
        }
        if (Object.keys(changes).length) {
          body = { id, baseRev, changes };
          await writeJson(submissionPath, body);
        }
      }
      let receipt = { outcome: 'no_change', rev: state.accepted.rev, oid: state.accepted.oid };
      await signalEditing(state, false);
      if (body) {
        try {
          const result = await rpc(state.origin, room, 'submit', state.memberToken, body);
          receipt = {
            outcome: 'accepted', submissionId: id, ...revision(result), supersededPaths: result.supersededPaths,
          };
        } catch (error) {
          return { room, outcome: 'pending', submissionId: id, workspace: state.turn.path, message: error.message };
        }
      }
      state.lastReceipt = receipt;
      delete state.turn;
      await save(state);
      await Promise.allSettled([rm(basePath, { force: true }), rm(submissionPath, { force: true })]);
    }
    let refreshError;
    try {
      await refresh(state, await snapshot(state));
    } catch (error) {
      refreshError = error.message;
    }
    return { ...workspaceInfo(state), ...state.lastReceipt, ...browserView(state), ...(refreshError && { refreshError }) };
  }

  async function room_status({ room }) {
    const state = await load(room);
    if (!state.accepted) await install(state);
    const remote = state.closed ? null : await rpc(state.origin, room, 'status', state.memberToken).catch(() => null);
    if (remote && !state.turn) {
      const pathMissing = await realpath(state.accepted.path).catch(() => null) !== state.accepted.path;
      if (remote.rev !== state.accepted.rev || remote.oid !== state.accepted.oid || typeof state.accepted.hasWebEntry !== 'boolean' || pathMissing) {
        await refresh(state, await snapshot(state));
      }
    }
    const result = {
      ...workspaceInfo(state),
      ...browserView(state, remote?.previewAvailable),
      connected: Boolean(remote),
      ...(state.closed && { closed: true }),
    };
    if (remote) {
      const { members, sharing } = remote;
      Object.assign(result, {
        ...(state.turn && revision(remote)),
        sharing,
        members: members.map(({ id, name }) => ({ id, name })),
      });
    }
    if (state.turn) {
      result.draftWorkspace = state.turn.path;
      const submission = await readJson(turnPath(state, 'submission'));
      result.turnState = submission ? 'sealed' : 'editing';
    }
    return result;
  }

  async function configure_browser({ room, pointers, actions, appUrl }) {
    const state = await load(room);
    if (state.closed) throw new Error('This room is closed.');
    if (pointers === undefined && actions === undefined && appUrl === undefined) {
      throw new Error('Choose a pointer, action or local preview setting.');
    }
    const local = appUrl === undefined ? state.localAppUrl : localAppAddress(appUrl);
    if (local && new URL(local).origin === new URL(state.browserUrl).origin) {
      throw new Error('Use a development server on a different origin from the room.');
    }
    const status = await rpc(state.origin, room, 'status', state.memberToken);
    let sharing = status.sharing;
    if (!sharing || typeof sharing.pointers !== 'boolean' || typeof sharing.actions !== 'boolean') {
      throw new Error('This room uses an older host. Start a room with the current prototype to configure browser sharing.');
    }
    if (pointers !== undefined || actions !== undefined) {
      const result = await rpc(state.origin, room, 'sharing', state.memberToken, {
        pointers: pointers ?? sharing.pointers,
        actions: actions ?? sharing.actions,
      });
      sharing = result.sharing;
    }
    if (appUrl !== undefined) {
      state.localAppUrl = local;
      await save(state);
    }
    return { room, sharing, ...browserView(state, status.previewAvailable) };
  }

  async function room_history({ room }) {
    const state = await load(room);
    const { entries } = await rpc(state.origin, room, 'history', state.memberToken);
    return {
      room,
      entries: entries.map(({ rev, oid, actor, id, baseRev, paths, supersededPaths }) =>
        ({ rev, oid, actor, id, baseRev, paths, supersededPaths })),
    };
  }

  async function end_room({ room }) {
    const state = await load(room);
    if (!state.host) throw new Error('Only the host can end this parcheh room.');
    if (!state.closed) {
      await rpc(state.origin, room, 'close', state.memberToken, {});
      state.closed = true;
      await save(state);
    }
    return { ...workspaceInfo(state), outcome: 'closed', ...(state.turn && { draftWorkspace: state.turn.path }) };
  }

  async function accessDraft(operation, args) {
    const state = await load(args.room);
    if (state.closed || !state.turn || await readJson(turnPath(state, 'submission'))) throw Error('Open a draft with begin_turn before editing.');
    await checkSavedDirectory(state.turn.path, 'Draft workspace');
    return draftFiles(state.turn.path, state.scope, operation, args);
  }

  const draftLocks = new Map();
  function releaseDraft(room) {
    draftLocks.get(room)?.close();
    draftLocks.delete(room);
  }
  async function close() {
    lock?.close();
    for (const room of draftLocks.keys()) releaseDraft(room);
    const pending = [];
    for (const {timer, stop} of editingTimers.values()) { clearInterval(timer); pending.push(stop()); }
    editingTimers.clear();
    await Promise.allSettled(pending);
  }

  const api = { preview_scope, start_room, join_room, begin_turn, finish_turn, room_status, configure_browser, room_history, end_room,
    list_draft: a => accessDraft('list',a), read_draft_file: a => accessDraft('read',a),
    write_draft_file: a => accessDraft('write',a), delete_draft_file: a => accessDraft('delete',a) };
  if (desktop) {
    for (const [name, method] of Object.entries(api)) {
      api[name] = async (args, ...rest) => {
        const room = name === 'join_room' ? parseInvite(args.inviteUrl, allowLanHttp).room : args.room;
        if (!room || !uuid.test(room)) return method(args, ...rest);
        const busy = new DatabaseSync(join(home, 'access-' + room + '.sqlite'));
        const drafting = ['begin_turn','finish_turn','list_draft','read_draft_file','write_draft_file','delete_draft_file'].includes(name);
        let acquired = false;
        try {
          try { busy.exec('BEGIN EXCLUSIVE'); }
          catch (e) { if (e.errcode === 5) throw Error('Another chat is updating this room. Retry this step.'); throw e; }
          if (drafting && !draftLocks.has(room)) {
            const edit = new DatabaseSync(join(home,'edit-' + room + '.sqlite'));
            try { edit.exec('BEGIN EXCLUSIVE'); }
            catch (error) {
              edit.close();
              if (error.errcode === 5) throw Error('Another chat on this Mac has the open draft. Finish the edit in that chat.');
              throw error;
            }
            draftLocks.set(room,edit); acquired = true;
          }
          const result = await method(args, ...rest);
          if (name === 'finish_turn' || name === 'end_room' || (acquired && name !== 'begin_turn')) releaseDraft(room);
          return result;
        } catch (error) {
          if (acquired) releaseDraft(room);
          throw error;
        } finally { busy.close(); }
      };
    }
  }
  return { ...api, close };
}
