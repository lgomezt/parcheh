import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { homedir, networkInterfaces, userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadOrCreateDeviceIdentity, saveDeviceCertificate, loadDeviceCertificates } from './device-identity.mjs';
import { checkSourceRoot } from './project-tree.mjs';
import { draftFiles } from './desktop-draft.mjs';
import { invalidDisplayName, normalizeDisplayName } from './display-name.mjs';
import { encryptTabHandoff } from './relay-crypto.mjs';
import { startLocalPreviewServer } from './local-preview.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const token = /^[A-Za-z0-9_-]{16,256}$/;
const isTree = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

function localDisplayName() {
  let username;
  try { username = userInfo().username; }
  catch { return 'Participant'; }
  if (/^(?:root|nobody|daemon|system|service|runner|administrator)$/i.test(username)) return 'Participant';
  return /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,39}$/u.test(username) ? username : 'Participant';
}

function entryDisplayName(value) {
  if (value === undefined) return localDisplayName();
  const name = normalizeDisplayName(value);
  if (!name) throw new Error(invalidDisplayName);
  return name;
}

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
  const hashParts = url.hash.slice(1).split('&');
  const secret = hashParts[0];
  const params = hashParts.slice(1);
  let handoff;
  let claim;
  let email;
  const seenKeys = new Set();
  for (const part of params) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) throw new Error('Invalid invitation tab handoff.');
    const key = part.slice(0, eqIdx);
    const value = part.slice(eqIdx + 1);
    if (seenKeys.has(key)) throw new Error('Invalid invitation tab handoff.');
    seenKeys.add(key);
    if (key === 'handoff') {
      if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid invitation tab handoff.');
      handoff = value;
    } else if (key === 'claim') {
      if (!/^[A-Za-z0-9._-]{16,2048}$/.test(value)) throw new Error('Invalid invitation tab handoff.');
      claim = value;
    } else if (key === 'email') {
      try {
        email = decodeURIComponent(value);
      } catch {
        throw new Error('Invalid invitation tab handoff.');
      }
      if (!email || !email.includes('@')) throw new Error('Invalid invitation tab handoff.');
    } else {
      throw new Error('Invalid invitation tab handoff.');
    }
  }
  if (prefix !== 'r' || !uuid.test(room) || url.pathname !== '/r/' + room || url.search || !token.test(secret)) {
    throw new Error('The parcheh invitation must include its room ID and secret fragment.');
  }
  return { room, origin: url.origin, inviteSecret: secret, handoff, claim, email };
}

const guestRelaysByToken = new Map();
const guestRelaysByRoom = new Map();
const activePreviewServers = new Map();

