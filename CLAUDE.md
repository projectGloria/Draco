# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Draco is a Windows-only IDM-style download manager: an Electron + React app whose
hand-written download engine does dynamic segmented downloads, plus a browser
extension (Chrome MV3, repackaged for Firefox) and a Go native-messaging host
that let it take downloads away from the browser. There is no README; the source
carries block comments explaining *why* each part is the way it is — read them
before changing behaviour, they usually record a decision rather than describe
the code. `AGENTS.md` is a short contributor-style summary and `IDM_COMPARISON.md`
tracks which IDM features are covered — neither is a design document.

## Commands

```bash
npm run dev          # electron-vite dev (main + preload + 4 renderer entries, HMR)
npm run build        # typecheck, then electron-vite build -> out/
npm run typecheck    # tsc --noEmit over tsconfig.node.json and tsconfig.web.json
npm test             # node --experimental-strip-types --test tests/*.test.mjs
npm run dist         # firefox extension + build + electron-builder --win (nsis) -> dist/
npm run pack         # same, but --dir (unpacked, for quick checks)

npm run host         # builds host/draco-host.exe via host/build.ps1 (needs Go)
npm run extension:firefox  # regenerates extension-firefox/ from extension/
npm run keygen       # one-time: generates extension/key.pem and pins the extension ID
npm run icon         # regenerates resources/icon.ico (needs Python)
```

Run a single test file: `node --experimental-strip-types --test tests/segmenter.test.mjs`.
Tests are plain `node:test` `.mjs` files that `import` the `.ts` sources directly
via type stripping — no test build step, no framework. There is no linter. The Go
host has its own tests: `go test ./...` in `host/`.

Drive the engine without any UI (prints the live segment table, so you can watch
splitting and confirm Ctrl-C resumes at the right offsets):

```bash
node tools/dl.ts <url> [--dir DIR] [--conn N] [--limit BPS] [--min-split BYTES] [--tasks N]
```

`tools/dl_yt.ts` is the same idea for the YouTube path, `tools/register-host.ps1`
registers the native host when the app itself cannot, and
`tools/e2e-native-handoff.mjs` replays a real handoff frame at the pipe.

## Architecture

Four separately-built artifacts cooperate:

1. **Electron main** (`src/main`) — owns all state and all privilege.
2. **Renderer** (`src/renderer`) — React 19 + Zustand + Tailwind v4; four HTML
   entries: `index` (app), `splash`, `handoff` (the per-download confirm window)
   and `progress` (IDM's per-download progress window).
3. **Go native host** (`host/main.go`) — a console binary the browser launches.
4. **Browser extension** (`extension/`) — MV3, loaded unpacked by the user.
   `extension-firefox/` is **generated** from it by
   `tools/build-firefox-extension.mjs` (drops `key`, converts the service worker
   to a background script, adds `browser_specific_settings`). Never hand-edit
   `extension-firefox/` — `extension/` is the only source.

### The browser bridge

`extension → native messaging (stdio) → host/draco-host.exe → named pipe \\.\pipe\draco → PipeServer → handleHostMessage`

- `src/main/bridge/protocol.ts` is the single wire-format definition, shared by
  all three sides. It is byte-identical to Chrome's own framing (4-byte LE length
  + UTF-8 JSON) precisely so the Go host relays frames without parsing them.
- The Go host is a **console-subsystem** binary on purpose (Chrome 115+ hides
  those; a GUI one flashes a window per download) and must **never** write
  anything to stdout except a protocol frame.
- A named pipe rather than a loopback port: the default ACL scopes it to the
  logged-in user, so there is no port to find and no shared secret.
- `bridge/integration.ts` rewrites the native-messaging manifests and the HKCU
  registry keys for **six** browsers (Chrome, Edge, Brave, Opera, Vivaldi and
  Firefox, which needs its own manifest shape) on **every** launch, so moving the
  app repairs the integration instead of breaking it.
- Message types: `ping`, `config` (extension asks what to intercept),
  `youtubePrime` (warm the yt-dlp lookup before a click), `download`, `media`,
  `youtube`. Mutating types are deduplicated in main by `requestId`, because the
  host retries.
- Everything from the extension originated in a web page — treat it as untrusted
  and validate (`engine/create.ts:validateUrl`) before acting.

