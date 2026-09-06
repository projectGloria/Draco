import { positions, outputSize, cropRect } from './geometry.mjs';
import { pageAction, selectArea } from './page.js';
import { captureStore } from './db.js';

let busy = false;
let lastCapture = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const page = async (tabId, action, args) => (await chrome.scripting.executeScript({ target: { tabId }, func: pageAction, args: [action, args || {}] }))[0].result;

async function screenshot(tab) {
  await delay(Math.max(0, 550 - (Date.now() - lastCapture)));
  const active = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
  if (active?.id !== tab.id || active.url !== tab.url) throw new Error('The active page changed. Keep the page selected while capturing.');
  const win = await chrome.windows.get(tab.windowId);
  if (!win.focused) throw new Error('Keep the browser window focused while capturing.');
  lastCapture = Date.now();
  const data = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const current = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
  if (current?.id !== tab.id || current.url !== tab.url) throw new Error('The page changed during capture. Please try again.');
  return createImageBitmap(await (await fetch(data)).blob());
}

async function capture(tab, mode) {
  let prepared = false;
  try {
    await chrome.storage.session.remove('error');
    await chrome.action.setBadgeBackgroundColor({ color: '#8061d5' });
    await chrome.action.setBadgeText({ text: mode === 'section' ? 'SEL' : '…' });
    await delay(300); // Allow the action popup to close before capturing.
    let canvas;
    if (mode === 'full') {
      const initial = await page(tab.id, 'prepare');
      prepared = true;
      const { width, height } = outputSize(initial.width, initial.height, initial.scale);
      canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      const xs = positions(initial.width, initial.contentWidth);
      const ys = positions(initial.height, initial.contentHeight);
      if (xs.length * ys.length > 160) throw new Error('This page needs too many captures. Zoom out or select a section.');
      let count = 0;
      for (const y of ys) for (const x of xs) {
        const current = await page(tab.id, 'scroll', { x, y, hidePinned: count > 0 });
        if (current.viewportWidth !== initial.viewportWidth || current.viewportHeight !== initial.viewportHeight || current.scale !== initial.scale) {
          throw new Error('The window size or zoom changed. Please try again.');
        }
        const bitmap = await screenshot(tab);
        try {
          const scale = bitmap.width / current.viewportWidth;
          if (Math.abs(scale - initial.scale) > 0.02) throw new Error('The page scale changed. Please try again.');
          // Bottom/right scrolls overlap previous tiles. Paint only the new portion,
          // preserving the first tile’s fixed header rather than overwriting it.
          const left = Math.max(x, current.x), top = Math.max(y, current.y);
          const right = Math.min(initial.width, current.x + current.contentWidth);
          const bottom = Math.min(initial.height, current.y + current.contentHeight);
          if (current.x > x + 1 || current.y > y + 1 || right < Math.min(x + current.contentWidth, initial.width) - 1 || bottom < Math.min(y + current.contentHeight, initial.height) - 1) {
            throw new Error('This page prevents normal scrolling. Try visible-area or section capture.');
          }
          const dx = Math.round(left * scale), dy = Math.round(top * scale);
          const dw = Math.round(right * scale) - dx, dh = Math.round(bottom * scale) - dy;
          ctx.drawImage(bitmap, Math.round((left - current.x) * scale), Math.round((top - current.y) * scale), dw, dh, dx, dy, dw, dh);
        } finally { bitmap.close(); }
        count++;
        await chrome.action.setBadgeText({ text: `${Math.round(count / (xs.length * ys.length) * 100)}%` });
      }
    } else {
      let rect;
      if (mode === 'section') {
        rect = (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: selectArea }))[0].result;
        if (!rect) return;
        await delay(180);
      }
      const metrics = await page(tab.id, 'metrics');
      if (rect && (rect.viewportWidth !== metrics.viewportWidth || rect.viewportHeight !== metrics.viewportHeight)) throw new Error('The window resized. Please select the area again.');
      const bitmap = await screenshot(tab);
      try {
        const crop = rect ? cropRect(rect, bitmap.width / metrics.viewportWidth, bitmap.width, bitmap.height) : { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
        const size = outputSize(crop.width, crop.height, 1);
        canvas = new OffscreenCanvas(size.width, size.height);
        canvas.getContext('2d').drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
      } finally { bitmap.close(); }
    }
    if (prepared) { await page(tab.id, 'restore'); prepared = false; }
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const id = crypto.randomUUID();
    // Keep at most the ten most recent captures. They can also be deleted in preview.
    const records = await captureStore('readonly', store => store.getAll());
    for (const record of records.sort((a, b) => b.created - a.created).slice(9)) await captureStore('readwrite', store => store.delete(record.id));
    await captureStore('readwrite', store => store.put({ id, blob, title: tab.title || 'Page', width: canvas.width, height: canvas.height, mode, created: Date.now() }));
    await chrome.tabs.create({ url: chrome.runtime.getURL(`preview.html?id=${id}`) });
  } catch (error) {
    const message = /Cannot access|Missing host permission|extensions gallery|cannot be scripted/i.test(error.message)
      ? 'This browser page does not allow screenshots through the extension. Open a regular website and try again.' : error.message;
    await chrome.storage.session.set({ error: message });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setTitle({ title: `Frame: ${message}` });
    return;
  } finally {
    if (prepared) await page(tab.id, 'restore').catch(() => {});
    busy = false;
    const { error } = await chrome.storage.session.get('error');
    if (!error) {
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setTitle({ title: 'Frame — Take a screenshot' });
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  if (message.type === 'status') { respond({ busy }); return; }
  if (message.type !== 'capture' || !['full', 'visible', 'section'].includes(message.mode)) return;
  if (busy) { respond({ error: 'A capture is already in progress.' }); return; }
  busy = true;
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (!tab?.id || !/^(https?:|file:)/.test(tab.url || '')) {
      busy = false; respond({ error: 'Open a regular website first. Browser settings and extension pages are restricted.' }); return;
    }
    respond({ ok: true });
    void capture(tab, message.mode);
  }).catch(error => { busy = false; respond({ error: error.message }); });
  return true;
});
