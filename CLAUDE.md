# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Draco

A personal Windows download manager in the mould of Internet Download Manager: dynamic segmented
downloads, browser takeover through an unpacked MV3 extension, categories, queues with a scheduler,
and an HLS grabber.

Personal use only. The extension is loaded from disk with **Load unpacked** and is never published
to the Chrome Web Store.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | electron-vite dev server + Electron |
| `npm run typecheck` | `tsconfig.node.json` (main/preload) then `tsconfig.web.json` (renderer) |
| `npm run build` | typecheck + build into `out/` |
| `npm run dist` | NSIS installer + portable via electron-builder |
| `npm run dl -- <url>` | Drives the engine headless from a terminal (see below) |
| `npm run keygen` | Generates `extension/key.pem` and pins the extension ID into the manifest |
| `npm run icon` | Redraws `resources/icon.ico` from the brand mark |
| `npm run host` | Builds `host/draco-host.exe` (needs Go) |
| `npm run pack` / `npm run start` | Unpacked build / preview the built app |

There is no test suite and no linter. Verification is done by running the thing — see **Verifying
a change**. `npm run typecheck` is the only automated gate, and it covers two projects: fixing one
does not mean the other passes.

**If `npm run dev` dies with `Error: Electron uninstall`,** Electron's binary was never downloaded
(its postinstall was skipped). Fix it with `node node_modules/electron/install.js` — reinstalling
the package does not necessarily re-run it.

## Layout

```
src/main/
  engine/      probe, segmenter, worker, journal, limiter, task, manager   ← Electron-free
  hls/         playlist, runner, mux, ffmpeg
  queue/       scheduler
  bridge/      pipe-server, protocol, integration (registry + native manifest)
  bootstrap/   paths
  store.ts categories.ts ipc.ts windows.ts tray.ts clipboard.ts log.ts index.ts
src/preload/index.ts        the whole contextBridge surface
src/renderer/               React + Zustand + Tailwind 4
src/shared/types.ts         the window.api contract
extension/                  unpacked MV3 extension
host/                       Go native-messaging host
tools/                      dl.ts, gen-extension-key.mjs, gen-icon.mjs, register-host.ps1
```

Runtime data lives in `%APPDATA%/Draco`: `settings.json`, `tasks.json`, `categories.json`,
`queues.json`, `media.json`, `bin/ffmpeg.exe`, `logs/main.log`.

## Rules that are easy to break

**IPC changes touch three files in lockstep.** `src/shared/types.ts`, `src/main/ipc.ts` and
`src/preload/index.ts`. Adding a channel in one and not the others typechecks in some
configurations and fails at runtime.

**`src/main/engine/**` must not import Electron.** It is driven by `tools/dl.ts` under bare Node so
the engine can be exercised without a GUI, and by the app in production — the same code path both
times. Anything the engine needs from the app is injected (`ManagerOptions.getSettings`,
`createHlsRunner`). Files there use relative `.ts` import specifiers so `node tools/dl.ts` runs
them with no build step, which also means **erasable-only TypeScript**: no parameter properties, no
enums, no namespaces.

**The renderer has no Node.** No `fs`, no `child_process`, no `require`. Every capability is an
explicit channel. `tasks:update` whitelists the fields the UI may patch — letting a renderer write
`segments` or `received` would corrupt the engine's own bookkeeping.

**There are three renderer entry points**, not one: `index.html` (the main window), `splash.html`
(bootstrap progress, framework-free so it paints on the first frame) and `handoff.html` (the
confirm window). Adding a fourth means editing `electron.vite.config.ts`'s `input` map *and* the
page union in `windows.ts`'s `rendererUrl()` — miss either and it silently 404s in dev or fails to
load when packaged. All three share one preload, so `window.api` is the same everywhere.

**There are two runner implementations behind one interface.** `engine/runner.ts` defines `Runner`;
`TaskRunner` does ranged HTTP and `HlsRunner` does playlists. The manager is written against the
interface and gets the HLS one injected (`ManagerOptions.createHlsRunner`), which is what keeps
`engine/` free of Electron and ffmpeg.

**Nothing lands at its final name until it is complete.** Partial data lives in `<name>.dracodl`
(plus `<name>.dracodl.json`, the resume journal) or `<name>.dracoparts/` for a playlist. Journals
and piece files are written to a temp name and renamed, so a crash can only ever cost the last
flush, never leave a file that parses as valid but is not.

**Resume validation errs toward re-downloading.** `journalMatches` rejects weak ETags and any size
disagreement. Starting over is the cheap mistake; splicing two different responses into one file is
not, because the result looks complete and is not.

**Progress is a batched 4 Hz feed.** `DownloadManager` publishes `tasks:progress` for every running
task on one ticker; nothing emits per chunk. The ticker stops itself when no task is running.

**Spawns use argument arrays with `shell: false`.** `shutdown`, `taskkill`, `reg`, `tar`, `ffmpeg`.
Never build a command string.

## Things that already bit us

