/** Popup: connection status, a manual send box, and the media found on this tab. */

const statusEl = document.getElementById('status')
const mediaEl = document.getElementById('media')
const form = document.getElementById('add')
const urlInput = document.getElementById('url')

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab ?? null
}

async function refreshStatus() {
  const reply = await chrome.runtime.sendMessage({ type: 'draco:status' })
  if (reply?.ok) {
    statusEl.textContent = reply.version ? `connected · ${reply.version}` : 'connected'
    statusEl.className = 'ok'
  } else {
    statusEl.textContent = 'app not reachable'
    statusEl.className = 'bad'
  }
}

function shorten(url) {
  try {
    const parsed = new URL(url)
    return parsed.hostname + parsed.pathname
  } catch {
    return url
  }
}

async function refreshMedia() {
  const tab = await currentTab()
  if (!tab) return

  const reply = await chrome.runtime.sendMessage({ type: 'draco:list-media', tabId: tab.id })
  const media = reply?.media ?? []

  if (media.length === 0) {
    mediaEl.innerHTML = '<p class="empty">Nothing detected yet.</p>'
    return
  }

  mediaEl.textContent = ''
  // Newest first: the stream a player just switched to is the one wanted.
  for (const item of [...media].reverse()) {
    const row = document.createElement('div')
    row.className = 'row'

    const kind = document.createElement('span')
    kind.className = 'kind'
    kind.textContent = item.kind

    const url = document.createElement('span')
    url.className = 'url'
    // Built with textContent, never innerHTML: this string comes off the wire.
    url.textContent = shorten(item.mediaUrl)
    url.title = item.mediaUrl

    row.append(kind, url)
    row.addEventListener('click', async () => {
      url.textContent = 'sending…'
      const result = await chrome.runtime.sendMessage({
        type: 'draco:send-media',
        tabId: tab.id,
        mediaUrl: item.mediaUrl,
        kind: item.kind
      })
      url.textContent = result?.ok ? 'sent to Draco' : 'failed'
    })

    mediaEl.appendChild(row)
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const btn = form.querySelector('button')
  const originalText = btn.textContent
  btn.textContent = '...'
  btn.disabled = true

  const tab = await currentTab()
  const res = await chrome.runtime.sendMessage({
    type: 'draco:send-url',
    url: urlInput.value,
    referer: tab?.url
  })

  if (res?.ok) {
    urlInput.value = ''
    window.close()
  } else {
    btn.textContent = 'Error'
    setTimeout(() => {
      btn.textContent = originalText
      btn.disabled = false
    }, 2000)
  }
})

void refreshStatus()
void refreshMedia()
