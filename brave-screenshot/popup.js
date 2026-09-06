const status = document.querySelector('#status');
const buttons = [...document.querySelectorAll('[data-mode]')];
const [{ busy }, { error }] = await Promise.all([chrome.runtime.sendMessage({ type: 'status' }), chrome.storage.session.get('error')]);
if (busy) { status.textContent = 'Capture in progress. Keep the page and window selected.'; buttons.forEach(button => button.disabled = true); }
else if (error) { status.textContent = error; status.classList.add('error'); }
for (const button of buttons) button.addEventListener('click', async () => {
  buttons.forEach(item => item.disabled = true);
  try {
    const response = await chrome.runtime.sendMessage({ type: 'capture', mode: button.dataset.mode });
    if (response.error) throw new Error(response.error);
    window.close();
  } catch (error) {
    status.textContent = error.message; status.classList.add('error');
    buttons.forEach(item => item.disabled = false);
  }
});
