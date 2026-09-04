/**
 * Draco browser integration.
 *
 * Two jobs:
 *   1. Take downloads away from the browser and hand them to Draco, with the
 *      cookies, referrer and user-agent the browser would itself have sent.
 *   2. Watch network traffic for media streams and offer them to Draco's grabber.
 *
 * Talks to the app through a native-messaging host. `sendNativeMessage` is used
 * rather than a long-lived port on purpose: an MV3 service worker is killed
 * whenever it goes idle, and a persistent port would just be a way of fighting
 * that. A one-shot message also lets the host cold-start the app.
 */

const HOST = 'com.nihil.draco'

/** Cached copy of the app's takeover rules, refreshed opportunistically. */
let config = {
  enabled: true,
  minSize: 1024 * 1024,
  extensions: [],
  excludeHosts: []
}
let configFetchedAt = 0
const CONFIG_TTL_MS = 60_000

const PREFS_KEY = 'dracoPrefs'
const APP_STATUS_TTL_MS = 4_000
let prefs = { paused: false, excludedChannelIds: [], excludedVideoIds: [] }
let appStatus = { running: false, version: null, checkedAt: 0 }

const prefsReady = chrome.storage.local.get(PREFS_KEY).then((stored) => {
  const saved = stored[PREFS_KEY] || {}
  prefs = {
    paused: saved.paused === true,
    excludedChannelIds: Array.isArray(saved.excludedChannelIds)
      ? [...new Set(saved.excludedChannelIds.filter((id) => typeof id === 'string'))].slice(0, 1000)
      : [],
    excludedVideoIds: Array.isArray(saved.excludedVideoIds)
      ? [...new Set(saved.excludedVideoIds.filter((id) => typeof id === 'string'))].slice(0, 5000)
      : []
  }
})

async function savePrefs(next) {
  await prefsReady
  prefs = next
  await chrome.storage.local.set({ [PREFS_KEY]: prefs })
  await refreshAllTabs()
}

async function probeApp(force = false) {
  if (!force && Date.now() - appStatus.checkedAt < APP_STATUS_TTL_MS) return appStatus
  if (probePromise) return probePromise

  probePromise = (async () => {
    try {
      const reply = await callHost({ type: 'ping' })
      const next = {
        running: reply?.ok === true,
        version: reply?.ok && typeof reply.version === 'string' ? reply.version : null,
        checkedAt: Date.now()
      }
      const changed = next.running !== appStatus.running || next.version !== appStatus.version
      appStatus = next
      if (changed) void refreshAllTabs()
      return appStatus
    } finally {
      probePromise = null
    }
  })()
  
  return probePromise
}

async function pageIdentity(tab) {
  if (!tab?.url) return { videoId: null, channelId: null }
  const urlVideoId = youtubeVideoId(tab.url)
  if (!urlVideoId || typeof tab.id !== 'number') return { videoId: null, channelId: null }

  let channelId = null
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        try {
          const player = document.querySelector('#movie_player')
          const live = player && typeof player.getPlayerResponse === 'function'
            ? player.getPlayerResponse()
            : window.ytInitialPlayerResponse
          return live?.videoDetails?.channelId || null
        } catch {
          return null
        }
      }
    })
    channelId = typeof result?.result === 'string' ? result.result : null
  } catch {}

  return { videoId: `youtube:${urlVideoId}`, channelId: channelId ? `youtube:${channelId}` : null }
}

async function stateForTab(tab, forceProbe = false) {
  await prefsReady
  const [status, identity] = await Promise.all([probeApp(forceProbe), pageIdentity(tab)])
  const excludedVideo = Boolean(identity.videoId && prefs.excludedVideoIds.includes(identity.videoId))
  const excludedChannel = Boolean(identity.channelId && prefs.excludedChannelIds.includes(identity.channelId))
  const excluded = excludedVideo || excludedChannel
  return {
    running: status.running,
    version: status.version,
    paused: prefs.paused,
    active: status.running && !prefs.paused && !excluded,
    excluded,
    excludedVideo,
    excludedChannel,
    videoId: identity.videoId,
    channelId: identity.channelId
  }
}