**Cold start is deliberately narrow.** The host can start the app, but
`shouldLaunchForMessage` (`host/main.go`, covered by `host/main_test.go`) only
lets a message the *user* caused do it — `download`, `media`, `youtube`. `ping`,
`config`, `youtubePrime` and anything unparseable are passive and never launch
Draco, so merely having the extension installed does not start the app. The
extension mirrors this: it primes YouTube only when `probeApp()` says Draco is
already running. The host reads `%APPDATA%/Draco/host-config.json`, written by
`writeHostFiles`. In development `appPath` is Electron itself and `appArgs` must
be `app.getAppPath()` (the directory with `package.json`), *not* `paths.root`
(userData). Get that wrong and Electron shows "Unable to find Electron app at …"
with nobody having tried to open anything.

### Extension identity

The extension ID is pinned by the `key` field in `extension/manifest.json`,
derived from `extension/key.pem` (gitignored, never shipped — see the
`electron-builder.yml` filter and the `build.extraResources` filter in
`package.json`). An unpacked extension's ID otherwise changes with its folder
path, which would silently break `allowed_origins`. Never regenerate the key
casually; `tools/gen-extension-key.mjs` deliberately reuses an existing
`key.pem`.

Chrome runs the old service worker until the extension is reloaded at
`chrome://extensions`, so changes to `extension/` need that reload before they
take effect — otherwise main silently sees the old message shape.

### The service worker and popup (`extension/background.js`, `popup.js`)

- Handoffs go out as one-shot `sendNativeMessage` calls, never a long-lived
  port: an MV3 worker is killed whenever it goes idle, and a one-shot message is
  also what lets the host cold-start the app.
- `shouldTakeOver` decides whether a download is Draco's business at all, from
  the rules the app answers `config` with (cached for 60 s). `isTakeableUrl` is
  the same rules minus everything that needs a live `DownloadItem`, because a
  link click has a URL and nothing else. A URL Draco declines goes onto a
  30-second pass-through list, so when the replayed navigation produces a
  download item `downloads.onCreated` leaves it alone instead of taking it over
  a second time.
- Stream sniffing is observation only — MV3 removed *blocking* webRequest, not
  watching. URLs are classified by extension; `onHeadersReceived` catches the
  extensionless CDN and API paths by `content-type`. Chunk hosts
  (`googlevideo.com`, `ttvnw.net`, …) and sub-512 KB responses are dropped,
  because an adaptive player's thousands of chunks would bury the one file that
  is actually downloadable. The per-tab list lives in `chrome.storage.session`,
  bounded to 40 and cleared on navigation; a playlist outranks a loose file.
- The popup carries the user's own opt-outs (`dracoPrefs` in
  `chrome.storage.local`): a global pause plus per-channel and per-video
  YouTube exclusions. Those are the extension's state and main knows nothing
  about them. The toolbar icon (`status-icons/`) encodes the four combinations
  of running/not and excluded/not, and is refreshed per tab.

### The in-page button (`extension/content.js`)

Everything here renders into *closed* shadow roots, so a page cannot restyle,
read or collide with it.

- Link clicks are taken on the `click` capture phase, **before** the browser does
  anything: by the time `chrome.downloads` fires, the download shelf has already
  been drawn. If Draco declines the job the navigation is replayed, so a link is
  never silently swallowed.
- A button is only put on a video the page exists to play (`pageWantsButtons`).
  On a YouTube host that means `/watch`, `/shorts/`, `/live/` or `/embed/` -
  YouTube's homepage, search and channel pages are wall-to-wall `<video>`,
  because every thumbnail plays a preview on hover. Other sites are unfiltered.
- The button sits *outside* the frame's top-left corner (below it when there is
  no room above) and can be dragged. The drag is stored as an offset from that
  anchor, not as a position, so a moved button still tracks its video when the
  page scrolls; it is persisted in `chrome.storage.local`.
- A successful handoff **retires** the button for that video: a second press
  could only produce a second copy. `checkNavigation` is what un-retires it, and
  it is not optional - YouTube is an SPA that reuses the very same `<video>`
  element for the next video, so without it the button never returns.
- Layout runs from one `requestAnimationFrame` per mutation batch plus a 500 ms
  poll that only exists while a button does; a `querySelectorAll` per mutation is
  a real cost on a page like YouTube.

### The download engine (`src/main/engine`)

The core idea, and the reason this is hand-written rather than an aria2 wrapper,
lives in `segmenter.ts`: start with one range and **split on demand** — when a
connection frees up, cut a segment and hand the tail to it. Splitting only moves
a segment's `end` backwards into unwritten bytes, so a mid-flight worker just
stops early.

