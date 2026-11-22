import { copyText } from '/invite.mjs';
import { invalidDisplayName, normalizeDisplayName } from '/display-name.mjs';

const element = id => document.getElementById(id);
const link = new URL(location.pathname + location.hash, location.origin);
const invitationKey = 'parcheh:invitation:' + link.pathname;
const preferenceKey = 'parcheh:join-preferences';
const invitePattern = /^#[a-zA-Z0-9_-]{16,256}$/;
const clients = {
  codex: { name: 'Codex', compose: 'codex://new', parameter: 'prompt', installer: 'parcheh-codex-macos-arm64.zip' },
  'claude-code': { name: 'Claude Code', compose: 'claude://code/new', parameter: 'q' },
  antigravity: { name: 'Antigravity', installer: 'parcheh-antigravity-macos-arm64.zip' },
};
const desktopInstaller = 'parcheh-claude-desktop-macos-arm64.mcpb';
const antigravityRelease = 'https://github.com/lgomezt/parcheh/releases/latest/download/parcheh-antigravity-macos-arm64.zip';
const setupHint = '\nIf parcheh is missing, help me install it from https://github.com/lgomezt/parcheh before joining.';

if (link.hash) history.replaceState(null, '', link.pathname);
try {
  if (invitePattern.test(link.hash)) sessionStorage.setItem(invitationKey, link.hash);
  else if (!link.hash) link.hash = sessionStorage.getItem(invitationKey) || '';
} catch { /* The invite remains usable with storage disabled. */ }

if (invitePattern.test(link.hash)) mount();
else element('message').textContent = 'Ask your collaborator for the complete invitation.';

function mount() {
  const name = element('name');
  const choices = [...document.querySelectorAll('input[name="client"]')];
  const selectedClient = () => clients[choices.find(choice => choice.checked).value];
  const open = element('open');
  const openAntigravity = element('open-antigravity');
  const copy = element('copy');
  const manual = element('manual');
  const status = element('status');
  const readyText = () => 'Paste the join request into a ' + selectedClient().name + ' chat with parcheh enabled.';
  let files = [];
  let interaction = 0;

  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey));
    if (typeof saved?.name === 'string') name.value = saved.name.slice(0, 40);
    const savedChoice = choices.find(choice => choice.value === saved?.client);
    if (savedChoice) savedChoice.checked = true;
  } catch { /* Preferences are optional. */ }
  element('flow').hidden = false;

  function remember() {
    try {
      localStorage.setItem(preferenceKey, JSON.stringify({
        client: choices.find(choice => choice.checked).value,
        name: name.value,
      }));
    } catch { /* The current selection remains available. */ }
  }

  function refresh() {
    const client = selectedClient();
    open.hidden = !client.compose;
    open.textContent = 'Open ' + client.name;
    openAntigravity.hidden = Boolean(client.compose);
    const help = element('help');
    const download = element('download');
    const isAntigravity = client === clients.antigravity;
    const isCodex = client === clients.codex;
    const hasPackage = files.includes(client.installer);
    element('marketplace').hidden = isAntigravity;
    element('codex-setup').hidden = !isCodex;
    element('claude-setup').hidden = isCodex;
    help.hidden = download.hidden = !hasPackage && !isAntigravity;
    if (!download.hidden) {
      download.href = hasPackage ? '/downloads/' + client.installer : antigravityRelease;
      help.textContent = 'Open the Apple silicon Mac ZIP and follow the included installation guide.';
    } else {
      download.removeAttribute('href');
    }
    element('desktop-chat').hidden = !files.includes(desktopInstaller);
    if (files.includes(desktopInstaller)) element('desktop-download').href = '/downloads/' + desktopInstaller;
  }

  function resetFeedback() {
    interaction += 1;
    status.textContent = '';
    manual.hidden = true;
    element('name-error').textContent = '';
    name.removeAttribute('aria-invalid');
  }

  function joinRequest() {
    const displayName = normalizeDisplayName(name.value);
    if (name.value.trim() && !displayName) {
      element('name-error').textContent = invalidDisplayName;
      name.setAttribute('aria-invalid', 'true');
      name.focus();
      return null;
    }
    return 'Join this parcheh room: ' + link.href +
      (displayName ? '\nUse ' + JSON.stringify(displayName) + ' as my display name.' : '');
  }

  async function copyRequest() {
    const request = joinRequest();
    if (!request) return false;
    const attempt = ++interaction;
    const copied = await copyText(request);
    if (attempt !== interaction) return false;
    manual.hidden = copied;
    if (copied) {
      status.textContent = 'Copied. ' + readyText();
    } else {
      status.textContent = 'Select and copy this request. ' + readyText();
      manual.value = request;
      manual.focus();
      manual.select();
    }
    return copied;
  }

  copy.onclick = copyRequest;
  openAntigravity.onclick = async () => {
    if (await copyRequest()) location.assign('antigravity://');
  };
  open.onclick = event => {
    const request = joinRequest();
    const client = selectedClient();
    if (!request || !client.compose) {
      event.preventDefault();
      return;
    }
    resetFeedback();
    const compose = new URL(client.compose);
    compose.searchParams.set(client.parameter, request + setupHint);
    // Put the invitation in the native app URL only during activation.
    open.href = compose.href;
    setTimeout(() => open.setAttribute('href', '#'), 0);
    status.textContent = 'If ' + client.name + ' opens, review and send the prepared request.';
  };
  name.oninput = () => { remember(); resetFeedback(); };
  for (const choice of choices) choice.onchange = () => { remember(); resetFeedback(); refresh(); };

  const source = element('source');
  const copySource = element('copy-source');
  copySource.onclick = async () => {
    if (await copyText(source.value)) copySource.textContent = 'Marketplace address copied';
    else { source.focus(); source.select(); }
  };

  refresh();
  fetch('/downloads', { credentials: 'omit', redirect: 'error' })
    .then(response => response.ok ? response.json() : {})
    .then(available => {
      files = Array.isArray(available?.files) ? available.files : [];
      refresh();
    })
    .catch(() => {});
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
    if (response.status !== 200 || response.headers.get('content-type') !== 'image/png' || declaredLength > limit) return;
    const image = await response.blob();
    if (image.size > limit) return;
    const preview = element('preview');
    const previewUrl = URL.createObjectURL(image);
    preview.onload = () => { preview.hidden = false; URL.revokeObjectURL(previewUrl); };
    preview.onerror = () => URL.revokeObjectURL(previewUrl);
    preview.src = previewUrl;
  } catch { /* The invitation is usable without a preview. */ }
}
