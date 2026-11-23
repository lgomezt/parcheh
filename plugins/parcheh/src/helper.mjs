import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadOrCreateDeviceIdentity } from './device-identity.mjs';
import { openClient } from './client.mjs';

export function helperSocketPath(home) {
  const directPath = join(home, 'helper.sock');
  if (Buffer.byteLength(directPath) <= 100) return directPath;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const tmpDir = join('/tmp', `parcheh-${uid}`);
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  try { chmodSync(tmpDir, 0o700); } catch {}
  const hash = createHash('sha256').update(home).digest('hex').slice(0, 20);
  return join(tmpDir, `h-${hash}.sock`);
}

export async function startHelperServer({
  home,
  env = process.env,
  idleMs = Number(env?.PARCHEH_HELPER_IDLE_MS || 15 * 60_000),
} = {}) {
  const resolvedHome = resolve(home || env.PARCHEH_HOME || join(homedir(), '.parcheh'));
  await mkdir(resolvedHome, { recursive: true, mode: 0o700 });
  const deviceIdentity = await loadOrCreateDeviceIdentity(resolvedHome, {
    useKeychain: env.PARCHEH_KEYCHAIN === '1',
  });

  const sockPath = helperSocketPath(resolvedHome);
  if (existsSync(sockPath)) {
    const alive = await new Promise(res => {
      const probe = net.createConnection(sockPath);
      probe.once('connect', () => { probe.end(); res(true); });
      probe.once('error', () => res(false));
    });
    if (alive) {
      return { sockPath, pid: process.pid, deviceIdentity, close: () => {} };
    }
    try { unlinkSync(sockPath); } catch {}
  }

  const connections = new Set();
  let lastActivity = Date.now();
  let closing = false;

  const server = net.createServer(socket => {
    connections.add(socket);
    lastActivity = Date.now();
    let sessionClient = null;
    const rootWaiters = new Map();
    let rootsSeq = 0;

    async function socketGetRoots() {
      const rootsId = 'r-' + ++rootsSeq;
      return new Promise(res => {
        const timer = setTimeout(() => {
          rootWaiters.delete(rootsId);
          res([]);
        }, 1800);
        rootWaiters.set(rootsId, roots => {
          clearTimeout(timer);
          res(roots);
        });
        socket.write(JSON.stringify({ id: rootsId, type: 'roots' }) + '\n');
      });
    }

    const rl = readline.createInterface({ input: socket });
    rl.on('line', async line => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'roots_reply') {
        const waiter = rootWaiters.get(msg.id);
        if (waiter) {
          rootWaiters.delete(msg.id);
          waiter(msg.roots || []);
        }
        return;
      }
      if (msg.type === 'ping') {
        socket.write(JSON.stringify({ id: msg.id, type: 'pong', pid: process.pid, deviceId: deviceIdentity.deviceId }) + '\n');
        return;
      }
      if (msg.type === 'call') {
        lastActivity = Date.now();
        try {
          if (!sessionClient) {
            sessionClient = await openClient({ ...env, ...msg.env, PARCHEH_HOME: resolvedHome }, { getRoots: socketGetRoots });
          }
          function progress(value, message) {
            socket.write(JSON.stringify({ id: msg.id, type: 'progress', value, message }) + '\n');
          }
          const result = await sessionClient[msg.name](msg.args, progress);
          socket.write(JSON.stringify({ id: msg.id, type: 'done', ok: true, result }) + '\n');
        } catch (error) {
          socket.write(JSON.stringify({ id: msg.id, type: 'done', ok: false, message: error.message || 'parcheh tool failed.' }) + '\n');
        }
      }
    });

    async function cleanupConnection() {
      connections.delete(socket);
      lastActivity = Date.now();
      for (const waiter of rootWaiters.values()) waiter([]);
      rootWaiters.clear();
      if (sessionClient) {
        await sessionClient.close().catch(() => {});
        sessionClient = null;
      }
    }

    socket.on('close', cleanupConnection);
    socket.on('error', cleanupConnection);
  });

  const prevUmask = process.umask ? process.umask(0o077) : null;
  try {
    await new Promise((res, rej) => {
      server.once('error', rej);
      server.listen(sockPath, res);
    });
    chmodSync(sockPath, 0o600);
  } finally {
    if (prevUmask !== null) process.umask(prevUmask);
  }

  function closeServer() {
    if (closing) return;
    closing = true;
    clearInterval(checkTimer);
    for (const socket of connections) socket.destroy();
    connections.clear();
    server.close(() => {
      try { unlinkSync(sockPath); } catch {}
    });
  }

  const checkTimer = setInterval(async () => {
    try {
      const stat = await lstat(resolvedHome);
      if (!stat.isDirectory()) throw new Error('Home removed');
    } catch {
      closeServer();
      if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
        process.exit(0);
      }
      return;
    }
    if (connections.size === 0 && Date.now() - lastActivity > idleMs) {
      closeServer();
      if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
        process.exit(0);
      }
    }
  }, 1500);
  checkTimer.unref();

  return { sockPath, pid: process.pid, deviceIdentity, close: closeServer };
}