*Which* segment and *where* are decided on measured throughput, not on bytes.
`observe()` folds each segment's progress into a smoothed per-segment rate off
the manager's existing ticker, and `split()` cuts the segment with the longest
**time** remaining — the one holding the most bytes may be the one about to
finish first. It cuts where both halves are expected to land together: an
incumbent at rate `r` against a newcomer expected to manage `q` keeps
`r / (r + q)` of what is left, so a slow connection gives most of its work away
and a fast one keeps most of its own. Equal rates reduce that to halving, which
is what happens before anything has been measured. Both halves are clamped to
`minSplitSize`, and that clamp is load-bearing beyond avoiding slivers — see
`worker.ts` below.

How *many* connections is measured too, by `ramp.ts`. The configured maximum is
a ceiling rather than an instruction: a task opens four, waits out TCP slow
start, then watches a rung for two seconds and doubles only when throughput rose
by more than a tenth — otherwise it hands the rung back and settles. Stepping
down tears nothing down; the cap simply stops being refilled, so the extras
retire as their segments finish. A `ServerBusyError` ends the climb outright,
because an explicit refusal outranks anything throughput has to say. The opt-in
`adaptiveConnectionCeiling` setting lets the climb continue past
`maxConnectionsPerTask` (a per-host rule still wins); it is null by default, so
out of the box the ramp only ever finds its way *up to* the configured number.

- `manager.ts` owns every task and decides what runs. **It imports no Electron
  and no ffmpeg** — that is load-bearing, because `tools/dl.ts` drives the exact
  same manager from a terminal. Anything Electron- or ffmpeg-specific is injected
  through `ManagerOptions` (`createHlsRunner`, `createMpdRunner`,
  `createDashRunner`, `refreshYouTube`, `onProbed`).
