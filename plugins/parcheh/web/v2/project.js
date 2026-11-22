import { mountInvite } from './invite.mjs';
import { sharedAction, validCoordinates } from './app-bridge.mjs';

const room = /^\/view\/([a-z0-9-]+)$/.exec(location.pathname)?.[1];
if (room) openProject(room);

function localApp(value) {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) &&
        ['127.0.0.1', 'localhost'].includes(url.hostname) && url.origin !== location.origin &&
        !url.username && !url.password) return url;
  } catch {
    // The room can still use its accepted static entry.
  }
  return null;
}

function browserSettings(room) {
  const tokenKey = `parcheh:browser:${room}`;
  const appKey = `parcheh:app:${room}`;
  const fragment = location.hash.slice(1);
  let token;
  let app;
  if (fragment) {
    const [pin, ...params] = fragment.split('&');
    token = /^[a-zA-Z0-9_-]+$/.test(pin) ? pin : null;
    app = localApp(new URLSearchParams(params.join('&')).get('app'));
    try {
      if (token) sessionStorage.setItem(tokenKey, token);
      else sessionStorage.removeItem(tokenKey);
      if (token && app) sessionStorage.setItem(appKey, app.href);
      else sessionStorage.removeItem(appKey);
    } catch {
      // Pin and app URL can stay in memory when tab storage is unavailable.
    }
    history.replaceState(null, '', location.pathname + location.search);
  } else {
    try {
      token = sessionStorage.getItem(tokenKey);
      app = localApp(sessionStorage.getItem(appKey));
    } catch {
      // An unopened view stays blank.
    }
  }
  if (app) app.searchParams.set('roomOrigin', location.origin);
  return { token, app };
}

