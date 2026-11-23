import { copyText } from '/invite.mjs';
import { prepareBrowserHandoff, restoreBrowser } from '/browser-handoff.mjs';

const element = id => document.getElementById(id);
const link = new URL(location.pathname + location.hash, location.origin);
const invitationKey = 'parcheh:invitation:' + link.pathname;
const invitePattern = /^#[a-zA-Z0-9_-]{16,256}$/;
const clients = {
  codex: { compose: 'codex://new', parameter: 'prompt' },
  'claude-code': { compose: 'claude://code/new', parameter: 'q' },
};
const setupHint = '\nIf parcheh is missing, help me install it from https://github.com/lgomezt/parcheh before joining.';

if (!link.hash) {
  try { link.hash = sessionStorage.getItem(invitationKey) || ''; } catch {}
  if (invitePattern.test(link.hash)) history.replaceState(null,'',link.href);
}
if (invitePattern.test(link.hash)) {
  if (!restoreBrowser(link)) mount();
} else element('message').textContent = 'Ask your collaborator for the complete invitation.';

function launchApp(url) {
  const launch = document.createElement('a');
  launch.id = 'native-launch';
  launch.hidden = true;
  launch.href = url;
  document.body.append(launch);
  launch.click();
  launch.remove();
}

function mount() {
  const choices = [...document.querySelectorAll('[data-client]')];
  const other = choices.find(choice => choice.dataset.client === 'other');
  const prompt = element('prompt');
  const manual = element('manual');
  const status = element('status');
  let selection;
  let preparedUrl;
  let interaction = 0;
  let activeClaimToken = null;
  let activeEmailParam = null;
  const handoffUnavailable = 'Choose an agent to join without connecting this tab.';

  const room = /^\/r\/([a-f0-9-]+)$/.exec(link.pathname)?.[1];
  let policy = { sharingMode: 'instant' };
  async function fetchPolicy() {
    try {
      let res = await fetch('/v1/rooms/' + room + '/policy').catch(() => null);
      if (!res || !res.ok) res = await fetch('/api/rooms/' + room + '/policy').catch(() => null);
      if (res && res.ok) policy = await res.json().catch(() => ({ sharingMode: 'instant' }));
    } catch {}
    if (policy.sharingMode === 'email') {
      const gate = element('email-gate');
      if (gate) gate.hidden = false;
    } else if (policy.sharingMode === 'restricted') {
      const gate = element('email-gate');
      if (gate) gate.hidden = false;
      const label = document.querySelector('label[for="guest-email"]');
      if (label) label.textContent = 'Enter your verified email';
      const hint = element('email-hint');
      if (hint) hint.textContent = policy.domainHint ? 'Requires verified ' + policy.domainHint + ' email' : 'Requires verified email';
    }
  }
  fetchPolicy();

  function buildJoinRequest(token, emailHint = activeEmailParam) {
    let urlStr = preparedUrl || link.href;
    if (token) urlStr += '&claim=' + token;
    else if (emailHint) urlStr += '&email=' + encodeURIComponent(emailHint);
    return 'Join this parcheh room: ' + urlStr;
  }

  function showPrompt(request) {
    manual.value = request;
    prompt.hidden = false;
  }

  for (const choice of choices) choice.onclick = async () => {
    const attempt = ++interaction;
    selection = choice;
    for (const option of choices) option.setAttribute('aria-pressed', String(option === choice));
    status.textContent = '';
    prompt.hidden = true;
    manual.value = '';

    if (policy.sharingMode === 'email') {
      const emailInput = element('guest-email');
      const emailVal = emailInput?.value?.trim() || '';
      if (!emailVal || !emailVal.includes('@')) {
        const hint = element('email-hint');
        if (hint) hint.textContent = 'Enter your email to join right away.';
        emailInput?.focus();
        for (const opt of choices) opt.setAttribute('aria-pressed', 'false');
        return;
      }
      try {
        let res = await fetch('/v1/auth/provisional', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: emailVal }),
        }).catch(() => null);
        if (!res || !res.ok) {
          res = await fetch('/api/auth/provisional', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: emailVal }),
          }).catch(() => null);
        }
        if (res && res.ok) {
          const prov = await res.json().catch(() => null);
          if (prov?.claimToken) activeClaimToken = prov.claimToken;
        }
      } catch {}
    } else if (policy.sharingMode === 'restricted') {
      const emailVal = element('guest-email')?.value?.trim() || '';
      activeEmailParam = emailVal.includes('@') ? emailVal : null;
    } else if (policy.sharingMode === 'instant') {
      const claimSection = element('claim-section');
      if (claimSection) claimSection.hidden = false;
    }

    const request = buildJoinRequest(activeClaimToken);
    const client = clients[choice.dataset.client];
    if (client) {
      const compose = new URL(client.compose);
      compose.searchParams.set(client.parameter, request + setupHint);
      launchApp(compose.href);
      return;
    }
    if (choice === other) {
      showPrompt(request);
      return;
    }
    const copied = await copyText(request);
    if (attempt !== interaction) return;
    showPrompt(request);
    if (copied) {
      status.textContent = 'Copied.';
      launchApp('antigravity://');
    } else {
      manual.focus();
      manual.select();
      status.textContent = 'Select and copy the prompt.';
    }
  };

  const claimInput = element('claim-email');
  if (claimInput) {
    claimInput.onchange = async () => {
      const emailVal = claimInput.value.trim();
      if (!emailVal || !emailVal.includes('@')) return;
      try {
        let res = await fetch('/v1/auth/claim-email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: emailVal }),
        }).catch(() => null);
        if (!res || !res.ok) {
          res = await fetch('/api/rooms/' + room + '/claim-email', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: emailVal }),
          }).catch(() => null);
        }
        if (res && res.ok) {
          const claimed = await res.json().catch(() => null);
          if (claimed?.claimToken) {
            activeClaimToken = claimed.claimToken;
            if (!prompt.hidden) showPrompt(buildJoinRequest(activeClaimToken));
          }
        }
        const claimStatus = element('claim-status');
        if (claimStatus) claimStatus.textContent = 'Email saved.';
      } catch {}
    };
  }

  element('copy').onclick = async () => {
    const attempt = ++interaction;
    const copied = await copyText(manual.value);
    if (attempt !== interaction) return;
    status.textContent = copied ? 'Copied.' : 'Select and copy the prompt.';
    if (!copied) {
      manual.focus();
      manual.select();
    }
  };

  prepareBrowserHandoff(link, (url, state) => {
    preparedUrl = url;
    if (state === 'expired') status.textContent = 'This invitation is no longer valid. Ask the host for a new link.';
    else if (state === 'retry') status.textContent = 'Reconnecting to the room…';
    else if (url && status.textContent === 'Reconnecting to the room…') status.textContent = '';
    const waiting = !url && state !== 'unavailable';
    for (const choice of choices) choice.disabled = waiting;
    element('copy').disabled = waiting;
    if (state === 'unavailable' && !selection) status.textContent = handoffUnavailable;
    else if (url && status.textContent === handoffUnavailable) status.textContent = '';
    if (!waiting && !prompt.hidden && selection === other) showPrompt(buildJoinRequest(activeClaimToken));
  });
  element('flow').hidden = false;
  showPreview();
}

