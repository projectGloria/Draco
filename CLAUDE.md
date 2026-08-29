# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Draco is a Windows-only IDM-style download manager: an Electron + React app whose
hand-written download engine does dynamic segmented downloads, plus a Chrome MV3
extension and a Go native-messaging host that let it take downloads away from the
browser. There is no README; the source carries block comments explaining *why*
each part is the way it is — read them before changing behaviour, they usually
record a decision rather than describe the code.

## Commands

```bash
npm run dev          # electron-vite dev (main + preload + 3 renderer entries, HMR)
npm run build        # typecheck, then electron-vite build -> out/
npm run typecheck    # tsc --noEmit over tsconfig.node.json and tsconfig.web.json
npm test             # node --experimental-strip-types --test tests/*.test.mjs
npm run dist         # build + electron-builder --win (nsis + portable) -> dist/
npm run pack         # build + electron-builder --dir (unpacked, for quick checks)

npm run host         # builds host/draco-host.exe via host/build.ps1 (needs Go)
npm run keygen       # one-time: generates extension/key.pem and pins the extension ID
npm run icon         # regenerates resources/icon.ico
```

Run a single test file: `node --experimental-strip-types --test tests/segmenter.test.mjs`.
Tests are plain `node:test` `.mjs` files that `import` the `.ts` sources directly
via type stripping — no test build step, no framework. There is no linter.

Drive the engine without any UI (prints the live segment table, so you can watch
splitting and confirm Ctrl-C resumes at the right offsets):

```bash
node tools/dl.ts <url> [--dir DIR] [--conn N] [--limit BPS] [--min-split BYTES] [--tasks N]
```

## Architecture

Four separately-built artifacts cooperate:

