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
  const handoffUnavailable = 'Choose an agent to join without connecting this tab.';

  function buildJoinRequest() {
    return 'Join this parcheh room: ' + (preparedUrl || link.href);
  }

  function showPrompt(request) {
    manual.value = request;
    prompt.hidden = false;
  }

  for (const choice of choices) choice.onclick = async () => {
    const attempt = ++interaction;
    selection = choice;
    other.setAttribute('aria-pressed', String(choice === other));
    status.textContent = '';
    prompt.hidden = true;
    manual.value = '';
    const request = buildJoinRequest();
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
    if (!waiting && !prompt.hidden && selection === other) showPrompt(buildJoinRequest());
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
