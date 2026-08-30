const statusEl = document.getElementById('status')
const statusDot = document.getElementById('status-dot')
const pausedInput = document.getElementById('paused')
const channelButton = document.getElementById('channel')
const videoButton = document.getElementById('video')
const channelNote = document.getElementById('channel-note')
const videoNote = document.getElementById('video-note')
const mediaEl = document.getElementById('media')
const form = document.getElementById('add')
const urlInput = document.getElementById('url')
let tab = null
let state = null

function renderState(next) {
  state = next
  pausedInput.checked = state.paused
  statusDot.classList.toggle('active', state.running && !state.paused)
  statusEl.textContent = state.excluded ? 'Excluded on this page' : state.paused ? 'Browser integration paused' : state.running ? (state.version ? `App ready · v${state.version}` : 'App ready') : 'App is not running'
  channelButton.disabled = !state.channelId
  channelButton.textContent = state.excludedChannel ? 'Include' : 'Exclude'
  channelButton.classList.toggle('selected', state.excludedChannel)
  channelNote.textContent = state.channelId ? (state.excludedChannel ? 'Downloads from this channel are hidden' : 'Allow or hide this YouTube channel') : 'Not available on this page'
  videoButton.disabled = !state.videoId
  videoButton.textContent = state.excludedVideo ? 'Include' : 'Exclude'
  videoButton.classList.toggle('selected', state.excludedVideo)
  videoNote.textContent = state.videoId ? (state.excludedVideo ? 'This video is currently hidden' : 'Allow or hide this video') : 'Not available on this page'
  const unavailable = !state.active
  urlInput.disabled = unavailable
  form.querySelector('button').disabled = unavailable
  for (const row of mediaEl.querySelectorAll('button')) row.disabled = unavailable
}

async function refreshState(force = false) {
  renderState(await chrome.runtime.sendMessage({ type: 'draco:page-state', tabId: tab?.id, force }))
}

function shorten(url) {
  try { const parsed = new URL(url); return parsed.hostname + parsed.pathname } catch { return url }
}

async function refreshMedia() {
  if (!tab) return
  const reply = await chrome.runtime.sendMessage({ type: 'draco:list-media', tabId: tab.id })
  const media = reply?.media ?? []
  mediaEl.textContent = ''
  if (media.length === 0) { mediaEl.innerHTML = '<p class="empty">Nothing detected yet.</p>'; return }
  for (const item of [...media].reverse()) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'media-row'
    const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = item.kind
    const url = document.createElement('span'); url.className = 'url'; url.textContent = shorten(item.mediaUrl); url.title = item.mediaUrl
    row.append(kind, url)
    row.addEventListener('click', async () => {
      url.textContent = 'Sending…'
      const result = await chrome.runtime.sendMessage({ type: 'draco:send-media', tabId: tab.id, mediaUrl: item.mediaUrl, kind: item.kind })
      url.textContent = result?.ok ? 'Sent to Draco' : result?.error || 'Failed'
    })
    mediaEl.appendChild(row)
  }
}

pausedInput.addEventListener('change', async () => {
  pausedInput.disabled = true
  const next = await chrome.runtime.sendMessage({ type: 'draco:set-paused', tabId: tab?.id, paused: pausedInput.checked })
  pausedInput.disabled = false
  renderState(next)
})

async function toggleExclusion(kind) {
  const excluded = kind === 'channel' ? state.excludedChannel : state.excludedVideo
  const reply = await chrome.runtime.sendMessage({ type: 'draco:set-exclusion', tabId: tab?.id, kind, excluded: !excluded })
  if (reply?.ok) renderState(reply.state)
}
channelButton.addEventListener('click', () => void toggleExclusion('channel'))
videoButton.addEventListener('click', () => void toggleExclusion('video'))

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const button = form.querySelector('button'); const original = button.textContent
  button.textContent = '…'; button.disabled = true
  const result = await chrome.runtime.sendMessage({ type: 'draco:send-url', tabId: tab?.id, url: urlInput.value, referer: tab?.url })
  if (result?.ok) { urlInput.value = ''; button.textContent = 'Sent' } else button.textContent = 'Error'
  setTimeout(() => { button.textContent = original; button.disabled = !state?.active }, 1400)
})

void (async () => {
  ;[tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  await Promise.all([refreshState(true), refreshMedia()])
  renderState(state)
})()