async function isRelayOrigin(origin) {
  try {
    const res = await fetch(origin + '/healthz', { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const json = await res.json().catch(() => null);
      if (json?.service === 'parcheh-relay') return true;
    }
  } catch {}
  return false;
}

async function rpc(origin, room, endpoint, memberToken, body) {
  if (memberToken && guestRelaysByToken.has(memberToken)) {
    return guestRelaysByToken.get(memberToken).rpc(endpoint, memberToken, body);
  }
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
    let errMessage = null;
    try {
      const errJson = await response.json();
      if (errJson?.error) errMessage = errJson.error;
    } catch {}
    await response.body?.cancel().catch(() => {});
    const baseMsg = errMessage ? `${errMessage} (HTTP ${response.status}).` : 'The parcheh host rejected ' + endpoint + ' (HTTP ' + response.status + ').';
    throw new Error(baseMsg);
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

function binding(room, origin, result, allowLanHttp, browserOrigin = origin, transport = 'direct') {
  if (result.roomId !== room || !token.test(result.memberToken) || typeof result.browserUrl !== 'string') {
    throw new Error('The parcheh host returned an invalid room membership.');
  }
  const browser = reachableUrl(result.browserUrl, allowLanHttp);
  const allowedOrigin = transport === 'relay'
    ? (['127.0.0.1', 'localhost'].includes(browser.hostname))
    : browser.origin === browserOrigin;
  if (!allowedOrigin || browser.pathname !== '/view/' + room || browser.search || !token.test(browser.hash.slice(1)) || browser.hash.slice(1) === result.memberToken) {
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
  const deviceIdentity = await loadOrCreateDeviceIdentity(home, { useKeychain: env.PARCHEH_KEYCHAIN === '1' });
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
  const liveTreePath = (state) => join(home, 'room-' + state.room + '-live.json');
  const save = (state) => writeJson(statePath(state.room), state);

  async function getGuestRelay(state) {
    const key = `${home}:${state.room}`;
    let gr = guestRelaysByRoom.get(key);
    if (!gr) {
      const { connectGuestRelay } = await import('./relay-transport.mjs');
      const identity = await loadOrCreateDeviceIdentity(home);
      gr = await connectGuestRelay({
        relayOrigin: state.origin,
        roomId: state.room,
        inviteSecret: state.inviteSecret,
        rejoinMemberId: state.memberId,
        reconnectSecret: state.reconnectSecret,
        deviceIdentity: identity,
        onRevisionBroadcast: async (revMsg) => {
          try {
            if (!state.folder) return;
            const gitDir = join(state.folder, 'git');
            const { importQuarantinedPack } = await import('./git-pack.mjs');
            const packBuf = Buffer.from(revMsg.packB64, 'base64');
            const tree = await importQuarantinedPack(gitDir, packBuf, revMsg.oid);
            await refresh(state, { rev: revMsg.rev, oid: revMsg.oid, tree });
          } catch {}
        },
      });
      const currentGr = gr;
      gr.onClose(() => {
        if (guestRelaysByRoom.get(key) === currentGr) guestRelaysByRoom.delete(key);
        if (state.memberToken && guestRelaysByToken.get(state.memberToken) === currentGr) {
          guestRelaysByToken.delete(state.memberToken);
        }
      });
      guestRelaysByRoom.set(key, gr);
      if (state.memberToken) {
        guestRelaysByToken.set(state.memberToken, gr);
      }
    }
    return gr;
  }

  async function load(room) {
    if (!uuid.test(room)) throw new Error('Enter a parcheh room ID.');
    const state = await readJson(statePath(room));
    if (!state) throw new Error('This parcheh process has no local binding for that room.');
    await checkSavedDirectory(state.folder, 'Room folder');
    reachableUrl(state.origin, allowLanHttp);
    if (state.transport === 'relay' && !state.closed) {
      const gr = await getGuestRelay(state).catch(() => null);
      if (gr && state.hostBrowserToken && !activePreviewServers.has(`${home}:${state.room}`)) {
        const previewServer = await startLocalPreviewServer({
          roomId: state.room,
          hostBrowserToken: state.hostBrowserToken,
          getTree: () => readJson(liveTreePath(state)),
          getRev: () => state.accepted?.rev ?? 0,
          guestRelay: gr,
          localAppUrl: state.localAppUrl,
        });
        activePreviewServers.set(`${home}:${state.room}`, previewServer);
        state.browserUrl = previewServer.browserUrl;
      }
    }
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
    if (!process.env.PARCHEH_LEGACY_SNAPSHOT) {
      try {
        const haveOids = state.accepted?.oid ? [state.accepted.oid] : [];
        const packRes = await rpc(state.origin, state.room, 'pack', state.memberToken, { haveOids });
        if (packRes?.oid && packRes?.packBase64) {
          revision(packRes);
          const packBuf = Buffer.from(packRes.packBase64, 'base64');
          const gitDir = join(state.folder, 'git');
          const { importQuarantinedPack } = await import('./git-pack.mjs');
          const tree = await importQuarantinedPack(gitDir, packBuf, packRes.oid);
          return { rev: packRes.rev, oid: packRes.oid, tree };
        }
      } catch (err) {}
    }
    const remote = await rpc(state.origin, state.room, 'snapshot', state.memberToken);
    revision(remote);
    if (!isTree(remote.tree)) {
      throw new Error('The parcheh host returned an invalid project tree.');
    }
    return remote;
  }

  async function syncLiveDirectory(state, remoteTree) {
    const livePath = join(state.folder, 'live');
    const treePath = liveTreePath(state);
    const liveStat = await lstat(livePath).catch(() => null);
    const hasLegacyPath = state.accepted?.path && state.accepted.path !== livePath;

    if (!liveStat?.isDirectory() || hasLegacyPath) {
      await rm(livePath, { recursive: true, force: true }).catch(() => {});
      const { materialize } = await import('./project.mjs');
      await materialize(livePath, remoteTree);
      await writeJson(treePath, remoteTree);
      return livePath;
    }

    const previousTree = await readJson(treePath);
    if (!previousTree) {
      await rm(livePath, { recursive: true, force: true }).catch(() => {});
      const { materialize } = await import('./project.mjs');
      await materialize(livePath, remoteTree);
      await writeJson(treePath, remoteTree);
      return livePath;
    }

    const { entriesEqual } = await import('./project-tree.mjs');

    for (const [name, prevEntry] of Object.entries(previousTree)) {
      if (!Object.hasOwn(remoteTree, name) || !entriesEqual(prevEntry, remoteTree[name])) {
        const filePath = join(livePath, name);
        const stat = await lstat(filePath).catch(() => null);
        if (stat?.isFile()) {
          const diskBytes = await readFile(filePath);
          const diskExec = Boolean(stat.mode & 0o111);
          const prevBytes = Buffer.from(prevEntry.data, 'base64');
          if (!diskBytes.equals(prevBytes) || diskExec !== prevEntry.executable) {
            const preserved = join(state.folder, 'preserved-local', name);
            await mkdir(dirname(preserved), { recursive: true, mode: 0o700 });
            await writeFile(preserved, diskBytes, { mode: diskExec ? 0o700 : 0o600 });
          }
        }
      }
    }

    const remoteKeys = Object.keys(remoteTree);
    for (const name of Object.keys(previousTree)) {
      const isDeleted = !Object.hasOwn(remoteTree, name);
      const isDisplacedByDir = remoteKeys.some((k) => k.startsWith(name + '/'));
      const isDisplacedByFile = remoteKeys.some((k) => name.startsWith(k + '/'));
      if (isDeleted || isDisplacedByDir || isDisplacedByFile) {
        await rm(join(livePath, name), { force: true });
        let dir = dirname(join(livePath, name));
        while (dir !== livePath && inside(livePath, dir)) {
          try {
            await rmdir(dir);
            dir = dirname(dir);
          } catch {
            break;
          }
        }
      }
    }

    for (const [name, entry] of Object.entries(remoteTree)) {
      if (Object.hasOwn(previousTree, name) && entriesEqual(previousTree[name], entry)) {
        continue;
      }
      const target = join(livePath, name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const tempPath = join(dirname(target), '.parcheh-sync-' + randomUUID() + '.tmp');
      const mode = entry.executable ? 0o700 : 0o600;
      try {
        await writeFile(tempPath, Buffer.from(entry.data, 'base64'), { mode });
        await chmod(tempPath, mode);
        await rename(tempPath, target);
      } finally {
        await rm(tempPath, { force: true }).catch(() => {});
      }
    }

    await writeJson(treePath, remoteTree);
    return livePath;
  }

  async function refresh(state, remote) {
    const current = revision(remote);
    const livePath = join(state.folder, 'live');
    if (state.accepted?.rev === current.rev && state.accepted.oid === current.oid && state.accepted.path === livePath && typeof state.accepted.hasWebEntry === 'boolean') {
      if (await realpath(state.accepted.path).catch(() => null) === state.accepted.path &&
          (await lstat(state.accepted.path)).isDirectory()) return;
    }
    if (state.accepted && current.rev < state.accepted.rev) throw new Error('The parcheh host returned an older revision.');
    const path = await syncLiveDirectory(state, remote.tree);
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

  async function preview_scope({ source, continueFromRoom }) {
    const selected = await chooseSource(source);
    if (inside(selected, home) || inside(home, selected)) throw new Error('The source must exclude PARCHEH_HOME.');
    const {prepareProject} = await import('./project-continuity.mjs');
    const excluded = {};
    const {tree: files} = await prepareProject(home, selected, continueFromRoom, (_path, reason) => {
      excluded[reason] = (excluded[reason] || 0) + 1;
    });
    const names = Object.keys(files).sort();
    const { inspectTreeRisks } = await import('./project.mjs');
    const { secretWarnings, buildConfigPaths } = inspectTreeRisks(files);
    return {
      fileCount: names.length,
      bytes: Object.values(files).reduce((n, f) => n + Buffer.byteLength(f.data, 'base64'), 0),
      paths: names,
      excluded,
      ...(secretWarnings.length && { secretWarnings }),
      ...(buildConfigPaths.length && { buildConfigPaths }),
    };
  }

  async function browserSettings(state, { pointers, actions }, fresh = false) {
    const status = await rpc(state.origin, state.room, 'status', state.memberToken);
    const { sharing } = status;
    if (!sharing || typeof sharing.pointers !== 'boolean' || typeof sharing.actions !== 'boolean') {
      // The earliest hosts support code collaboration without configurable browser sharing.
      if (pointers === undefined && actions === undefined) return status;
      throw new Error('This host does not support browser sharing settings.');
    }
    const desired = {
      pointers: pointers ?? (fresh || sharing.pointers),
      actions: actions ?? (fresh || sharing.actions),
    };
    if (desired.pointers !== sharing.pointers || desired.actions !== sharing.actions) {
      status.sharing = (await rpc(state.origin, state.room, 'sharing', state.memberToken, desired)).sharing;
    }
    return status;
  }

  async function readyView(state, local, openPreview, progress) {
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

  async function start_room({ source, continueFromRoom, workspaceParent, displayName, pointers, actions, openPreview, allowGuestInvite, sharingMode, allowedEmails, allowedDomain }, progress = () => {}) {
    if (sharingMode !== undefined && !['instant', 'email', 'restricted'].includes(sharingMode)) {
      throw new Error("sharingMode must be 'instant', 'email', or 'restricted'.");
    }
    if (sharingMode === 'restricted' && !allowedEmails && !allowedDomain) {
      throw new Error('Restricted rooms require allowedEmails or allowedDomain.');
    }
    const name = entryDisplayName(displayName);
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
    const launch = () => startHost({
      source: selected, continuityHome:home, continueFromRoom, deferPublish:true, displayName: name, storage: join(home, 'host-' + randomUUID()), bind, port, publicOrigin,
      relayOrigin: env.PARCHEH_PUBLIC_ORIGIN === '' ? undefined : (env.PARCHEH_RELAY_ORIGIN || undefined),
      allowGuestInvite,
      sharingMode: sharingMode || 'instant',
      allowedEmails: allowedEmails || null,
      allowedDomain: allowedDomain || null,
      trustedAuthPublicKeys: env.PARCHEH_TRUSTED_AUTH_PUBKEY
        ? env.PARCHEH_TRUSTED_AUTH_PUBKEY.split(',').map(s => s.trim()).filter(Boolean)
        : undefined,
    });
    let host;
    try { host = await launch(); } catch (error) {
      if (error.code !== 'PROJECT_ACTIVE') throw error;
      const {latestRoom} = await import('./project-continuity.mjs');
      // A simultaneous first start may still be installing the owner's workspace.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const id = await latestRoom(home,selected);
        const state = id && await readJson(statePath(id));
        if (state?.host && state.closed) {
          // A close receipt may arrive just before the previous process releases the folder.
          try { host = await launch(); break; }
          catch (retry) { if (retry.code !== 'PROJECT_ACTIVE') throw retry; }
        }
        if (state?.host && !state.closed && state.accepted) {
          if (continueFromRoom && continueFromRoom !== id) throw error;
          const result = await api.room_status({room:id});
          if (!result.connected) throw Error('The project host still owns this room but could not be reached. Retry when the host responds.');
          const invite = await rpc(state.origin,id,'host-invite',state.memberToken,{});
          const parsed = parseInvite(invite.inviteUrl,allowLanHttp);
          if (parsed.room !== id || parsed.origin !== new URL(state.browserUrl).origin) throw Error('The running room returned an invalid invitation.');
          if (pointers !== undefined || actions !== undefined) {
            result.sharing = (await api.configure_browser({room:id,pointers,actions})).sharing;
          }
          if (openPreview === true && desktop && result.browserUrl) await openPreviewUrl(result.browserUrl);
          progress(100,'Ready');
          return {...result, inviteUrl:invite.inviteUrl};
        }
        await new Promise(done=>setTimeout(done,100));
      }
      if (!host) throw error;
    }
    try {
      parseInvite(host.inviteUrl, allowLanHttp);
      const origin = reachableUrl(host.localBaseUrl ?? host.baseUrl, allowLanHttp).origin;
      const state = { ...binding(host.roomId, origin, host, allowLanHttp, host.baseUrl), host: true };
      const { sharing } = await browserSettings(state, { pointers, actions }, true);
      state.folder = await mkdtemp(join(parent, '.parcheh-room-' + state.room + '-'));
      progress(60, 'Room created');
      const local = await install(state);
      // The owner receipt and workspace now exist. A lost acknowledgment can
      // be resolved from the same local transaction that selected the room.
      try { await rpc(origin,state.room,'host-ready',state.memberToken,{}); }
      catch (error) {
        const {latestRoom}=await import('./project-continuity.mjs');
        if (await latestRoom(home,selected)!==state.room) throw error;
      }
      const initialTree = await readJson(liveTreePath(state));
      const { inspectTreeRisks } = await import('./project.mjs');
      const { secretWarnings, buildConfigPaths } = inspectTreeRisks(initialTree || {});
      return {
        ...await readyView(state,local,openPreview,progress),
        sharing,
        inviteUrl: host.inviteUrl,
        ...(secretWarnings.length && { secretWarnings }),
        ...(buildConfigPaths.length && { buildConfigPaths }),
      };
    } catch (error) {
      await host.close().catch(() => {});
      throw error;
    }
  }

  async function join_room({ inviteUrl, workspaceParent, displayName, pointers, actions, openPreview, email }, progress = () => {}) {
    const name = entryDisplayName(displayName);
    const { room, origin, inviteSecret, handoff, claim, email: urlEmail } = parseInvite(inviteUrl, allowLanHttp);
    let claimToken = claim;
    let guestEmail = email || urlEmail;
    let deviceCert = null;

    const certs = await loadDeviceCertificates(home, { useKeychain: env.PARCHEH_KEYCHAIN === '1' }).catch(() => []);
    if (guestEmail) {
      const match = certs.find(c => c.origin === origin && c.email.toLowerCase() === guestEmail.toLowerCase());
      if (match) deviceCert = match.certificate;
    }
    if (!deviceCert) {
      const match = certs.find(c => c.origin === origin);
      if (match) {
        deviceCert = match.certificate;
        if (!guestEmail) guestEmail = match.email;
      }
    }

    if (!claimToken && !deviceCert && guestEmail) {
      try {
        const provRes = await fetch(origin + '/v1/auth/provisional', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: guestEmail }),
          signal: AbortSignal.timeout(3000),
        }).catch(() => null);
        if (provRes && provRes.ok) {
          const json = await provRes.json().catch(() => null);
          if (json?.claimToken) claimToken = json.claimToken;
        } else {
          const hRes = await fetch(origin + '/api/auth/provisional', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: guestEmail }),
            signal: AbortSignal.timeout(3000),
          }).catch(() => null);
          if (hRes && hRes.ok) {
            const json = await hRes.json().catch(() => null);
            if (json?.claimToken) claimToken = json.claimToken;
          }
        }
      } catch {}
    }
    async function finishJoin(state, result) {
      if (!handoff) return readyView(state,result,openPreview,progress);
      const app = state.localAppUrl ? localAppAddress(state.localAppUrl) : null;
      const browserToken = new URL(state.browserUrl).hash.slice(1);
      const payload = {
        redirectUrl: state.browserUrl,
        browserToken,
        ...(app && { app }),
      };
      const enc = encryptTabHandoff(handoff, room, payload);
      if (state.transport === 'relay') {
        const res = await fetch(`${origin}/v1/rooms/${room}/handoffs/${handoff}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: enc,
        });
        if (!res.ok) throw new Error(`Failed to deliver tab handoff to relay (HTTP ${res.status}).`);
      } else {
        const res = await fetch(`${origin}/api/rooms/${room}/handoffs/${handoff}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${state.memberToken}`,
            'content-type': 'application/octet-stream',
          },
          body: enc,
        });
        if (!res.ok) throw new Error(`Failed to deliver tab handoff to host (HTTP ${res.status}).`);
      }
      progress(100,'Ready in the invitation tab');
      return {...result, browserUrl:null, browserHandoff:'invitation-tab'};
    }
    const parent = await chooseWorkspace(workspaceParent);
    progress(15, 'Invite checked');
    const existing = await readJson(statePath(room));
    if (existing) {
      const state = await load(room);
      if (state.origin !== origin || await realpath(join(state.folder, '..')) !== parent) {
        throw new Error('That room is already bound to a different host or workspace on this device.');
      }
      const result = !state.turn ? await install(state) : { ...workspaceInfo(state), ...browserView(state) };
      // Reopening an existing draft without changing its settings also works offline.
      if (!state.turn || pointers !== undefined || actions !== undefined) {
        result.sharing = (await browserSettings(state, { pointers, actions })).sharing;
      }
      return finishJoin(state,result);
    }
    const pendingPath = join(home, 'join-' + room + '.json');
    const fingerprint = createHash('sha256').update(origin + '/r/' + room + '#' + inviteSecret).digest('hex');
    let pending = await readJson(pendingPath);
    if (!pending || pending.fingerprint !== fingerprint) {
      pending = { fingerprint, displayName: name, requestId:randomUUID() };
    }
    pending.sharing ??= {};
    if (pointers !== undefined) pending.sharing.pointers = pointers;
    if (actions !== undefined) pending.sharing.actions = actions;
    await writeJson(pendingPath, pending);

    let guestRelay = null;
    let activeState = null;
    if (await isRelayOrigin(origin)) {
      const { connectGuestRelay } = await import('./relay-transport.mjs');
      const identity = await loadOrCreateDeviceIdentity(home);
      guestRelay = await connectGuestRelay({
        relayOrigin: origin,
        roomId: room,
        inviteSecret,
        deviceIdentity: identity,
        onRevisionBroadcast: async (revMsg) => {
          try {
            if (!activeState?.folder) return;
            const gitDir = join(activeState.folder, 'git');
            const { importQuarantinedPack } = await import('./git-pack.mjs');
            const packBuf = Buffer.from(revMsg.packB64, 'base64');
            const tree = await importQuarantinedPack(gitDir, packBuf, revMsg.oid);
            await refresh(activeState, { rev: revMsg.rev, oid: revMsg.oid, tree });
          } catch {}
        },
      });
      guestRelaysByRoom.set(`${home}:${room}`, guestRelay);
    }

    async function admit() {
      const identity = await loadOrCreateDeviceIdentity(home, { useKeychain: env.PARCHEH_KEYCHAIN === '1' });
      const { signDevicePayload } = await import('./device-identity.mjs');
      const joinProofNonce = randomUUID();
      const signBuf = Buffer.from(`${room}:${pending.requestId || ''}:${joinProofNonce}`, 'utf8');
      const joinProofSigHex = signDevicePayload(identity, signBuf).toString('hex');

      const request = {
        inviteSecret,
        displayName: pending.displayName,
        requestId: pending.requestId,
        ...(handoff && { handoff }),
        ...(claimToken && { claimToken }),
        ...(deviceCert && { deviceCertificate: deviceCert }),
        guestEdPubHex: identity.publicKeyHex,
        joinProofNonce,
        joinProofSigHex,
      };
      if (guestRelay) {
        return guestRelay.rpc('join', undefined, request);
      }
      try { return await rpc(origin, room, 'join', undefined, request); }
      catch (error) {
        if (!handoff && error.message.includes('(HTTP 400)')) return rpc(origin, room, 'join', undefined, { inviteSecret, displayName: pending.displayName });
        if (error.message.startsWith('Could not reach')) return rpc(origin, room, 'join', undefined, request);
        throw error;
      }
    }
    const member = await admit().catch(async (error) => {
      if (error.message.includes('(HTTP 4')) await rm(pendingPath,{force:true});
      throw error;
    });
    if (guestRelay && member.memberToken) {
      const key = `${home}:${room}`;
      const currentGr = guestRelay;
      guestRelay.onClose(() => {
        if (guestRelaysByRoom.get(key) === currentGr) guestRelaysByRoom.delete(key);
        if (guestRelaysByToken.get(member.memberToken) === currentGr) {
          guestRelaysByToken.delete(member.memberToken);
        }
      });
      guestRelaysByToken.set(member.memberToken, guestRelay);
    }
    const state = binding(room, origin, member, allowLanHttp, origin, guestRelay ? 'relay' : 'direct');
    if (guestRelay) {
      state.transport = 'relay';
      state.memberId = member.memberId;
      state.reconnectSecret = member.reconnectSecret;
      state.hostBrowserToken = new URL(member.browserUrl).hash.slice(1);
      const previewServer = await startLocalPreviewServer({
        roomId: room,
        hostBrowserToken: state.hostBrowserToken,
        getTree: () => readJson(liveTreePath(state)),
        getRev: () => state.accepted?.rev ?? 0,
        guestRelay,
        localAppUrl: state.localAppUrl,
      });
      activePreviewServers.set(`${home}:${room}`, previewServer);
      state.browserUrl = previewServer.browserUrl;
      activeState = state;
    }
    // Set fresh enrollment defaults before saving or exposing the browser URL. The
    // outstanding join receipt lets a retry recover this member on a 0.2.x host.
    const { sharing } = await browserSettings(state, pending.sharing, true);
    state.folder = await mkdtemp(join(parent, '.parcheh-room-' + room + '-'));
    await save(state);
    await rm(pendingPath, {force:true});
    progress(55, 'Joined');
    const result = await install(state);
    return finishJoin(state,{ ...result, sharing });
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
    let submittedChanges;
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
      if (body?.changes) submittedChanges = body.changes;
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
      const turnStage = dirname(state.turn.path);
      state.lastReceipt = receipt;
      delete state.turn;
      await save(state);
      await Promise.allSettled([
        rm(basePath, { force: true }),
        rm(submissionPath, { force: true }),
        rm(turnStage, { recursive: true, force: true }),
      ]);
    }
    let refreshError;
    try {
      await refresh(state, await snapshot(state));
    } catch (error) {
      refreshError = error.message;
    }
    let secretWarnings;
    let buildConfigPaths;
    if (submittedChanges) {
      const { inspectTreeRisks } = await import('./project.mjs');
      const changedEntries = Object.fromEntries(Object.entries(submittedChanges).filter(([, e]) => e !== null));
      const risks = inspectTreeRisks(changedEntries);
      secretWarnings = risks.secretWarnings;
      buildConfigPaths = risks.buildConfigPaths;
    }
    return {
      ...workspaceInfo(state),
      ...state.lastReceipt,
      ...browserView(state),
      ...(refreshError && { refreshError }),
      ...(secretWarnings?.length && { secretWarnings }),
      ...(buildConfigPaths?.length && { buildConfigPaths }),
    };
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
        members: members.map(({ id, name, email, emailVerified, emailStatus }) => ({
          id,
          name,
          ...(email && {
            email,
            emailVerified: Boolean(emailVerified),
            emailStatus: emailVerified ? 'verified' : (emailStatus || 'unverified'),
          }),
        })),
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
    const { sharing, previewAvailable } = await browserSettings(state, { pointers, actions });
    if (!sharing) throw new Error('This host does not support browser sharing settings.');
    if (appUrl !== undefined) {
      state.localAppUrl = local;
      await save(state);
    }
    return { room, sharing, ...browserView(state, previewAvailable) };
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

  async function leave_room({ room }) {
    const state = await load(room);
    if (state.host) throw new Error('Only guests can leave a parcheh room. Use end_room if you are the host.');
    if (!state.closed) {
      try {
        await rpc(state.origin, room, 'leave', state.memberToken, {});
      } catch {}
      const activeTimer = editingTimers.get(room);
      if (activeTimer) {
        clearInterval(activeTimer.timer);
        activeTimer.stop().catch(() => {});
        editingTimers.delete(room);
      }
      state.closed = true;
      state.left = true;
      await save(state);
    }
    const key = `${home}:${room}`;
    const ps = activePreviewServers.get(key);
    if (ps) {
      ps.close();
      activePreviewServers.delete(key);
    }
    const gr = guestRelaysByRoom.get(key);
    if (gr) {
      gr.close();
      guestRelaysByRoom.delete(key);
      if (state.memberToken) guestRelaysByToken.delete(state.memberToken);
    }
    return { ...workspaceInfo(state), outcome: 'left', ...(state.turn && { draftWorkspace: state.turn.path }) };
  }

  async function revoke_member({ room, member }) {
    const state = await load(room);
    if (!state.host) throw new Error('Only the host can revoke a participant.');
    const res = await rpc(state.origin, room, 'revoke-member', state.memberToken, { member });
    return { room, ...res };
  }

  async function revoke_invite({ room }) {
    const state = await load(room);
    if (!state.host) throw new Error('Only the host can revoke an invitation.');
    await rpc(state.origin, room, 'revoke-invite', state.memberToken, {});
    return { room, inviteRevoked: true };
  }

  async function new_invite({ room, sharingMode, allowedEmails, allowedDomain, allowGuestInvite }) {
    const state = await load(room);
    if (!state.host) throw new Error('Only the host can create a new invitation.');
    const res = await rpc(state.origin, room, 'new-invite', state.memberToken, {
      ...(sharingMode && { sharingMode }),
      ...(allowedEmails !== undefined && { allowedEmails }),
      ...(allowedDomain !== undefined && { allowedDomain }),
      ...(allowGuestInvite !== undefined && { allowGuestInvite }),
    });
    parseInvite(res.inviteUrl, allowLanHttp);
    return { room, inviteUrl: res.inviteUrl };
  }

  async function verify_email({ email, code, challengeToken, origin, inviteUrl }) {
    if (!email || typeof email !== 'string') throw new Error('email must be a valid string.');
    const normEmail = email.trim().toLowerCase();

    let targetOrigin = null;
    if (origin) {
      targetOrigin = reachableUrl(origin, allowLanHttp).origin;
    } else if (inviteUrl) {
      targetOrigin = reachableUrl(inviteUrl, allowLanHttp).origin;
    } else {
      targetOrigin = env.PARCHEH_RELAY_ORIGIN || 'https://parcheh.augi.ca';
    }
    targetOrigin = targetOrigin.replace(/\/+$/, '');

    const identity = await loadOrCreateDeviceIdentity(home, { useKeychain: env.PARCHEH_KEYCHAIN === '1' });
    const pendingVerifyPath = join(home, 'pending-verify.json');

    if (!code) {
      let res;
      try {
        res = await fetch(`${targetOrigin}/v1/auth/request-verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: normEmail, devicePublicKeyHex: identity.publicKeyHex }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 404) {
          res = await fetch(`${targetOrigin}/api/auth/request-verify`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: normEmail, devicePublicKeyHex: identity.publicKeyHex }),
            signal: AbortSignal.timeout(10_000),
          });
        }
      } catch {
        throw new Error(`Could not reach authentication server at ${targetOrigin}.`);
      }

      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.error || `Request verify failed with HTTP ${res.status}.`);
      }

      const data = await res.json();
      const tokenToSave = data.challengeToken;
      const record = {
        email: normEmail,
        challengeToken: tokenToSave,
        origin: targetOrigin,
        expiresAt: data.expiresAt,
      };
      const staged = pendingVerifyPath + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(staged, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600, flush: true });
        await rename(staged, pendingVerifyPath);
      } finally {
        await rm(staged, { force: true }).catch(() => {});
      }
      return { status: 'code_sent', email: normEmail, origin: targetOrigin };
    }

    let tokenToUse = challengeToken;
    if (!tokenToUse) {
      try {
        const raw = await readFile(pendingVerifyPath, 'utf8');
        const saved = JSON.parse(raw);
        if (saved.email === normEmail) {
          tokenToUse = saved.challengeToken;
          if (!origin && !inviteUrl && saved.origin) targetOrigin = saved.origin;
        }
      } catch {}
    }
    if (!tokenToUse) {
      throw new Error('No pending challenge token found. Call verify_email with your email first.');
    }

    const { signDevicePayload } = await import('./device-identity.mjs');
    const proofPayload = Buffer.from('parcheh-verify:' + normEmail + ':' + String(code).trim() + ':' + tokenToUse, 'utf8');
    const proofSigHex = signDevicePayload(identity, proofPayload).toString('hex');

    let res;
    try {
      res = await fetch(`${targetOrigin}/v1/auth/complete-verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: normEmail,
          code: String(code).trim(),
          challengeToken: tokenToUse,
          devicePublicKeyHex: identity.publicKeyHex,
          proofSigHex,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404) {
        res = await fetch(`${targetOrigin}/api/auth/complete-verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: normEmail,
            code: String(code).trim(),
            challengeToken: tokenToUse,
            devicePublicKeyHex: identity.publicKeyHex,
            proofSigHex,
          }),
          signal: AbortSignal.timeout(10_000),
        });
      }
    } catch {
      throw new Error(`Could not reach authentication server at ${targetOrigin}.`);
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      throw new Error(errBody?.error || `Complete verify failed with HTTP ${res.status}.`);
    }

    const data = await res.json();
    await saveDeviceCertificate(home, {
      origin: targetOrigin,
      email: normEmail,
      certificate: data.deviceCertificate,
    }, { useKeychain: env.PARCHEH_KEYCHAIN === '1' });
    await rm(pendingVerifyPath, { force: true }).catch(() => {});

    return { status: 'verified', email: normEmail, devicePublicKeyHex: identity.publicKeyHex };
  }

  async function end_room({ room }) {
    const state = await load(room);
    if (!state.host) throw new Error('Only the host can end this parcheh room.');
    if (!state.closed) {
      await rpc(state.origin, room, 'close', state.memberToken, {});
      state.closed = true;
      await save(state);
    }
    const key = `${home}:${room}`;
    const ps = activePreviewServers.get(key);
    if (ps) {
      ps.close();
      activePreviewServers.delete(key);
    }
    const gr = guestRelaysByRoom.get(key);
    if (gr) {
      gr.close();
      guestRelaysByRoom.delete(key);
      if (state.memberToken) guestRelaysByToken.delete(state.memberToken);
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
    const edit = draftLocks.get(room);
    if (edit?.isOpen) edit.close();
    draftLocks.delete(room);
  }
  async function close() {
    if (lock?.isOpen) lock.close();
    for (const room of draftLocks.keys()) releaseDraft(room);
    for (const [key, ps] of activePreviewServers) {
      if (key.startsWith(`${home}:`)) {
        ps.close();
        activePreviewServers.delete(key);
      }
    }
    for (const [key, gr] of guestRelaysByRoom) {
      if (key.startsWith(`${home}:`)) {
        for (const [tok, mapped] of guestRelaysByToken) {
          if (mapped === gr) guestRelaysByToken.delete(tok);
        }
        gr.close();
        guestRelaysByRoom.delete(key);
      }
    }
    const pending = [];
    for (const {timer, stop} of editingTimers.values()) { clearInterval(timer); pending.push(stop()); }
    editingTimers.clear();
    await Promise.allSettled(pending);
  }

  const api = { preview_scope, start_room, join_room, leave_room, revoke_member, revoke_invite, new_invite, verify_email,
    begin_turn, finish_turn, room_status, configure_browser, room_history, end_room,
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
          if (name === 'finish_turn' || name === 'end_room' || name === 'leave_room' || (acquired && name !== 'begin_turn')) releaseDraft(room);
          return result;
        } catch (error) {
          if (acquired) releaseDraft(room);
          throw error;
        } finally { busy.close(); }
      };
    }
  }
  return { ...api, close, deviceIdentity, home };
}