1. **Electron main** (`src/main`) — owns all state and all privilege.
2. **Renderer** (`src/renderer`) — React 19 + Zustand + Tailwind v4; four HTML
   entries: `index` (app), `splash`, `handoff` (the per-download confirm window)
   and `progress` (IDM's per-download progress window).
3. **Go native host** (`host/main.go`) — a console binary Chrome launches.
4. **Chrome MV3 extension** (`extension/`) — loaded unpacked by the user.

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
- `bridge/integration.ts` rewrites the native-messaging manifest and the three
  HKCU registry keys (Chrome/Edge/Brave) on **every** launch, so moving the app
  repairs the integration instead of breaking it.
- Message types: `ping`, `config` (extension asks what to intercept), `download`,
  `media`, `youtube`. Mutating types are deduplicated in main by `requestId`,
  because the host retries.
- Everything from the extension originated in a web page — treat it as untrusted
  and validate (`engine/create.ts:validateUrl`) before acting.

**The host cold-starts the app**, so an idle extension launches Draco on its own
— the config poll alone is enough. It reads `%APPDATA%/Draco/host-config.json`,
written by `writeHostFiles`. In development `appPath` is Electron itself and
`appArgs` must be `app.getAppPath()` (the directory with `package.json`), *not*
`paths.root` (userData). Get that wrong and Electron shows "Unable to find
Electron app at …" with nobody having tried to open anything.

### Extension identity

The extension ID is pinned by the `key` field in `extension/manifest.json`,
derived from `extension/key.pem` (gitignored, never shipped — see the
`electron-builder.yml` filter). An unpacked extension's ID otherwise changes with
its folder path, which would silently break `allowed_origins`. Never regenerate
the key casually; `tools/gen-extension-key.mjs` deliberately reuses an existing
`key.pem`.

Chrome runs the old service worker until the extension is reloaded at
`chrome://extensions`, so changes to `extension/` need that reload before they
take effect — otherwise main silently sees the old message shape.

### The download engine (`src/main/engine`)

The core idea, and the reason this is hand-written rather than an aria2 wrapper,
lives in `segmenter.ts`: start with one range and **split on demand** — when a
connection frees up, take the segment with the most remaining work and hand half
of it to the idle connection. Splitting only moves a segment's `end` backwards
into unwritten bytes, so a mid-flight worker just stops early.

- `manager.ts` owns every task and decides what runs. **It imports no Electron
  and no ffmpeg** — that is load-bearing, because `tools/dl.ts` drives the exact
  same manager from a terminal. Anything Electron- or ffmpeg-specific is injected
  through `ManagerOptions` (`createHlsRunner`, `createDashRunner`,
  `refreshYouTube`, `onProbed`).
- `runner.ts` is the interface the manager is written against. Runner selection:
  `kind === 'hls'` → HLS runner; `task.audioUrl` set → DASH runner (separate
  video+audio tracks, muxed at the end); otherwise `TaskRunner`.
- `worker.ts` writes with positioned `fh.write(..., position)` so all connections
  share one file handle with no locking. `HttpStatusError` (e.g. 429) is distinct
  from a generic failure so the task ratchets its connection cap down instead of
  failing.
- `http.ts` holds one shared undici `Agent` per timeout value, so keep-alive is
  reused across segments *and* across downloads to the same host.
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
  permits that only when a `youtube` format id is present.
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

### Playlists (`src/main/hls`)

HLS deliberately does **not** reuse the byte-range segmenter — a playlist is
hundreds of separate resources, some individually encrypted, not one resource in
ranges. What is shared is the rate limiter, retry discipline, and the rule that
nothing takes its final name until complete. HLS resume needs no journal: a
finished piece is renamed into place, so the piece file's existence *is* the
record.

ffmpeg and yt-dlp are **not bundled**. Both look on PATH first and otherwise
fetch into `%APPDATA%/Draco/bin`; the ffmpeg download is the step most likely to
stall, so it carries connect and stall timeouts and reports progress *before* the
request rather than on the first byte. Muxing is always `-c copy`, and `mux()`
passes `-nostdin` with no stdout for the child: ffmpeg waiting on an open stdin,
or filling an undrained pipe, is a finished download stuck on "Muxing" forever.

### State, IPC and the renderer

- All persistence is JSON files under `%APPDATA%/Draco` (`bootstrap/paths.ts` is
  the only place that names them). `store.ts` writes via unique-temp + rename;
  everything read back goes through `store-sanitize.ts`, which is defensive
  against hostile/malformed records and is directly tested.
- `preload/index.ts` is the entire renderer capability surface — no Node, no fs,
  contextIsolation on. A new feature needs a channel in both `preload/index.ts`
  and `main/ipc.ts`, and a type in `shared/types.ts` (`RendererApi`).
- The renderer owns no truth: every mutation goes out over IPC and comes back
  through a subscription. Task list changes push `tasks:changed`; progress is a
  separate batched 4 Hz `tasks:progress` feed (manager ticks at 250 ms).
- `queue/scheduler.ts` never downloads anything — it only decides which tasks are
  allowed to be `queued`, so the manager remains the single place work starts.
- Startup (`main/index.ts`) is a real 5-step sequence reported to the splash
  window (`appdata`, `settings`, `restore`, `bridge`, `integration`); a failed
  step becomes an error card with Retry/Continue. `main()` builds singletons once;
  only `runBootstrap()` is retryable.
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
`hls/playlist-parser.ts`, `queue/scheduler-window.ts` and `youtube-ladder.ts` are
written that way. Breaking it fails only at test/tool runtime, never at
typecheck. The renderer additionally has `@` → `src/renderer/src`.

**What can be unit-tested.** A module is testable only if its whole value-import
graph is free of Electron. `paths.ts`, `integration.ts`, `clipboard.ts`,
`icons.ts`, `index.ts`, `ipc.ts`, `tray.ts` and `windows.ts` import `electron`, and anything
pulling one of them in (`log.ts` → `paths.ts`, so also `mux.ts`) cannot be loaded
by `node --test`. When logic inside such a file is worth testing, split it out as
its own Electron-free module — that is why `store-sanitize.ts` and
`youtube-ladder.ts` exist.

**Line endings are mixed.** Six files are CRLF and the rest are LF:
`electron.vite.config.ts`, `src/main/windows.ts`, `src/renderer/src/App.tsx`,
and `components/{DownloadTable,OptionsDialog,TaskDetailDialog}.tsx`. Exact-string
edits written with LF silently fail to match in those files, and rewriting one
wholesale churns every line. Match the file's existing endings.

**tsconfig.** `tsconfig.node.json` covers main/preload/shared; `tsconfig.web.json`
covers renderer/preload/shared. `noUnusedLocals` is on in both, so an unused
field or import is a build failure, not a warning.

Comments here explain rationale, not mechanics — match that when adding code.
