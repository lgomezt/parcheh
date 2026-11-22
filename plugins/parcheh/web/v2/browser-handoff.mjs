// Only the public ID travels to the local agent. The receipt stays in this tab.
const hex = bytes => Array.from(crypto.getRandomValues(new Uint8Array(bytes)),
  byte => byte.toString(16).padStart(2, '0')).join('');

function read(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function store(key,value) {
  try { sessionStorage.setItem(key,value); return true; } catch { return false; }
}

export function restoreBrowser(link) {
  const room = link.pathname.split('/')[2];
  if (!read('parcheh:browser:' + room) || read('parcheh:invitation:' + link.pathname) !== link.hash) return false;
  location.replace('/view/' + room);
  return true;
}

export function prepareBrowserHandoff(link,onReady) {
  const room = link.pathname.split('/')[2];
  const key = 'parcheh:handoff:' + room;
  const fresh = () => ({id:hex(24), receipt:hex(32), claim:hex(24), invitation:link.hash});
  let record;
  try { record = JSON.parse(read(key)); } catch {}
  if (record?.invitation !== link.hash || !record.claim) record = fresh();
  let timer;
  let ready = false;
  function request(route) {
    const {id,receipt,claim} = record;
    return fetch('/api/rooms/' + room + '/tab-' + route, {
      method:'POST', headers:{Authorization:'Bearer ' + link.hash.slice(1), 'Content-Type':'application/json'},
      credentials:'omit', redirect:'error', cache:'no-store', keepalive:route === 'ack',
      body:JSON.stringify(route === 'register' ? {id,receipt} : {id,receipt,claim}),
    });
  }
  async function poll() {
    try {
      store(key, JSON.stringify(record));
      const response = await request(record.registered ? 'receive' : 'register');
      if (response.status === 403) {
        onReady(null,'expired');
        return;
      }
      if (response.status === 410) {
        record = fresh();
        ready = false;
        onReady(null);
      } else if (response.ok) {
        const result = await response.json();
        if (result.browserToken && /^[A-Za-z0-9_-]{43}$/.test(result.browserToken)) {
          const saved = store('parcheh:browser:' + room,result.browserToken);
          store('parcheh:invitation:' + link.pathname,link.hash);
          try {
            sessionStorage.removeItem(key);
            if (result.app) sessionStorage.setItem('parcheh:app:' + room,result.app);
            else sessionStorage.removeItem('parcheh:app:' + room);
          } catch {}
          // The stable claim lets an interrupted response retry until the tab stores the grant.
          if (saved) void request('ack').catch(()=>{});
          const fragment = '#' + result.browserToken + (result.app ? '&app=' + encodeURIComponent(result.app) : '');
          location.replace('/view/' + room + (saved ? '' : fragment));
          return;
        }
        record.registered = true;
        store(key,JSON.stringify(record));
        if (!ready) {
          ready = true;
          onReady(link.href + '&handoff=' + record.id);
        }
      } else {
        ready = false;
        onReady(null,response.status === 404 ? 'unavailable' : 'retry');
      }
    } catch { ready = false; onReady(null,'retry'); }
    timer = setTimeout(poll,1200);
  }
  addEventListener('pagehide',()=>clearTimeout(timer));
  addEventListener('pageshow',event=>{ if (event.persisted) location.reload(); });
  void poll();
}
