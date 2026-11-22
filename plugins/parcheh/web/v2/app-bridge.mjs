const privateControls = [
  '[data-parcheh-private]', 'form', 'label', 'input', 'textarea', 'select',
  '[contenteditable]:not([contenteditable="false"])', '[role="textbox"]',
].join(',');
const noSharing = { pointers: false, actions: false, actionIds: [], payloads: {} };

export function validCoordinates(...values) {
  return values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1);
}

export function sharedAction(actionIds, payloads, actionId, payload) {
  if (typeof actionId !== 'string' || !actionIds.includes(actionId)) return null;
  const shape = Object.hasOwn(payloads, actionId) ? payloads[actionId] : undefined;
  if (shape === undefined) return payload === undefined ? { actionId } : null;
  const fields = shape === 'point' ? ['x', 'y'] : shape === 'segment' ? ['x', 'y', 'x2', 'y2'] : [];
  if (!fields.length || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (Object.keys(payload).length !== fields.length || !fields.every((key) => Object.hasOwn(payload, key))) return null;
  if (!validCoordinates(...fields.map((key) => payload[key]))) return null;
  return { actionId, payload: Object.fromEntries(fields.map((key) => [key, payload[key]])) };
}

export function cursorColor(index) {
  const base = ['#6941c6', '#006b75', '#b23d1a', '#a12a72'];
  if (Number.isInteger(index) && index >= 0 && index < base.length) return base[index];
  if (Number.isInteger(index) && index >= base.length) {
    return `hsl(${Math.round(index * 137.508) % 360} 68% 36%)`;
  }
  return '#6941c6';
}

export function trustedRoomOrigin(roomOriginParam, pageOrigin) {
  if (typeof roomOriginParam !== 'string' || !roomOriginParam) return null;
  let url;
  try {
    url = new URL(roomOriginParam);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const isPrivateLan = /^(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}$/.test(hostname)
    || /^\[?f[cd][0-9a-f]{2}:/i.test(url.hostname);
  if (url.origin === pageOrigin || isLoopback || isPrivateLan) {
    return url.origin;
  }
  return null;
}

let currentBridge;

export function connectParcheh({ stage, parentOrigin } = {}) {
  if (typeof window === 'undefined' || window.parent === window) return () => {};
  const pageUrl = new URL(location.href);
  let expected;
  if (parentOrigin) {
    try {
      expected = new URL(parentOrigin).origin;
    } catch {
      return () => {};
    }
  } else if (window.origin !== 'null' && pageUrl.searchParams.has('roomOrigin')) {
    expected = trustedRoomOrigin(pageUrl.searchParams.get('roomOrigin'), pageUrl.origin);
    if (!expected) return () => {};
  } else {
    try {
      expected = new URL(pageUrl.origin).origin;
    } catch {
      return () => {};
    }
  }
  if (currentBridge?.origin === expected) {
    if (stage instanceof HTMLElement) currentBridge.stage = stage;
    return currentBridge.disconnect;
  }
  currentBridge?.disconnect();

  const bridgeSecret = window.origin === 'null' ? null : new URLSearchParams(pageUrl.hash.slice(1)).get('parcheh-bridge');
  let challenge;
  let port;
  let sharing = noSharing;
  let localDocument;
  let lastPointer = -Infinity;
  let pointerTimer;
  let nextPointer;
  let hadPointer = false;
  let peers = [];
  let overlay;
  const markers = new Map();
  const listeners = new AbortController();
  const { signal } = listeners;
  const bridge = { origin: expected, stage, disconnect };
  currentBridge = bridge;

  function activeStage() {
    return bridge.stage?.isConnected
      ? bridge.stage
      : document.querySelector('[data-parcheh-stage]') || document.documentElement;
  }

  function announce() {
    window.parent.postMessage({
      type: 'parcheh:ready', challenge, title: document.title, path: location.pathname,
    }, expected);
  }

  function hidePointer() {
    clearTimeout(pointerTimer);
    nextPointer = null;
    if (hadPointer && sharing.pointers) port?.postMessage({ type: 'hide-pointer' });
    hadPointer = false;
  }

  function renderPointers() {
    const stage = activeStage();
    const visiblePeers = stage.closest(privateControls) ? [] : peers;
    for (const [id, marker] of markers) {
      if (visiblePeers.some((peer) => peer.memberId === id)) continue;
      marker.remove();
      markers.delete(id);
    }
    if (!visiblePeers.length) {
      overlay?.host.remove();
      overlay = undefined;
      return;
    }
    if (!overlay) {
      const layer = document.createElement('div');
      Object.assign(layer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647' });
      overlay = layer.attachShadow({ mode: 'open' });
      const css = document.createElement('style');
      css.textContent = `
        [data-parcheh-peer] { position:fixed; left:0; top:0; color:var(--cursor-color,#6941c6);
          pointer-events:none; will-change:transform; }
        svg { display:none; width:17px; height:21px; filter:drop-shadow(0 1px 1px #0005); }
        [data-positioned] svg { display:block; }
        .name { display:block; width:max-content; background:var(--cursor-color,#6941c6); color:white;
          border-radius:5px; padding:3px 7px; font:600 12px/15px system-ui; white-space:nowrap; }
        [data-positioned] .name { margin:-4px 0 0 12px; }
        [data-moving] { transition:transform 55ms linear; }
        [data-editing] .name::after { content:''; display:inline-block; width:8px; height:8px; margin-left:5px;
          border:1.5px solid #ffffff70; border-top-color:white; border-radius:50%; animation:spin .8s linear infinite; }
        @keyframes spin { to { transform:rotate(360deg) } }
        @media (prefers-reduced-motion: reduce) { [data-moving] { transition:none; } [data-editing] .name::after { animation:none; } }
      `;
      overlay.append(css);
      document.documentElement.append(layer);
    }
    const bounds = stage.getBoundingClientRect();
    let corner = 0;
    for (const peer of visiblePeers) {
      let marker = markers.get(peer.memberId);
      if (!marker) {
        marker = document.createElement('span');
        marker.dataset.parchehPeer = peer.memberId;
        const ns = 'http://www.w3.org/2000/svg';
        const arrow = document.createElementNS(ns,'svg');
        arrow.setAttribute('viewBox','0 0 17 21');
        arrow.setAttribute('aria-hidden','true');
        const path = document.createElementNS(ns,'path');
        path.setAttribute('d','M1 1L15.5 11.8L9 12.5L6 19Z');
        path.setAttribute('fill','currentColor');
        path.setAttribute('stroke','white');
        path.setAttribute('stroke-linejoin','round');
        arrow.append(path);
        const label = document.createElement('span');
        label.className = 'name';
        marker.append(arrow,label);
        overlay.append(marker);
        markers.set(peer.memberId, marker);
      }
      const positioned = validCoordinates(peer.x, peer.y);
      marker.toggleAttribute('data-moving', positioned && marker.hasAttribute('data-positioned'));
      marker.toggleAttribute('data-positioned', positioned);
      const x = bounds.left + (positioned ? peer.x * bounds.width : 8);
      const y = bounds.top + (positioned ? peer.y * bounds.height : 8 + 22 * corner++);
      marker.style.transform = `translate(${x}px, ${y}px)`;
      marker.toggleAttribute('data-editing', peer.editing === true);
      marker.style.setProperty('--cursor-color', cursorColor(peer.colorIndex));
      const label = `${peer.name}${peer.editing ? ' · Editing' : ''}`;
      if (marker.lastChild.textContent !== label) marker.lastChild.textContent = label;
    }
  }

  function clearPointers() {
    peers = [];
    renderPointers();
  }

  function disconnect() {
    hidePointer();
    clearPointers();
    port?.close();
    listeners.abort();
    titles.disconnect();
    if (currentBridge === bridge) currentBridge = undefined;
  }

  let title = document.title;
  const titles = new MutationObserver(() => {
    if (title === document.title) return;
    title = document.title;
    port?.postMessage({ type: 'title', title });
  });
  titles.observe(document.head || document.documentElement, { childList: true, subtree: true, characterData: true });

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== expected) return;
    const message = event.data;
    if (bridgeSecret && message?.bridgeToken !== bridgeSecret) return;
    if (message?.type === 'parcheh:probe' && typeof message.challenge === 'string') {
      challenge = message.challenge;
      announce();
      return;
    }
    if (message?.type !== 'parcheh:connected' || !challenge || message.challenge !== challenge || !event.ports[0]) return;
    port?.close();
    port = event.ports[0];
    sharing = noSharing;
    clearPointers();
    port.onmessage = ({ data }) => {
      if (data?.type === 'sharing') {
        sharing = data;
        if (Object.hasOwn(data, 'documentId')) localDocument = data.documentId ? data : null;
        if (!sharing.pointers) {
          hadPointer = false;
          clearPointers();
        }
      } else if (data?.type === 'pointers' && Array.isArray(data.peers)) {
        peers = sharing.pointers ? data.peers : data.peers
          .filter(peer => peer.editing === true)
          .map(({ memberId, name }) => ({ memberId, name, editing: true }));
        renderPointers();
      } else if (['document-pending','document-refused'].includes(data?.type) && data.documentId === localDocument?.documentId) {
        const action = sharedAction(localDocument.documentActions, localDocument.payloads, data.actionId, data.payload);
        if (action) activeStage().dispatchEvent(new CustomEvent('parcheh:' + data.type, { detail: { ...action, id:data.id } }));
      } else if (data?.type === 'document-private' && data.documentId === sharing.documentId) {
        activeStage().dispatchEvent(new CustomEvent('parcheh:document-private', { detail: { operations: data.operations } }));
      } else if (data?.type === 'document-reset' && data.documentId === sharing.documentId) {
        activeStage().dispatchEvent(new CustomEvent('parcheh:document-reset', { detail: { documentId: data.documentId } }));
      } else if (data?.type === 'document-operation' && sharing.actions && data.documentId === sharing.documentId) {
        const action = sharedAction(sharing.documentActions, sharing.payloads, data.actionId, data.payload);
        if (action) activeStage().dispatchEvent(new CustomEvent('parcheh:document-operation', {
          detail: { ...action, documentId: data.documentId, id: data.id, seq: data.seq, actor: data.actor, self: data.self },
        }));
      } else if (data?.type === 'action' && sharing.actions) {
        const action = sharedAction(sharing.actionIds, sharing.payloads, data.actionId, data.payload);
        if (action) activeStage().dispatchEvent(new CustomEvent('parcheh:action', {
          detail: { ...action, actor: data.actor, seq: data.seq, self: data.self },
        }));
      }
    };
  }, { signal });

  function pointermove(event) {
    if (!event.isTrusted || !sharing.pointers) return;
    const stage = activeStage();
    const path = event.composedPath();
    if (!path.includes(stage) || path.some((node) => node instanceof Element && node.matches(privateControls))) {
      hidePointer();
      return;
    }
    const now = performance.now();

    const bounds = stage.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    if (!validCoordinates(x, y)) {
      hidePointer();
      return;
    }
    nextPointer = { type: 'pointer', x, y };
    clearTimeout(pointerTimer);
    const emit = () => {
      if (!nextPointer || !sharing.pointers) return;
      lastPointer = performance.now();
      hadPointer = true;
      port?.postMessage(nextPointer);
      nextPointer = null;
    };
    if (now - lastPointer >= 32) emit();
    else pointerTimer = setTimeout(emit, 32 - (now - lastPointer));
  }

  function publish(actionId, payload, event) {
    if (!sharing.actions) return;
    const action = sharedAction(sharing.actionIds, sharing.payloads, actionId, payload);
    if (!action) return;
    if (sharing.documentId && sharing.documentActions?.includes(actionId)) {
      // Only an explicit app publication may append a durable operation.
      if (!event?.cancelable) return;
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      const id = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
      event.preventDefault();
      activeStage().dispatchEvent(new CustomEvent('parcheh:document-pending', {detail:{id, ...action}}));
      port.postMessage({ type:'document', documentId:sharing.documentId, epoch:sharing.epoch, id, ...action });
    } else {
      port?.postMessage({ type: 'action', ...action });
    }
  }

  document.addEventListener('pointermove', pointermove, { capture: true, passive: true, signal });
  document.addEventListener('pointerout', (event) => {
    if (event.isTrusted && !event.relatedTarget) hidePointer();
  }, { capture: true, passive: true, signal });
  window.addEventListener('blur', hidePointer, { signal });
  window.addEventListener('resize', renderPointers, { signal });
  document.addEventListener('scroll', renderPointers, { capture: true, passive: true, signal });

  document.addEventListener('click', (event) => {
    if (!event.isTrusted || !sharing.actions) return;
    const stage = activeStage();
    const path = event.composedPath();
    if (!path.includes(stage) || path.some((node) => node instanceof Element && node.matches(privateControls))) return;
    const control = path.find((node) => node instanceof Element && stage.contains(node) && node.hasAttribute('data-parcheh-action'));
    if (control) publish(control.getAttribute('data-parcheh-action'));
  }, { capture: true, signal });
  document.addEventListener('parcheh:publish', (event) => {
    const stage = activeStage();
    if (event.target === stage && !stage.closest(privateControls)) {
      publish(event.detail?.actionId, event.detail?.payload, event);
    }
  }, { capture: true, signal });

  document.addEventListener('parcheh:save-private', (event) => {
    if (event.target !== activeStage() || !localDocument) return;
    const action = sharedAction(localDocument.documentActions, localDocument.payloads, event.detail?.actionId, event.detail?.payload);
    if (action) port.postMessage({ type: 'document-private', documentId: localDocument.documentId, ...action });
  }, { capture: true, signal });

  announce();
  return disconnect;
}

if (typeof window !== 'undefined' && window.parent !== window) connectParcheh();