async function setTabIndicator(tab) {
  if (typeof tab?.id !== 'number') return
  const state = await stateForTab(tab)
  const status = state.running && !state.paused ? 'active' : 'inactive'
  const iconState = state.excluded ? `${status}-excluded` : status
  const iconPath = Object.fromEntries(
    [16, 32, 48, 128].map((size) => [size, `status-icons/${iconState}-${size}.png`])
  )
  const title = state.excluded
    ? 'Draco — excluded on this page'
    : state.paused
      ? 'Draco — paused'
      : state.running
        ? 'Draco — active'
        : 'Draco — app offline'
  await Promise.all([
    chrome.action.setBadgeText({ tabId: tab.id, text: '' }),
    chrome.action.setIcon({ tabId: tab.id, path: iconPath }),
    chrome.action.setTitle({ tabId: tab.id, title })
  ]).catch(() => {})
  chrome.tabs.sendMessage(tab.id, { type: 'draco:state-changed', state }).catch(() => {})
}

async function refreshAllTabs() {
  const tabs = await chrome.tabs.query({}).catch(() => [])
  await Promise.all(tabs.map((tab) => setTabIndicator(tab)))
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[PREFS_KEY]?.newValue) return
  const saved = changes[PREFS_KEY].newValue
  prefs = {
    paused: saved.paused === true,
    excludedChannelIds: Array.isArray(saved.excludedChannelIds) ? saved.excludedChannelIds : [],
    excludedVideoIds: Array.isArray(saved.excludedVideoIds) ? saved.excludedVideoIds : []
  }
  void refreshAllTabs()
})

/** Media seen per tab, so the badge and popup can show what is grabbable. */
async function getMedia(tabId) {
  if (tabId == null || tabId < 0) return []
  const data = await chrome.storage.session.get(`media_${tabId}`)
  return data[`media_${tabId}`] || []
}

async function setMedia(tabId, list) {
  if (tabId == null || tabId < 0) return
  if (list.length === 0) {
    await chrome.storage.session.remove(`media_${tabId}`)
  } else {
    await chrome.storage.session.set({ [`media_${tabId}`]: list })
  }
}

/**
 * URLs that the content script's link-click handler tried and that Draco
 * declined (or that are not takeable). When the browser's own navigation then
 * creates a download item, onCreated must leave it alone rather than trying to
 * take it over again. Entries expire after 30 seconds to prevent unbounded
 * growth over a long session.
 */
const PASSTHROUGH_EXPIRY_MS = 30_000

let passThroughMutex = Promise.resolve()

function addPassThrough(url) {
  passThroughMutex = passThroughMutex.then(async () => {
    const data = await chrome.storage.session.get('passThrough')
    const pt = data.passThrough || {}
    pt[url] = Date.now() + PASSTHROUGH_EXPIRY_MS

    const now = Date.now()
    for (const k of Object.keys(pt)) {
      if (pt[k] < now) delete pt[k]
    }
    await chrome.storage.session.set({ passThrough: pt })
  }).catch(() => {})
  return passThroughMutex
}

async function checkAndConsumePassThrough(url) {
  let result = false
  passThroughMutex = passThroughMutex.then(async () => {
    const data = await chrome.storage.session.get('passThrough')
    const pt = data.passThrough || {}

    let changed = false
    const now = Date.now()
    for (const k of Object.keys(pt)) {
      if (pt[k] < now) {
        delete pt[k]
        changed = true
      }
    }

    if (pt[url]) {
      delete pt[url]
      changed = true
      result = true
    }

    if (changed) {
      await chrome.storage.session.set({ passThrough: pt })
    }
  }).catch(() => {})
  
  await passThroughMutex
  return result
}

/* ------------------------------------------------------------------ */
/* Native host                                                         */
/* ------------------------------------------------------------------ */

