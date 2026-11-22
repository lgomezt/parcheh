import { copyText } from '/invite.mjs';
const link = new URL(location.href);
const copy = document.querySelector('#copy');
const key = 'parcheh:invitation:' + link.pathname;
try {
  if (link.hash) sessionStorage.setItem(key,link.hash);
  else link.hash = sessionStorage.getItem(key) || '';
} catch {}
if (/^#[a-zA-Z0-9_-]{16,256}$/.test(link.hash)) {
  history.replaceState(null, '', link.pathname);
  copy.hidden = false;
  copy.onclick = async () => {
    if (await copyText(link.href)) copy.textContent = 'Copied';
    else {
      const input = document.querySelector('#manual');
      input.value = link.href; input.hidden = false; input.select();
    }
  };
} else document.querySelector('#message').textContent = 'Ask your friend for the complete invitation.';
const client = document.querySelector('#client');
function select() {
  document.querySelector('#download').href = '/downloads/parcheh-' + client.value;
  document.querySelector('#help').textContent = client.value.endsWith('.mcpb') ? 'Open Claude Settings → Extensions to install the downloaded file.' : 'Open the downloaded ZIP and follow the included installation guide.';
}
const available = await fetch('/downloads',{credentials:'omit',redirect:'error'})
  .then(r => r.ok ? r.json() : {}).catch(() => ({}));
const files = Array.isArray(available.files) ? available.files : [];
for (const option of [...client.options]) {
  if (!files.includes('parcheh-' + option.value)) option.remove();
}
if (client.options.length) {
  client.hidden = false; document.querySelector('#download').hidden = false;
  client.onchange = select;
  select();
} else {
  document.querySelector('#intro').textContent = 'Ask the person who invited you for the Parcheh extension for your desktop app. After installation, paste this invitation into your chat.';
}
