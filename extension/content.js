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
  try {
    const match = /\.([a-z0-9]{1,10})$/i.exec(new URL(url, location.href).pathname)
    return match ? match[1].toLowerCase() : ''
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

    chrome.runtime
      .sendMessage({ type: 'draco:link-click', url, filename: suggested || undefined })
      .then((reply) => {
        if (!reply?.taken) location.href = url
      })
      .catch(() => {
        location.href = url
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

/** A press has to move this far before it is a drag rather than a click. */
const DRAG_SLOP = 4

/** Set when a drag has just ended, so its trailing click does not download. */
let suppressClickUntil = 0

/** How far outside the frame the button sits. */
const GAP = 8

let mediaCount = 0
let scheduled = false
let scanScheduled = false
let pollTimer = null

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
      .btn {
        display: inline-flex; align-items: center; gap: 6px;
        font: 600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
        padding: 7px 10px;
        border-radius: 8px;
        background: rgba(12, 15, 22, .85);
        color: #e6e9f0;
        border: 1px solid rgba(255,255,255,.16);
        box-shadow: 0 6px 20px rgba(0,0,0,.45);
        cursor: pointer;
        white-space: nowrap;
        user-select: none;
        /* Outside the picture now, so it no longer has to stay out of the way
           of it - at .4 against a page background it just looked broken. */
        opacity: .8;
        cursor: grab;
        touch-action: none;
        transition: opacity .15s ease, border-color .15s ease, background .15s ease;
      }
      .btn:hover { opacity: 1; border-color: #38bdf8; background: rgba(12,15,22,.96); }
      .btn.hot { opacity: .95; }
      .btn.ready { border-color: rgba(56,189,248,.55); }
      .btn.busy { opacity: 1; }
      .btn.bad { opacity: 1; border-color: rgba(251,191,36,.55); color: #fbbf24; }
      .btn.done { opacity: 1; border-color: rgba(52,211,153,.55); color: #34d399; }
      .mark { width: 14px; height: 14px; flex: none; }
    </style>
    <div class="btn" role="button" tabindex="0" title="Download with Draco">
      <svg class="mark" viewBox="0 0 24 24" fill="none" stroke="#38bdf8"
           stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3.5v11M12 15.5 7.2 10.4M12 15.5l4.8-5.1M4.5 19.5h15" />
      </svg>
      <span class="label">Download</span>
    </div>
  `

  const entry = {
    video,
    host,
    button: shadow.querySelector('.btn'),
    label: shadow.querySelector('.label'),
    hot: false,
    state: '',
    resetTimer: null
  }

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

  video.addEventListener('mouseenter', () => {
    entry.hot = true
    paint(entry)
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
  removePanel()

  clearTimeout(entry.resetTimer)
  entry.resetTimer = setTimeout(() => {
    destroy(entry)
    overlays.delete(entry.video)
  }, 1800)
}

function setLabel(entry, text, state, title) {
  entry.label.textContent = text
  entry.state = state ?? ''
  entry.button.title = title ?? 'Download with Draco'
  paint(entry)

  clearTimeout(entry.resetTimer)
  if (state === 'done' || state === 'bad') {
    entry.resetTimer = setTimeout(() => {
      entry.label.textContent = 'Download'
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
  let reply
  try {
    reply = await chrome.runtime.sendMessage({
      type: 'draco:grab-best',
      videoSrc: /^https?:/i.test(source) ? source : '',
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
    const hidden =
      rect.width < MIN_VIDEO_W ||
      rect.height < MIN_VIDEO_H ||
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

  if (overlays.size > 0 && !pollTimer) {
    // A safety net for layout the observers cannot see - a player animating its
    // own size, a sticky header collapsing. Cheap, and only while a video exists.
    pollTimer = setInterval(schedule, 500)
  } else if (overlays.size === 0 && pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

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
  checkNavigation()

  if (!pageWantsButtons()) {
    clearOverlays()
    return
  }

  for (const video of document.querySelectorAll('video')) {
    if (!overlays.has(video) && !handled.has(video)) createOverlay(video)
  }
  schedule()
}

/* ------------------------------------------------------------------ */
/* 3. The corner panel, for media with no video element                */
/* ------------------------------------------------------------------ */

let panelHost = null
let panelShadow = null

function ensurePanel() {
  if (panelHost) return

  panelHost = document.createElement('div')
  panelHost.style.cssText =
    'position:fixed;right:18px;bottom:18px;z-index:2147483647;margin:0;padding:0;border:0'

  panelShadow = panelHost.attachShadow({ mode: 'closed' })
  panelShadow.innerHTML = `
    <style>
      :host { all: initial; }
      .card {
        font: 500 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
        display: flex; align-items: center; gap: 10px;
        padding: 10px 12px; border-radius: 10px;
        background: #12151d; color: #e6e9f0;
        border: 1px solid #2a3040;
        box-shadow: 0 10px 30px rgba(0,0,0,.45);
        cursor: pointer; user-select: none;
      }
      .card:hover { border-color: #38bdf8; }
      .dot {
        width: 20px; height: 20px; border-radius: 6px;
        background: #38bdf8; color: #06121a;
        display: grid; place-items: center; font-weight: 700; font-size: 11px;
      }
      .close { margin-left: 4px; opacity: .5; font-size: 15px; line-height: 1; padding: 0 2px; }
      .close:hover { opacity: 1; }
    </style>
    <div class="card">
      <span class="dot">D</span>
      <span class="label">Media detected</span>
      <span class="close" title="Hide">&times;</span>
    </div>
  `

  panelShadow.querySelector('.card').addEventListener('click', async (event) => {
    if (event.target.classList.contains('close')) {
      event.stopPropagation()
      removePanel()
      return
    }

    const reply = await chrome.runtime
      .sendMessage({ type: 'draco:grab-best', videoSrc: '', adaptive: false })
      .catch(() => null)

    if (reply?.ok) takenOver = true
    panelShadow.querySelector('.label').textContent = reply?.ok
      ? 'Opened in Draco'
      : 'Nothing Draco can grab'
    setTimeout(removePanel, 2500)
  })

  document.documentElement.appendChild(panelHost)
}

function removePanel() {
  panelHost?.remove()
  panelHost = null
  panelShadow = null
}

function updatePanel() {
  // Only in the top frame, and only when there is no video to hang a button on
  // - otherwise the page gets a button *and* a panel saying the same thing.
  if (!isTopFrame) return
  // The page has already been handed over; the retired button must not come
  // back as a panel saying the same thing.
  if (takenOver) return
  // And a page that is not for watching does not get the panel either, or a
  // YouTube homepage would answer a removed button with a corner card.
  if (!pageWantsButtons()) {
    removePanel()
    return
  }

  if (mediaCount > 0 && overlays.size === 0) {
    ensurePanel()
    panelShadow.querySelector('.label').textContent =
      mediaCount === 1 ? 'Download this media' : `${mediaCount} media streams`
  } else {
    removePanel()
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message) => {
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
new MutationObserver(() => {
  if (scanScheduled) return
  scanScheduled = true
  requestAnimationFrame(() => {
    scanScheduled = false
    scan()
    updatePanel()
  })
}).observe(document.documentElement, { childList: true, subtree: true })

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

function loadOffset() {
  try {
    return Promise.resolve(chrome.storage?.local?.get(OFFSET_KEY))
      .then((stored) => {
        const saved = stored?.[OFFSET_KEY]
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
          offset = { x: saved.x, y: saved.y }
        }
      })
      .catch(() => {})
  } catch {
    return Promise.resolve()
  }
}

void loadOffset().then(schedule)

chrome.runtime
  .sendMessage({ type: 'draco:list-media' })
  .then((reply) => {
    mediaCount = reply?.media?.length ?? 0
  })
  .catch(() => {})
  .finally(() => {
    scan()
    updatePanel()
  })