async function callHost(message) {
  const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const payload = { ...message, requestId }
  try {
    const reply = await chrome.runtime.sendNativeMessage(HOST, payload)
    return reply ?? { ok: false, error: 'empty reply' }
  } catch (err) {
    // The host is missing, not registered, or the app refused to start. Never
    // throw from here: callers must be able to fall back to the browser.
    return { ok: false, error: String(err?.message ?? err) }
  }
}

async function refreshConfig(force = false) {
  if (!force && Date.now() - configFetchedAt < CONFIG_TTL_MS) return config

  const reply = await callHost({ type: 'config' })
  if (reply.ok && reply.config) {
    config = reply.config
    configFetchedAt = Date.now()
  }
  return config
}

/* ------------------------------------------------------------------ */
/* Download takeover                                                   */
/* ------------------------------------------------------------------ */

function extensionOf(name) {
  const match = /\.([a-z0-9]{1,10})$/i.exec(name || '')
  return match ? match[1].toLowerCase() : ''
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Decides whether Draco should claim a download. Runs before any handoff so a
 * download that is clearly the browser's business never leaves the browser.
 */
function shouldTakeOver(item, rules) {
  if (!rules.enabled) return false

  // Nothing to hand over: these have no URL the app could re-request.
  if (!item.url || !/^https?:/i.test(item.finalUrl || item.url)) return false

  const host = hostnameOf(item.finalUrl || item.url)
  if (rules.excludeHosts.some((h) => host === h || host.endsWith('.' + h))) return false

  if (rules.extensions.length > 0) {
    const ext = extensionOf(item.filename) || extensionOf(item.url)
    if (!rules.extensions.includes(ext)) return false
  }

  // A known-small file is not worth the round trip; an unknown size (-1) is,
  // because that is exactly the streaming case Draco handles better.
  if (item.totalBytes > 0 && item.totalBytes < rules.minSize) return false

  return true
}

/**
 * The same rules as `shouldTakeOver`, minus everything that needs a live
 * DownloadItem. A link click has a URL and nothing else - no size, no MIME - so
 * the size threshold cannot apply and the extension list is matched against the
 * path.
 */
function isTakeableUrl(url, rules) {
  if (!/^https?:/i.test(url)) return false

  const host = hostnameOf(url)
  if (rules.excludeHosts.some((h) => host === h || host.endsWith('.' + h))) return false

  if (rules.extensions.length > 0) {
    let path = ''
    try {
      path = new URL(url).pathname
    } catch {
      return false
    }
    if (!rules.extensions.includes(extensionOf(path))) return false
  }

  return true
}

async function cookieHeaderFor(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url })
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  } catch {
    return ''
  }
}

chrome.downloads.onCreated.addListener(async (item) => {
  if (item.startTime) {
    const age = Date.now() - new Date(item.startTime).getTime()
    if (age > 10_000) return // Ignore old downloads re-emitted by the browser on startup
  }

  if (item.finalUrl && await checkAndConsumePassThrough(item.finalUrl)) return
  if (item.url && await checkAndConsumePassThrough(item.url)) return

  const sourceTab = item.tabId >= 0 ? await chrome.tabs.get(item.tabId).catch(() => null) : null
  if (!(await stateForTab(sourceTab)).active) return

  const url = item.finalUrl || item.url
  const rules = await refreshConfig()
  if (!shouldTakeOver(item, rules)) return
  const [cookie, tab] = await Promise.all([
    cookieHeaderFor(url),
    Promise.resolve(sourceTab)
  ])

  try {
    await chrome.downloads.pause(item.id)
  } catch {
    // If it's too fast, we might not be able to pause it.
  }

  const reply = await callHost({
    type: 'download',
    url,
    filename: item.filename ? item.filename.split(/[\\/]/).pop() : undefined,
    referer: item.referrer || tab?.url || undefined,
    cookie: cookie || undefined,
    userAgent: navigator.userAgent,
    size: item.totalBytes > 0 ? item.totalBytes : null,
    mimeType: item.mime || null
  })

  if (!reply.ok || !reply.taken) {
    console.warn('Draco did not take the download:', reply.error ?? 'declined')
    try {
      await chrome.downloads.resume(item.id)
    } catch {}
    return
  }

  try {
    await chrome.downloads.cancel(item.id)
    await chrome.downloads.erase({ id: item.id })
  } catch {}
})

