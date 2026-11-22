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
  const request = 'Join this Parcheh room: ' + link.href;
  copy.hidden = false;
  copy.onclick = async () => {
    if (await copyText(request)) copy.textContent = 'Copied';
    else {
      const input = document.querySelector('#manual');
      input.value = request; input.hidden = false; input.select();
    }
  };
} else document.querySelector('#message').textContent = 'Ask your friend for the complete invitation.';

const source = document.querySelector('#source');
const copySource = document.querySelector('#copy-source');
copySource.onclick = async () => {
  if (await copyText(source.value)) copySource.textContent = 'Copied';
  else source.select();
};

const client = document.querySelector('#client');
const help = document.querySelector('#help');
const download = document.querySelector('#download');
let files = [];
function select() {
  const claudeCode = client.value === 'claude-code';
  document.querySelector('#marketplace').hidden = !claudeCode;
  help.hidden = claudeCode;
  const file = 'parcheh-' + client.value;
  const available = !claudeCode && files.includes(file);
  download.hidden = !available;
  download.removeAttribute('href');
  if (claudeCode) return;
  if (available) {
    download.href = '/downloads/' + file;
    help.textContent = client.value.endsWith('.mcpb') ? 'Open Claude Settings → Extensions to install the downloaded file.' : 'Open the downloaded ZIP and follow the included installation guide.';
  } else {
    help.textContent = 'Ask your host for the Apple silicon Mac package for ' + client.selectedOptions[0].textContent + '.';
  }
}
client.onchange = select;
const available = await fetch('/downloads',{credentials:'omit',redirect:'error'})
  .then(r => r.ok ? r.json() : {}).catch(() => ({}));
files = Array.isArray(available.files) ? available.files : [];
select();
