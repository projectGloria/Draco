/**
 * The in-page half of the integration.
 *
 *   1. Intercept clicks on download links, so the browser never starts the
 *      download and never gets a chance to show its own dialog or shelf.
 *   2. Pin a small "Download" button just outside the top-left corner of a
 *      video the page is there to play.
 *
 * Both render into *closed* shadow roots, so the page cannot restyle them, read
 * them, or collide with their class names.
 */

/* ------------------------------------------------------------------ */
/* 0. Surviving the extension being reloaded                           */
/* ------------------------------------------------------------------ */

/**
 * A content script outlives the extension that injected it.
 *
 * Reloading the extension at chrome://extensions - or Chrome updating it -
 * leaves this script running in the page attached to a chrome.runtime that has
 * been cut off from it. Every call through it then throws "Extension context
 * invalidated." *synchronously*, before there is a promise to reject, so a
 * .catch() on the returned value never sees it and the failure escapes as an
 * uncaught rejection instead.
 *
 * There is nothing here to reconnect: a fresh copy of this script is injected
 * on the next navigation and owns the page from then on. What the orphan must
 * not do is keep its timers running and its buttons on screen, throwing every
 * five seconds while its replacement works beside it. So the first call that
 * fails for that reason is the signal to take the UI down and go quiet.
 */
let orphaned = false
let stateTimer = null
let pageObserver = null

function extensionAlive() {
  if (orphaned) return false
  try {
    // runtime.id is the cheapest thing that goes undefined on invalidation,
    // and reading it can throw in its own right once the context is gone.
    return Boolean(chrome.runtime?.id)
  } catch {
    return false
  }
}

/**
 * The only way this file talks to the service worker. Never throws and never
 * rejects: a null reply means "no answer", which every caller already handles
 * for the ordinary case of Draco not running.
 */
async function sendToExtension(message) {
  if (!extensionAlive()) {
    // Reaching here on an already-dead context is the same verdict as a
    // failed call, and it is the path an orphan normally takes: nothing
    // throws, so without this it would go quiet but never actually retire.
    standDown()
    return null
  }

  try {
    return await chrome.runtime.sendMessage(message)
  } catch {
    // A closed port is routine - an MV3 worker is killed whenever it goes idle,
    // and the next message wakes it again. An invalidated context is the one
    // that is permanent, and runtime.id is what tells the two apart.
    if (!extensionAlive()) standDown()
    return null
  }
}

/** Retires this copy of the script in favour of the one that replaced it. */
function standDown() {
  if (orphaned) return
  orphaned = true
  clearInterval(stateTimer)
  pageObserver?.disconnect()
  clearOverlays()
}

/* ------------------------------------------------------------------ */
/* 1. Link interception                                                */
/* ------------------------------------------------------------------ */

/**
 * Extensions that mean "a file", not "a page". A click is only taken away from
 * the browser when it is unambiguous - guessing wrong here breaks navigation,
 * which is far worse than missing a download.
 */
const FILE_EXTENSIONS = new Set([
  '7z', 'aac', 'ace', 'aiff', 'apk', 'appimage', 'arj', 'avi', 'bin', 'bz2', 'cab', 'chm',
  'deb', 'dmg', 'doc', 'docx', 'epub', 'exe', 'flac', 'flv', 'gz', 'img', 'iso', 'jar',
  'lzh', 'm4a', 'm4v', 'mkv', 'mobi', 'mov', 'mp3', 'mp4', 'mpg', 'mpeg', 'msi', 'ogg',
  'opus', 'pdf', 'pkg', 'ppt', 'pptx', 'psd', 'rar', 'rpm', 'run', 'sh', 'tar', 'tgz',
  'torrent', 'txz', 'vhd', 'wav', 'webm', 'wma', 'wmv', 'xls', 'xlsx', 'xz', 'zip', 'zst'
])