/* ------------------------------------------------------------------ */
/* Context menus                                                       */
/* ------------------------------------------------------------------ */

const MENUS = [
  { id: 'draco-link', title: 'Download with Draco', contexts: ['link'] },
  { id: 'draco-image', title: 'Download image with Draco', contexts: ['image'] },
  { id: 'draco-media', title: 'Download media with Draco', contexts: ['video', 'audio'] },
  { id: 'draco-all-links', title: 'Download all links with Draco', contexts: ['page'] },
  { id: 'draco-all-images', title: 'Download all images with Draco', contexts: ['page'] }
]

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const menu of MENUS) chrome.contextMenus.create(menu)
  })
})

function isYouTubePage(url) {
  try {
    const parsed = new URL(url)
    return (
      /(^|\.)youtube\.com$/i.test(parsed.hostname) ||
      /(^|\.)youtu\.be$/i.test(parsed.hostname)
    )
  } catch {
    return false
  }
}

function youtubeVideoId(url) {
  try {
    const parsed = new URL(url)
    if (/(^|\.)youtu\.be$/i.test(parsed.hostname)) {
      return parsed.pathname.replace(/^\//, '').split('/')[0] || null
    }
    if (!/(^|\.)youtube\.com$/i.test(parsed.hostname)) return null
    return (
      parsed.searchParams.get('v') ||
      (/^\/(?:shorts|embed|live)\/([^/?#]+)/i.exec(parsed.pathname) || [])[1] ||
      null
    )
  } catch {
    return null
  }
}

const youtubePrimeRequests = new Map()

/** Warms links from tab navigation even if the content script has not loaded yet. */
async function primeYouTubeUrl(url) {
  const videoId = youtubeVideoId(url)
  if (!videoId) return { ok: false, primed: false }
  await prefsReady
  if (prefs.paused || prefs.excludedVideoIds.includes(`youtube:${videoId}`)) {
    return { ok: false, primed: false, reason: 'disabled' }
  }

  const active = youtubePrimeRequests.get(videoId)
  if (active) return active

  const request = (async () => {
    const cookie = await cookieHeaderFor(url)
    const reply = await callHost({
      type: 'youtubePrime',
      pageUrl: url,
      referer: url,
      cookie: cookie || undefined,
      userAgent: navigator.userAgent
    })
    console.debug(
      reply?.ok && reply?.primed
        ? `[Draco] links ready for ${videoId}`
        : `[Draco] link preparation failed for ${videoId}: ${reply?.error ?? 'unknown error'}`
    )
    return reply
  })().finally(() => youtubePrimeRequests.delete(videoId))

  youtubePrimeRequests.set(videoId, request)
  return request
}

/**
 * The quality ladder straight out of the page.
 *
 * YouTube already parsed its player response in order to play the video, so the
 * whole ladder is sitting in the tab for free. Reading it here is the difference
 * between a menu that appears the moment the button is pressed and one that
 * appears after yt-dlp has spent six seconds asking YouTube the same question.
 *
 * Direct URLs are included only when they point at the matching itag on
 * Google's media CDN. Those are the resources the browser is already playing,
 * so using them removes the extractor wait after the final Download click.
 */
async function youTubePageFormats(tab) {
  if (!tab || typeof tab.id !== 'number' || tab.id < 0) return null

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        const wanted =
          new URLSearchParams(location.search).get('v') ||
          (/^\/(?:shorts|embed|live)\/([^/?#]+)/.exec(location.pathname) || [])[1] ||
          null

        const sources = []
        try {
          // The live player, asked directly. Unlike the page globals below this
          // always describes the video currently loaded, so it survives the
          // in-page navigations YouTube does instead of real page loads.
          const player = document.querySelector('#movie_player')
          if (player && typeof player.getPlayerResponse === 'function') {
            const live = player.getPlayerResponse()
            if (live) sources.push(live)
          }
        } catch {}
        try {
          if (window.ytInitialPlayerResponse) sources.push(window.ytInitialPlayerResponse)
        } catch {}
        try {
          const raw =
            window.ytplayer && window.ytplayer.config && window.ytplayer.config.args
              ? window.ytplayer.config.args.raw_player_response
              : null
          if (raw) sources.push(typeof raw === 'string' ? JSON.parse(raw) : raw)
        } catch {}

        for (const response of sources) {
          const details = response && response.videoDetails
          const streaming = response && response.streamingData
          if (!details || !streaming) continue

          // YouTube is a single-page app and these globals outlive the video
          // that set them. A stale ladder is worse than none: it would offer
          // qualities belonging to something the user is no longer watching.
          if (wanted && details.videoId && details.videoId !== wanted) continue

          const all = [].concat(streaming.formats || [], streaming.adaptiveFormats || [])
          const formats = []
          let directCount = 0
          let cipherCount = 0
          for (const format of all) {
            if (!format || typeof format.itag !== 'number') continue
            let directUrl = null
            try {
              const parsed = new URL(format.url)
              if (
                parsed.protocol === 'https:' &&
                /(^|\.)googlevideo\.com$/i.test(parsed.hostname) &&
                /\/videoplayback$/i.test(parsed.pathname) &&
                parsed.searchParams.get('itag') === String(format.itag)
              ) {
                directUrl = parsed.href
                directCount++
              }
            } catch {}
            if (!directUrl && (format.signatureCipher || format.cipher)) cipherCount++
            formats.push({
              itag: format.itag,
              mimeType: typeof format.mimeType === 'string' ? format.mimeType.slice(0, 200) : null,
              bitrate: Number(format.bitrate) || null,
              width: Number(format.width) || null,
              height: Number(format.height) || null,
              fps: Number(format.fps) || null,
              contentLength: Number(format.contentLength) || null,
              url: directUrl
            })
            if (formats.length >= 100) break
          }

          if (formats.length > 0) {
            return {
              title: details.title || '',
              formats,
              diagnostics: {
                formats: formats.length,
                direct: directCount,
                ciphered: cipherCount,
                sabr: Boolean(streaming.serverAbrStreamingUrl)
              }
            }
          }
        }

        return null
      }
    })

    const first = results && results[0]
    return (first && first.result) || null
  } catch {
    return null
  }
}

async function sendYouTube(tab) {
  const cookie = await cookieHeaderFor(tab.url)
  const page = await youTubePageFormats(tab)
  if (page?.diagnostics) console.debug('Draco YouTube ladder', page.diagnostics)
  const reply = await callHost({
    type: 'youtube',
    pageUrl: tab.url,
    pageTitle: page?.title || tab.title || '',
    referer: tab.url,
    cookie: cookie || undefined,
    userAgent: navigator.userAgent,
    pageFormats: page?.formats
  })

  notify(
    reply?.ok
      ? 'YouTube video sent to Draco'
      : `YouTube extraction failed: ${reply?.error ?? 'unknown error'}`
  )
}

async function sendUrls(urls, referer) {
  const unique = [...new Set(urls.filter((u) => /^https?:/i.test(u)))]
  let taken = 0

  for (const url of unique) {
    const cookie = await cookieHeaderFor(url)
    const reply = await callHost({
      type: 'download',
      url,
      referer,
      cookie: cookie || undefined,
      userAgent: navigator.userAgent,
      // One link asks where to save it, the way IDM does. Forty links must not
      // ask forty times, so a bulk send says so and Draco just queues them.
      bulk: unique.length > 1
    })
    if (reply.ok && reply.taken) taken++
  }

  notify(
    taken > 0 ? `Sent ${taken} download${taken === 1 ? '' : 's'} to Draco` : 'Draco did not accept the links'
  )
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!(await stateForTab(tab, true)).active) {
    notify('Draco is offline, paused, or excluded on this page')
    return
  }
  const referer = tab?.url

  if (info.menuItemId === 'draco-link' && info.linkUrl) {
    await sendUrls([info.linkUrl], referer)
    return
  }

  if (info.menuItemId === 'draco-media' && tab?.url && isYouTubePage(tab.url)) {
    await sendYouTube(tab)
    return
  }

  if ((info.menuItemId === 'draco-image' || info.menuItemId === 'draco-media') && info.srcUrl) {
    await sendUrls([info.srcUrl], referer)
    return
  }

  if (info.menuItemId === 'draco-all-links' || info.menuItemId === 'draco-all-images') {
    if (!tab?.id) return
    const wantImages = info.menuItemId === 'draco-all-images'

    // Collected in the page rather than from the SW, because only the page has
    // the live DOM after scripts have run.
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [wantImages],
      func: (images) =>
        images
          ? [...document.querySelectorAll('img')].map((el) => el.src)
          : [...document.querySelectorAll('a, area')].map((el) => el.href)
    })

    await sendUrls(result?.result ?? [], referer)
  }
})