- `undici` 7 moved redirects to `interceptors.redirect()` composed onto an `Agent`; there is no
  `maxRedirections` option on a request. `engine/http.ts` owns the one shared dispatcher. The probe
  uses `fetch` rather than `request` because `context.history` omits the final hop and
  `response.url` does not.
- `accept-encoding: identity` is mandatory. Over a compressed transfer `Content-Length` describes
  the compressed size and byte ranges stop matching file offsets.
- `Accept-Ranges: bytes` is advisory and servers lie about it. Only a real 206 with a
  `Content-Range` proves a file is resumable.
- Some servers answer the 3rd..8th connection with **429**. That is a cap, not a failure:
  `TaskRunner` ratchets `connectionCap` down and backs off rather than failing the task.
- `DownloadManager`'s constructor must not read settings — it is built during bootstrap, before
  `settings.json` has been loaded. The limit is applied in `schedule()`.
- `tasks.json` is written on a one-second coalesce, so after a hard kill it lags. `manager.load()`
  reconciles every unfinished task against its journal (or its piece files) so the list is honest
  before the user presses Resume.
- **A stream that ends early does not always reject.** A peer can close cleanly mid-body and
  `stream/promises.pipeline` resolves on a partial file. `hls/ffmpeg.ts` compares the bytes written
  against `Content-Length`; without that a truncated archive reached `tar` as the baffling "this
  does not look like a tar archive".
- **bsdtar reads `host:path` as a remote spec**, so an absolute Windows path starting `C:\` fails
  with "Cannot connect to C: resolve failed". Run it with `cwd` set and a relative archive name.
- **`filenameForKind` must stay idempotent.** It runs in `placeTask` *and* again in `createTask`; a
  version that blindly appended produced `video 1080p.mp4.mp4.mp4`.
- `DownloadTask.detail` is what the Status column shows when the status word alone is not enough
  ("Fetching ffmpeg 40%", "Muxing…"). Long silent stages must set it or they look like a hang.

## The browser link

Chrome hands a native-messaging host its stdio, so the host cannot be Electron: `host/main.go`
builds a small console binary that relays length-prefixed JSON between Chrome and
`\\.\pipe\draco`. It launches Draco if the pipe is not there, and **never writes to stdout** except
protocol frames — that channel is the protocol; diagnostics go to `logs/host.log`.

The extension ID is pinned by the `key` field in `extension/manifest.json`, derived from
`extension/key.pem` (gitignored — anyone holding it can impersonate the extension). The native
manifest's `allowed_origins` must match that ID, which is why `npm run keygen` writes both.

`ensureRegistered()` runs on every launch, so moving the app folder repairs the registration
rather than silently breaking it.

**Suppressing the browser's own UI has one rule: cancel before any `await`.** Chrome puts a
download on the shelf - and opens its Save As dialog, if that setting is on - the moment the item
exists. Reading cookies or asking the native host first means all of that has already appeared on
screen. So `downloads.onCreated` cancels synchronously against the *cached* rules and asks
afterwards; `giveBack()` hands the download back to the browser if Draco turns out not to want it,
and `passThrough` stops the re-issued copy being intercepted again. Better still is the content
script, which cancels the click before a download exists at all.

**The confirm window is a window, not a modal.** `createHandoffWindow` opens a small always-on-top
window per request. The click that triggered it happened in the browser, so the answer belongs in
front of the browser - dragging the whole download manager forward to ask two questions is the
interruption IDM avoids. Requests are queued in `AppContext.pendingHandoffs` rather than pushed at
a renderer, because the host can cold-start the app *in order to* service a download and the
request has to outlive having no window at all.

## Verifying a change

1. **Engine** — `npm run dl -- <url> --conn 8`. Watch segments split as connections free up. Stop
   it partway, run it again, confirm it resumes and the hash matches.
2. **UI** — `npm run dev`. Add a URL, pause/resume/stop, sort every column, open the detail dialog
   and confirm the segment bars track the engine. Kill the app mid-download and relaunch: the task
   must come back **paused** with its real progress, not lost and not at zero.
3. **Queues** — a queue with a start time two minutes out; confirm it fires, respects
   `maxConcurrent`, and that a shutdown action shows a countdown you can cancel.
4. **Extension** — `chrome://extensions` → Load unpacked → `extension/`. Confirm the ID matches
   `allowed_origins`. Click a download link: the browser shelf stays empty and Draco picks it up
   with cookies intact. Quit Draco and click a link — the host must cold-start it.
5. **Grabber** — a page with an HLS player; check the badge counts it, download it, play the result.
   Cancel one mid-mux and check Task Manager for a stray `ffmpeg.exe`.

The named pipe is also the quickest way to inject a download without a browser: connect to
`\\.\pipe\draco` and write a 4-byte little-endian length followed by
`{"type":"download","url":"…"}`.

## Not in scope

FTP, the site grabber (crawl-a-site-for-offline), and Firefox. Site-specific extractors
(YouTube and friends) are deliberately out — the sibling Vega project covers that, and adding
yt-dlp here would duplicate it.