function extensionOfPath(url) {
  // Fast path: avoid URL parsing if string clearly doesn't have an extension
  const match = /\.([a-z0-9]{1,10})(?:[?#]|$)/i.exec(url)
  if (!match) return ''
  try {
    const parsed = new URL(url, location.href)
    const m = /\.([a-z0-9]{1,10})$/i.exec(parsed.pathname)
    return m ? m[1].toLowerCase() : ''
  } catch {
    return ''
  }
}

/** The anchor a click landed on, looking through shadow boundaries. */
function anchorFor(event) {
  for (const node of event.composedPath()) {
    if (node instanceof HTMLAnchorElement && node.href) return node
  }
  return null
}

addEventListener(
  'click',
  (event) => {
    if (event.defaultPrevented) return
    // Modified clicks mean "new tab", "save", "select" - all of them the user
    // asking the browser for something specific. Leave them alone.
    if (event.button !== 0 || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) {
      return
    }

    const anchor = anchorFor(event)
    if (!anchor) return

    const url = anchor.href
    if (!/^https?:/i.test(url)) return

    const named = anchor.hasAttribute('download')
    if (!named && !FILE_EXTENSIONS.has(extensionOfPath(url))) return

    /*
     * Stopped here, before the browser does anything at all. That is the only
     * way to be sure no download shelf or Save As dialog appears - by the time
     * chrome.downloads fires, the browser has already drawn its own UI.
     *
     * If the app turns out not to want it, the navigation is replayed below, so
     * a link is never silently swallowed.
     */
    event.preventDefault()
    event.stopPropagation()

    const suggested = anchor.getAttribute('download') || ''

    let replayNode = null
    const replay = () => {
      if (anchor.target === '_blank') {
        window.open(url, '_blank')
      } else {
        location.href = url
      }
    }

    void sendToExtension({ type: 'draco:link-click', url, filename: suggested || undefined })
      .then((reply) => {
        // No answer means the same as a refusal here. The navigation has
        // already been cancelled, so it has to be given back either way.
        if (!reply?.taken) replay()
      })
  },
  true
)

/* ------------------------------------------------------------------ */
/* 2. The per-video button                                             */
/* ------------------------------------------------------------------ */

/** Below this a video is a thumbnail or a tracking pixel, not something to grab. */
const MIN_VIDEO_W = 140
const MIN_VIDEO_H = 80

/**
 * Sites whose players fetch encrypted or separately-muxed adaptive streams.
 * Grabbing what flies past on the wire yields a video with no audio, or a file
 * that will not play at all - so the button says so rather than producing one.
 */
const ADAPTIVE_SITES =
  /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|twitch\.tv|netflix\.com|disneyplus\.com|primevideo\.com|spotify\.com)$/i

const isTopFrame = window.top === window
const overlays = new Map()

const YOUTUBE_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i

/**
 * Whether this page is one someone is watching something on.
 *
 * YouTube's homepage, search results, subscriptions and channel pages are full
 * of `<video>` elements - every thumbnail plays a preview when the pointer
 * crosses it - and a Download button on each of them is noise attached to
 * something nobody meant to download. A button belongs on the page you opened
 * to watch one video.
 *
 * Only YouTube is filtered, because only YouTube plays this much video nobody
 * asked for; everywhere else a frame large enough to earn a button is one the
 * page is deliberately showing. `/embed/` keeps its button: that frame *is* a
 * video someone put on a page to be watched.
 */
function pageWantsButtons() {
  if (!YOUTUBE_HOSTS.test(location.hostname)) return true
  if (/(^|\.)youtu\.be$/i.test(location.hostname)) return true

  return (
    /^\/watch$/i.test(location.pathname) ||
    /^\/(shorts|embed|live)\//i.test(location.pathname)
  )
}

/**
 * Videos Draco has already taken, and whether anything on this page has been.
 *
 * Once a download has been handed over, the button has done its job and stays
 * gone: leaving it there invites a second copy of the same file, and there is
 * nothing useful for a second press to do.
 *
 * Both are forgotten the moment the page becomes a different page - see
 * `checkNavigation`. YouTube is a single-page app, so the next video arrives
 * without a reload and often in the very same `<video>` element; without that
 * reset the button would be retired for the rest of the browsing session and
 * the second video could not be downloaded at all.
 */
let handled = new WeakSet()
let takenOver = false
let pageKey = location.href
let primedVideoId = null
let primingVideoId = null
let primeRetryTimer = null
let primeRetryDelay = 800

/**
 * Where the button sits relative to the corner it is anchored to.
 *
 * Nudged by dragging it and remembered across pages, because the one spot that
 * is out of the way is a property of the person's screen and habits, not of any
 * particular video. Zero means the anchor itself: just outside the frame's
 * top-left corner.
 */
let offset = { x: 0, y: 0 }
const OFFSET_KEY = 'draco:button-offset'
let buttonWidth = 144
const SIZE_KEY = 'draco:button-width'
const MIN_BUTTON_WIDTH = 96
const MAX_BUTTON_WIDTH = 320

/** A press has to move this far before it is a drag rather than a click. */
const DRAG_SLOP = 4

/** Set when a drag has just ended, so its trailing click does not download. */
let suppressClickUntil = 0

/** How far outside the frame the button sits. */
const GAP = 8

let mediaCount = 0
let dracoState = { running: false, paused: false, active: false, excluded: false }
let dismissedPageKey = null
let scheduled = false
let scanScheduled = false

/** Fullscreen creates a new stacking context; anything outside it is invisible. */
function overlayRoot() {
  return document.fullscreenElement ?? document.documentElement
}

/*
 * The host element *is* the button.
 *
 * The previous shape - a full-size transparent overlay with the button placed
 * inside by `right: 10px` - put the button in the top-left corner whenever the
 * host had not been given its width yet, and made the click target depend on
 * pointer-events passing through two layers. Sizing the host to the button and
 * computing its corner directly removes both problems: there is one element,
 * it is exactly where it is drawn, and it receives its own clicks.
 */
function createOverlay(video) {
  const host = document.createElement('div')
  host.style.cssText =
    'position:fixed;left:0;top:0;z-index:2147483647;margin:0;padding:0;border:0;display:none'

  const shadow = host.attachShadow({ mode: 'closed' })
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .control {
        position: relative;
        display: inline-block;
        margin: 0; padding: 0; border: 0;
        background: transparent;
      }
      .btn {
        display: block;
        font: 600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
        margin: 0; padding: 0; border: 0; border-radius: 0;
        background: none;
        color: #e6e9f0;
        white-space: nowrap;
        user-select: none;
        cursor: grab;
        touch-action: none;
      }
      .btn:focus-visible { outline: 1px dotted rgba(255,255,255,.8); outline-offset: 2px; }
      .btn.hot, .btn.ready { color: #f8fafc; }
      .btn.bad { color: #fbbf24; }
      .btn.done { color: #34d399; }
      .art { width: 144px; height: auto; display: block; object-fit: contain; pointer-events: none; }
      .art[hidden], .label[hidden] { display: none; }
      .label { display: block; padding: 7px 9px; text-shadow: 0 1px 3px #000; }
      .close {
        position: absolute; right: -17px; top: -3px;
        width: 16px; height: 16px; margin: 0; padding: 0; border: 0;
        background: none; color: rgba(255,255,255,.7); cursor: pointer;
        font: 500 15px/16px system-ui, sans-serif;
        opacity: 0; transition: opacity .12s ease, color .12s ease;
      }
      .control:hover .close, .close:focus-visible { opacity: 1; }
      .close:hover, .close:focus-visible {
        outline: none; color: #fff;
      }
      .resize {
        position: absolute; right: 0; bottom: 0;
        width: 14px; height: 14px;
        cursor: nwse-resize; touch-action: none;
        background: transparent;
      }
    </style>
    <div class="control">
      <div class="btn" role="button" tabindex="0" title="Download with Draco">
        <img class="art" src="${chrome.runtime.getURL('downloadButton.png')}" alt="Download with Draco" />
        <span class="label" hidden>Download</span>
      </div>
      <button class="close" type="button" title="Hide on this page" aria-label="Hide Draco download button">&times;</button>
      <span class="resize" role="separator" aria-label="Resize Draco download button" title="Drag to resize"></span>
    </div>
  `

  const entry = {
    video,
    host,
    button: shadow.querySelector('.btn'),
    art: shadow.querySelector('.art'),
    label: shadow.querySelector('.label'),
    resizeHandle: shadow.querySelector('.resize'),
    hot: false,
    state: '',
    resetTimer: null
  }

  entry.art.style.width = buttonWidth + 'px'

  const activate = (event) => {
    event.preventDefault()
    event.stopPropagation()
    // The click that ends a drag is the browser's doing, not the user's.
    if (Date.now() < suppressClickUntil) return
    void grab(entry)
  }

  entry.button.addEventListener('click', activate)
  entry.button.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') activate(event)
  })
  shadow.querySelector('.close').addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    dismissedPageKey = pageKey
    clearOverlays()
  })

  /*
   * Dragging.
   *
   * The pointer is captured on the button, so a fast drag cannot outrun it and
   * leave the button stuck to the cursor - and every move keeps arriving even
   * once the pointer is over the player, which would otherwise swallow them.
   * Position is written through `offset` and applied by `layout`, so a dragged
   * button still tracks its video when the page scrolls or the player resizes.
   */
  let drag = null

  // The press is taken as well as the click: players commonly swallow clicks
  // over themselves, so the button would otherwise never answer near one - and
  // stopping it here is also what keeps a drag from reaching whatever is
  // underneath the button when it has been moved over the page.
  entry.button.addEventListener('pointerdown', (event) => {
    event.stopPropagation()
    if (event.button !== 0) return

    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      fromX: offset.x,
      fromY: offset.y,
      moved: false
    }
    try {
      entry.button.setPointerCapture(event.pointerId)
    } catch {
      // Capture is an optimisation, not a requirement.
    }
  })

  entry.button.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return

    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return

    if (!drag.moved) {
      drag.moved = true
      entry.button.style.cursor = 'grabbing'
    }

    offset = { x: drag.fromX + dx, y: drag.fromY + dy }
    // Batched to one placement per frame rather than one per move event.
    schedule()
  })

  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.id) return
    const moved = drag.moved
    drag = null

    entry.button.style.cursor = ''
    try {
      entry.button.releasePointerCapture(event.pointerId)
    } catch {
      // Already released with the pointer.
    }

    if (!moved) return
    // Long enough to cover the click the release is about to produce, short
    // enough that it can never eat a press the user meant.
    suppressClickUntil = Date.now() + 300
    saveOffset()
  }

  entry.button.addEventListener('pointerup', endDrag)
  entry.button.addEventListener('pointercancel', endDrag)

  let resize = null
  entry.resizeHandle.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.button !== 0) return
    resize = { id: event.pointerId, x: event.clientX, fromWidth: buttonWidth }
    try {
      entry.resizeHandle.setPointerCapture(event.pointerId)
    } catch {
      // Capture is an optimisation, not a requirement.
    }
  })
  entry.resizeHandle.addEventListener('pointermove', (event) => {
    if (!resize || event.pointerId !== resize.id) return
    buttonWidth = Math.min(
      MAX_BUTTON_WIDTH,
      Math.max(MIN_BUTTON_WIDTH, Math.round(resize.fromWidth + event.clientX - resize.x))
    )
    for (const item of overlays.values()) item.art.style.width = buttonWidth + 'px'
    entry.art.style.width = buttonWidth + 'px'
    schedule()
  })
  const endResize = (event) => {
    if (!resize || event.pointerId !== resize.id) return
    resize = null
    suppressClickUntil = Date.now() + 300
    try {
      entry.resizeHandle.releasePointerCapture(event.pointerId)
    } catch {
      // Already released with the pointer.
    }
    saveButtonWidth()
  }
  entry.resizeHandle.addEventListener('pointerup', endResize)
  entry.resizeHandle.addEventListener('pointercancel', endResize)

  video.addEventListener('mouseenter', () => {
    entry.hot = true
    paint(entry)
    // Hovering the player is a strong signal a click on the download button
    // is coming. Cheap to call - primeYouTubeIfNeeded no-ops once a video is
    // already primed or an attempt is already in flight.
    primeYouTubeIfNeeded()
  })
  video.addEventListener('mouseleave', () => {
    entry.hot = false
    paint(entry)
  })

  overlayRoot().appendChild(host)

  if (typeof ResizeObserver === 'function') {
    entry.observer = new ResizeObserver(schedule)
    entry.observer.observe(video)
  }

  overlays.set(video, entry)
  paint(entry)
  return entry
}

function paint(entry) {
  const classes = ['btn']
  if (entry.state) classes.push(entry.state)
  else if (mediaCount > 0) classes.push('ready')
  if (entry.hot) classes.push('hot')
  entry.button.className = classes.join(' ')
}

/**
 * Retires a button after Draco has taken its video: the confirmation stays up
 * long enough to be read, then the button is gone for the rest of the page's
 * life.
 */
function retire(entry) {
  takenOver = true
  handled.add(entry.video)

  clearTimeout(entry.resetTimer)
  entry.resetTimer = setTimeout(() => {
    destroy(entry)
    overlays.delete(entry.video)
  }, 1800)
}

function setLabel(entry, text, state, title) {
  entry.label.textContent = text
  const idle = text === 'Download' && !state
  entry.art.hidden = !idle
  entry.label.hidden = idle
  entry.state = state ?? ''
  entry.button.title = title ?? 'Download with Draco'
  paint(entry)

  clearTimeout(entry.resetTimer)
  if (state === 'done' || state === 'bad') {
    entry.resetTimer = setTimeout(() => {
      entry.label.textContent = 'Download'
      entry.art.hidden = false
      entry.label.hidden = true
      entry.state = ''
      entry.button.title = 'Download with Draco'
      paint(entry)
    }, 5000)
  }
}

async function grab(entry) {
  setLabel(entry, 'Checking…', 'busy')

  const isYouTube =
    (
      /(^|\.)youtube\.com$/i.test(location.hostname) &&
      (/^\/watch$/i.test(location.pathname) || /^\/shorts\//i.test(location.pathname))
    ) ||
    /(^|\.)youtu\.be$/i.test(location.hostname)

  if (isYouTube) {
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'draco:resolve-youtube' })
      if (reply?.ok) {
        setLabel(entry, 'Opened in Draco', 'done')
        retire(entry)
      } else {
        setLabel(
          entry,
          'YouTube failed',
          'bad',
          reply?.error ?? 'Could not extract this YouTube video.'
        )
      }
      return
    } catch (err) {
      setLabel(
        entry,
        'YouTube failed',
        'bad',
        err instanceof Error ? err.message : String(err)
      )
      return
    }
  }

  const source = entry.video.currentSrc || entry.video.src || ''
  const subtitles = [...entry.video.querySelectorAll('track[src]')]
    .filter((track) => track.kind === 'subtitles' || track.kind === 'captions')
    .slice(0, 20)
    .map((track) => {
      const url = new URL(track.src, location.href).href
      const path = new URL(url).pathname.toLowerCase()
      const format = path.endsWith('.srt') ? 'srt' : path.endsWith('.ttml') || path.endsWith('.xml') ? 'ttml' : 'vtt'
      return {
        url,
        label: track.label || track.srclang || 'Subtitles',
        language: track.srclang || null,
        format
      }
    })
  let reply
  try {
    reply = await chrome.runtime.sendMessage({
      type: 'draco:grab-best',
      videoSrc: /^https?:/i.test(source) ? source : '',
      videoWidth: Number(entry.video.videoWidth) || null,
      videoHeight: Number(entry.video.videoHeight) || null,
      subtitles,
      adaptive: source.startsWith('blob:') || ADAPTIVE_SITES.test(location.hostname)
    })
  } catch (err) {
    reply = { ok: false, error: String(err?.message ?? err) }
  }

  if (reply?.ok) {
    setLabel(entry, 'Opened in Draco', 'done')
    retire(entry)
    return
  }

  if (reply?.reason === 'adaptive') {
    setLabel(
      entry,
      'Adaptive stream',
      'bad',
      'This site streams video and audio separately behind signed URLs. ' +
        'Downloading it needs a site-specific extractor, which Draco does not have.'
    )
    return
  }

  if (reply?.reason === 'none') {
    setLabel(
      entry,
      'Nothing to grab',
      'bad',
      'No downloadable stream has been seen on this page yet. Start playback and try again.'
    )
    return
  }

  setLabel(entry, 'Draco unreachable', 'bad', reply?.error ?? 'Could not reach the Draco app.')
}

/* ------------------------------------------------------------------ */
/* Positioning                                                         */
/* ------------------------------------------------------------------ */

function schedule() {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(() => {
    scheduled = false
    layout()
  })
}

function layout() {
  const root = overlayRoot()

  for (const [video, entry] of overlays) {
    if (!video.isConnected) {
      destroy(entry)
      overlays.delete(video)
      continue
    }

    const rect = video.getBoundingClientRect()
    const minimumHeight = video instanceof HTMLAudioElement ? 30 : MIN_VIDEO_H
    const hidden =
      rect.width < MIN_VIDEO_W ||
      rect.height < minimumHeight ||
      rect.bottom <= 0 ||
      rect.top >= innerHeight ||
      rect.right <= 0 ||
      rect.left >= innerWidth

    if (hidden) {
      entry.host.style.display = 'none'
      continue
    }

    // Entering or leaving fullscreen changes which element the overlay has to
    // live inside; re-parenting is cheap and only happens when it really did.
    if (entry.host.parentNode !== root) root.appendChild(entry.host)

    // Made measurable before being measured: a display:none element has no size,
    // and placing the corner needs the button's real width.
    entry.host.style.display = 'block'

    const width = entry.host.offsetWidth || 110
    const height = entry.host.offsetHeight || 30

    /*
     * Just outside the frame's top-left corner, not on top of it.
     *
     * Over the picture the button covered the thing it was offering to
     * download and competed with the player's own controls for the same
     * pixels. Above the frame where there is room for it, below where there is
     * not - both are outside - and only pinned inside the viewport when the
     * video is taller than the window and there is nowhere outside left.
     */
    let left = rect.left
    let top = rect.top - height - GAP
    if (top < 4) top = rect.bottom + GAP

    left = Math.min(Math.max(4, left + offset.x), Math.max(4, innerWidth - width - 4))
    top = Math.min(Math.max(4, top + offset.y), Math.max(4, innerHeight - height - 4))

    entry.host.style.left = Math.round(left) + 'px'
    entry.host.style.top = Math.round(top) + 'px'
  }
}

addEventListener('scroll', schedule, { capture: true, passive: true })
addEventListener('resize', schedule, { passive: true })

function destroy(entry) {
  clearTimeout(entry.resetTimer)
  entry.observer?.disconnect()
  entry.host.remove()
}

/**
 * Notices an in-page navigation and puts the button back.
 *
 * Checked here rather than through `history` patching or a site-specific event:
 * this runs off the same mutation-driven scan the buttons already depend on, so
 * it needs nothing from the page and works wherever that does.
 */
function checkNavigation() {
  if (location.href === pageKey) return
  pageKey = location.href

  handled = new WeakSet()
  takenOver = false
  clearTimeout(primeRetryTimer)
  primeRetryTimer = null
  primingVideoId = null
  primeRetryDelay = 800
  dismissedPageKey = null
  lastDomInventory = ''

  // The overlays go with the old page. Rebuilding them is what returns a button
  // to a reused video element, and `destroy` also cancels the retire timer of
  // anything that was mid-retirement when the navigation happened.
  clearOverlays()
}

function clearOverlays() {
  for (const [video, entry] of overlays) {
    destroy(entry)
    overlays.delete(video)
  }
}

function scan() {
  if (orphaned) return
  checkNavigation()

  if (!dracoState.active || dismissedPageKey === pageKey || !pageWantsButtons()) {
    clearOverlays()
    return
  }

  const mediaElements = document.querySelectorAll('video, audio')
  for (const media of mediaElements) {
    if (!overlays.has(media) && !handled.has(media)) createOverlay(media)
  }
  inventoryDomMedia()
  // Priming only needs the video id out of the URL, not a mounted <video>
  // element, so it starts the moment a watch page shows up in a scan - which
  // on an SPA nav is well before the player itself remounts. Waiting on the
  // element was giving away the head start this exists to buy.
  primeYouTubeIfNeeded()
  schedule()
}

let lastDomInventory = ''
function inventoryDomMedia() {
  const items = []
  for (const element of document.querySelectorAll('video, audio, source')) {
    const raw = element.currentSrc || element.src || element.getAttribute('src') || ''
    if (!raw) continue
    let url
    try { url = new URL(raw, location.href).href } catch { continue }
    if (!/^https?:/i.test(url)) continue
    const parent = element.parentElement
    const audio = element instanceof HTMLAudioElement || parent instanceof HTMLAudioElement
    items.push({ url, mediaType: audio ? 'audio' : 'video' })
  }
  const unique = [...new Map(items.map((item) => [item.url, item])).values()].slice(0, 50)
  const signature = unique.map((item) => `${item.mediaType}:${item.url}`).join('\n')
  if (!signature || signature === lastDomInventory) return
  lastDomInventory = signature
  void sendToExtension({ type: 'draco:dom-media', items: unique })
}

function currentYouTubeVideoId() {
  return (
    new URLSearchParams(location.search).get('v') ||
    (/^\/(?:shorts|embed|live)\/([^/?#]+)/i.exec(location.pathname) || [])[1] ||
    (/(^|\.)youtu\.be$/i.test(location.hostname)
      ? location.pathname.replace(/^\//, '').split('/')[0]
      : null)
  )
}

function scheduleYouTubePrimeRetry(videoId) {
  if (currentYouTubeVideoId() !== videoId || primedVideoId === videoId) return

  clearTimeout(primeRetryTimer)
  const delay = primeRetryDelay
  primeRetryDelay = Math.min(primeRetryDelay * 2, 10000)
  primeRetryTimer = setTimeout(() => {
    primeRetryTimer = null
    primeYouTubeIfNeeded()
  }, delay)
}

/** Starts extraction on page open and retries until the link cache is ready. */
function primeYouTubeIfNeeded() {
  if (!isTopFrame || !YOUTUBE_HOSTS.test(location.hostname)) return

  const videoId = currentYouTubeVideoId()

  if (!videoId || videoId === primedVideoId || videoId === primingVideoId) return

  primingVideoId = videoId
  void sendToExtension({ type: 'draco:prime-youtube' })
    .then((reply) => {
      if (currentYouTubeVideoId() !== videoId) return

      if (reply?.ok && reply?.primed) {
        primedVideoId = videoId
        primeRetryDelay = 800
        console.debug('[Draco] YouTube download links are ready')
      } else {
        scheduleYouTubePrimeRetry(videoId)
      }
    })
    .catch(() => scheduleYouTubePrimeRetry(videoId))
    .finally(() => {
      if (primingVideoId === videoId) primingVideoId = null
    })
}

function updatePanel() {
  // Intentionally empty. Detected media is reflected on the player button and
  // in the extension popup; Draco no longer covers pages with a corner card.
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'draco:state-changed') {
    dracoState = message.state ?? dracoState
    scan()
    updatePanel()
    return
  }
  if (message?.type !== 'draco:media-count') return
  mediaCount = message.count ?? 0

  for (const entry of overlays.values()) paint(entry)
  updatePanel()
})

/**
 * Videos appear late on nearly every site worth downloading from, so the DOM has
 * to be watched - but the sites that matter most also mutate constantly, and a
 * querySelectorAll on every mutation batch is a real cost on a page like
 * YouTube. One scan per frame at most.
 */
pageObserver = new MutationObserver(() => {
  if (scanScheduled) return
  scanScheduled = true
  requestAnimationFrame(() => {
    scanScheduled = false
    scan()
    updatePanel()
  })
})
pageObserver.observe(document.documentElement, { childList: true, subtree: true })

addEventListener('scroll', schedule, { capture: true, passive: true })
addEventListener('resize', schedule, { passive: true })
document.addEventListener('fullscreenchange', schedule)

function saveOffset() {
  try {
    void chrome.storage?.local?.set({ [OFFSET_KEY]: offset })
  } catch {
    // Remembering where the button was put is a convenience, not something to
    // fail a page over.
  }
}

function saveButtonWidth() {
  try {
    void chrome.storage?.local?.set({ [SIZE_KEY]: buttonWidth })
  } catch {
    // Remembering the button size is optional.
  }
}

function loadPlacement() {
  try {
    return Promise.resolve(chrome.storage?.local?.get([OFFSET_KEY, SIZE_KEY]))
      .then((stored) => {
        const saved = stored?.[OFFSET_KEY]
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
          offset = { x: saved.x, y: saved.y }
        }
        const savedWidth = stored?.[SIZE_KEY]
        if (Number.isFinite(savedWidth)) {
          buttonWidth = Math.min(MAX_BUTTON_WIDTH, Math.max(MIN_BUTTON_WIDTH, savedWidth))
        }
      })
      .catch(() => {})
  } catch {
    return Promise.resolve()
  }
}

void loadPlacement().then(() => {
  for (const entry of overlays.values()) entry.art.style.width = buttonWidth + 'px'
  schedule()
})

async function refreshDracoState(force = false) {
  const state = await sendToExtension({ type: 'draco:page-state', force })
  if (state) dracoState = state
  scan()
  updatePanel()
}

void Promise.all([
  sendToExtension({ type: 'draco:list-media' }).then((reply) => {
    mediaCount = reply?.media?.length ?? 0
  }),
  refreshDracoState(true)
]).finally(() => {
  scan()
  updatePanel()
})

// A content script can outlive the app. A lightweight native-host probe keeps
// stale controls from remaining visible after Draco exits and makes them appear
// when it is started without requiring a page reload.
stateTimer = setInterval(() => {
  // standDown clears this, but it can also run before this line does - the
  // probe below is the first thing an orphan touches. Checking here means the
  // ticker retires itself whichever order those two happen in.
  if (orphaned) {
    clearInterval(stateTimer)
    return
  }

  if (document.visibilityState === 'visible') void refreshDracoState(true)
}, 5000)
