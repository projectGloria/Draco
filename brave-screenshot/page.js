// Functions are serialized by chrome.scripting; keep them self-contained.
export async function pageAction(action, args = {}) {
  const key = '__frameScreenshotSession';
  const metrics = () => ({
    width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0, innerWidth),
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, innerHeight),
    viewportWidth: innerWidth, viewportHeight: innerHeight,
    contentWidth: document.documentElement.clientWidth,
    contentHeight: document.documentElement.clientHeight,
    x: scrollX, y: scrollY, scale: devicePixelRatio
  });
  if (action === 'metrics') return metrics();
  if (action === 'restore') { globalThis[key]?.restore(); return; }
  if (action === 'prepare') {
    globalThis[key]?.restore();
    const x = scrollX, y = scrollY;
    const style = document.createElement('style');
    style.textContent = 'html,body{scroll-behavior:auto!important;scroll-snap-type:none!important;overflow-anchor:none!important}*{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}';
    document.documentElement.append(style);
    const hidden = [];
    const session = { style, hidden, restore() {
      clearTimeout(session.timer);
      for (const [element, value, priority] of hidden) {
        if (value) element.style.setProperty('visibility', value, priority);
        else element.style.removeProperty('visibility');
      }
      window.scrollTo(x, y);
      style.remove();
      delete globalThis[key];
    } };
    globalThis[key] = session;
    session.timer = setTimeout(session.restore, 15000);
    return metrics();
  }
  const session = globalThis[key];
  if (!session) throw new Error('The page changed during capture. Please try again.');
  clearTimeout(session.timer);
  session.timer = setTimeout(session.restore, 15000);
  if (args.hidePinned && !session.pinnedHidden) {
    for (const element of document.querySelectorAll('body *')) {
      const position = getComputedStyle(element).position;
      if (position === 'fixed' || position === 'sticky') {
        session.hidden.push([element, element.style.getPropertyValue('visibility'), element.style.getPropertyPriority('visibility')]);
        element.style.setProperty('visibility', 'hidden', 'important');
      }
    }
    session.pinnedHidden = true;
  }
  window.scrollTo(args.x, args.y);
  await new Promise(resolve => setTimeout(resolve, 220));
  return metrics();
}

export function selectArea() {
  return new Promise(resolve => {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      :host{color-scheme:dark} .overlay{position:fixed;inset:0;cursor:crosshair;touch-action:none;outline:none;background:#10131b33}
      .hint{position:absolute;top:24px;left:50%;transform:translateX(-50%);padding:14px 20px;border:1px solid #ffffff30;border-radius:12px;background:#171a24;color:white;font:14px system-ui;pointer-events:none;white-space:nowrap}
      .box{position:absolute;display:none;border:2px solid #b7a0ff;background:transparent;box-sizing:border-box;box-shadow:0 0 0 100vmax #10131b88;pointer-events:none}
      .size{position:absolute;bottom:8px;left:8px;padding:4px 8px;background:#171a24;color:white;border-radius:5px;font:12px system-ui;white-space:nowrap}
    </style><div class="overlay" tabindex="0" role="dialog" aria-label="Drag to select a screenshot area. Escape to cancel."><div class="hint">Drag to select an area · Esc to cancel</div><div class="box"><span class="size"></span></div></div>`;
    document.documentElement.append(host);
    const overlay = shadow.querySelector('.overlay'), box = shadow.querySelector('.box');
    const previousFocus = document.activeElement;
    let start, rect;
    const finish = value => {
      clearTimeout(timer); host.remove();
      window.removeEventListener('keydown', keyboard, true);
      window.removeEventListener('resize', cancel);
      window.removeEventListener('scroll', cancel, true);
      previousFocus?.focus?.({ preventScroll: true });
      resolve(value);
    };
    const cancel = () => finish(null);
    const keyboard = event => { event.stopImmediatePropagation(); event.preventDefault(); if (event.key === 'Escape') cancel(); };
    window.addEventListener('keydown', keyboard, true);
    window.addEventListener('resize', cancel);
    window.addEventListener('scroll', cancel, true);
    overlay.addEventListener('wheel', event => event.preventDefault(), { passive: false });
    overlay.addEventListener('contextmenu', event => event.preventDefault());
    overlay.onpointerdown = event => {
      if (event.button !== 0) return;
      event.preventDefault(); start = { x: event.clientX, y: event.clientY };
      overlay.setPointerCapture(event.pointerId);
    };
    overlay.onpointermove = event => {
      if (!start) return;
      const x = Math.max(0, Math.min(innerWidth, event.clientX));
      const y = Math.max(0, Math.min(innerHeight, event.clientY));
      rect = { x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) };
      Object.assign(box.style, { display: 'block', left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' });
      shadow.querySelector('.size').textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    };
    overlay.onpointerup = () => {
      if (rect?.width >= 3 && rect?.height >= 3) finish({ ...rect, viewportWidth: innerWidth, viewportHeight: innerHeight });
      else { start = null; rect = null; box.style.display = 'none'; }
    };
    overlay.onpointercancel = cancel;
    const timer = setTimeout(cancel, 60000);
    overlay.focus({ preventScroll: true });
  });
}