- `runner.ts` is the interface the manager is written against. Runner selection
  is four-way, and the two "DASH" names are **not** the same thing:
  `kind === 'hls'` → `hls/runner.ts`; `kind === 'dash'` → `dash/runner.ts`
  (`MpdRunner`: a whole MPEG-DASH manifest handed to ffmpeg's native demuxer);
  `task.audioUrl` set → `hls/dash.ts` (`DashRunner`: two `TaskRunner`s for a
  separate video and audio track, muxed at the end); otherwise `TaskRunner`.
- `worker.ts` gathers socket chunks and lands them with one positioned
  `fh.writev(..., position)`, so all connections share one file handle with no
  locking. Batching is what keeps the syscall count and the part file's NTFS
  extent map down — undici hands over 16-64 KB at a time — and `writev` is what
  makes it free, since the chunks are written as they are rather than copied
  into a buffer first. A batch may never exceed `minSplitSize`: gathered bytes
  have not moved `seg.position` yet, and that is the number `split()` reads, so
  staying under one minimum split keeps them behind any split point. The commit
  re-clamps to the live `end` regardless, since `end` can also move while a
  write is in flight; bytes past it are written but not claimed, and whoever now
  owns them writes the same bytes at the same offsets.
- `preallocate.ts` reserves the whole part file before the first byte lands, and
  the reason it is a module rather than a line is that the obvious way does not
  work. A plain extend leaves NTFS's valid data length at zero, and NTFS makes
  good on that by zero-filling from there to wherever the next write goes - so
  the first connection to reach the far end of a segmented download makes the
  system write the entire file out in zeros first. The two usable answers are
  `fsutil file setvaliddata`, which declares the range valid without writing it
  and leaves a contiguous file, and marking the file sparse, which has no
  zero-fill because there is nothing allocated to zero. The first needs
  SeManageVolumePrivilege (an elevated run, or "Perform volume maintenance
  tasks" granted to the account) and is tried first; the second always works and
  is the fallback, at the cost of an extent map that scattered writes grow one
  entry at a time. The verdict is cached per volume root, so an unprivileged
  session probes once rather than once per download. `HttpStatusError` (e.g. 429) is distinct
  from a generic failure so the task ratchets its connection cap down instead of
  failing.
- A server that advertises ranges and then ignores one leaves data that can never
  line up. `manager.ts` catches that once, wipes the partial file and sets
  `task.singleConnectionFallback`, which then sticks for the life of the task.
- `http.ts` holds one shared undici `Agent` per timeout value, so keep-alive is
  reused across segments *and* across downloads to the same host. `setProxyUrl`
  swaps in a `ProxyAgent` by *retiring* the existing pools rather than closing
  them, so in-flight requests finish on the old one.
- Per-host connection caps live in `network-rules.ts` (most-specific rule wins,
  parent domains included); the rolling transfer quota lives in `limiter.ts`
  beside the speed cap and is persisted to `quota.json`.
- **Resume contract** (`journal.ts`): partial data is `<name>.dracodl`, beside it
  `<name>.dracodl.json` recording every segment's position. Journal writes go
  through temp-file + rename. On load, every unfinished task is reconciled
  against its journal — not just ones caught mid-flight, since the journal can be
  ahead of `tasks.json` by several restarts.
- `probe.ts` settles the real filename and MIME type before any bytes land; that
  is when `onProbed` re-files the task into its category folder.

A runner's `status` is what the UI reads: `DownloadTable` and `StatusBar` show
speed and ETA from the task's own figures, and every runner is expected to zero
`speed` and null `eta` on pause, error and completion. A composite runner must
also keep the parent's status honest while its children work — `DashRunner.tick`
derives it from them, because a parent stuck on `probing` for the whole transfer
reads as a broken speed indicator.

### YouTube (`src/main/youtube.ts`, `src/main/youtube-ladder.ts`)

yt-dlp costs ~6.5s per video, nearly all of it its own startup plus YouTube round
trips, so it is deliberately kept off the path between pressing the button and
seeing the quality list:

- The extension reads the ladder out of the page (`#movie_player`'s
  `getPlayerResponse()`, then `ytInitialPlayerResponse`) via
  `chrome.scripting.executeScript` with `world: 'MAIN'`, and sends it as
  `pageFormats` on the `youtube` message. It checks the response's `videoId`
  against the URL first — YouTube is an SPA and those globals outlive the video
  that set them.
- **`pageFormats` is metadata only and carries no URLs.** The page is web
  content; it may name a format by itag but must never nominate what Draco
  fetches. Every download URL still comes from yt-dlp, and from exactly one
  place: `refreshYouTubeFormat`, which re-applies `isDirectDownload`.
  Consequently a page-derived `MediaVariant.url` is `''` — `sanitizeVariants`
  permits that only when a `youtube` format id is present. Where a prepared URL
  *is* accepted, `youtube-url.ts` pins it to `googlevideo.com/videoplayback`
  with an itag matching the format the page described.
- **The two ladders do not share itags.** The page's player response and
  yt-dlp's `--dump-single-json` are answers from different YouTube clients: a
  page offering 720p as itag 136 has been seen against a yt-dlp list containing
  no 136 at all, only 298. So the task records the *rung* the user chose
  (`task.youtube.height`) alongside the itags, and `selectDirectYtFormat` falls
  back to it — nearest rung, never above the one chosen, and refused outright
  when the rung is unknown. Without that, a perfectly downloadable video failed
  with "format 136 is no longer available" on the strength of a name.
- **A YouTube task carries the watch page, never a signed URL.** `url` (and
  `audioUrl`, which is what selects the DASH runner) is the watch page plus the
  chosen format ids; `TaskRunner.run` resolves the real URL as it starts. That
  keeps an expiring URL out of `tasks.json`, and it is why pressing Start closes
  the confirm window at once instead of waiting on yt-dlp first.
- `primeYouTube` starts the yt-dlp lookup as the confirm window opens, so it
  overlaps with the user choosing and the start above normally finds it cached.
  `loadInfo` caches per video id for 5 minutes. `refreshYouTube(task, force)`
  distinguishes the two callers: a start takes the cache, a 401/403 part-way
  through forces past it, because the expired URL came from that cache. Forcing
  on both would run yt-dlp again per stream — twice more for a video+audio pair.
- yt-dlp needs a JavaScript runtime for YouTube's player challenges;
  `youtube-runtime.ts` points it at the running Electron executable with
  `ELECTRON_RUN_AS_NODE`, so neither Deno nor Node on PATH is required in dev or
  in a packaged build.
- Main logs which path produced the ladder ("from the page" vs "from yt-dlp") —
  check `%APPDATA%/Draco/logs/main.log` when the picker is slow.

`youtube-ladder.ts` collapses YouTube's many duplicate formats into one entry per
quality rung — the highest-bitrate copy of each — labelled 8K/4K/2K/1080p. Four
rules there are not obvious and are individually tested:

- **Only directly fetchable formats** (`isDirectDownload`). yt-dlp also lists
  HLS/DASH repackagings and prices them *above* the real file, so ranking on
  bitrate alone picks a manifest at every rung; the engine then saves playlist
  text as `.v.mp4` and ffmpeg rejects it with "Invalid data found". They also
  carry no `filesize`, so every quality shows the same audio-only estimate.
- **Rungs snap to the short side** of the frame, which is how YouTube names
  quality — otherwise a 1080×1920 Short is offered as "4K".
- **Progressive formats are ranked on video bitrate**, discounting the audio that
  their `tbr` includes, so they do not beat video-only formats on bitrate they do
  not have.
- **`container` is what the mux must produce**, not what the video half happens
  to be: `-c copy` means the container has to take both streams as they are. AAC
  keeps it `.mp4` whatever the video codec, Opus needs `.webm`, and Opus beside
  an MP4-only video leaves `.mkv`. It is also the extension the quality picker
  shows and the name it suggests, so the label and the file cannot disagree.

### Playlists and manifests (`src/main/hls`, `src/main/dash`)

HLS deliberately does **not** reuse the byte-range segmenter — a playlist is
hundreds of separate resources, some individually encrypted, not one resource in
ranges. What is shared is the rate limiter, retry discipline, and the rule that
nothing takes its final name until complete. HLS resume needs no journal: a
finished piece is renamed into place, so the piece file's existence *is* the
record.

`dash/manifest.ts` inspects an MPD before anything is fetched and **fails loudly
on `<ContentProtection>`**, naming the system (Widevine / PlayReady / FairPlay /
ClearKey). DRM is diagnosed, never bypassed. `dash/headers.ts` serializes
captured browser headers for ffmpeg while rejecting CR and LF, so a page cannot
inject header lines into the child process.

ffmpeg and yt-dlp are **not bundled**. Both look on PATH first and otherwise
fetch into `%APPDATA%/Draco/bin`; the ffmpeg download is the step most likely to
stall, so it carries connect and stall timeouts and reports progress *before* the
request rather than on the first byte. Muxing is always `-c copy`, and `mux()`
passes `-nostdin` with no stdout for the child: ffmpeg waiting on an open stdin,
or filling an undrained pipe, is a finished download stuck on "Muxing" forever.

### Other main-process subsystems

- `site-grabber/` — IDM's site grabber. `crawler.ts` is a bounded breadth-first
  crawl (depth, page count, same-host and robots limits, all clamped in the
  crawler regardless of what the caller asked for) that returns pages with
  rewritten offline links; `projects.ts` persists projects to
  `site-projects.json` and re-runs them on a 5-minute tick, adding only newly
  discovered URLs rather than re-fetching everything.
- `security/scanner.ts` — optional post-download antivirus. `shell: false`, a
  `{file}` placeholder, and a hard timeout: no command shell ever sees a
  downloaded file's name. A scanner that fails to run is reported as a failure,
  never treated as a pass.
- `update.ts` / `update-version.ts` — a provider-neutral HTTPS JSON feed
  (`{ version, url, notes }`) that is checked and surfaced only; nothing installs
  itself, and a redirect off HTTPS is an error.
- `media/subtitles.ts` — page captions saved as sidecars, size-capped and run
  through the shared rate limiter; a caption failure must never damage the video.
- `queue/scheduler.ts` — never downloads anything; it only decides which tasks
  are allowed to be `queued`, so the manager remains the single place work
  starts. Completion actions (sleep/shutdown/exit, or a program to run) sit
  behind a cancellable grace period. The time-window arithmetic is split into the
  Electron-free `scheduler-window.ts` so it can be tested.

### State, IPC and the renderer

- All persistence is JSON files under `%APPDATA%/Draco` (`bootstrap/paths.ts` is
  the only place that names them: settings, tasks, categories, queues, quota,
  media and site projects, plus the icon cache, `bin/` and `logs/`). `store.ts`
  writes via unique-temp + rename; everything read back goes through
  `store-sanitize.ts`, which is defensive against hostile/malformed records and
  is directly tested.
- `preload/index.ts` is the entire renderer capability surface — no Node, no fs,
  contextIsolation on. A new feature needs a channel in both `preload/index.ts`
  and `main/ipc.ts`, and a type in `shared/types.ts` (`RendererApi`).
- The renderer owns no truth: every mutation goes out over IPC and comes back
  through a subscription. Task list changes push `tasks:changed`; progress is a
  separate batched 4 Hz `tasks:progress` feed (manager ticks at 250 ms).
  `store/app.ts` is the one Zustand store and the only place those
  subscriptions are wired. Per-task speed history is deliberately *not* in it
  (`lib/history.ts`): a 4 Hz sample per running task in reactive state would
  re-render the whole table to animate a sparkline that is usually closed.
- Localized UI strings live in `src/renderer/src/i18n.ts` (English and Turkish,
  keyed off the `language` setting). It is a flat literal map typed off the
  English table, so a new key must be added to both or `typecheck` fails.
- Startup (`main/index.ts`) is a real 5-step sequence reported to the splash
  window (`appdata`, `settings`, `restore`, `bridge`, `integration`); a failed
  step becomes an error card with Retry/Continue, and only `appdata` and
  `settings` are fatal — the rest offer Continue because they degrade
  gracefully. `main()` builds singletons once; only `runBootstrap()` is
  retryable.
- Handoffs are held in `AppContext.pendingHandoffs` in main, because the host can
  cold-start the app *in order to* service a download and there is no window yet.
- The progress windows (`windows.ts`, one per task id) are fed by `broadcast()`
  rather than `send()`: they watch the same `tasks:changed` and `tasks:progress`
  feeds the list does, so no window can disagree with another about a download.
  `ipc.ts:announce` opens one only for downloads a person actually started - not
  for a queue draining or the restore pass - and only while `showProgressWindow`
  is on. A window whose task leaves the list closes itself.
- Icons in the UI are not Draco's: `icons.ts` asks the shell for the file-type
  association (via an empty stand-in file, because `app.getFileIcon` needs a real
  path) and fetches the source site's own `/favicon.ico`, both cached per process
  and handed over as data URLs so `img-src 'self' data:` stays as tight as it is.

## Conventions

**Imports.** `shared/types.ts` exports types only, so every `@shared/types`
import is an `import type` and is erased before Node sees it — the alias is safe
anywhere. What matters is *runtime* imports: anything a test or `tools/dl.ts`
loads must reach its dependencies through relative specifiers with an explicit
`.ts` extension, because Node's type stripping resolves those for real and knows
nothing about tsconfig paths. That is why `engine/**`, `bridge/protocol.ts`,
`hls/playlist-parser.ts`, `dash/**`, `site-grabber/**`, `log.ts`,
`queue/scheduler-window.ts` and `youtube-ladder.ts` are written that way.
Breaking it fails only at test/tool runtime, never at typecheck. The renderer
additionally has `@` → `src/renderer/src`.

**What can be unit-tested.** A module is testable only if its whole value-import
graph is free of Electron. Exactly eight files in `src/main` import
`electron`: `paths.ts`,
`integration.ts`, `clipboard.ts`, `icons.ts`, `index.ts`, `ipc.ts`, `tray.ts` and
`windows.ts` (`preload/index.ts` does too, but nothing imports it). Anything
pulling one of them in cannot be loaded by `node --test` —
`hls/ffmpeg.ts` is the case that bites, via `paths.ts`. `log.ts` is deliberately
*not* one of them: it takes its directory from `setLogDirectory()` once Electron
is ready, which is what keeps `hls/mux.ts` and the engine importable from tests.
When logic inside an Electron-bound file is worth testing, split it out as its
own Electron-free module — that is why `store-sanitize.ts`,
`store-sanitize-path.ts`, `update-version.ts`, `youtube-ladder.ts`,
`youtube-url.ts` and `scheduler-window.ts` exist.

**Line endings are mixed** — twenty-two tracked text files are CRLF and the
rest are LF, and the split follows no rule (`electron.vite.config.ts`,
`extension/manifest.json`, `src/shared/types.ts`, `src/preload/index.ts` and a
scattering of `src/main` and renderer files). Exact-string edits written with LF
silently fail to match in a CRLF file, and rewriting one wholesale churns every
line. Match the file, and check first when unsure (`-I` matters: without it
every PNG in `extension/` and `resources/` comes back too):

```bash
git ls-files -z | xargs -0 grep -lUI $'\r' --
```

**tsconfig.** `tsconfig.node.json` covers main/preload/shared; `tsconfig.web.json`
covers renderer/preload/shared. `noUnusedLocals` is on in both, so an unused
field or import is a build failure, not a warning.

**Style.** Two-space indent, single quotes, no semicolons; PascalCase component
files, `*.test.mjs` tests. There is no linter, so `npm run typecheck` is the
only gate before a change lands.

Comments here explain rationale, not mechanics — match that when adding code.
