import { captureStore } from './db.js';
const id = new URLSearchParams(location.search).get('id');
const image = document.querySelector('#image'), status = document.querySelector('#status');
const save = document.querySelector('#save'), zoom = document.querySelector('#zoom'), remove = document.querySelector('#delete');
let url;
try {
  const record = await captureStore('readonly', store => store.get(id || ''));
  if (!record) throw new Error('This capture is no longer available. Take a new screenshot to get started.');
  url = URL.createObjectURL(record.blob);
  image.src = url; image.hidden = false;
  document.querySelector('#title').textContent = record.title;
  document.querySelector('#details').textContent = `${record.width.toLocaleString()} × ${record.height.toLocaleString()} px · PNG · ${(record.blob.size / 1024 / 1024).toFixed(1)} MB`;
  save.href = url;
  save.download = `${record.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 100) || 'Screenshot'}-${new Date(record.created).toISOString().replace(/[:.]/g, '-')}.png`;
  save.hidden = false; zoom.disabled = false; remove.disabled = false;
  status.textContent = 'Saved locally · Latest 10 captures retained';
  zoom.onclick = () => {
    const actual = document.querySelector('#stage').classList.toggle('actual');
    zoom.textContent = actual ? 'Fit to width' : 'Actual size';
  };
  remove.onclick = async () => {
    try {
      await captureStore('readwrite', store => store.delete(id));
      URL.revokeObjectURL(url); image.hidden = true; save.hidden = true;
      zoom.disabled = true; remove.disabled = true;
      status.textContent = 'Capture deleted from this browser.';
    } catch (error) { status.textContent = error.message; }
  };
} catch (error) {
  document.querySelector('#title').textContent = 'No screenshot here';
  document.querySelector('#details').textContent = 'Take a capture using the Frame toolbar button.';
  status.textContent = error.message;
}
window.addEventListener('pagehide', () => { if (url) URL.revokeObjectURL(url); });
