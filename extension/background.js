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
const passThrough = new Set()
const PASSTHROUGH_EXPIRY_MS = 30_000

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
  const url = item.finalUrl || item.url
  if (passThrough.delete(item.finalUrl) || passThrough.delete(item.url)) return

  const rules = await refreshConfig()
  if (!shouldTakeOver(item, rules)) return
  const [cookie, tab] = await Promise.all([
    cookieHeaderFor(url),
    item.tabId ? chrome.tabs.get(item.tabId).catch(() => null) : Promise.resolve(null)
  ])

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

  // Only now is it safe to cancel. Cancelling first and asking afterwards would
  // silently eat the download whenever the app is not reachable.
  if (!reply.ok || !reply.taken) {
    console.warn('Draco did not take the download:', reply.error ?? 'declined')
    return
  }

  try {
    await chrome.downloads.cancel(item.id)
    await chrome.downloads.erase({ id: item.id })
  } catch {
    // The download may have already finished if it was tiny. Nothing to undo:
    // Draco has its own copy queued either way.
  }
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
  void refreshConfig(true)
})

chrome.runtime.onStartup.addListener(() => void refreshConfig(true))

function isYouTubePage(url) {
  try {
    const parsed = new URL(url)
    return (
      /(^|\\.)youtube\\.com$/i.test(parsed.hostname) ||
      /(^|\\.)youtu\\.be$/i.test(parsed.hostname)
    )
  } catch {
    return false
  }
}

/**
 * The quality ladder straight out of the page.
 *
 * YouTube already parsed its player response in order to play the video, so the
 * whole ladder is sitting in the tab for free. Reading it here is the difference
 * between a menu that appears the moment the button is pressed and one that
 * appears after yt-dlp has spent six seconds asking YouTube the same question.
 *
 * Metadata only - itags, heights, bitrates. No URLs are taken from the page:
 * the app looks those up itself, so a hostile page cannot nominate what Draco
 * downloads. A null return is fine; the app falls back to asking yt-dlp.
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
          for (const format of all) {
            if (!format || typeof format.itag !== 'number') continue
            formats.push({
              itag: format.itag,
              mimeType: typeof format.mimeType === 'string' ? format.mimeType.slice(0, 200) : null,
              bitrate: Number(format.bitrate) || null,
              width: Number(format.width) || null,
              height: Number(format.height) || null,
              fps: Number(format.fps) || null,
              contentLength: Number(format.contentLength) || null
            })
            if (formats.length >= 100) break
          }

          if (formats.length > 0) return { title: details.title || '', formats }
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
          ? [...document.images].map((el) => el.src)
          : [...document.links].map((el) => el.href)
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

async function remember(tabId, mediaUrl, kind) {
  const list = await getMedia(tabId)
  // A player re-requests the same playlist constantly; one entry is enough.
  if (list.some((m) => m.mediaUrl === mediaUrl)) return

  list.push({ mediaUrl, kind, at: Date.now() })
  // Keep the list bounded: a long live stream would otherwise grow forever.
  const bounded = list.slice(-40)
  await setMedia(tabId, bounded)

  chrome.action.setBadgeText({ tabId, text: String(bounded.length) })
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#38bdf8' })
  chrome.tabs.sendMessage(tabId, { type: 'draco:media-count', count: bounded.length }).catch(() => {})
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
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    chrome.storage.session.remove(`media_${tabId}`)
    chrome.action.setBadgeText({ tabId, text: '' })
  }
})

/* ------------------------------------------------------------------ */
/* Messages from the popup and content script                          */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  ;(async () => {
    switch (message?.type) {
      case 'draco:list-media': {
        const tabId = message.tabId ?? sender.tab?.id
        const list = await getMedia(tabId)
        sendResponse({ media: list })
        return
      }

      case 'draco:get-yt-data': {
        const tab = sender.tab;
        if (!tab || !tab.id) {
          sendResponse(null);
          return false;
        }

        fetch(tab.url)
          .then(res => res.text())
          .then(html => {
            const patterns = [
              /ytInitialPlayerResponse\s*=\s*({.+?});\s*var\s+meta/s,
              /window\.\["ytInitialPlayerResponse"\]\s*=\s*({.+?});/s,
              /ytInitialPlayerResponse\s*=\s*({.+?})\s*;/s
            ];
            
            for (const p of patterns) {
              const m = html.match(p);
              if (m && m[1]) {
                try {
                  const data = JSON.parse(m[1]);
                  if (data && data.streamingData) {
                    sendResponse({ streamingData: data.streamingData });
                    return;
                  }
                } catch(e) {}
              }
            }
            throw new Error('Not found in HTML');
          })
          .catch(() => {
            // Fallback to executeScript (only extracting streamingData to avoid large serialization limits)
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              world: 'MAIN',
              func: () => {
                try {
                  let res = null;
                  const player = document.getElementById('movie_player');
                  if (player && typeof player.getPlayerResponse === 'function') {
                    res = player.getPlayerResponse();
                  }
                  if (!res) {
                    res = window.ytInitialPlayerResponse || (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args && JSON.parse(window.ytplayer.config.args.raw_player_response));
                  }
                  return res && res.streamingData ? { streamingData: res.streamingData } : null;
                } catch(e) {
                  return null;
                }
              }
            }).then(results => {
              sendResponse(results?.[0]?.result ?? null);
            }).catch(() => {
              sendResponse(null);
            });
          });
        return true; // Keep message channel open for async response
      }

      case 'draco:resolve-youtube': {
        const tab = sender.tab
        if (!tab?.url) {
          sendResponse({ ok: false, error: 'No active YouTube page' })
          return
        }

        const cookie = await cookieHeaderFor(tab.url)
        const page = await youTubePageFormats(tab)
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

      case 'draco:grab-best': {
        const tab = sender.tab
        const list = await getMedia(tab?.id)

        if (message.ytVariants && message.ytVariants.length > 0) {
          const cookie = await cookieHeaderFor(tab?.url)
          const reply = await callHost({
            type: 'media',
            pageUrl: tab?.url ?? '',
            pageTitle: tab?.title ?? '',
            mediaUrl: message.ytVariants[0].url,
            audioUrl: message.ytVariants[0].audioUrl,
            variants: message.ytVariants,
            kind: 'file',
            referer: tab?.url,
            cookie: cookie || undefined,
            userAgent: navigator.userAgent
          })
          sendResponse(reply.ok ? { ok: true } : { ok: false, error: reply.error })
          return
        }

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
        const rules = await refreshConfig()
        const url = message.url

        function ignoreUrl(u) {
          passThrough.add(u)
          setTimeout(() => passThrough.delete(u), PASSTHROUGH_EXPIRY_MS)
        }

        if (!rules.enabled || !isTakeableUrl(url, rules)) {
          ignoreUrl(url)
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
        ignoreUrl(url)
        sendResponse({ taken: false, error: reply.error })
        return
      }

      case 'draco:send-url': {
        await sendUrls([message.url], message.referer)
        sendResponse({ ok: true })
        return
      }

      case 'draco:status': {
        const reply = await callHost({ type: 'ping' })
        sendResponse(reply)
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
      iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      title: 'Draco',
      message
    })
    .catch?.(() => {})
}