function openProject(roomId) {
  const { token, app } = browserSettings(roomId);
  if (!token) return;
  mountInvite(roomId,token).catch(() => {});
  const frame = document.querySelector('iframe');
  const api = `/api/rooms/${encodeURIComponent(roomId)}`;
  let project;
  let sourceMessage;
  let navigation;
  let bridge;
  let visibilityEpoch = 0;
  let stopped = false;
  let sending = Promise.resolve();
  let delivering = false;
  let refreshing = false;
  let refreshTimer;
  let outboxKey;
  let outbox = [];
  let personalKey;
  let personal = [];

  function restorePersonal(source, mode) {
    source.personalMode = mode;
    const key = `${outboxKey}:private:${mode.documentId}`;
    if (personalKey !== key) {
      personalKey = key;
      try { personal = JSON.parse(sessionStorage.getItem(key)) || []; }
      catch { personal = []; }
    }
    if (!Array.isArray(personal)) personal = [];
    personal = personal.flatMap(op => {
      const action = sharedAction(mode.documentActions, mode.payloads, op?.actionId, op?.payload);
      return action ? [{ ...action, ...(op.id && {id:op.id}) }] : [];
    });
    source.port.postMessage({ type: 'document-private', documentId: mode.documentId, operations: personal });
  }

  function recordPersonal(action) {
    personal.push(action);
    savePersonal();
  }

  function savePersonal() {
    try { sessionStorage.setItem(personalKey, JSON.stringify(personal)); }
    catch { /* Keep artwork in this frame when browser storage is unavailable. */ }
  }

  function saveOutbox() {
    try {
      if (outbox.length) sessionStorage.setItem(outboxKey, JSON.stringify(outbox));
      else sessionStorage.removeItem(outboxKey);
    } catch { /* In-memory delivery still works when tab storage is full. */ }
  }

  function loadOutbox(memberId) {
    const key = `parcheh:pending:${roomId}:${memberId}`;
    if (outboxKey === key) return;
    outboxKey = key;
    try { outbox = JSON.parse(sessionStorage.getItem(key)) || []; }
    catch { outbox = []; }
    if (!Array.isArray(outbox)) outbox = [];
  }

  function schedule(delay = 0) {
    clearTimeout(refreshTimer);
    if (!refreshing && !stopped && !document.hidden) refreshTimer = setTimeout(refresh, delay);
  }

  async function request(endpoint, activity) {
    const headers = { Authorization: `Bearer ${token}` };
    const options = {
      headers, cache: 'no-store', credentials: 'omit', redirect: 'error',
      referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(5000),
    };
    if (activity) {
      headers['Content-Type'] = 'application/json';
      options.method = 'POST';
      options.body = JSON.stringify(activity);
    }
    const result = await fetch(`${api}/${endpoint}`, options);
    if (!result.ok) throw new Error('Project view request failed', { cause: result.status });
    return result.json();
  }

  function stopPointerStream(source) {
    source?.pointerStream?.abort();
    if (source) source.streamPointers = undefined;
  }

  async function watchPointers(source) {
    if (source.pointerStream || Date.now() < (source.retryPointersAt || 0)) return;
    const controller = new AbortController();
    source.pointerStream = controller;
    let watchdog;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => controller.abort(), 4000);
    };
    try {
      arm();
      const response = await fetch(api + '/pointers', {
        headers:{Authorization:'Bearer ' + token}, credentials:'omit', redirect:'error',
        cache:'no-store', referrerPolicy:'no-referrer', signal:controller.signal,
      });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('application/x-ndjson')) return;
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      while (!controller.signal.aborted) {
        const {value, done} = await reader.read();
        if (done || controller.signal.aborted) break;
        buffer += value;
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const snapshot = JSON.parse(buffer.slice(0,newline));
          buffer = buffer.slice(newline+1);
          arm();
          if (source === bridge && source.mode?.pointers && snapshot.rev === project.rev) {
            source.streamPointers = snapshot.pointers;
            showPointers(source, source.streamPointers);
          }
        }
        if (buffer.length > 8192) break;
      }
    } catch { /* The live response supplies cursors while the stream reconnects. */ }
    finally {
      clearTimeout(watchdog);
      controller.abort();
      source.pointerStream = undefined;
      source.streamPointers = undefined;
      source.retryPointersAt = Date.now() + 2000;
    }
  }

  function resetBridge() {
    if (!bridge) return;
    stopPointerStream(bridge);
    bridge.mode = null;
    bridge.lastSeq = null;
    bridge.port.postMessage({ type: 'sharing', pointers: false, actions: false, actionIds: [], payloads: {} });
  }

  function disconnectNetwork(source) {
    if (!source || source !== bridge) return;
    stopPointerStream(source);
    const mode = source.mode;
    source.lastSeq = null;
    if (!mode?.documentId || !mode.actions) { resetBridge(); return; }
    if (mode.offline) return;
    // Only a previously enrolled document can collect normalized edits offline.
    source.mode = { ...mode, offline:true, pointers:false, actionIds:mode.documentActions };
    source.port.postMessage({ type:'sharing', ...source.mode });
    source.port.postMessage({ type:'pointers', peers:[] });
  }

  function detach() {
    stopPointerStream(bridge);
    bridge?.port.close();
    bridge = undefined;
  }

  function updateProject(next) {
    const previous = project;
    project = next;
    if (previous?.rev !== next.rev) resetBridge();

    let url = app ? new URL(app.href) : null;
    let bridgeToken;
    if (url) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bridgeToken = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      url.hash = 'parcheh-bridge=' + bridgeToken;
    }
    if (!url && typeof next.entryUrl === 'string' && next.entryUrl.startsWith('/')) {
      const entry = new URL(next.entryUrl, location.origin);
      if (entry.origin === location.origin && !entry.username && !entry.password) url = entry;
    }
    if (!url && !sourceMessage) {
      sourceMessage = document.createElement('p');
      sourceMessage.setAttribute('role','status');
      sourceMessage.textContent = 'Your files are ready in your agent. The project preview will appear here when available.';
      sourceMessage.style.cssText = 'position:absolute;top:1rem;left:1rem;margin:0;font:1rem/1.5 system-ui';
      document.body.append(sourceMessage);
    } else if (url && sourceMessage) {
      sourceMessage.remove();
      sourceMessage = undefined;
    }
    if (navigation?.href === url?.href) return;
    detach();
    document.title = '';
    frame.title = 'Project';
    if (!url) {
      navigation = undefined;
      frame.removeAttribute('src');
      return;
    }

    navigation = {
      href: url.href,
      origin: app ? url.origin : 'null',
      projectDirectory: app ? null : new URL('.', url).pathname,
      challenge: null,
      bridgeToken: bridgeToken || null,
    };
    frame.setAttribute('sandbox', app ? 'allow-scripts allow-same-origin allow-forms' : 'allow-scripts');
    frame.src = url.href;
  }

  function probe() {
    if (!navigation?.challenge) return;
    frame.contentWindow.postMessage(
      {
        type: 'parcheh:probe',
        challenge: navigation.challenge,
        ...(navigation.bridgeToken && { bridgeToken: navigation.bridgeToken }),
      },
      navigation.origin === 'null' ? '*' : navigation.origin,
    );
  }

  frame.addEventListener('load', () => {
    detach();
    if (!navigation) return;
    navigation.challenge = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, '0')).join('');
    probe();
  });

  function changeTitle(title) {
    if (typeof title !== 'string') return;
    document.title = title;
    frame.title = title || 'Project';
  }

  window.addEventListener('message', (event) => {
    const expected = navigation;
    if (!expected || event.source !== frame.contentWindow || event.origin !== expected.origin) return;
    const data = event.data;
    if (data?.type !== 'parcheh:ready' || bridge || !expected.challenge) return;
    if (data.challenge === undefined) {
      probe();
      return;
    }
    if (data.challenge !== expected.challenge) return;
    if (expected.projectDirectory && (typeof data.path !== 'string' || !data.path.startsWith(expected.projectDirectory))) return;

    const channel = new MessageChannel();
    const opened = { port: channel.port1, mode: null, lastSeq: null, documentSeq: 0, documentId: null };
    bridge = opened;
    changeTitle(data.title);
    opened.port.onmessage = ({ data: message }) => receive(opened, message);
    frame.contentWindow.postMessage(
      {
        type: 'parcheh:connected',
        challenge: expected.challenge,
        ...(expected.bridgeToken && { bridgeToken: expected.bridgeToken }),
      },
      expected.origin === 'null' ? '*' : expected.origin,
      [channel.port2],
    );
    schedule();
  });

  function sendActivity(source, activity, mode) {
    if (activity.kind === 'pointer' || activity.kind === 'hide-pointer') {
      source.nextPointer = { activity, mode };
      if (source.sendingPointer) return;
      source.sendingPointer = true;
      void (async () => {
        try {
          while (source.nextPointer) {
            const next = source.nextPointer;
            source.nextPointer = null;
            if (source === bridge && next.mode === source.mode && !document.hidden) {
              await request('activity', next.activity);
            }
          }
        } catch { /* A newer sample will replace this one. */ }
        finally { source.sendingPointer = false; }
      })();
      return;
    }
    sending = sending.then(async () => {
      if (source !== bridge || mode !== source.mode || document.hidden) return;
      await request('activity', activity);
    }).catch(() => {});
  }

  // A stale write belongs to this tab. Keep its UUID so an already-committed
  // response lost during disconnection can still reconcile against later history.
  function keepLocal(item) {
    if (item.confirmed) return;
    const op = { id:item.id, actionId:item.actionId, payload:item.payload };
    const key = `${outboxKey}:private:${item.documentId}`;
    if (key === personalKey) {
      if (personal.some(existing => existing.id === item.id)) return;
      recordPersonal(op);
      if (bridge?.personalMode?.documentId === item.documentId) {
        bridge.port.postMessage({ type:'document-refused', documentId:item.documentId, ...op });
      }
    } else {
      try {
        const stored = JSON.parse(sessionStorage.getItem(key)) || [];
        if (!stored.some(existing => existing.id === item.id)) {
          sessionStorage.setItem(key, JSON.stringify([...stored, op]));
        }
      } catch { /* Old document is no longer mounted and tab storage is unavailable. */ }
    }
  }

  // A lost response leaves the same UUID at the front for the next verified poll.
  async function deliver() {
    if (delivering || !outbox.length) return;
    delivering = true;
    try {
      while (outbox.length) {
        const source = bridge;
        const mode = source?.mode;
        if (!mode || mode.offline || document.hidden) return;
        const item = outbox[0];
        if (!mode.actions || item.documentId !== mode.documentId || item.epoch !== mode.epoch) {
          keepLocal(item);
        } else {
          const { documentId, id, actionId, payload } = item;
          try {
            const receipt = await request('document', { documentId, id, actionId, payload, sharingEpoch:item.epoch });
            if (receipt.id !== id || receipt.documentId !== documentId || !Number.isSafeInteger(receipt.seq)) return;
          } catch (error) {
            if (![400, 403, 409, 413, 422, 507].includes(error.cause)) {
              if (source?.mode === mode) disconnectNetwork(source);
              return;
            }
            keepLocal(item);
          }
        }
        if (outbox[0] === item) outbox.shift();
        saveOutbox();
        schedule();
      }
    } finally { delivering = false; }
  }

  function receive(source, message) {
    if (source !== bridge) return;
    if (message?.type === 'title') {
      changeTitle(message.title);
      return;
    }
    if (message?.type === 'document-private') {
      const local = source.personalMode;
      if (local && message.documentId === local.documentId) {
        const action = sharedAction(local.documentActions, local.payloads, message.actionId, message.payload);
        if (action) recordPersonal(action);
      }
      return;
    }
    const mode = source.mode;
    if (message?.type === 'document') {
      const local = source.personalMode;
      if (!local || message.documentId !== local.documentId || typeof message.id !== 'string' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(message.id)) return;
      const action = sharedAction(local.documentActions, local.payloads, message.actionId, message.payload);
      if (!action) return;
      const item = { epoch:message.epoch, documentId:local.documentId, id:message.id, ...action };
      if (!document.hidden && mode?.actions && mode.documentId === local.documentId && mode.epoch === item.epoch) {
        outbox.push(item);
        saveOutbox();
        void deliver();
      } else keepLocal(item);
      return;
    }
    if (!mode || document.hidden) return;
    if (message?.type === 'hide-pointer' && mode.pointers) {
      sendActivity(source, { kind: 'hide-pointer' }, mode);
    } else if (message?.type === 'pointer' && mode.pointers && validCoordinates(message.x, message.y)) {
      sendActivity(source, { kind: 'pointer', surface: mode.surface, x: message.x, y: message.y }, mode);
    } else if (message?.type === 'action' && !mode.offline && mode.actions && !mode.documentActions.includes(message.actionId)) {
      const action = sharedAction(mode.actionIds, mode.payloads, message.actionId, message.payload);
      if (action) sendActivity(source, { kind: 'action', surface: mode.surface, ...action }, mode);
    }
  }

  function showPointers(source, pointers) {
    const mode = source.mode;
    const peers = mode.pointers ? pointers.filter(peer =>
      peer.memberId !== source.selfId && peer.surface === mode.surface && validCoordinates(peer.x, peer.y)
    ) : [];
    const editors = source.editors;
    const editing = new Set(editors.map(peer => peer.memberId));
    const markers = peers.map(peer => ({ ...peer, editing: editing.has(peer.memberId) }));
    // A room editing lease carries only identity. It has no dependency on pointer sharing.
    for (const { memberId, name } of editors) {
      if (!peers.some(peer => peer.memberId === memberId)) markers.push({ memberId, name, editing: true });
    }
    source.port.postMessage({ type: 'pointers', peers: markers });
  }

  async function applyLive(source, state) {
    const config = project.config;
    const previous = source.mode;
    const actionIds = Array.isArray(config?.actions) ? config.actions : [];
    const payloads = config?.payloads || {};
    const declared = Number.isSafeInteger(state.documentHead) && config?.document;
    const documentId = declared?.id || null;
    const documentActions = declared?.actions || [];
    const mode = {
      pointers: state.sharing?.pointers === true,
      actions: state.sharing?.actions === true && !!actionIds.length,
      actionIds, payloads, documentId, documentActions,
      surface: `app:${config?.surface || 'page'}:${project.rev}`,
      epoch: state.sharingEpoch,
    };
    if (previous && mode.epoch < previous.epoch) return;

    const head = state.actionSeq;
    if (!Number.isSafeInteger(head) || head < 0) return;
    loadOutbox(state.self.id);
    if (source.lastSeq === null) {
      // A new document or interrupted view only applies future actions.
      source.lastSeq = head;
    } else if (mode.actions) {
      const watermark = Number.isSafeInteger(state.sharingActionSeq)
        ? state.sharingActionSeq
        : previous?.actions ? source.lastSeq : head;
      source.lastSeq = Math.max(source.lastSeq, watermark);
    }

    if (!previous || previous.offline || previous.pointers !== mode.pointers || previous.actions !== mode.actions || previous.epoch !== mode.epoch || previous.documentId !== documentId || previous.surface !== mode.surface) {
      source.mode = mode;
      const { pointers, actions } = mode;
      source.port.postMessage({ type: 'sharing', pointers, actions, actionIds, payloads, documentId, documentActions, epoch:mode.epoch });
    }

    if (mode.actions) {
      for (const event of state.actions) {
        if (!Number.isSafeInteger(event.seq) || event.seq <= source.lastSeq || event.seq > head ||
            event.kind !== 'action' || event.surface !== mode.surface || documentActions.includes(event.actionId)) continue;
        const action = sharedAction(actionIds, payloads, event.actionId, event.payload);
        if (action) source.port.postMessage({
          type: 'action', ...action, seq: event.seq, actor: event.name, self: event.memberId === state.self.id,
        });
        source.lastSeq = event.seq;
      }
    }
    source.lastSeq = Math.max(source.lastSeq, head);

    source.selfId = state.self.id;
    source.editors = (state.editing || []).filter(peer => peer.memberId !== source.selfId);
    if (mode.pointers) void watchPointers(source);
    else stopPointerStream(source);
    showPointers(source, source.streamPointers || state.pointers);

    if (source.documentId !== documentId) {
      source.documentId = documentId;
      source.documentSeq = 0;
      source.port.postMessage({ type: 'document-reset', documentId });
      source.personalMode = null;
      if (documentId) {
        restorePersonal(source, mode);
        for (const item of outbox) {
          if (item.documentId === documentId) source.port.postMessage({ ...item, type:'document-pending' });
        }
      }
    }
    if (documentId) source.personalMode = mode;
    void deliver();
    if (mode.actions && documentId && source.documentSeq < state.documentHead) {
      const activeMode = source.mode;
      const cursor = source.documentSeq;
      let page;
      try {
        page = await request(`document?after=${cursor}&documentId=${encodeURIComponent(documentId)}`);
      } catch (error) {
        // A consent or revision change between /live and this page is resolved by the next poll.
        if ([400, 403, 404, 409].includes(error.cause)) return;
        throw error;
      }
      if (source !== bridge || source.mode !== activeMode || document.hidden || page.documentId !== documentId) return;
      for (const operation of page.operations) {
        if (operation.seq !== source.documentSeq + 1) throw Error('Missing document operation');
        const action = sharedAction(documentActions, payloads, operation.actionId, operation.payload);
        if (operation.memberId === state.self.id) {
          const pending = outbox.find(item => item.id === operation.id);
          if (pending) pending.confirmed = true;
          if (personal.some(item => item.id === operation.id)) {
            personal = personal.filter(item => item.id !== operation.id);
            savePersonal();
          }
        }
        if (action) source.port.postMessage({
          type: 'document-operation', documentId, ...action, id: operation.id, seq: operation.seq,
          actor: operation.name, self: operation.memberId === state.self.id,
        });
        source.documentSeq = operation.seq;
      }
      return page.more === true;
    }
  }

  async function refresh() {
    if (refreshing || stopped) return;
    refreshing = true;
    let more = false;
    try {
      if (!project) updateProject(await request('config'));
      if (document.hidden) return;
      const source = bridge;
      const epoch = visibilityEpoch;
      const state = await request('live');
      if (epoch !== visibilityEpoch) return;
      if (project.rev !== state.rev) {
        resetBridge();
        updateProject(await request('config'));
      } else if (source && source === bridge) {
        more = await applyLive(source, state);
      }
    } catch (error) {
      stopped = [401, 403, 404, 410].includes(error.cause);
      if (stopped) {
        for (const item of outbox) keepLocal(item);
        outbox = [];
        if (outboxKey) saveOutbox();
        resetBridge();
      } else disconnectNetwork(bridge);
    } finally {
      refreshing = false;
      schedule(more ? 0 : 160);
    }
  }

  document.addEventListener('visibilitychange', () => {
    visibilityEpoch++;
    if (document.hidden) disconnectNetwork(bridge);
    else schedule();
  });

  void refresh();
}
