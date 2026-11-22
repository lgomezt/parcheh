// This module runs in the outer document. Project code never receives the invitation.
export async function copyText(value) {
  try { await navigator.clipboard.writeText(value); return true; } catch { /* Same-Wi-Fi HTTP may have no clipboard API. */ }
  const field = document.createElement('textarea');
  field.value = value;
  field.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(field);
  const focused = document.activeElement;
  field.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch {}
  field.remove();
  focused?.focus({ preventScroll:true });
  return copied;
}

const room = /^\/view\/([a-f0-9-]+)$/.exec(location.pathname)?.[1];
if (room) mount(room).catch(() => {});

async function mount(room) {
  let token = location.hash.slice(1).split('&')[0];
  try { token ||= sessionStorage.getItem('parcheh:browser:' + room); } catch {}
  if (!token) return;
  const response = await fetch('/api/rooms/' + room + '/invite', {
    headers:{Authorization:'Bearer ' + token}, redirect:'error', credentials:'omit', cache:'no-store',
  });
  if (!response.ok) return;
  const invite = new URL((await response.json()).inviteUrl);
  if (invite.pathname !== '/r/' + room || !/^#[a-zA-Z0-9_-]+$/.test(invite.hash) || !['http:','https:'].includes(invite.protocol)) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.title = 'Copy invite link · drag to move';
  button.setAttribute('aria-label', 'Copy invite link');
  button.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:3;width:40px;height:40px;display:grid;place-items:center;border:1px solid #8887;border-radius:50%;background:#fff;color:#24312f;box-shadow:0 1px 6px #0002;cursor:pointer;touch-action:none';
  button.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m10 14 4-4m-6 3-1.5 1.5a3.5 3.5 0 0 0 5 5L15 16m1-5 1.5-1.5a3.5 3.5 0 0 0-5-5L9 8"/></svg>';
  const icon = button.innerHTML;
  let drag, dragged = false, reset, manual;
  const frame = document.querySelector('iframe');
  function position(x,y) {
    button.style.left = Math.max(0, Math.min(innerWidth - 40, x)) + 'px';
    button.style.top = Math.max(0, Math.min(innerHeight - 40, y)) + 'px';
    button.style.right = 'auto'; button.style.bottom = 'auto';
  }
  button.onpointerdown = e => {
    if (!e.isPrimary || e.button !== 0 || drag) return;
    const box = button.getBoundingClientRect();
    drag = { pointerId:e.pointerId, x:e.clientX, y:e.clientY, left:box.left, top:box.top, frameEvents:frame.style.pointerEvents };
    // Chromium can route the first move to the underlying iframe before capture takes effect.
    frame.style.pointerEvents = 'none';
    dragged = false;
    button.setPointerCapture(e.pointerId);
  };
  button.onpointermove = e => {
    if (drag?.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx,dy)>4) dragged = true;
    if (dragged) position(drag.left+dx, drag.top+dy);
  };
  function endDrag(e) {
    if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.pointerId)) return;
    frame.style.pointerEvents = drag.frameEvents;
    drag = null;
  }
  button.onpointerup = endDrag;
  button.onpointercancel = endDrag;
  button.onlostpointercapture = endDrag;
  addEventListener('blur', endDrag);
  addEventListener('resize', () => {
    if (!button.style.left) return;
    const box = button.getBoundingClientRect();
    position(box.left, box.top);
  });
  button.onclick = async e => {
    if (dragged && e.detail) { dragged = false; return; }
    if (await copyText(invite.href)) {
      button.title = 'Invite copied';
      button.setAttribute('aria-label', 'Invite copied');
      button.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m4 10 4 4 8-9"/></svg>';
      clearTimeout(reset);
      reset = setTimeout(() => {button.title='Copy invite link · drag to move';button.setAttribute('aria-label','Copy invite link');button.innerHTML=icon;},2000);
    } else {
      manual?.remove();
      manual=document.createElement('input');
      manual.readOnly=true; manual.value=invite.href; manual.setAttribute('aria-label','Invite link');
      manual.style.cssText='position:fixed;bottom:56px;right:12px;width:min(24rem,85vw);z-index:4';
      document.body.append(manual); manual.select();
      manual.onblur=()=>manual?.remove();
      manual.onkeydown=e=>{if(e.key==='Escape') button.focus();};
    }
  };
  document.body.append(button);
}
