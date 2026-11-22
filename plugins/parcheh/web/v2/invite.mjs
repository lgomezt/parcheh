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

export async function mountInvite(room,token) {
  if (!token) return;
  const response = await fetch('/api/rooms/' + room + '/invite', {
    headers:{Authorization:'Bearer ' + token}, redirect:'error', credentials:'omit', cache:'no-store',
  });
  if (!response.ok) return;
  const invite = new URL((await response.json()).inviteUrl);
  if (invite.pathname !== '/r/' + room || !/^#[a-zA-Z0-9_-]+$/.test(invite.hash) || !['http:','https:'].includes(invite.protocol)) return;
  if (invite.origin === location.origin) {
    try { sessionStorage.setItem('parcheh:invitation:' + invite.pathname,invite.hash); } catch {}
    history.replaceState(null,'',invite.href);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', 'Share the session');
  button.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:3;width:40px;height:40px;display:grid;place-items:center;border:1px solid #8887;border-radius:50%;background:#fff;color:#24312f;box-shadow:0 1px 6px #0002;cursor:pointer;touch-action:none';
  const glyph = document.createElement('span');
  glyph.style.display = 'grid';
  const icon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3m-4 4 4-4 4 4M7 10H5v10h14V10h-2"/></svg>';
  glyph.innerHTML = icon;
  const tooltip = document.createElement('span');
  tooltip.hidden = true;
  tooltip.setAttribute('role', 'tooltip');
  tooltip.textContent = 'Share the session';
  tooltip.style.cssText = 'position:absolute;bottom:calc(100% + 6px);right:0;pointer-events:none;white-space:nowrap;padding:5px 8px;border-radius:5px;background:#24312f;color:#fff;font:12px/1.4 system-ui,sans-serif';
  button.append(glyph, tooltip);
  let hovering = false;
  function updateTooltip() {
    tooltip.hidden = Boolean(drag) || !(hovering || button.matches(':focus-visible'));
    if (tooltip.hidden) return;
    const bounds = button.getBoundingClientRect();
    tooltip.style.left = bounds.right < tooltip.offsetWidth + 4 ? '0' : 'auto';
    tooltip.style.right = tooltip.style.left === '0px' ? 'auto' : '0';
    tooltip.style.bottom = bounds.top < tooltip.offsetHeight + 10 ? 'auto' : 'calc(100% + 6px)';
    tooltip.style.top = tooltip.style.bottom === 'auto' ? 'calc(100% + 6px)' : 'auto';
  }
  button.onpointerenter = () => { hovering = true; updateTooltip(); };
  button.onpointerleave = () => { hovering = false; updateTooltip(); };
  button.onfocus = button.onblur = updateTooltip;
  const feedback = document.createElement('span');
  feedback.setAttribute('role', 'status');
  feedback.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)';
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
    updateTooltip();
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
    updateTooltip();
  }
  button.onpointerup = endDrag;
  button.onpointercancel = endDrag;
  button.onlostpointercapture = endDrag;
  addEventListener('blur', endDrag);
  addEventListener('resize', () => {
    if (!button.style.left) return;
    const box = button.getBoundingClientRect();
    position(box.left, box.top);
    updateTooltip();
  });
  button.onclick = async e => {
    if (dragged && e.detail) { dragged = false; return; }
    if (await copyText(invite.href)) {
      feedback.textContent = 'Invite copied';
      glyph.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m4 10 4 4 8-9"/></svg>';
      clearTimeout(reset);
      reset = setTimeout(() => { feedback.textContent = ''; glyph.innerHTML = icon; }, 2000);
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
  document.body.append(button, feedback);
}