export async function connectHelper({ home, env = process.env, getRoots = async () => [] } = {}) {
  const resolvedHome = resolve(home || env.PARCHEH_HOME || join(homedir(), '.parcheh'));
  const sockPath = helperSocketPath(resolvedHome);

  async function tryConnect() {
    return new Promise((res, rej) => {
      const socket = net.createConnection(sockPath);
      socket.once('connect', () => res(socket));
      socket.once('error', err => rej(err));
    });
  }

  let socket;
  try {
    socket = await tryConnect();
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./helper.mjs', import.meta.url))], {
        detached: true,
        stdio: 'ignore',
        env: { ...env, PARCHEH_HOME: resolvedHome },
      });
      child.unref();

      const start = Date.now();
      while (Date.now() - start < 3000) {
        await new Promise(r => setTimeout(r, 50));
        try {
          socket = await tryConnect();
          break;
        } catch {}
      }
      if (!socket) {
        throw new Error('Could not connect to parcheh helper daemon.');
      }
    } else {
      throw err;
    }
  }

  const calls = new Map();
  const rl = readline.createInterface({ input: socket });

  rl.on('line', async line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'roots') {
      const roots = await getRoots();
      socket.write(JSON.stringify({ id: msg.id, type: 'roots_reply', roots }) + '\n');
      return;
    }
    const call = calls.get(msg.id);
    if (!call) return;
    if (msg.type === 'progress') {
      call.progress?.(msg.value, msg.message);
      return;
    }
    if (msg.type === 'done') {
      calls.delete(msg.id);
      if (msg.ok) call.resolve(msg.result);
      else call.reject(new Error(msg.message));
      return;
    }
    if (msg.type === 'pong') {
      calls.delete(msg.id);
      call.resolve(msg);
      return;
    }
  });

  socket.on('error', err => {
    for (const call of calls.values()) call.reject(err);
    calls.clear();
  });
  socket.on('close', () => {
    for (const call of calls.values()) call.reject(new Error('Helper connection closed.'));
    calls.clear();
  });

  const toolNames = [
    'preview_scope', 'start_room', 'join_room', 'leave_room', 'revoke_member', 'revoke_invite', 'new_invite',
    'verify_email',
    'begin_turn', 'finish_turn', 'room_status', 'configure_browser', 'room_history', 'end_room',
    'list_draft', 'read_draft_file', 'write_draft_file', 'delete_draft_file',
  ];

  const client = {
    async ping() {
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        calls.set(id, { resolve, reject });
        socket.write(JSON.stringify({ id, type: 'ping' }) + '\n');
      });
    },
    async close() {
      socket.end();
    },
  };

  for (const name of toolNames) {
    client[name] = async (args, progress) => {
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        calls.set(id, { resolve, reject, progress });
        socket.write(JSON.stringify({ id, type: 'call', name, args, env }) + '\n');
      });
    };
  }

  return client;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const home = process.env.PARCHEH_HOME || join(homedir(), '.parcheh');
  await startHelperServer({ home, env: process.env });
}