/* ------------------------------------------------------------------ */
/* Media sniffing                                                      */
/* ------------------------------------------------------------------ */

/**
 * MV3 removed *blocking* webRequest, not observation. Watching requests go by is
 * still allowed, which is all a stream sniffer needs.
 */
const MEDIA_PATTERNS = [
  { re: /\.m3u8(\?|$)/i, kind: 'hls' },
  { re: /\.mpd(\?|$)/i, kind: 'dash' },
  { re: /\.(mp4|webm|mkv|mov|flac|mp3|m4a|ogg)(\?|$)/i, kind: 'file' }
]

function classify(url) {
  for (const { re, kind } of MEDIA_PATTERNS) {
    if (re.test(url)) return kind
  }
  return null
}

/** Hosts that only ever serve adaptive chunks, never a whole file. */
const ADAPTIVE_HOSTS = /(^|\.)(googlevideo\.com|ytimg\.com|ttvnw\.net|nflxvideo\.net)$/i

const tabLocks = new Map()

async function remember(tabId, mediaUrl, kind) {
  let p = tabLocks.get(tabId) || Promise.resolve()
  p = p.then(async () => {
    const list = await getMedia(tabId)
    // A player re-requests the same playlist constantly; one entry is enough.
    if (list.some((m) => m.mediaUrl === mediaUrl)) return

    list.push({ mediaUrl, kind, at: Date.now() })
    // Keep the list bounded: a long live stream would otherwise grow forever.
    const bounded = list.slice(-40)
    await setMedia(tabId, bounded)

    chrome.tabs.sendMessage(tabId, { type: 'draco:media-count', count: bounded.length }).catch(() => {})
  }).catch(() => {})
  tabLocks.set(tabId, p)
}