async function showPreview() {
  const room = /^\/r\/([a-f0-9-]+)$/.exec(link.pathname)?.[1];
  if (!room) return;
  try {
    const response = await fetch('/api/rooms/' + room + '/invite-preview', {
      headers: { Authorization: 'Bearer ' + link.hash.slice(1) },
      credentials: 'omit', cache: 'no-store', redirect: 'error',
    });
    const limit = 512 * 1024;
    const declaredLength = Number(response.headers.get('content-length'));
    if (response.status === 200 && response.headers.get('content-type') === 'image/png' && declaredLength <= limit) {
      const image = await response.blob();
      if (image.size <= limit) {
        const preview = element('preview');
        const previewUrl = URL.createObjectURL(image);
        preview.onload = () => { preview.hidden = false; URL.revokeObjectURL(previewUrl); };
        preview.onerror = () => URL.revokeObjectURL(previewUrl);
        preview.src = previewUrl;
        return;
      }
    }
  } catch {}
  try {
    const response = await fetch('/v1/rooms/' + room + '/poster.enc', {
      credentials: 'omit', cache: 'no-store', redirect: 'error',
    });
    if (response.status !== 200) return;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 28 || bytes.length > 512 * 1024 + 28) return;
    const iv = bytes.slice(0, 12);
    const ct = bytes.slice(12);
    const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(link.hash.slice(1)), 'HKDF', false, ['deriveKey']);
    const posterKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode(room),
        info: new TextEncoder().encode('parcheh-v1:poster'),
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: new TextEncoder().encode('parcheh-poster:' + room),
      },
      posterKey,
      ct
    );
    const decBytes = new Uint8Array(decrypted);
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (decBytes.length < 8 || decBytes.length > 512 * 1024 || !pngSignature.every((b, i) => decBytes[i] === b)) return;
    const image = new Blob([decBytes], { type: 'image/png' });
    const preview = element('preview');
    const previewUrl = URL.createObjectURL(image);
    preview.onload = () => { preview.hidden = false; URL.revokeObjectURL(previewUrl); };
    preview.onerror = () => URL.revokeObjectURL(previewUrl);
    preview.src = previewUrl;
  } catch {}
}