/**
 * Ranks what was seen on a page. A playlist beats a loose media file: it is the
 * whole programme rather than one of its parts, and Draco can reassemble it.
 */
const KIND_RANK = { hls: 0, file: 1, dash: 2 }

function pickBest(list) {
  return [...list].sort(
    (a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || b.at - a.at
  )[0]
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return
    const kind = classify(details.url)
    if (!kind) return
    remember(details.tabId, details.url, kind)
  },
  { urls: ['<all_urls>'] }
)

/**
 * Plenty of sites serve video from a URL with no extension in it at all - an
 * API path, a signed CDN link. The response headers say what it really is, and
 * observing those catches everything the URL patterns miss.
 */
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return
    if (classify(details.url)) return // already counted by the URL pattern

    const headers = details.responseHeaders ?? []
    const type = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? ''
    if (!/^(video|audio)\//i.test(type)) return

    // Adaptive players fetch thousands of tiny media chunks that are useless on
    // their own; counting them would bury anything actually downloadable.
    if (ADAPTIVE_HOSTS.test(hostnameOf(details.url))) return

    const length = Number(
      headers.find((h) => h.name.toLowerCase() === 'content-length')?.value ?? 0
    )
    if (length > 0 && length < 512 * 1024) return

    remember(details.tabId, details.url, 'file')
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
)

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`media_${tabId}`))
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    chrome.storage.session.remove(`media_${tabId}`)
    chrome.action.setBadgeText({ tabId, text: '' })
  }

  const url = changeInfo.url || tab.url
  if (url && youtubeVideoId(url)) void primeYouTubeUrl(url)
  void setTabIndicator(tab)
})

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs.get(tabId).then((tab) => setTabIndicator(tab)).catch(() => {})
})

// Reloading the extension should prepare a YouTube tab that is already open;
// requiring another refresh here is both surprising and easy to miss in tests.
void prefsReady.then(() => refreshAllTabs()).catch(() => {})

/* ------------------------------------------------------------------ */
/* Messages from the popup and content script                          */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  ;(async () => {
    const messageTab = sender.tab ?? (
      typeof message?.tabId === 'number'
        ? await chrome.tabs.get(message.tabId).catch(() => null)
        : null
    )

    switch (message?.type) {
      case 'draco:page-state': {
        const state = await stateForTab(messageTab, message.force === true)
        if (messageTab) void setTabIndicator(messageTab)
        sendResponse(state)
        return
      }

      case 'draco:set-paused': {
        await prefsReady
        await savePrefs({ ...prefs, paused: message.paused === true })
        sendResponse(await stateForTab(messageTab, true))
        return
      }

      case 'draco:set-exclusion': {
        await prefsReady
        const state = await stateForTab(messageTab)
        const kind = message.kind === 'channel' ? 'channel' : 'video'
        const id = kind === 'channel' ? state.channelId : state.videoId
        if (!id) {
          sendResponse({ ok: false, error: `No ${kind} identity is available on this page` })
          return
        }
        const key = kind === 'channel' ? 'excludedChannelIds' : 'excludedVideoIds'
        const values = new Set(prefs[key])
        if (message.excluded === false) values.delete(id)
        else values.add(id)
        await savePrefs({ ...prefs, [key]: [...values] })
        sendResponse({ ok: true, state: await stateForTab(messageTab) })
        return
      }

      case 'draco:list-media': {
        const tabId = message.tabId ?? sender.tab?.id
        const list = await getMedia(tabId)
        sendResponse({ media: list })
        return
      }

      case 'draco:resolve-youtube': {
        const tab = sender.tab
        if (!(await stateForTab(tab)).active) {
          sendResponse({ ok: false, error: 'Draco is offline, paused, or excluded on this page' })
          return
        }
        if (!tab?.url) {
          sendResponse({ ok: false, error: 'No active YouTube page' })
          return
        }

        const cookie = await cookieHeaderFor(tab.url)
        const page = await youTubePageFormats(tab)
        if (page?.diagnostics) console.debug('Draco YouTube ladder', page.diagnostics)
        const reply = await callHost({
          type: 'youtube',
          pageUrl: tab.url,
          pageTitle: page?.title || tab.title || '',
          referer: tab.url,
          cookie: cookie || undefined,
          userAgent: navigator.userAgent,
          pageFormats: page?.formats
        })

        sendResponse(reply)
        return
      }

      case 'draco:prime-youtube': {
        const tab = sender.tab
        if (!(await stateForTab(tab)).active) {
          sendResponse({ ok: false, primed: false, reason: 'disabled' })
          return
        }
        if (!tab?.url || !isYouTubePage(tab.url)) {
          sendResponse({ ok: false, primed: false })
          return
        }

        const reply = await primeYouTubeUrl(tab.url)
        sendResponse(reply)
        return
      }

      case 'draco:grab-best': {
        const tab = sender.tab
        if (!(await stateForTab(tab)).active) {
          sendResponse({ ok: false, error: 'Draco is offline, paused, or excluded on this page' })
          return
        }
        const list = await getMedia(tab?.id)

        // The page's own <video src> is the most reliable thing there is when
        // it is a plain URL: no guessing about which of forty sniffed requests
        // was the one being watched.
        const direct = /^https?:/i.test(message.videoSrc ?? '')
          ? { mediaUrl: message.videoSrc, kind: classify(message.videoSrc) ?? 'file' }
          : null

        let best = direct
        if (!best) {
          const candidate = pickBest(list)
          // If the video is an adaptive blob, a single loose file (like success.mp3)
          // sniffed from the page is definitely not the video.
          if (candidate && (!message.adaptive || candidate.kind !== 'file')) {
            best = candidate
          }
        }

        if (!best) {
          sendResponse({ ok: false, reason: message.adaptive ? 'adaptive' : 'none' })
          return
        }

        const cookie = await cookieHeaderFor(best.mediaUrl)
        const reply = await callHost({
          type: 'media',
          pageUrl: tab?.url ?? '',
          pageTitle: tab?.title ?? '',
          mediaUrl: best.mediaUrl,
          subtitles: message.subtitles,
          kind: best.kind,
          referer: tab?.url,
          cookie: cookie || undefined,
          userAgent: navigator.userAgent
        })

        sendResponse(reply.ok ? { ok: true } : { ok: false, error: reply.error })
        return
      }

      case 'draco:send-media': {
        const tab = sender.tab ?? (message.tabId ? await chrome.tabs.get(message.tabId) : null)
        if (!(await stateForTab(tab)).active) {
          sendResponse({ ok: false, error: 'Draco is offline, paused, or excluded on this page' })
          return
        }
        const cookie = await cookieHeaderFor(message.mediaUrl)
        const reply = await callHost({
          type: 'media',
          pageUrl: tab?.url ?? '',
          pageTitle: tab?.title ?? '',
          mediaUrl: message.mediaUrl,
          kind: message.kind ?? 'file',
          referer: tab?.url,
          cookie: cookie || undefined,
          userAgent: navigator.userAgent
        })
        sendResponse(reply)
        return
      }

      case 'draco:link-click': {
        if (!(await stateForTab(sender.tab)).active) {
          await addPassThrough(message.url)
          sendResponse({ taken: false })
          return
        }
        const rules = await refreshConfig()
        const url = message.url

        async function ignoreUrl(u) {
          // Store the exemption before replaying the click. The browser can
          // create its DownloadItem immediately after the reply is received.
          await addPassThrough(u)
        }

        if (!rules.enabled || !isTakeableUrl(url, rules)) {
          await ignoreUrl(url)
          sendResponse({ taken: false })
          return
        }

        const tab = sender.tab
        const cookie = await cookieHeaderFor(url)
        const reply = await callHost({
          type: 'download',
          url,
          filename: message.filename || undefined,
          referer: tab?.url,
          cookie: cookie || undefined,
          userAgent: navigator.userAgent
        })

        if (reply.ok && reply.taken) {
          sendResponse({ taken: true })
          return
        }

        // Let the page's own navigation happen instead; onCreated will see the
        // URL in passThrough and keep its hands off it.
        await ignoreUrl(url)
        sendResponse({ taken: false, error: reply.error })
        return
      }

      case 'draco:send-url': {
        if (!(await stateForTab(messageTab)).active) {
          sendResponse({ ok: false, error: 'Draco is unavailable' })
          return
        }
        await sendUrls([message.url], message.referer)
        sendResponse({ ok: true })
        return
      }

      case 'draco:status': {
        const state = await stateForTab(messageTab, true)
        sendResponse({ ok: state.running, ...state })
        return
      }

      default:
        sendResponse({ ok: false, error: 'unknown message' })
    }
  })()

  // Keeps the message channel open for the async work above.
  return true
})

function notify(message) {
  chrome.notifications
    ?.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon.png'),
      title: 'Draco',
      message
    })
    .catch?.(() => {})
}
