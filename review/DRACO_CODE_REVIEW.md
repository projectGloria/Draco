# Draco – Independent Code Review

**Audit Date:** 2026-11-19  
**Target Platform:** Windows 10/11 (x64)  
**Target Stack:** Electron 43.7.9, React 19.2.5, TypeScript 7.0.0-dev, Tailwind CSS 4.2.3, Zustand 5.0.12, undici 7.30.0, WebTorrent 2.8.5, Go 1.25 (`host/draco-host.exe`), Chromium MV3 + Firefox WebExtension  
**Repository State:** Commit `dcf6c5b` (`HEAD -> master`, 5 commits total; 1 untracked file `repomix-output.xml`)  
**Review Mode:** Full source read (100% of authored source, extension, host, CLI, build/verification tooling, and 100% of test suites) + dynamic verification in an isolated disposable workspace copy.

---

## 1. Executive Summary

### Overall Health Verdict
Draco is a **genuinely well-engineered personal desktop download manager** whose core HTTP segmented engine, crash-recovery journal, media pipeline, and Electron boundary hardening are significantly more disciplined than typical Electron applications. The codebase exhibits strong invariants around atomic file persistence, DPAPI sealing of sensitive state (`tasks.json`, `browser-handoffs.json`, `credentials.json`), origin-scoped credential/header stripping on HTTP redirects, strict child-process argument separation (`execFile`/`spawn` with `shell: false`), and SHA-256 verification of externally fetched `yt-dlp` and `ffmpeg` binaries.

However, our audit identified **4 High**, **5 Medium**, and **3 Low** severity findings (all **CONFIRMED**). The most serious issues sit at the **browser extension trust boundary**, the **SSRF hostname validator**, and a **regression introduced during a prior self-audit fix** in `DashRunner`.

### Top 5 Risks
1. **[F-01 | HIGH | CONFIRMED] Browser extension synthetic click hijack & cross-site `SameSite` cookie attachment (`extension/content.js:123-194`, `extension/background.js:484-491`)**: `content.js` runs in all frames (`all_frames: true`) on `<all_urls>` and intercepts clicks in the capture phase without checking `event.isTrusted`. Any malicious webpage or embedded iframe can dispatch a synthetic `.click()` on `<a href="..." download>`, cold-starting `Draco.exe` via the native host with zero user gesture, bypassing browser automatic-download blocks, and attaching the target origin's `SameSite=Strict`/`Lax` cookies on cross-site requests.
2. **[F-02 | HIGH | CONFIRMED] SSRF guard (`isPrivateHost` / `fetchGuarded`) checks only literal hostname syntax, not DNS resolution (`src/main/engine/create.ts:241-303`, `src/main/fetch-guard.ts:76-159`, `src/main/engine/http.ts:23-62`)**: `validateUrl(..., { allowPrivate: false })` blocks literal `localhost` and numeric RFC1918/loopback IPs, but immediately returns `false` for any domain name (`127.0.0.1.nip.io` or an attacker domain with an `A 127.0.0.1` / `A 192.168.1.1` record), and `undici` connects without a `lookup` IP filter.
3. **[F-03 | HIGH | CONFIRMED] `DashRunner.adoptFinishedHalf` rejects valid completed streams due to synthetic 88%/12% `expectedSize` split (`src/main/hls/dash.ts:68-72, 285-301`)**: Fix 1.1 added `info.size !== runner.task.expectedSize` to `adoptFinishedHalf`, overlooking that `DashRunner` fabricates child `expectedSize` values as an `88% / 12%` heuristic of the combined task estimate. On retry after a mux or audio-half failure, completed multi-gigabyte video halves are rejected, re-downloaded from scratch, and saved under `... (1)` while leaving the original half orphaned on disk.
4. **[F-04 | HIGH | CONFIRMED] Capture-phase click interception runs even when Draco is offline/paused/excluded and breaks `<a download>` and `target="_blank"` fallback (`extension/content.js:123-194`)**: `content.js` calls `event.preventDefault()` before checking `dracoState.active`, and its async `replay()` fallback drops the `download` attribute (navigating the active tab away on non-attachment responses) and loses transient user activation (causing popup blockers to block `window.open(url, '_blank')`).
5. **[F-05 & F-07 | MEDIUM | CONFIRMED] State desynchronization on queue deletion (`src/main/queue/scheduler.ts:151-165`) and unapplied/regressed fixes from `fixes.md` (`src/main/ipc.ts:373-399, 812-847, 1298-1300`)**: Deleting a queue orphans assigned tasks in renderer state and fails to persist `tasks.json` or trigger scheduling; additionally, four items marked complete in `fixes.md` (including Cat Mode and `tasks:redownload` queue awareness) are either dead code or unapplied.

### Top 5 Strengths
1. **Segmented HTTP Engine & Journal Integrity (`src/main/engine/runner.ts`, `worker.ts`, `segmenter.ts`, `journal.ts`)**: Dynamic tail-splitting by estimated time-to-completion, strict `If-Range` / validator verification (`ETag` + `Last-Modified`), bounded response readers (`src/main/response-limit.ts`), serialized file-handle closing before rename, and hashed per-task workspace directories (`.dracodl/<name>~<hash>/part`) prevent cross-task corruption and partial-file leaks.
2. **Redirect & Credential Hygiene (`src/main/engine/redirect.ts`, `auth.ts`, `worker.ts`)**: Manual redirect stepping strips `Cookie`, `Authorization`, `Referer`, and custom headers immediately on any cross-origin hop, and only presents stored Basic Auth credentials after an origin challenge.
3. **DPAPI State Sealing with Legacy Migration (`src/main/sealed-json.ts`, `electron-json-cipher.ts`, `json-file.ts`)**: `tasks.json`, `browser-handoffs.json`, and `credentials.json` (plus their `.bak` files) are encrypted at rest via Electron's `safeStorage` (Windows DPAPI) with atomic temp-file writes (`fsync` + `ReplaceFileW`).
4. **Hardened Electron & Pipe Boundaries (`src/main/windows.ts`, `src/main/bridge/pipe.ts`, `host/main.go`)**: All renderer windows run with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP, navigation locking, and sender frame verification (`assertTrustedRenderer`). The Windows named pipe uses a current-user-only SDDL DACL (`D:P(A;;GA;;;<UserSID>)`) with `FILE_FLAG_FIRST_PIPE_INSTANCE`.
5. **Verified Tool Binary Swapping (`src/main/ytdlp-digest.ts`, `archive-digest.ts`, `hls/replace-executable.ts`)**: Updates to `yt-dlp.exe` and `ffmpeg.exe` validate published SHA-256 digests over HTTPS, run a smoke execution on the staged binary, and perform rollback-safe file replacement.

### Readiness Recommendation
- **Ready for daily personal use?** **Yes, with caution on browser extension installation.** The desktop app and CLI are stable, fast, and preserve data integrity well. If using the browser extension today, keep *"Confirm downloads from browser"* (`confirmHandoff: true`, the default) enabled until **F-01** and **F-04** are patched.
- **Ready for public distribution?** **Not yet.** Before public release, fix the four **HIGH** findings (**F-01** through **F-04**), bump `undici` to `>=7.30.1` and `electron` to `>=43.8.1` (**F-09**), and configure Authenticode code signing (`electron-builder.yml` currently builds unsigned installers with `signAndEditExecutable: false`).

---

## 2. Scope, Method and Limitations

### 2.1 Review Methodology
1. **Phase 0 (Inventory & Scope)**: Enumerated all files in the repository, separating authored source code from build caches (`.build-cache/`), generated extension output (`extension-firefox/`), and bundled native binaries (`host/draco-host.exe`, `resources/runtime/*.exe`).
2. **Phase 1 (Dynamic Verification)**: Copied the project to an isolated disposable directory outside the workspace (`<scratch>/draco-copy`), ran `npm ci --ignore-scripts`, verified generator reproducibility (`tools/build-firefox-extension.mjs`), ran TypeScript typechecks (`npm run typecheck`), Go native-host tests (`go test -v ./...`), the full Node test suite twice (`npm test`), dependency vulnerability audits (`npm audit`), and microbenchmarks (`npm run bench:list`, `npm run bench:http`).
3. **Phases 2–4 (Static Architecture, Subsystem & Cross-Cutting Audit)**: Opened and reviewed **100% of all authored source files and 100% of all test files** (251 text/code files totaling 54,487 lines).
4. **Phases 5–6 (Prior Audit Verification & Self-Challenge)**: Cross-checked claims from `README.md`, `docs/AUDIT_2026-10-04.md`, `docs/AUDIT_2026-10-11.md`, and `fixes.md` against actual code and git commits (`5a86c9d`..`dcf6c5b`), then challenged and filtered candidate findings to eliminate false positives.

### 2.2 Codebase Size Inventory (Actual vs Claimed)
`README.md` and `docs/AUDIT_2026-10-11.md` claim *"~42k authored lines, 577 tests in 91 suites"*; `fixes.md` claims *"673 tests in 113 suites"*. Actual counts at `HEAD` (`dcf6c5b`):

| Area | Files | Lines | Notes |
|---|---:|---:|---|
| `src/main/**` | 111 | 21,984 | Electron main process, download engine, HLS/DASH, media, bridge, queue, security |
| `src/preload/**` | 1 | 300 | `contextBridge` API (`window.draco`) |
| `src/shared/**` | 10 | 1,738 | Shared types, URL/HTML/torrent helpers, i18n dictionary |
| `src/cli/**` | 16 | 3,157 | Terminal CLI (`draco`), session runner, TUI progress, parsers |
| `src/renderer/**` | 48 | 10,790 | React 19 + Zustand + Tailwind 4 UI (`main`, `handoff`, `progress` windows) |
| `extension/**` | 5 | 2,539 | Chromium MV3 extension (`background.js`, `content.js`, `popup.*`, `manifest.json`) |
| `extension-firefox/**` | 4 | 2,549 | Generated Firefox MV3 WebExtension (verified 100% identical to generator output) |
| `host/**` | 3 | 581 | Go native messaging host (`main.go`, `main_test.go`, `build.ps1`) |
| `bin/**` + `resources/**` (text) | 7 | 265 | `bin/draco.mjs`, `resources/installer.nsh`, `cli-installer.nsi`, shims, manifest |
| `tools/**` (code/docs) | 23 | 3,087 | Packaging, verification, smoke, and benchmark scripts |
| **Subtotal (Non-Test Authored)** | **224** | **44,441** | Excluding generated `extension-firefox/` |
| `tests/**` | 89 | 10,046 | 88 `.test.ts` files + `tests/helpers/renderer-fixture.ts` (678 tests in 114 suites) |
| **Total Reviewed Text Files** | **317** | **57,036** | Including `extension-firefox/` and root docs/configs |

### 2.3 Limitations & Assumptions
- **Unreviewed Binary Assets**: `host/draco-host.exe` (2,976,256 B), `resources/runtime/ffmpeg.exe` (170,051,584 B), `resources/runtime/ffprobe.exe` (169,836,032 B), `resources/runtime/yt-dlp.exe` (23,575,744 B), icons/images (`resources/*.png|*.ico|*.webp`, `extension/**/*.png`), audio (`resources/cat-meow.wav`), and `.build-cache/**` were not disassembled or reviewed line-by-line. We verified how they are built or fetched (`host/build.ps1`, `tools/bundle-runtime.mjs`, `resources/runtime/manifest.json`) and compared their on-disk SHA-256 hashes against `resources/runtime/manifest.json`.
- **Host Safety Constraints**: Per review safety rules, we did not run NSIS installers, `tools/register-host.ps1`, `tools/install-cli.ps1`, or live Electron GUI smoke scripts that modify `HKCU` registry keys, user `PATH`, browser profiles, or `%APPDATA%\Draco`.
- **Assumptions**: Draco is evaluated against both its primary stated use case (*single-user Windows desktop power tool*) and potential *public distribution* (where users browse untrusted websites with the Draco extension enabled and import untrusted `.torrent`, `.m3u8`, or transfer-list files).

---

## 3. Verification Results (Phase 1)

All commands were executed in an isolated disposable copy on Windows x64 (`Node.js v26.13.0`, `npm 11.20.0`, `go1.27.4 windows/amd64`). The original workspace (`c:\Users\Nihil\Desktop\projectGloria\Draco`) was kept untouched (`git status --short` shows only the pre-existing untracked `repomix-output.xml` plus our new `review/DRACO_CODE_REVIEW.md`).

### 3.1 Dynamic Verification Summary Table

| Step | Command Executed | Exit Code | Duration | Result / Output Summary | Comparison vs Repo Claims |
|---|---|---:|---:|---|---|
| Dependency install | `npm ci --ignore-scripts` | `0` | `15.2s` | `added 531 packages` | Clean lockfile install without lifecycle scripts |
| Firefox extension drift check | `node tools/build-firefox-extension.mjs` + SHA-256 compare | `0` | `0.2s` | `background.js`, `content.js`, `manifest.json`, `popup.html`, `popup.js` SHA-256 identical before/after | Zero generator drift |
| Bundled runtime hash check | SHA-256 of `resources/runtime/*.exe` vs `manifest.json` | `0` | `0.8s` | `ffmpeg.exe` (`1fc338a8...`), `ffprobe.exe` (`0ffdaffe...`), `yt-dlp.exe` (`f5389d36...`) all match `manifest.json` | Verified 100% match |
| TypeScript typecheck | `npm run typecheck` | `0` | `4.1s` | `tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json` — 0 errors | Matches claim (note: `tools/` is excluded by `tsconfig.node.json`, see **F-12**) |
| Go native host tests | `go test -v ./...` (in `host/`) | `0` | `1.19s` | 4/4 tests PASS (`TestPassiveMessagesNeverLaunchApp`, `TestUserDownloadMessagesMayLaunchApp`, `TestBridgePipeOverrideIsLimitedToDisposableNames`, `TestPathCanonicalization`) | Matches claim |
| Unit & integration tests (Run 1) | `npm test` | `0` | `39.34s` | **678 tests, 114 suites, 678 pass, 0 fail, 0 skipped** | Exceeds `README.md` (577/91) and `fixes.md` (673/113) due to commits `4b867d5` & `dcf6c5b` |
| Unit & integration tests (Run 2) | `npm test` | `0` | `41.18s` | **678 tests, 114 suites, 678 pass, 0 fail, 0 skipped** | Zero flakiness across back-to-back runs |
| Dependency audit (all) | `npm audit --json` | `1` | `1.8s` | **15 vulnerabilities** (`7 high`, `8 moderate`, `0 critical`) | Worse than `AUDIT_2026-10-11.md` claim (`12 total: 4 high, 8 moderate`) |
| Dependency audit (prod) | `npm audit --omit=dev --json` | `1` | `1.5s` | **6 vulnerabilities** (`5 high`, `1 moderate`, `0 critical`) | Worse than `AUDIT_2026-10-11.md` claim (`4 high`) |
| List selector benchmark | `npm run bench:list` | `0` | `1.4s` | 1,000 tasks: `nameSort` median `0.458 ms`, `speedSort` `0.029 ms`, `oneTaskProgressTick` `0.048 ms` | Matches `tools/bench/results/list-latest.json` profile |
| HTTP engine benchmark | `npm run bench:http` | `0` | `2.6s` | Loopback 8 MiB × {1,2,4,8} tasks (4 conn/task): 8 tasks = `127.16 MiB/s`, peak RSS `153.1 MiB`, all SHA-256 verified | Engine throughput and integrity verified |

### 3.2 Selected Command Output Excerpts

**`npm test` (Run 1 & Run 2 summary):**
```text
ℹ tests 678
ℹ suites 114
ℹ pass 678
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 39344.8462   # Run 1 (Run 2: 41182.5368 ms)
```

**`go test -v ./...` (in `host/`):**
```text
=== RUN   TestPassiveMessagesNeverLaunchApp
--- PASS: TestPassiveMessagesNeverLaunchApp (0.00s)
=== RUN   TestUserDownloadMessagesMayLaunchApp
--- PASS: TestUserDownloadMessagesMayLaunchApp (0.00s)
=== RUN   TestBridgePipeOverrideIsLimitedToDisposableNames
--- PASS: TestBridgePipeOverrideIsLimitedToDisposableNames (0.00s)
=== RUN   TestPathCanonicalization
--- PASS: TestPathCanonicalization (0.00s)
PASS
ok      draco-host      1.190s
```

**`npm audit --json` & `npm audit --omit=dev --json` summary:**
```text
ALL_TOTAL=15 {"info":0,"low":0,"moderate":8,"high":7,"critical":0,"total":15}
PROD_TOTAL=6 {"info":0,"low":0,"moderate":1,"high":5,"critical":0,"total":6}
- undici (high, direct prod, range <=7.30.0, fix 7.30.1): 8 GHSAs including GHSA-2m5v-pch6-74hx, GHSA-55wc-3pg8-jfw6, GHSA-xjj6-f33q-929c
- electron (high, dev/runtime, range >=43.0.0-alpha.1 <43.8.1, fix 43.8.1): GHSA-jr5w-w6x2-84p9
- ip (high, transitive prod via webtorrent -> ... -> ip@2.0.1): GHSA-2p57-rm9w-gvfp (SSRF categorisation)
- ip-address (moderate, transitive prod via webtorrent): GHSA-rxp7-6hxx-x8q5
```

---

## 4. Architecture Overview

### 4.1 Component & Trust-Boundary Diagram

```mermaid
flowchart TD
  subgraph Untrusted["Untrusted External Sources"]
    WebPage["Web Page / Third-Party Iframe"]
    RemoteServer["Remote HTTP / HLS / YouTube / Tracker Server"]
    TorrentFile["Untrusted .torrent / .m3u8 / Transfer List"]
  end

  subgraph Browser["Browser Extension (Chromium MV3 / Firefox)"]
    ContentJS["extension/content.js<br/>(all_frames: true, <all_urls>)"]
    BgJS["extension/background.js<br/>(Service Worker: cookies, webRequest,<br/>downloads, tabs, nativeMessaging)"]
  end

  subgraph NativeHost["Go Native Messaging Host"]
    HostExe["host/draco-host.exe<br/>(stdin/stdout 4-byte framing, max 1 MiB)"]
  end

  subgraph MainProc["Electron Main Process (src/main)"]
    PipeServer["Named Pipe Server (bridge/pipe.ts)<br/>\\\\.\\pipe\\draco-download-manager-<uid><br/>SDDL DACL: Current User Only + Auth Token"]
    IPC["IPC & Admission Router (ipc.ts / index.ts)<br/>assertTrustedRenderer + Handoff Queue"]
    Mgr["DownloadManager (engine/manager.ts)<br/>Concurrency, Finalize Pool, Limits"]
    Sched["Queue Scheduler (queue/scheduler.ts)"]
    Runners["Runners: TaskRunner (engine/runner.ts)<br/>HlsRunner / DashRunner / TorrentRunner"]
    Tools["Child Processes (execFile / spawn)<br/>yt-dlp.exe / ffmpeg.exe / AV Scanner"]
    Store["Persistence (store.ts / sealed-json.ts)<br/>DPAPI: tasks.json, credentials.json, handoffs<br/>Plaintext: settings.json, queues.json"]
  end

  subgraph RendererProc["Electron Renderer Windows (Sandboxed)"]
    Preload["Preload Bridge (src/preload/index.ts)<br/>contextIsolation: true, sandbox: true"]
    ReactUI["React 19 + Zustand (src/renderer)<br/>Main App / HandoffWindow / ProgressWindow"]
  end

  WebPage -->|"DOM click / postMessage"| ContentJS
  ContentJS -->|"chrome.runtime.sendMessage"| BgJS
  RemoteServer <-->|"webRequest / downloads API"| BgJS
  BgJS <-->|"Native Messaging"| HostExe
  HostExe <-->|"Named Pipe JSON lines (64 KiB max)"| PipeServer
  PipeServer --> IPC
  TorrentFile --> IPC
  IPC <--> Preload
  Preload <--> ReactUI
  IPC --> Mgr
  Sched <--> Mgr
  Mgr --> Runners
  Runners <-->|"undici / fetchGuarded / WebTorrent"| RemoteServer
  Runners --> Tools
  IPC --> Store
  Mgr --> Store
```

### 4.2 End-to-End Download Data Flow
1. **Admission**: A download enters via one of four paths:
   - **GUI IPC** (`tasks:add`, `tasks:create-paused`, `playlist:download`, `media:resolve`, `grabber:start` in `src/main/ipc.ts`) gated by `assertTrustedRenderer(event)`.
   - **Browser Handoff** (`extension/content.js` or `extension/background.js` → `host/draco-host.exe` → `src/main/bridge/pipe.ts` → `onPayload` in `src/main/index.ts`). If `settings.confirmHandoff` is `true` (default), the handoff is persisted in `browser-handoffs.json` (DPAPI-sealed) and opens a frameless `handoff.html` window (`maxPendingHandoffs = 12`, 5-minute timeout).
   - **OS Protocol / File Association** (`magnet:`, `.torrent`, `.draco.json` via `process.argv` or `second-instance` event in `src/main/index.ts`).
   - **Standalone CLI** (`src/cli/draco.ts` → `src/cli/session.ts`), which instantiates `DownloadManager` directly in a headless Node process.
2. **Task Placement & Normalization**: `createTask()` (`src/main/engine/create.ts`) validates the URL, sanitizes the filename (`sanitizeFilename` strips path separators, control chars, trailing dots/spaces, and prefixes Windows device names like `CON`/`NUL` with `_`), and sets `dirLocked`. `placeTask()` (`src/main/ipc.ts:346-371`) assigns the category (`video`, `audio`, `compressed`, `documents`, `programs`, `other`) and category subfolder unless `dirLocked` is true.
3. **Scheduling & Runner Dispatch**: `DownloadManager.schedule()` (`src/main/engine/manager.ts:615-645`) starts unqueued tasks up to `settings.maxConcurrentTasks`, while `Scheduler.tick()` (`src/main/queue/scheduler.ts:276-341`) starts tasks belonging to active queues within their time window. Depending on `task.kind` and `task.audioUrl`, `DownloadManager.launchRunner()` creates:
   - `TaskRunner` (`src/main/engine/runner.ts`) for HTTP/HTTPS files.
   - `HlsRunner` (`src/main/hls/runner.ts`) for `.m3u8` VOD/event playlists (including AES-128-CBC segment decryption).
   - `DashRunner` (`src/main/hls/dash.ts`) for dual-stream (`video` + `audio`) downloads requiring an `ffmpeg` mux (`muxStreams`).
   - `TorrentRunner` (`src/main/engine/torrent.ts`) for BitTorrent (`magnet:` or `.torrent`).
4. **Segmented HTTP Execution & Crash-Safe Journaling**:
   - `TaskRunner` opens a dedicated workspace directory `<dir>/.dracodl/<filename>~<sha256(taskId)[0..12]>/part` (`src/main/engine/workspace.ts:15-26`).
   - `probeUrl()` (`src/main/engine/probe.ts`) sends `GET Range: bytes=0-0` (falling back to streaming `GET` if ranges are unsupported) to discover `size`, `resumable`, `etag`, `lastModified`, and `finalUrl`.
   - If resuming, `readJournal()` (`src/main/engine/journal.ts`) validates the journal against the probed `size`, `etag`, and `lastModified`. If any validator changed or `etag`/`lastModified` are both absent, the journal is discarded and the file restarts from byte 0.
   - `Segmenter` (`src/main/engine/segmenter.ts`) manages byte ranges `[start, end]`, dynamically splitting the segment with the longest estimated time remaining (`ConnectionRamp` in `src/main/engine/ramp.ts`).
   - Each worker (`runSegment` in `src/main/engine/worker.ts`) streams bytes through a 512 KiB buffer (`WRITE_BUFFER_BYTES`), throttled by the global and per-task token-bucket `RateLimiter` (`src/main/engine/limiter.ts`), writing via positional `fh.write(buf, 0, len, offset)`.
   - Journals are flushed every 1,000 ms (`JOURNAL_INTERVAL_MS`) via atomic temp-file replacement (`writeJournal`).
5. **Finalization**:
   - Once all segments complete, `TaskRunner.finish()` awaits `Promise.allSettled(this.workerPromises)`, closes the file handle, verifies on-disk size (`stat(this.partPath).size === this.task.size`), runs optional SHA-256/MD5/SHA-1/CRC32 verification (`verifyChecksum`) and optional antivirus scanning (`runSecurityScan`) inside a bounded finalization pool (`maxConcurrentFinalizations = 2`), renames `part` to `uniquePath(dir, filename)` (`name (1).ext` on collision), and removes the `.dracodl` workspace directory.

### 4.3 Architectural Critique
- **God-Modules in Main Process & Extension**:
  - `src/main/ipc.ts` (**1,830 lines**), `src/main/index.ts` (**1,196 lines**), `src/renderer/src/components/OptionsDialog.tsx` (**1,797 lines**), and `extension/background.js` (**1,554 lines**) concentrate too many responsibilities in single files.
  - `src/main/ipc.ts` is not just an IPC transport layer: it contains business logic for task admission, media resolution orchestration, playlist expansion, redownload state resetting, queue mutation side effects, file-open status transitions, and cookie testing.
- **Side-Effect Coupling That Forces Source-Slicing Tests**:
  - Because `src/main/index.ts`, `src/main/ipc.ts`, `src/main/windows.ts`, `src/main/store.ts`, and `extension/background.js` import Electron/Chrome globals or run top-level initialization, unit tests cannot import their helper functions directly. Six test files (`tests/bootstrap-safety.test.ts`, `tests/ipc-admission.test.ts`, `tests/extensions.test.ts`, `tests/window-placement.test.ts`, `tests/store-corruption.test.ts`, `tests/extension-mv3.test.ts`) read `.ts`/`.js` files as text, slice substrings via `source.indexOf(...)`, strip `import`/`export` lines with regexes, and execute them inside `vm.runInNewContext` (**F-10**).
- **Split State Ownership Between `DownloadManager`, `Scheduler`, and `ipc.ts`**:
  - Tasks live in `DownloadManager.tasks` (`Map<string, DownloadTask>`) and are persisted by a debounced subscriber in `src/main/index.ts:819-833` whenever `manager.onUpdate` fires. However, both `Scheduler` (`src/main/queue/scheduler.ts`) and several handlers in `src/main/ipc.ts` mutate `task` properties directly in memory (`task.queueId = null`, `task.status = 'missing'`) without going through `DownloadManager` methods that emit updates and persist `tasks.json`. This directly caused **F-05** and **F-07**.

---

## 5. Findings Register

| ID | Title | Severity | Confidence | Category | Location | Effort |
|---|---|---|---|---|---|---|
| **F-01** | Untrusted Synthetic Click Interception (`!event.isTrusted`) and Cross-Site `SameSite` Cookie Attachment in Browser Extension | **HIGH** | CONFIRMED | security | `extension/content.js:123-194`, `extension/background.js:484-491, 1461-1514` | S |
| **F-02** | SSRF Guard (`isPrivateHost` / `fetchGuarded`) Checks Only Hostname Syntax, Allowing Domain Resolution & DNS Rebinding to Loopback/RFC1918 | **HIGH** | CONFIRMED | security | `src/main/engine/create.ts:241-303`, `src/main/fetch-guard.ts:76-159`, `src/main/engine/http.ts:23-62` | M |
| **F-03** | `DashRunner.adoptFinishedHalf` Rejects Valid Completed Streams Due to Synthetic 88%/12% `expectedSize` Split (Regression from Fix 1.1) | **HIGH** | CONFIRMED | reliability | `src/main/hls/dash.ts:57-73, 285-301`, `src/main/ipc.ts:390, 487`, `src/cli/session.ts:264` | S |
| **F-04** | Capture-Phase Click Handler Intercepts Links When Draco Is Offline/Paused/Excluded and `replay()` Breaks `<a download>` and `target="_blank"` | **HIGH** | CONFIRMED | reliability / UX | `extension/content.js:123-194`, `extension/background.js:1461-1514` | S |
| **F-05** | Deleting a Queue Orphans Assigned Tasks in Renderer State, Skips Scheduling, and Fails to Persist `tasks.json` | **MEDIUM** | CONFIRMED | integrity | `src/main/queue/scheduler.ts:151-165, 192-217`, `src/main/ipc.ts:1049-1052` | S |
| **F-06** | Cat Mode (`settings.catMode`) Is Unreachable Dead Code Due to Mutually Exclusive Guards in `DownloadManager` | **MEDIUM** | CONFIRMED | reliability | `src/main/engine/manager.ts:632-644, 1249-1280` | S |
| **F-07** | Four Fixes Claimed Complete in `fixes.md` (3.3, 3.5-part-2, 4.2-part-4, 2.4-part-1) Are Incomplete or Absent in Current Code | **MEDIUM** | CONFIRMED | reliability | `src/main/ipc.ts:373-399, 812-847, 1291-1305`, `extension/background.js:1403-1409` | S |
| **F-08** | Proxy Credentials Are Stored in Plaintext in `settings.json` / `.bak` and Broadcast to All Renderer Windows | **MEDIUM** | CONFIRMED | security | `src/main/store.ts:157, 171, 200-202`, `src/shared/types.ts:644`, `src/main/ipc.ts:865` | M |
| **F-09** | Active High-Severity Advisories in Direct Runtime/Network Dependencies (`undici@7.30.0`, `electron@43.7.9`) and Transitive `webtorrent` Tree | **MEDIUM** | CONFIRMED | security | `package.json:45, 57, 58`, `package-lock.json` | S |
| **F-10** | Monolithic Main/Extension Modules Force Brittle Source-Slicing `vm.runInNewContext` Harnesses in 6 Test Suites | **LOW** | CONFIRMED | maintainability | `src/main/ipc.ts`, `src/main/index.ts`, `tests/bootstrap-safety.test.ts:8-12`, `tests/ipc-admission.test.ts:18-45` | M |
| **F-11** | `OptionsDialog` Appearance/Columns/Cookies Controls Bypass Draft Transaction, and Multiple Dialogs Hardcode English Strings | **LOW** | CONFIRMED | UX | `src/renderer/src/components/OptionsDialog.tsx:1022-1047, 1287-1290, 1571-1640`, `HandoffWindow.tsx`, `SiteGrabberDialog.tsx` | M |
| **F-12** | `tools/smoke-cli-media.mjs` and `tools/dl.ts` Have Broken Signatures / Types Because `tsconfig.node.json` Excludes `tools/` | **LOW** | CONFIRMED | test gap | `tools/smoke-cli-media.mjs:23-54`, `tools/dl.ts:46-60`, `tsconfig.node.json:21` | S |

---

## 6. Detailed Findings

### F-01: Untrusted Synthetic Click Interception (`!event.isTrusted`) and Cross-Site `SameSite` Cookie Attachment in Browser Extension
- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Category:** security
- **Effort:** S
- **Locations:**
  - `extension/content.js:123-194` (capture-phase `'click'` event listener)
  - `extension/manifest.json:31-38` (`content_scripts` with `all_frames: true`, `<all_urls>`)
  - `extension/background.js:484-491` (`cookieHeaderFor`)
  - `extension/background.js:1461-1514` (`chrome.runtime.onMessage` handler for `'draco:intercept-link'`)
  - `host/main.go:196-206` (`shouldLaunchOnBridgeFailure`)

#### Description & Evidence
`extension/content.js` is injected into every frame (`"all_frames": true`) on `<all_urls>` at `document_idle`. Lines 123–194 register a capture-phase `'click'` listener on `document`:

```javascript
// extension/content.js:123-175
  document.addEventListener(
    'click',
    (event) => {
      if (event.defaultPrevented) return
      if (event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      if (replayingAnchor) return

      const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target]
      const anchor = findAnchorInPath(path)
      if (!anchor) return
      // ...
      const hasDownloadAttr = anchor.hasAttribute('download')
      const suggested = hasDownloadAttr ? (anchor.getAttribute('download') || '').trim() : ''
      const matchesExt = !hasDownloadAttr && looksDownloadable(url, dracoState.interceptExtensions)
      if (!hasDownloadAttr && !matchesExt) return
      // ...
      event.preventDefault()
      event.stopPropagation()

      sendToExtension(
        {
          type: 'draco:intercept-link',
          url,
          filename: suggested || undefined,
          referer: location.href
        },
```

There are three compounding flaws across this boundary:
1. **No `event.isTrusted` or user-activation check**: In DOM event dispatch, `element.click()` or `element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))` satisfies every condition in `content.js:126-129`.
2. **Cold-launch of native app from background script**: `background.js:1487` forwards `draco:intercept-link` as native message `{ type: 'download', source: 'link-click', ... }`. In `host/main.go:196-206`, `shouldLaunchOnBridgeFailure` returns `true` for `type == "download"`, which spawns `Draco.exe` if it is not running.
3. **Unfiltered `SameSite` cookie extraction**: When `background.js:1485` prepares the download payload, it calls `cookieHeaderFor(url)`:
   ```javascript
   // extension/background.js:484-491
   async function cookieHeaderFor(url) {
     try {
       const list = await chrome.cookies.getAll({ url })
       if (!list || list.length === 0) return undefined
       return list.map((c) => `${c.name}=${c.value}`).join('; ')
     } catch {
       return undefined
     }
   }
   ```
   `chrome.cookies.getAll({ url })` returns **all** cookies for `url`—including `SameSite=Strict` and `SameSite=Lax` cookies—regardless of whether the initiating frame (`sender.url` / `sender.tab.url`) is cross-site to `url`. Even for top-level navigation, browsers never attach `SameSite=Strict` cookies on cross-site requests, and never attach `SameSite=Lax` cookies on subresource/iframe-initiated downloads.

#### Concrete Scenario / Trigger
A user visits `https://malicious.example` (or any page containing a sandboxed third-party ad iframe). On load, without any user interaction, JavaScript executes:
```javascript
for (let i = 0; i < 12; i++) {
  const a = document.createElement('a')
  a.href = `https://victim.example/account/backup.zip?i=${i}`
  a.download = `payload-${i}.zip`
  document.body.appendChild(a)
  a.click()
}
```
1. `content.js` intercepts all 12 synthetic clicks.
2. `background.js` attaches the user's `SameSite=Strict` session cookies for `victim.example` and sends 12 `download` messages to `draco-host.exe`.
3. If `Draco.exe` is closed, `draco-host.exe` launches it.
4. If `confirmHandoff` is `true` (default), 12 frameless `alwaysOnTop: true` handoff confirmation windows pop over the user's desktop (`maxPendingHandoffs = 12`). If the user disabled *"Confirm downloads from browser"* (`confirmHandoff: false`), all 12 authenticated cross-site downloads execute silently to the user's disk.

#### Impact
- Zero-click drive-by application launch and UI flood (`alwaysOnTop` window spam) from any web page or cross-origin iframe.
- Drive-by arbitrary file downloads when `confirmHandoff` is disabled.
- Cross-site `SameSite=Strict` (and iframe-triggered `SameSite=Lax`) cookie attachment to authenticated endpoints.

#### Recommended Fix
1. **Require a trusted user event in `extension/content.js`**:
   ```javascript
   if (!event.isTrusted) return
   ```
2. **Require top-frame or same-origin frame in `extension/background.js`** for `draco:intercept-link`, and filter `chrome.cookies.getAll({ url })` by `sameSite` whenever `sender.url` is cross-site to `url`:
   - Parse the registrable domain / site of `sender.url` (and `sender.tab?.url`) vs `url`.
   - If the request is cross-site, exclude cookies where `c.sameSite === 'strict'`, and if the click came from a non-top frame (`sender.frameId !== 0`), also exclude `c.sameSite === 'lax'` and `c.sameSite === 'unspecified'`.

#### How to Test
- Add a test in `tests/extensions.test.ts` that dispatches an untrusted click (`{ isTrusted: false, button: 0 }`) and verifies `sendToExtension` is not called.
- Add a test in `tests/extension-mv3.test.ts` verifying `cookieHeaderFor(targetUrl, sender)` omits `sameSite: 'strict'` cookies when `sender.url` is on a different origin from `targetUrl`.

---

### F-02: SSRF Guard (`isPrivateHost` / `fetchGuarded`) Checks Only Hostname Syntax, Allowing Domain Resolution & DNS Rebinding to Loopback/RFC1918
- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Category:** security
- **Effort:** M
- **Locations:**
  - `src/main/engine/create.ts:241-303` (`isPrivateHost`, `validateUrl`)
  - `src/main/fetch-guard.ts:76-159` (`fetchGuarded`)
  - `src/main/engine/http.ts:23-62` (`buildDirectAgent`, `getDispatcher`)
  - `src/main/engine/probe.ts:104-129` (`probeUrl`)
  - `src/main/engine/worker.ts:144-184` (`requestSegment`)

#### Description & Evidence
Draco relies on `validateUrl(url, { allowPrivate: false })` and `fetchGuarded(url, { allowPrivate: false })` to prevent untrusted external inputs (browser extension handoffs, HLS playlists, media scrapers, thumbnail URLs, redirects) from making requests to loopback (`127.0.0.1`, `::1`), RFC1918 LAN addresses (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), or cloud metadata (`169.254.169.254`).

However, `isPrivateHost(hostname)` in `src/main/engine/create.ts:241-303` performs **purely lexical string inspection**:

```typescript
// src/main/engine/create.ts:241-289
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (h === '::1' || h === '0:0:0:0:0:0:0:1' || h === '::' || h === '0:0:0:0:0:0:0:0') return true
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true
  // ... IPv4-mapped IPv6 and dotted-quad IPv4 regex /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (ipv4) {
    // ... checks 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16
  }
  return false
}
```

If `hostname` is any standard DNS name (e.g., `127.0.0.1.nip.io`, `localtest.me`, `router.evil.example`), `isPrivateHost` reaches `return false` without performing DNS resolution, and neither `fetchGuarded` (`src/main/fetch-guard.ts`) nor `buildDirectAgent` (`src/main/engine/http.ts:44-57`) attaches a custom `connect.lookup` callback to validate the resolved IP address before opening the TCP socket.

#### Concrete Scenario / Trigger
1. A malicious webpage or remote `.m3u8` playlist references `http://127.0.0.1.nip.io:9222/json` or `http://internal.evil.example/admin/export. backup` (where `internal.evil.example` has an `A` record pointing to `127.0.0.1` or `192.168.1.1`).
2. `validateUrl('http://127.0.0.1.nip.io:9222/json', { allowPrivate: false })` passes because `'127.0.0.1.nip.io'` does not match `localhost`, `.local`, `.internal`, or the 4-octet IPv4 regex.
3. `fetchGuarded` or `TaskRunner` resolves `127.0.0.1.nip.io` via OS DNS to `127.0.0.1` and connects directly to the loopback service.

#### Impact
Complete bypass of the `allowPrivate: false` SSRF boundary across all external admission points (`ipc.ts`, `bridge`, `fetchGuarded`, HLS segment fetching, redirect targets, and thumbnail fetching), allowing remote attackers to probe or download from localhost daemons and LAN devices.

#### Recommended Fix
1. **Enforce IP validation at the socket `lookup` layer** so that both static DNS records (`127.0.0.1.nip.io`) and TOCTOU DNS rebinding are blocked without a race window:
   - Implement a custom `dns.lookup` wrapper (`safeLookup(hostname, options, callback)`) that calls `dns.lookup` and rejects any returned IPv4/IPv6 address for which `isPrivateHost(address)` is `true`.
   - Pass `{ connect: { lookup: safeLookup } }` to an undici `Agent` used for `allowPrivate: false` requests (and in `fetchGuarded` via undici's `dispatcher` option).
2. Additionally, extend `isPrivateHost` to catch integer/hex/octal IPv4 literals (note that `new URL()` in WHATWG URL normalizes `http://0x7f000001` and `http://2130706433` to `http://127.0.0.1`, so `parsed.hostname` in `validateUrl` already normalizes those, provided `isPrivateHost` is always called on `new URL(url).hostname`).

#### How to Test
- Add a unit test in `tests/fetch-guard.test.ts` using an injectable/custom `lookup` or a domain resolving to `127.0.0.1` and assert that `fetchGuarded('http://localtest.example/secret', { allowPrivate: false })` rejects with `/private or local network/`.

---

### F-03: `DashRunner.adoptFinishedHalf` Rejects Valid Completed Streams Due to Synthetic 88%/12% `expectedSize` Split (Regression from Fix 1.1)
- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Category:** reliability
- **Effort:** S
- **Locations:**
  - `src/main/hls/dash.ts:57-73` (`DashRunner.constructor`)
  - `src/main/hls/dash.ts:285-301` (`DashRunner.adoptFinishedHalf`)
  - `src/main/engine/runner.ts:390-417` (`TaskRunner.finish`)
  - `src/main/ipc.ts:390, 487` (`prepareTaskInput`, `playlist:download`)
  - `src/cli/session.ts:264` (`taskFromResolution`)
  - `src/renderer/src/components/SaveAsDialog.tsx:285` (`submit`)

#### Description & Evidence
For dual-stream downloads (`DashRunner`, used for all merged YouTube 1080p/1440p/4K downloads where video and audio are fetched separately and muxed with `ffmpeg`), `DashRunner.constructor` fabricates child `expectedSize` values using an **88% / 12% heuristic** whenever the parent task has `task.expectedSize`:

```typescript
// src/main/hls/dash.ts:68-72
    if (task.expectedSize && task.expectedSize > 0) {
      this.videoTask.expectedSize = Math.round(task.expectedSize * 0.88)
      this.audioTask.expectedSize = Math.max(1, task.expectedSize - this.videoTask.expectedSize)
    }
```

Note that `task.expectedSize` is populated from `variant.estimatedSize` (`video.size + audio.size`, or `bitrate * duration / 8`) across almost all YouTube entry points:
- `src/Renderer/src/components/SaveAsDialog.tsx:285`: `expectedSize: isYouTube && activeVariant?.estimatedSize ? activeVariant.estimatedSize : ...`
- `src/main/ipc.ts:390` (`prepareTaskInput`) and `src/main/ipc.ts:487` (`playlist:download`): `expectedSize: pick.estimatedSize ?? undefined`
- `src/cli/session.ts:264` (`taskFromResolution`): `expectedSize: pick.estimatedSize ?? undefined`

During the prior self-audit remediation (Fix 1.1 in `fixes.md`), `adoptFinishedHalf` in `src/main/hls/dash.ts:285-301` was modified to check `info.size !== runner.task.expectedSize`:

```typescript
// src/main/hls/dash.ts:285-296
  private async adoptFinishedHalf(runner: HalfRunner): Promise<boolean> {
    if (await exists(runner.partPath)) return false
    const finalPath = join(runner.task.dir, runner.task.filename)
    try {
      const info = await stat(finalPath)
      if (info.size <= 0) return false
      if (runner.task.expectedSize && info.size !== runner.task.expectedSize) return false
      runner.task.size = info.size
      runner.task.received = info.size
```

Because `runner.task.expectedSize` on `videoTask` and `audioTask` is a synthetic `Math.round(totalEstimatedSize * 0.88)` (and `TaskRunner` updates `runner.task.size` from the HTTP `Content-Length`, never touching `runner.task.expectedSize`), `info.size !== runner.task.expectedSize` evaluates to `true` for virtually every real YouTube stream!

Worse still, when `adoptFinishedHalf` returns `false`:
1. The existing valid completed half file (`<filename>.v.<itag>.mp4`) remains at `finalPath` (`join(runner.task.dir, runner.task.filename)`).
2. `TaskRunner` re-downloads the entire video stream from byte 0.
3. When the re-download finishes, `TaskRunner.finish()` calls `uniquePath(this.task.dir, this.task.filename)` (`src/main/engine/runner.ts:404`), which sees the existing `<filename>.v.<itag>.mp4` on disk and renames the newly downloaded half to `<filename>.v.<itag> (1).mp4`!
4. `DashRunner` then muxes `<filename>.v.<itag> (1).mp4`, deletes `<filename>.v.<itag> (1).mp4`, and **permanently orphans** the original multi-gigabyte `<filename>.v.<itag>.mp4` in the user's download folder.

#### Concrete Scenario / Trigger
1. A user downloads a 2 GB 4K YouTube video (`estimatedSize = 2_000_000_000`). `videoTask.expectedSize` is set to `1_760_000_000` (88%), while the actual video stream `Content-Length` is `1_850_412_100`.
2. The 1.85 GB video half finishes downloading (`movie.mp4.v.313.mp4`), and its `.dracodl` workspace is cleaned up.
3. The audio half fails due to a transient network drop (or `ffmpeg` is missing and the user installs `ffmpeg` and clicks **Resume** / **Retry**).
4. On resume, `adoptFinishedHalf(this.videoRunner)` checks `info.size (1_850_412_100) !== videoTask.expectedSize (1_760_000_000)`, returns `false`, re-downloads all 1.85 GB of video, writes it to `movie.mp4.v.313 (1).mp4`, and leaves the first 1.85 GB `movie.mp4.v.313.mp4` orphaned on disk.

#### Impact
- Complete failure to reuse completed video/audio halves on retry whenever `task.expectedSize` is set.
- Multi-gigabyte bandwidth waste and multi-gigabyte orphaned `.v.<itag>.mp4` files left in the user's download directory.

#### Recommended Fix
1. **Do not overwrite `runner.task.expectedSize` with a fake 88%/12% byte count** in `DashRunner.constructor` (or store the heuristic in a separate display-only field for initial progress bar estimation before `probeUrl` learns `runner.task.size`).
2. In `TaskRunner` (`src/main/engine/runner.ts:154-160`), once `probeUrl` discovers an authoritative `probed.size`, update `this.task.size = probed.size`.
3. In `DashRunner.adoptFinishedHalf` (`src/main/hls/dash.ts:290`), check against an authoritative size (`runner.task.size`) if known, or remove any stale `finalPath` before re-running if a half genuinely failed validation so `uniquePath` does not create an orphaned `(1)` copy.

#### How to Test
- Add a test in `tests/media-Hardening.test.ts` creating a `DashRunner` with `task.expectedSize = 10_000` where the actual video half on disk is `9_123` bytes (`!== 8_800`), and verify `adoptFinishedHalf` adopts the finished half on retry without re-downloading or creating a `(1)` file.

---

### F-04: Capture-Phase Click Handler Intercepts Links When Draco Is Offline/Paused/Excluded and `replay()` Breaks `<a download>` and `target="_blank"`
- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Category:** reliability / UX
- **Effort:** S
- **Locations:**
  - `extension/content.js:123-194` (capture-phase `'click'` listener and `replay()`)
  - `extension/background.js:1461-1514` (`draco:intercept-link` handler)

#### Description & Evidence
In `extension/content.js:23-39`, the content script maintains `dracoState = { active: false, interceptExtensions: null }` and refreshes it via `draco:should-intercept` (which checks `paused`, `connected` / `nativeReachable`, and `isHostExcluded(tabHost)` in `extension/background.js:1439-1459`).

However, the capture-phase `'click'` listener in `extension/content.js:123-194` **never checks `dracoState.active`**, whereas the `'draco:Download'` custom-event listener right below it at line 198 explicitly does (`if (!dracoState.active) return`):

```javascript
// extension/content.js:145-167
      const hasDownloadAttr = anchor.hasAttribute('download')
      const suggested = hasDownloadAttr ? (anchor.getAttribute('download') || '').trim() : ''
      const matchesExt = !hasDownloadAttr && looksDownloadable(url, dracoState.interceptExtensions)
      if (!hasDownloadAttr && !matchesExt) return

      const replay = () => {
        replayingAnchor = anchor
        try {
          if (anchor.target === '_blank') window.open(url, '_blank', 'noopener')
          else location.href = url
        } finally {
          setTimeout(() => {
            replayingAnchor = null
          }, 0)
        }
      }

      event.preventDefault()
      event.stopPropagation()
```

When Draco is not running, or takeover is paused, or the current website is in the user's excluded-hosts list, **every click on `<a download>` or a file-extension link still has `event.preventDefault()` and `event.stopPropagation()` called synchronously**. The click is sent to `background.js`, which replies `{ taken: false }`, triggering `replay()` asynchronously.

`replay()` then fails in two distinct ways:
1. **It destroys `<a download="filename">` semantics**: Setting `location.href = url` navigates the top-level window to `url` without the HTML5 `download` attribute. If the server does not send `Content-Disposition: attachment` (standard for same-origin `<a download="report.json|chart.svg|notes.txt|photo.png">` exports), the browser **navigates away from the user's web app** and renders the file inline instead of downloading it.
2. **It breaks `target="_blank"` via popup-blocker rejection and `replayingAnchor` bypass**: Notice that `replay()` sets `replayingAnchor = anchor`, but then calls `window.open` / `location.href` instead of `anchor.click()` (`replayingAnchor` is therefore completely unused!). Furthermore, when `replay()` is invoked after an async native-host probe—or up to 5 minutes later if the user clicks *"Cancel"* in Draco's handoff dialog—the browser's transient user activation has expired, so `window.open(url, '_blank', 'noopener')` is blocked by the browser's popup blocker.

#### Concrete Scenario / Trigger
- **Scenario A (Draco closed or site excluded)**: The user excludes `github.com` in the extension popup or closes Draco, then clicks `<a href="/raw/data.json" download="data.json">` on a web app. `content.js` calls `event.preventDefault()`, asks `background.js` (which returns `{ taken: false }`), and runs `location.href = url`, navigating the user away from the web app into raw JSON text.
- **Scenario B (User declines handoff on a `target="_blank"` link)**: The user clicks `<a href="https://files.example.com/manual.pdf" target="_blank">`. Draco pops up the Handoff confirmation window. Five seconds later, the user clicks **Cancel** in the Handoff window so the browser will handle it. `content.js` receives `{ taken: false }` and calls `window.open(url, '_blank', 'noopener')`, which Chrome/Firefox blocks as an unprompted popup.

#### Impact
- Broken `<a download>` behavior and unexpected tab navigation on websites even when Draco is paused, closed, or excluded.
- Blocked `target="_blank"` downloads when falling back to the browser.

#### Recommended Fix
1. **Check `dracoState.active` before intercepting** in `extension/content.js`:
   ```javascript
   if (!dracoState.active) return
   ```
2. **Use synthetic `anchor.click()` inside `replay()`** (which is what `replayingAnchor = anchor` was originally written for!) so the browser preserves the `<a download="filename">` attribute and `target` attributes:
   ```javascript
   const replay = () => {
     replayingAnchor = anchor
     try {
       anchor.click()
     } finally {
       setTimeout(() => {
         replayingAnchor = null
       }, 0)
     }
   }
   ```

#### How to Test
- Update `tests/extensions.test.ts` to verify that when `dracoState.active === false`, clicking an `<a download>` link does not call `event.preventDefault()`, and that when `{ taken: false }` is returned while active, `replay()` triggers `anchor.click()` preserving the `download` attribute.

---

### F-05: Deleting a Queue Orphans Assigned Tasks in Renderer State, Skips Scheduling, and Fails to Persist `tasks.json`
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Category:** integrity
- **Effort:** S
- **Locations:**
  - `src/main/queue/scheduler.ts:151-165` (`Scheduler.remove`)
  - `src/main/queue/scheduler.ts:192-217` (`Scheduler.synchronizeMembership`)
  - `src/main/ipc.ts:1049-1052` (`queues:remove` IPC handler)
  - `src/main/engine/manager.ts:624-631` (`DownloadManager.schedule`)

#### Description & Evidence
When a queue is deleted, `Scheduler.remove(id)` (`src/main/queue/scheduler.ts:151-165`) and the `queues:remove` IPC handler (`src/main/ipc.ts:1049-1052`) execute:

```typescript
// src/main/queue/scheduler.ts:151-165
  async remove(id: string): Promise<boolean> {
    if (id === 'main') return false
    const idx = this.queues.findIndex((q) => q.id === id)
    if (idx === -1) return false
    this.queues.splice(idx, 1)
    for (const task of this.deps.manager.list()) {
      if (task.queueId === id) task.queueId = null
    }
    this.clearTaskNotesForQueue(id)
    await this.persist()
    return true
  }
```
```typescript
// src/main/ipc.ts:1049-1052
  ipcMain.handle('queues:remove', async (event, id: unknown) => {
    assertTrustedRenderer(event)
    return ctx.scheduler.remove(expectId(id, 'queue id'))
  })
```

Compare this with `queues:assign` (`src/main/ipc.ts:1054-1061`), which explicitly calls `ctx.manager.emitTasks()` after mutating queue membership. Because neither `Scheduler.remove()` nor `queues:remove` calls `this.deps.manager.notifyTaskMetadataChanged()`, `this.deps.manager.emitTasks()`, or `this.deps.manager.applySettings()`:
1. **Renderer state desynchronization**: `tasks:changed` is never broadcast to the renderer, so the React UI continues to show those tasks with `task.queueId === deletedQueueId`.
2. **Unscheduled queued tasks**: Tasks that were `status === 'queued'` in the deleted queue now have `task.queueId = null` in main-process memory, making them eligible for `DownloadManager.schedule()`, which skips tasks with `task.queueId` (`if (task.queueId) continue` at `src/main/engine/manager.ts:626`). Because `schedule()` is never triggered by `remove()`, those tasks sit idle in `queued` state.
3. **Unpersisted `tasks.json` & permanent orphan on restart**: `this.persist()` in `Scheduler` only saves `queues.json`, not `tasks.json`. If the user closes Draco before another download event triggers a `tasks.json` write (or if Draco crashes), `tasks.json` reloads on next launch with `task.queueId === deletedQueueId`. On startup, `Scheduler.synchronizeMembership()` (`src/main/queue/scheduler.ts:192-217`) only loops over `for (const queue of this.queues)` and clears `task.queueId` for queues that exist in `this.queues`; it **never** clears `task.queueId` when `task.queueId` points to a queue ID that no longer exists! As a result, `DownloadManager.schedule()` skips those tasks forever (`if (task.queueId) continue`).

#### Concrete Scenario / Trigger
1. User creates a secondary queue `"Nightly"`, assigns 3 paused/queued downloads to `"Nightly"`, and then deletes `"Nightly"`.
2. In the UI, the tasks still reference the deleted queue ID, and queued tasks do not start.
3. If the user restarts Draco before adding/updating another task, `tasks.json` still has `queueId: "<deleted-id>"`, and those tasks are permanently ignored by both `DownloadManager.schedule()` and `Scheduler.tick()`.

#### Impact
- Immediate main/renderer state desynchronization on queue deletion.
- Orphaned tasks across restart that can never be started by the main scheduler.

#### Recommended Fix
1. In `Scheduler.remove(id)` (`src/main/queue/scheduler.ts:156-163`), call `this.deps.manager.notifyTaskMetadataChanged?.()` and `this.deps.manager.applySettings(this.deps.getSettings())` (or in `ipc.ts` `queues:remove`, call `ctx.manager.emitTasks()` and `ctx.manager.applySettings(ctx.store.getSettings())`).
2. In `Scheduler.synchronizeMembership()` (`src/main/queue/scheduler.ts:193`), first build `const validQueueIds = new Set(this.queues.map((q) => q.id))` and clear any dangling `task.queueId` where `task.queueId && !validQueueIds.has(task.queueId)`.

#### How to Test
- Add a test in `tests/scheduler-lifecycle.test.ts` verifying that `scheduler.remove(queueId)` emits a task update (`notifyTaskMetadataChanged`), schedules newly unqueued tasks, and that `synchronizeMembership()` clears `task.queueId` if a task loaded from disk references a non-existent queue ID.

---

### F-06: Cat Mode (`settings.catMode`) Is Unreachable Dead Code Due to Mutually Exclusive Guards in `DownloadManager`
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Category:** reliability
- **Effort:** S
- **Locations:**
  - `src/main/engine/manager.ts:632-644` (`DownloadManager.schedule`)
  - `src/main/engine/manager.ts:1249-1280` (`DownloadManager.maybePlayCatMeow`)

#### Description & Evidence
In `src/main/engine/manager.ts:615-645`, `DownloadManager.schedule()` loops over all tasks and synchronously calls `this.launchRunner(task)` for every unqueued task (`!task.queueId && task.status === 'queued' && !this.runners.has(task.id)`) until `this.activeCount >= limit` (`limit = settings.maxConcurrentTasks`), at which point it calls `this.maybePlayCatMeow()`:

```typescript
// src/main/engine/manager.ts:632-644
    for (const task of this.tasks.values()) {
      if (this.activeCount >= limit) break
      if (task.queueId) continue
      if (task.status === 'queued' && !this.runners.has(task.id)) {
        this.launchRunner(task)
      }
    }
    if (this.activeCount > 0) {
      this.maybePlayCatMeow()
    }
```

Now inspect `maybePlayCatMeow()` at `src/main/engine/manager.ts:1249-1261` (modified in commits `20f5e81` and `4b867d5`):

```typescript
// src/main/engine/manager.ts:1249-1261
  private maybePlayCatMeow(): void {
    const settings = this.getSettings()
    if (!settings.catMode) return
    if (this.activeCount >= settings.maxConcurrentTasks) return
    const now = Date.now()
    if (now - this.lastCatMeowAt < 5000) return
    const play = this.onCatMeow
    if (!play) return

    const queuedTasks = [...this.tasks.values()].filter(
      (t) => !t.queueId && t.kind !== 'dash' && t.status === 'queued' && !this.runners.has(t.id)
    )
    if (queuedTasks.length === 0) return
```

Look at the two guards:
1. Line 1252 requires `this.activeCount < settings.maxConcurrentTasks`.
2. Line 1259 requires at least one task matching `!t.queueId && t.kind !== 'dash' && t.status === 'queued' && !this.runners.has(t.id)`.

Because `launchRunner(task)` synchronously sets `task.status = 'probing'` (or `'downloading'`) and inserts `task.id` into `this.runners` (`src/main/engine/manager.ts:680-780`), the `for` loop in `schedule()` (lines 632–638) has **already started every single task with `!t.queueId && t.status === 'queued' && !this.runners.has(t.id)`** whenever `this.activeCount < settings.maxConcurrentTasks`!

The only time `queuedTasks.length > 0` after the loop is when the loop terminated early via `if (this.activeCount >= limit) break`—in which case line 1252 (`if (this.activeCount >= settings.maxConcurrentTasks) return`) immediately returns! The two conditions are mathematically mutually exclusive. `this.onCatMeow` can never be called.

#### Concrete Scenario / Trigger
User enables **Cat Mode** in Options → General (`settings.catMode = true`) and adds 1 or 10 downloads. `maybePlayCatMeow()` always exits at either line 1252 (when concurrency is full) or line 1261 (when concurrency is not full, because all unqueued tasks are already active in `this.runners`).

#### Impact
The Cat Mode feature (`settings.catMode`, `cat:meow` IPC event, and Fix 3.2 in `fixes.md`) is 100% non-functional dead code.

#### Recommended Fix
Decide what Cat Mode is intended to do and align the guards:
- If Cat Mode is meant to periodically meow (and nudge/restart a waiting or active task) while downloads are actively running or waiting behind the concurrency limit, remove `if (this.activeCount >= settings.maxConcurrentTasks) return` (or only skip calling `this.launchRunner(pick)` when `this.activeCount >= settings.maxConcurrentTasks` while still playing the sound, or select from active/queued tasks before the loop).

#### How to Test
- Add a unit test in `tests/scheduler-lifecycle.test.ts` with `catMode: true` and `onCatMeow` spy, add tasks via `manager.add()`, and assert `onCatMeow` is invoked.

---

### F-07: Four Fixes Claimed Complete in `fixes.md` (3.3, 3.5-part-2, 4.2-part-4, 2.4-part-1) Are Incomplete or Absent in Current Code
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Category:** reliability
- **Effort:** S
- **Locations:**
  - `src/main/ipc.ts:812-847` (`tasks:redownload` — Fix 3.3)
  - `src/main/ipc.ts:1291-1305` (`openable` — Fix 3.5 part 2)
  - `src/main/ipc.ts:373-399` (`prepareTaskInput` — Fix 4.2 part 4)
  - `extension/background.js:1403-1409` (`draco:send-media` — Fix 2.4 part 1)

#### Description & Evidence
Cross-checking `fixes.md` against the actual codebase revealed four items marked as completed and checked off (`[x]`) that were never applied (or were only partially applied):

1. **Fix 3.3 (`tasks:redownload` queue awareness and `dirLocked` preservation)**:
   `fixes.md` claims: *"Added `const startNow = !task.queueId`; passed `startNow` to `ctx.manager.add(fresh, startNow)`... Called `await ctx.scheduler.syncTaskQueues([fresh.id], fresh.queueId)`... Only passed `dir` when `task.dirLocked` is true (or `task.groupFolder` is set) so unlocked tasks continue to follow category folder rules."*
   In reality, `src/main/ipc.ts:812-847` reads:
   ```typescript
   // src/main/ipc.ts:825-846
     const fresh = placeTask(ctx, {
       url: redownloadUrl,
       sourceUrl: task.sourceUrl ?? undefined,
       filename: isYouTubePage ? undefined : task.filename,
       dir: task.groupFolder ? dirname(task.dir) : task.dir,
       groupFolder: task.groupFolder ?? undefined,
       // ...
     })
     fresh.queueId = task.queueId
     await ctx.manager.remove(taskId, false)
     await ctx.manager.add(fresh, true)
     announce(fresh)
   ```
   - `ctx.manager.add(fresh, true)` and `announce(fresh)` are still called unconditionally even when `task.queueId !== null`, immediately starting the download and bypassing the queue's schedule/concurrency window.
   - `ctx.scheduler.syncTaskQueues` is never called, leaving the old `taskId` in `queue.taskIds` until the next `synchronizeMembership()`.
   - Passing `dir: task.groupFolder ? dirname(task.dir) : task.dir` causes `createTask` (`src/main/engine/create.ts:144`: `dirLocked: Boolean(input.dir)`) to force `fresh.dirLocked = true` on every redownloaded task.

2. **Fix 3.5 part 2 (`openable()` missing status persistence)**:
   `fixes.md` claims: *"Replaced `broadcast('tasks:changed', ctx.manager.list())` with `ctx.manager.emitTasks()` so the status transition is both persisted to `tasks.json` and broadcast to main + progress windows."*
   In reality, `src/main/ipc.ts:1297-1301` still reads:
   ```typescript
   // src/main/ipc.ts:1297-1301
     if (!(await pathExists(full))) {
       task.status = 'missing'
       broadcast('tasks:changed', ctx.manager.list())
       return null
     }
   ```
   Because `broadcast('tasks:changed', ...)` bypasses `ctx.manager.emitTasks()`, `manager.onUpdate` never fires, `tasks.json` is not saved, and open per-task progress windows are not notified.

3. **Fix 4.2 part 4 (`xPostUrl` check in `prepareTaskInput`)**:
   `fixes.md` claims: *"`prepareTaskInput()` in `src/main/ipc.ts`: Added `xPostUrl(input.url)` check before `isSupportedYouTubeUrl(input.url)` that routes X/Twitter post URLs through `resolveTwitter(canonicalX, ctx.fetch, settings.cookieBrowser)`."*
   In reality, `prepareTaskInput` (`src/main/ipc.ts:373-399`) only checks `isPlaylistUrl(input.url)` and `isSupportedYouTubeUrl(input.url)`. Dropping an X/Twitter link onto `Dropzone.tsx` or submitting it via batch paste calls `tasks:add` → `prepareTaskInput`, which skips `resolveTwitter` and downloads the raw X.com HTML shell as a binary file task.

4. **Fix 2.4 part 1 (`draco:send-media` `/i/web/status/<id>` recognition in `extension/background.js`)**:
   `fixes.md` claims: *"Updated `extension/background.js` (`draco:send-media`) to accept `/i/status/<id>` and `/i/web/status/<id>`."*
   In reality, `extension/background.js:1403-1408` still uses the single-segment regex `/^\/[A-Za-z0-9_]{1,15}\/status\/\d+(?:\/|$)/i`, which matches `/i/status/123` (because `i` is 1–15 chars) but **rejects** `/i/web/status/123` (two path segments before `/status/`).

#### Concrete Scenario / Trigger
- Clicking **Re-download** on a task assigned to a scheduled nightly queue immediately starts downloading it outside the queue window and locks its directory.
- Dragging and dropping `https://x.com/user/status/1234567890` onto the Draco dropzone downloads an unusable HTML file instead of resolving the tweet's video/images.
- Clicking the floating Draco Media Pill on `https://x.com/i/web/status/1234567890` uses the fallback URL instead of canonicalizing the post URL.

#### Impact
Regressions and unapplied fixes in user-facing workflows that the project's tracking documentation (`fixes.md`) marks as resolved.

#### Recommended Fix
Apply each of the four changes described above directly in `src/main/ipc.ts` (`prepareTaskInput`, `tasks:redownload`, `openable`) and `extension/background.js` (`draco:send-media`).

#### How to Test
- Add unit tests covering: (1) `prepareTaskInput` with an `https://x.com/alice/status/123` URL, (2) `tasks:redownload` on a queued task verifying `startNow === false` and `dirLocked` preservation, (3) `openable()` calling `ctx.manager.emitTasks()`, and (4) `draco:send-media` on `https://x.com/i/web/status/12345`.

---

### F-08: Proxy Credentials Are Stored in Plaintext in `settings.json` / `.bak` and Broadcast to All Renderer Windows
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Category:** security
- **Effort:** M
- **Locations:**
  - `src/shared/types.ts:644` (`Settings.proxyUrl`)
  - `src/main/store.ts:157, 171, 200-202` (`Store.getSettings`, `Store.setSettings`, `Store.saveSettings`)
  - `src/main/ipc.ts:865` (`settings:set` broadcast)

#### Description & Evidence
Draco went to considerable effort to encrypt credentials at rest using Windows DPAPI (`safeStorage` via `src/main/electron-json-cipher.ts` and `src/main/sealed-json.ts`) for `tasks.json`, `browser-handoffs.json`, and `credentials.json`.

However, `Settings.proxyUrl` (`src/shared/types.ts:644`, documented as `"Optional HTTP(S) proxy URL (e.g. http://user:pass@127.0.0.1:8080)"`, and rendered in `OptionsDialog.tsx:1141` with placeholder `"http://127.0.0.1:8080 or http://user:pass@proxy:8080"`) is stored inside `settings.json` and `settings.json.bak`.

In `src/main/store.ts:200-202`:
```typescript
// src/main/store.ts:200-202
  private saveSettings(): Promise<void> {
    return this.enqueueWrite('settings', () => writeJsonAtomic(this.settingsPath, this.settings))
  }
```
Unlike `saveTasks()` (`store.ts:195`), which seals via `sealJson(..., this.cipher)`, `saveSettings()` writes `this.settings` in **plaintext** to `%APPDATA%\Draco\settings.json` and `%APPDATA%\Draco\settings.json.bak`. Additionally, `Store.getSettings()` returns the raw `proxyUrl` (including `user:pass`) to every renderer window (`index.html`, `handoff.html`, `progress.html`) via `settings:get` and `broadcast('settings:changed', next)`.

#### Concrete Scenario / Trigger
A user configures an authenticated corporate or residential proxy `http://alice:SecretPass123@proxy.corp.example:8080` in Options → Connection. The password is written in cleartext to `%APPDATA%\Draco\settings.json` and `settings.json.bak`, bypassing the DPAPI protection applied to `credentials.json` and `tasks.json`.

#### Impact
Cleartext exposure of proxy credentials on disk to any backup tool, file-reading process, or forensic artifact, contradicting Draco's DPAPI credential storage model.

#### Recommended Fix
- Either seal `settings.json` with `readSealedJsonFile` / `sealJson` (matching `tasks.json`), or strip `username`/`password` from `Settings.proxyUrl` when saving `settings.json` and store the proxy credentials inside the DPAPI-sealed `CredentialStore` (`credentials.json`).

#### How to Test
- Add a test in `tests/sealed-json.test.ts` or `tests/store-corruption.test.ts` verifying that saving a `proxyUrl` containing `user:secret@host:8080` does not leave `secret` in plaintext on disk in `settings.json` or `settings.json.bak`.

---

### F-09: Active High-Severity Advisories in Direct Runtime/Network Dependencies (`undici@7.30.0`, `electron@43.7.9`) and Transitive `webtorrent` Tree
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Category:** security
- **Effort:** S
- **Locations:**
  - `package.json:45` (`"electron": "^43.7.9"`)
  - `package.json:57` (`"undici": "^7.30.0"`)
  - `package.json:58` (`"webtorrent": "^2.8.5"`)
  - `package-lock.json`

#### Description & Evidence
Running `npm audit` against `package-lock.json` reported **15 total vulnerabilities** (`7 high`, `8 moderate`), including **6 in production dependencies** (`5 high`, `1 moderate`) plus **1 high in the Electron runtime**:

| Package | Installed | Severity | Advisory / GHSA | Relevance to Draco | Fix Available |
|---|---|---|---|-|---|
| `undici` | `7.30.0` | **HIGH** | `GHSA-2m5v-pch6-74hx` (Certificate validation bypass when custom `tls` options passed), `GHSA-55wc-3pg8-jfw6` (unbounded memory in `DeduplicationHandler`), `GHSA-xjj6-f33q-929c`, `GHSA-v9p9-hfj2-hcw8`, `GHSA-4992-7rv2-5pvq`, `GHSA-f269-vfmq-vjvj`, `GHSA-phc3-fgpg-7m6h`, `GHSA-2464-8jfc-74w3` | **Direct production HTTP engine** (`src/main/engine/http.ts`, `probe.ts`, `worker.ts`). Note: Draco currently passes `{ connect: { timeout } }` without custom `tls` options, so `GHSA-2m5v-pch6-74hx` is not triggered today, but HTTP response/header DoS advisories apply when connecting to untrusted servers. | `undici@7.30.1` (patch bump) |
| `electron` | `43.7.9` | **HIGH** | `GHSA-jr5w-w6x2-84p9` (unsanitized navigation options in cross-document navigation privilege boundary) | **Core desktop runtime** | `electron@43.8.1` (patch bump) |
| `vite` | `7.3.6` | **HIGH** | `GHSA-p9ff-h696-f583`, `GHSA-4w7w-66w2-5vf9`, `GHSA-v2wj-q39q-566r` | Dev server only (not shipped in packaged app) | `vite@7.3.7` |
| `ip` | `2.0.1` | **HIGH** | `GHSA-2p57-rm9w-gvfp` (SSRF categorization via non-canonical IP representations) | Transitive prod dependency via `webtorrent` (`dht-rpc`, `bittorrent-dht`) | Upstream `webtorrent` tree |
| `ip-address` | `10.0.1` | **MODERATE** | `GHSA-rxp7-6hxx-x8q5` | Transitive prod dependency via `webtorrent` (`nat-api`) | `npm audit fix` (`>=10.7.4`) |
| `fast-uri`, `minimatch` | `2.4.0`, `10.2.2` | **MODERATE** | `GHSA-265r-96f9-PFv8`, `GHSA-g3hv-75wg-m249` | Dev dependencies (`eslint` / `electron-builder`) | Patch bumps |

#### Concrete Scenario / Trigger
A malicious HTTP server targeted by a download task sends crafted HTTP responses triggering `undici@7.30.0` DoS advisories, or future TLS customization in `buildDirectAgent` (`src/main/engine/http.ts:44`) inadvertently disables TLS certificate verification due to `GHSA-2m5v-pch6-74hx`.

#### Impact
Exposure to patched high-severity vulnerabilities in the primary networking library (`undici`) and application runtime (`electron`).

#### Recommended Fix
Run patch updates for direct dependencies:
```powershell
npm install undici@^7.30.1
npm install --save-dev electron@^43.8.1 vite@^7.3.7
```

#### How to Test
- Run `npm audit --omit=dev` and `npm test` after upgrading `undici` to `7.30.1` and `electron` to `43.8.1`.

---

### F-10: Monolithic Main/Extension Modules Force Brittle Source-Slicing `vm.runInNewContext` Harnesses in 6 Test Suites
- **Severity:** LOW
- **Confidence:** CONFIRMED
- **Category:** maintainability
- **Effort:** M
- **Locations:**
  - `src/main/ipc.ts:1-1830`
  - `src/main/index.ts:1-1196`
  - `extension/background.js:1-1554`
  - `tests/bootstrap-safety.test.ts:8-12`
  - `tests/ipc-admission.test.ts:18-45`
  - `tests/extensions.test.ts:135-145`
  - `tests/window-placement.test.ts:11-28`
  - `tests/store-corruption.test.ts:19-42`
  - `tests/extension-mv3.test.ts:70-95`

#### Description & Evidence
Six test files cannot import the functions they test because those functions live inside unexported monolithic entry points (`src/main/index.ts`, `src/main/ipc.ts`, `src/main/windows.ts`, `src/main/store.ts`, `extension/background.js`) that import `electron` or bind `chrome.*` listeners at module load time. Instead, the tests read the source files as strings, slice by function name with `source.indexOf(...)`, regex-strip TypeScript annotations or `import` lines, and run the sliced text in `vm.runInNewContext`:

```typescript
// tests/bootstrap-safety.test.ts:8-12
const indexSource = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')

function sliceIndex(startMarker: string, endMarker: string): string {
  const start = indexSource.indexOf(startMarker)
  const end = indexSource.indexOf(endMarker, start)
  if (start === -1 || end === -1) throw new Error(`Could not slice ${startMarker}`)
  return indexSource.slice(start, end)
}
```
```typescript
// tests/ipc-admission.test.ts:19-28
function loadIpcModule(): { registerIpc: (ctx: Record<string, unknown>) => void; ... } {
  const source = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"]\r?\n/gm, '')
    .replace(/export\s+interface\s+IpcContext[\s\S]*?\r?\n\}\r?\n/, '')
    .replace(/export\s+function\s+registerIpc/, 'function registerIpc')
```

Furthermore, in `tests/ipc-admission.test.ts`, every helper imported by `src/main/ipc.ts` has to be manually re-stubbed in the VM sandbox (`validateUrl`, `createTask`, `isPlaylistUrl`, `isSupportedYouTubeUrl`, `xPostUrl`, etc.). When `src/main/ipc.ts` is edited, `tests/ipc-admission.test.ts` runs against the VM's hand-rolled stubs rather than the real imported modules.

#### Concrete Scenario / Trigger
A developer reorders helper functions in `src/main/index.ts` or adds a multi-line import in `src/main/ipc.ts` that does not match the regex `/^import[\s\S]*?from\s+['"][^'"]+['"]\r?\n/gm`. The test harness either crashes with `Could not slice ...` or silently diverges from the real module dependencies.

#### Impact
High maintenance friction and risk of false confidence in tests that mock away real module imports via regex source manipulation.

#### Recommended Fix
- Extract pure domain/orchestration modules without top-level `electron` imports:
  - Move `placeTask`, `prepareTaskInput`, `openable`, and task admission logic out of `src/main/ipc.ts` into `src/main/task-admission.ts` (accepting an injected `AdmissionDeps` interface).
  - Move startup/handoff/protocol arg routing out of `src/main/index.ts` into `src/main/bootstrap.ts`.
  - Move window bounds clamping (`placeWithinDisplay`, `usableWorkArea`) out of `src/main/windows.ts` into `src/main/window-geometry.ts`.
- Import and test those pure TypeScript modules directly without `readFileSync` + `vm.runInNewContext`.

#### How to Test
- Replace the `sliceIndex` / `loadIpcModule` string-slicing helpers in `tests/bootstrap-safety.test.ts`, `tests/ipc-admission.test.ts`, and `tests/window-placement.test.ts` with direct ES module `import` statements and verify `npm test` and `npm run typecheck` pass.

---

### F-11: `OptionsDialog` Appearance/Columns/Cookies Controls Bypass Draft Transaction, and Multiple Dialogs Hardcode English Strings
- **Severity:** LOW
- **Confidence:** CONFIRMED
- **Category:** UX
- **Effort:** M
- **Locations:**
  - `src/renderer/src/components/OptionsDialog.tsx:1022-1047` (`AppearanceTab`)
  - `src/renderer/src/components/OptionsDialog.tsx:1287-1290` (`CookiesTab`)
  - `src/renderer/src/components/OptionsDialog.tsx:1571-1640` (`ColumnToggles`)
  - `src/renderer/src/components/HandoffWindow.tsx:1-225`
  - `src/renderer/src/components/SiteGrabberDialog.tsx:1-306`
  - `src/renderer/src/components/ProgressWindow.tsx:177-318`
  - `src/renderer/src/components/GroupDetailDialog.tsx:96-247`
  - `src/renderer/src/components/ClipboardPanel.tsx:66-163`

#### Description & Evidence
1. **Draft Transaction Bypass in `OptionsDialog.tsx`**:
   `OptionsDialog` implements an explicit transactional draft pattern (`const [draft, setDraft] = useState<Settings | null>(null)` at line 58, with **Save**, **Cancel**, and an **Unsaved changes — Discard / Keep editing** confirmation modal at lines 225–265).
   However, three sub-components inside `OptionsDialog.tsx` read and write the global Zustand store directly via `useApp((s) => s.patchSettings)` instead of `draft` / `patchDraft`:
   - `AppearanceTab` (`OptionsDialog.tsx:1022-1047`): `const patchSettings = useApp((s) => s.patchSettings)` — toggling Density (`compact`/`comfortable`), Accent Color, or Language immediately persists to `settings.json` even if the user clicks **Cancel** / **Discard**. Worse, if the user also edited another field in `draft` and then clicks **Save**, `save()` sends `patchSettings(draft)` (which still holds the old `uiDensity`, `accentColor`, and `language` from when the dialog opened), **overwriting and reverting** the appearance changes the user just made!
   - `ColumnToggles` (`OptionsDialog.tsx:1571-1640`): calls `patchSettings({ visibleColumns: next })` directly on live settings, which is likewise overwritten by stale `draft.visibleColumns` if the user later clicks **Save**.
   - `CookiesTab` (`OptionsDialog.tsx:1287-1290`): clicking *"Use public formats"* calls `patchSettings({ cookieBrowser: 'none' })` directly without updating `draft.cookieBrowser`, so clicking **Save** reverts `cookieBrowser` back to the failed browser.

2. **Incomplete Turkish (`tr`) Localization**:
   `src/shared/i18n.ts` defines a ~190-key English/Turkish dictionary, and `Toolbar`, `Sidebar`, `StatusBar`, `DownloadTable`, `Inspector`, `QueueDialog`, `SaveAsDialog`, `SchedulerDialog`, `BatchDialog`, and `ChecksumDialog` use `useT()`. However:
   - `HandoffWindow.tsx` (all 225 lines) and `SiteGrabberDialog.tsx` (all 306 lines) do not import `useT` at all and are 100% hardcoded English.
   - `OptionsDialog.tsx` (1,797 lines) uses `t()` ONLY for the Language label (`t('options.language')`) at line 1110; the other ~1,750 lines (every tab title, section header, setting description, button, and modal) are hardcoded English.
   - `ProgressWindow.tsx`, `GroupDetailDialog.tsx`, and `ClipboardPanel.tsx` translate only 2–4 strings and hardcode the rest in English.

#### Concrete Scenario / Trigger
1. User opens **Options**, switches to **Appearance**, changes Accent Color to *Violet* and Language to *Türkçe*, then switches to **General**, toggles *Show completion dialog*, and clicks **Save**.
2. Because `draft` still holds the initial `accentColor: 'amber'` and `language: 'en'`, clicking **Save** overwrites the live settings with `draft` and reverts both Accent Color and Language back to Amber and English!
3. When Language is set to *Türkçe*, the Options dialog, Browser Handoff popup, and Site Grabber dialog remain almost entirely in English.

#### Impact
- Data loss of user settings edits inside `OptionsDialog` when combining Appearance/Column/Cookie changes with other tabs.
- Half-translated UI when Turkish (`tr`) is selected.

#### Recommended Fix
- Pass `draft` and `patchDraft` into `AppearanceTab`, `ColumnToggles`, and `CookiesTab`'s *"Use public formats"* action so all settings changes participate in the same `draft` state (if live preview of theme/density/language is desired, either sync those fields into `draft` on every change or revert them on **Cancel**).
- Route hardcoded strings in `HandoffWindow.tsx`, `SiteGrabberDialog.tsx`, `OptionsDialog.tsx`, `ProgressWindow.tsx`, `GroupDetailDialog.tsx`, and `ClipboardPanel.tsx` through `src/shared/i18n.ts`.

#### How to Test
- Add a test in `tests/renderer-flows.test.ts` verifying that changing `accentColor` or `cookieBrowser` inside `OptionsDialog` updates `draft` so that clicking `Save` preserves both the appearance change and edits on other tabs.

---

### F-12: `tools/smoke-cli-media.mjs` and `tools/dl.ts` Have Broken Signatures / Types Because `tsconfig.node.json` Excludes `tools/`
- **Severity:** LOW
- **Confidence:** CONFIRMED
- **Category:** test gap
- **Effort:** S
- **Locations:**
  - `tools/smoke-cli-media.mjs:23-54` (`captureRun`)
  - `src/cli/draco.ts:235` (`main`)
  - `tools/dl.ts:46-60` (`EngineSettings` literal)
  - `tsconfig.node.json:21` (`include`)

#### Description & Evidence
`tsconfig.node.json:21` includes only `["electron.vite.config.*", "src/main/**/*", "src/preload/**/*", "src/shared/**/*", "src/cli/**/*"]`, excluding `tools/**` and `tests/**`. As a result, two scripts in `tools/` drifted behind refactors in `src/cli/` and `src/shared/`:

1. **`tools/smoke-cli-media.mjs:23-32`** calls `main(argv, { preferences, signal, choose, status })` and asserts old terminal output markers (`output.includes('━')`, `output.includes('Saved: ')`):
   ```javascript
   // tools/smoke-cli-media.mjs:23-32
   const code = await main(argv, {
     preferences: () => ({ dir: workDir, cookieBrowser: 'none' }),
     signal: AbortSignal.timeout(180_000),
     choose: async () => { throw new Error('Smoke commands must not prompt interactively') },
     status: (text) => process.stderr.write(`  ${text}\n`)
   })
   ```
   However, `main(argv: string[])` in `src/cli/draco.ts:235` takes only a single `argv` parameter (ignoring the second argument), loads real user preferences from disk instead of `workDir`, and outputs `saved` instead of `Saved: `. Running `npm run smoke:cli:media` will download into the user's real download folder and then fail the assertion at line 53 (`assert.equal(run.output.includes('Saved: '), true)`).
2. **`tools/dl.ts:46-60`** constructs an `EngineSettings` object missing three required fields added in later commits (`checkDiskSpace`, `exponentialBackoff`, `seedTorrents`).

#### Concrete Scenario / Trigger
A maintainer runs `npm run smoke:cli:media` before release; the script ignores `workDir`, writes to the user's real download directory, and fails on the old `Saved: ` output assertion.

#### Impact
Broken CLI media smoke test that silently writes outside its temporary `workDir`.

#### Recommended Fix
- Update `tools/smoke-cli-media.mjs` to pass `['-d', workDir, '--cookies', 'none', '--no-confirm', ...]` via `argv` (matching how `tools/verify-all.mjs:150-165` invokes `main()`), and update its output assertions to match current `src/cli/output.ts` formatting (`saved`).
- Add `checkDiskSpace: true, exponentialBackoff: true, seedTorrents: false` to `tools/dl.ts:46-60`, and add `"tools/**/*.ts"` to `tsconfig.node.json`.

#### How to Test
- Include `"tools/**/*.ts"` in `tsconfig.node.json` and run `npm run typecheck`.

---

## 7. Verification of Prior Audit Claims (Phase 5)

We audited 15 specific claims from `docs/AUDIT_2026-10-04.md`, `docs/AUDIT_2026-10-11.md`, and `fixes.md` against the actual source tree at `HEAD` (`dcf6c5b`).

| # | Source Document & Claim ID | Claimed Fix / Behavior | Rating | Evidence in Current Code |
|---:|---|---|---|---|
| 1 | `fixes.md` **Fix 1.1** (`DashRunner` half adoption validation) | Validate adopted half size against `runner.task.expectedSize` when `expectedSize` is known | **REGRESSED** | Added at `src/main/hls/dash.ts:290`, but `DashRunner` sets child `expectedSize` to an `88% / 12%` heuristic (`dash.ts:68-72`), causing `adoptFinishedHalf` to reject almost all valid completed halves and orphan `(1)` duplicates (**F-03**). |
| 2 | `fixes.md` **Fix 1.2** (`uniquePath` exhaustion guard) | Cap `uniquePath` loop at 10,000 and fall back to timestamp + `randomUUID().slice(0, 8)` | **VERIFIED** | `src/main/engine/naming.ts:276-288`: loops `for (let i = 1; i <= 10_000; i++)` and falls back to `${stem} (${Date.now()}-${randomUUID().slice(0, 8)})${ext}`. Tested in `tests/naming.test.ts:132-145`. |
| 3 | `fixes.md` **Fix 1.3** (`RateLimiter` floating-point residue) | Floor `this.tokens` after consumption (`this.tokens = Math.floor(this.tokens - take)`) | **VERIFIED** | `src/main/engine/limiter.ts:127`: `this.tokens = Math.floor(this.tokens - take)`. Tested in `tests/limiter.test.ts:135-146`. |
| 4 | `fixes.md` **Fix 1.4** (Per-task `RateLimiter` wake on pause/cancel) | Register abort listener on `signal` in `TaskRunner` and `HlsRunner` calling `this.taskLimiter.wake()` | **VERIFIED** | `src/main/engine/runner.ts:124-125` and `src/main/hls/runner.ts:116`: `signal.addEventListener('abort', () => this.taskLimiter.wake(), { once: true })`. |
| 5 | `fixes.md` **Fix 2.1** (Duplicate `createWindow()` in `app.whenReady`) | Remove second `createWindow()` call when `startupTasks.length === 0 && !startHidden` | **VERIFIED** | `src/main/index.ts:1049-1055`: `createWindow()` is called once at line 1049 (when `!startHidden`), and the `else` branch was removed. |
| 6 | `fixes.md` **Fix 2.2** (Browser handoff admission queue) | Cap concurrent handoff windows to `maxPendingHandoffs = 12` and auto-expire after `handoffTimeoutMs = 5 * 60_000` | **VERIFIED** | `src/main/index.ts:86-87, 360-363, 474-482`: enforces `pendingHandoffs.size >= maxPendingHandoffs` and sets an unref'd 5-minute expiry timer. Tested in `tests/bootstrap-safety.test.ts:52-77`. |
| 7 | `fixes.md` **Fix 2.3** (Go host passive message suppression) | `draco-host.exe` must not launch `Draco.exe` on `status` or `cancel-handoff` messages | **VERIFIED** | `host/main.go:196-206` (`shouldLaunchOnBridgeFailure`): only `download` and `show-app` return `true`. Verified by `go test` (`TestPassiveMessagesNeverLaunchApp`). |
| 8 | `fixes.md` **Fix 2.4** (X/Twitter `/i/web/status/<id>` & `vxtwitter`/`fixupx`) | Support `/i/web/status/<id>` and wrapper hosts in `src/shared/x-post.ts`, `extension/content.js`, and `extension/background.js` | **PARTIAL** | `src/shared/x-post.ts:3-18` and `extension/content.js:409-424` support `/i/web/status/<id>`, `vxtwitter.com`, and `fixupx.com`, **but** `extension/background.js:1403-1409` (`draco:send-media`) still uses `/^\/[A-Za-z0-9_]{1,15}\/status\/\d+(?:\/|$)/i` which rejects `/i/web/status/<id>` (**F-07**). |
| 9 | `fixes.md` **Fix 3.1** (Scheduler retry timer clearing on `stop` / `pauseAll` / `dispose`) | Call `clearRetryTimers()` in `pauseAll()` and `dispose()`, and `clearQueueRetryTimers(id)` in `stop(id)` | **VERIFIED** | `src/main/queue/scheduler.ts:75, 181, 220`: all three methods clear active retry timers. Tested in `tests/scheduler-lifecycle.test.ts:95-115`. |
| 10 | `fixes.md` **Fix 3.2** (Cat Mode unreachable condition) | Remove `this.activeCount >= settings.maxConcurrentTasks` early return so Cat Mode can fire | **REGRESSED** | Commit `20f5e81` fixed it, then commit `4b867d5` ("restore cat-mode limit") re-added `if (this.activeCount >= settings.maxConcurrentTasks) return` at `src/main/engine/manager.ts:1252` while keeping `!this.runners.has(t.id)` at line 1259, making Cat Mode 100% unreachable again (**F-06**). |
| 11 | `fixes.md` **Fix 3.3** (`tasks:redownload` queue awareness & `dirLocked`) | Pass `startNow = !task.queueId`, call `scheduler.syncTaskQueues`, and preserve `dirLocked` | **NOT FOUND** | `src/main/ipc.ts:812-847` still calls `ctx.manager.add(fresh, true)` and `announce(fresh)` unconditionally, never calls `syncTaskQueues`, and passes `dir` unconditionally so `dirLocked` becomes `true` (**F-07**). |
| 12 | `fixes.md` **Fix 3.5** (Progress window push on `remove`/`clearCompleted` & `openable` persistence) | Close progress windows on `remove`, broadcast `tasks:changed` on `clearCompleted`, and call `ctx.manager.emitTasks()` in `openable()` | **PARTIAL** | `tasks:remove` (`ipc.ts:775`) and `tasks:clear-completed` (`ipc.ts:852`) are fixed, **but** `openable()` (`ipc.ts:1299`) still calls `broadcast('tasks:changed', ...)` without `ctx.manager.emitTasks()` (**F-07**). |
| 13 | `fixes.md` **Fix 4.2** (Unified media URL routing across GUI & CLI) | Route Suno/SoundCloud/X/Khinsider consistently in `ipc.ts` (`media:resolve`, `tasks:inspect`, `prepareTaskInput`) and `src/cli/media.ts` | **PARTIAL** | `media:resolve` (`ipc.ts:524-540`), `tasks:inspect` (`ipc.ts:624-628`), and `src/cli/media.ts:39-57` are unified, **but** `prepareTaskInput` (`ipc.ts:373-399`) still lacks the `xPostUrl` branch claimed in `fixes.md` (**F-07**). |
| 14 | `AUDIT_2026-10-04.md` **Security #1–#4** (Named pipe ACL, redirect header stripping, DPAPI sealing, binary digest verification) | SDDL current-user pipe ACL + auth token; cross-origin header stripping; DPAPI `safeStorage`; SHA-256 verification for `yt-dlp`/`ffmpeg` | **VERIFIED** | `src/main/bridge/pipe.ts:73-138` (SDDL + `timingSafeEqual` token), `src/main/engine/redirect.ts:24-45` (header stripping), `src/main/sealed-json.ts` (DPAPI), `src/main/ytdlp-digest.ts` & `archive-digest.ts` (SHA-256 verification). |
| 15 | `AUDIT_2026-10-11.md` **Section 1 & 7** (Test counts and `npm audit` counts) | Claims `577 tests in 91 suites` (`fixes.md`: `673 in 113`) and `12 vulnerabilities (4 high in prod)` | **PARTIAL** | Test count is higher (`678 tests in 114 suites`, all passing), while `npm audit` count has grown to **15 vulnerabilities (`7 high, 8 moderate`; 6 in prod: `5 high, 1 moderate`)** due to new `undici` and `electron` advisories (**F-09**). |

---

## 8. Threat Model Summary

### 8.1 Assets to Protect
1. **User Filesystem Integrity**: Preventing arbitrary file overwrite, path traversal outside the download folder, or deletion of unrelated user files (`removeTaskArtifacts` / `deleteWithFiles`).
2. **Browser Session & Saved Credentials**: Browser cookies extracted via `chrome.cookies.getAll`, yt-dlp `--cookies-from-browser`, Basic Auth credentials in `credentials.json`, signed CDN URLs/headers in `tasks.json`, and proxy credentials in `settings.json`.
3. **Host Process Execution & Local Network**: Preventing remote web pages, malicious manifests/torrents, or local untrusted processes from achieving arbitrary command execution or probing internal localhost/LAN services (SSRF).

### 8.2 Attacker Profiles, Trust Boundaries & Mitigation Coverage

| Attacker / Vector | Entry Boundary | Existing Mitigations in Code | Residual Gaps / Findings |
|---|---|---|---|
| **1. Malicious Website / Ad Iframe** | `extension/content.js` → `background.js` → `draco-host.exe` → Named Pipe → `index.ts` | • Content script uses isolated world (`chrome.runtime.sendMessage`).<br/>• `draco:download` custom event requires opt-in `allowPageApi === true`.<br/>• `validateUrl(..., { allowPrivate: false })` on handoff URLs.<br/>• `maxPendingHandoffs = 12` cap + 5-min expiry (`index.ts:360, 474`).<br/>• Passive messages (`status`) cannot cold-start `Draco.exe` (`host/main.go:196`). | • **F-01 (HIGH)**: Capture-phase click listener does not check `event.isTrusted`; synthetic `.click()` bypasses user gesture, cold-starts `Draco.exe`, and attaches `SameSite=Strict`/`Lax` cookies cross-site.<br/>• **F-02 (HIGH)**: `isPrivateHost` checks only hostname text; DNS records resolving to `127.0.0.1` bypass `allowPrivate: false`. |
| **2. MITM / Redirecting Remote Server** | `TaskRunner` / `probeUrl` / `runSegment` / `fetchGuarded` | • `stepRedirect` (`src/main/engine/redirect.ts:24-45`) strips `Cookie`, `Authorization`, `Referer`, and non-UA headers on any cross-origin redirect.<br/>• `HttpAuthenticator` (`src/main/engine/auth.ts`) only sends credentials after a `401` challenge and scopes by origin.<br/>• Bounded response readers (`readResponseBytes` / `readResponseText`) prevent memory exhaustion.<br/>• `If-Range` / `ETag` / `Last-Modified` mismatch detection prevents spliced range corruption. | • **F-02 (HIGH)**: Redirect target check in `fetchGuarded` (`src/main/fetch-guard.ts:144`) and `probeUrl` uses `isPrivateHost` string check without socket IP validation.<br/>• **F-09 (MEDIUM)**: `undici@7.30.0` has active DoS advisories fixed in `7.30.1`. |
| **3. Hostile `.torrent` / `.m3u8` / Transfer List** | `TorrentRunner`, `HlsRunner`, `parseTransferFile`, `resolvePageMedia` | • `sanitizeRelativeSubpath` & `assertPathInsideDir` (`src/main/engine/naming.ts:214-262`) block `..`, rooted paths, drive letters, and reserved names in torrent file trees.<br/>• `deleteTorrentPayload` (`src/main/engine/torrent-files.ts:69-118`) verifies realpaths (`realpath`) stay strictly inside `realpath(baseDir)` before deleting.<br/>• HLS parser (`src/main/hls/parser.ts`) caps playlist size (5 MiB) and segments (`MAX_SEGMENTS = 20_000`), blocks `#EXT-X-BYTERANGE` and SAMPLE-AES, and uses `fetchGuarded(..., { allowPrivate: false })` for segments and AES-128 keys.<br/>• `ffmpeg` muxing uses `-f concat -safe 1` with plain basenames (`muxSegments` in `src/main/hls/ffmpeg.ts:122-145`). | • **F-02 (HIGH)**: HLS segment and AES-128 key URLs pointing to domain names that resolve to `127.0.0.1` / RFC1918 bypass `fetchGuarded`'s `allowPrivate: false` check. |
| **4. Local Non-Admin Process on Same Machine** | Named pipe `\\.\pipe\draco-download-manager-<uid>` & `%APPDATA%\Draco` | • `src/main/bridge/pipe.ts:73-112` creates the Windows named pipe with SDDL `D:P(A;;GA;;;<CurrentUserSID>)` and `FILE_FLAG_FIRST_PIPE_INSTANCE`.<br/>• Bridge handshake requires a 256-bit shared token stored in `%APPDATA%\Draco\bridge-token` (`0o600`), verified with `timingSafeEqual`.<br/>• Another Windows user account on the same machine is blocked at both OS pipe DACL and file ACL layers.<br/>• Any process already running as the *same* non-admin Windows user SID is inside the OS user boundary. | • **F-08 (MEDIUM)**: `settings.json` stores `proxyUrl` (which may contain `user:pass@host`) in plaintext rather than DPAPI-sealing it like `credentials.json` and `tasks.json`. |
| **5. Compromised Upstream Binary / Update Channel** | `tools:install-ytdlp`, `tools:install-ffmpeg`, `update:check`, `security/scanner.ts` | • `yt-dlp.exe` download verifies against `SHA2-256SUMS` (`src/main/ytdlp-digest.ts`).<br/>• `ffmpeg` zip download verifies against GitHub Releases REST API `assets[].digest` (`sha256:...`) (`src/main/archive-digest.ts`).<br/>• `replaceVerifiedExecutable` smoke-tests `--version` before swapping.<br/>• AV scanner (`src/main/security/scanner.ts`) validates `stat().isFile()` and uses `execFile` (`shell: false`). | • Both `yt-dlp.exe` and `SHA2-256SUMS` are fetched from the same GitHub release (`yt-dlp/yt-dlp/releases/latest`), so SHA-256 protects against CDN/transit corruption rather than a compromised upstream GitHub release key (no GPG signature verification on `SHA2-256SUMS.sig`).<br/>• App updates (`src/main/update.ts`) open the GitHub release page via `shell.openExternal` rather than auto-executing an unsigned binary. |

---

## 9. Test-Suite Assessment

### 9.1 What the Test Suite Proves Well
With **678 passing tests across 114 suites** (88 `.test.ts` files, ~10,046 lines) plus 4 Go host tests, Draco has unusually strong unit and loopback integration coverage for a desktop app:
- **Real Loopback HTTP Servers**: `tests/engine.test.ts`, `tests/runner-http.test.ts`, `tests/worker-redirect.test.ts`, `tests/youtube-chunks.test.ts`, `tests/hls.test.ts`, `tests/probe-safety.test.ts`, `tests/auth-redirect.test.ts`, and `tests/fetch-guard.test.ts` spin up ephemeral `127.0.0.1:0` HTTP servers and test real byte-range transfers, `If-Range` / `ETag` mismatch recovery, redirect credential stripping, rate limiting, and SHA-256 output integrity.
- **Filesystem & Journal Edge Cases**: `tests/journal.test.ts`, `tests/workspace-migration.test.ts`, `tests/preallocate-safety.test.ts`, `tests/naming.test.ts`, and `tests/torrent-cleanup.test.ts` use real temporary directories (`mkdtemp`) to test crash recovery, junction/symlink rejection during torrent deletion, and legacy `.dracodl` migration.
- **Parser & Media Ladder Coverage**: `tests/youtube-quality.test.ts`, `tests/youtube-playlist.test.ts`, `tests/media-Hardening.test.ts`, and `tests/parser.test.ts` thoroughly cover aspect-ratio tier snapping, HLS playlist parsing, and yt-dlp error normalization.

### 9.2 Weaknesses in Existing Tests
1. **Regex Source-Slicing VM Tests (`F-10`)**: As detailed in **F-10**, 6 test suites (`bootstrap-safety.test.ts`, `ipc-admission.test.ts`, `extensions.test.ts`, `window-placement.test.ts`, `store-corruption.test.ts`, `extension-mv3.test.ts`) slice raw `.ts`/`.js` text and execute it in `vm.runInNewContext` with hand-written stubs for sibling modules. This allowed bugs in `ipc.ts` (such as **F-07**'s missing `xPostUrl` check in `prepareTaskInput` and missing `emitTasks()` in `openable`) to escape notice.
2. **Renderer Tests Do Not Mount React Components**: `tests/renderer-flows.test.ts`, `tests/renderer-store.test.ts`, `tests/renderer-details.test.ts`, and `tests/renderer-batch.test.ts` test the Zustand store (`src/renderer/src/store.ts`) and pure helper functions against a fake `window.draco` bridge (`tests/helpers/renderer-fixture.ts`), which is fast and deterministic, but **zero tests render any `.tsx` React component** (`OptionsDialog.tsx`, `SaveAsDialog.tsx`, `HandoffWindow.tsx`, `DownloadTable.tsx`). Consequently, component-level state bugs like `AppearanceTab` and `ColumnToggles` bypassing `OptionsDialog`'s `draft` state (**F-11**) have no test coverage.

### 9.3 Specific Missing Tests Worth Adding
1. **`DashRunner` Half Adoption with Realistic Estimated Sizes (`tests/media-Hardening.test.ts`)**: Test `DashRunner` retry when `task.expectedSize` is set to an estimate (`10_000`) and the completed video half on disk has an actual size (`9_100`) that differs from `Math.round(10_000 * 0.88)` (**F-03**).
2. **Extension Content Script Untrusted Click & Inactive State (`tests/extensions.test.ts`)**: Test that `content.js` ignores `click` events when `event.isTrusted === false` (**F-01**) or `dracoState.active === false` (**F-04**), and that `replay()` preserves `<a download="name.ext">`.
3. **Cross-Site `SameSite` Cookie Filtering (`tests/extension-mv3.test.ts`)**: Test `cookieHeaderFor` when `sender.url` is cross-site to the download URL, verifying `SameSite=Strict` (and sub-frame `SameSite=Lax`) cookies are excluded (**F-01**).
4. **DNS-Resolved Private IP Rejection (`tests/fetch-guard.test.ts`)**: Test `fetchGuarded(..., { allowPrivate: false })` and `TaskRunner` against a hostname whose DNS lookup returns `127.0.0.1` or `192.168.1.1` (**F-02**).
5. **Queue Deletion & Dangling `queueId` Recovery (`tests/scheduler-lifecycle.test.ts`)**: Test `scheduler.remove(id)` emitting task updates and scheduling freed tasks, plus `synchronizeMembership()` clearing `task.queueId` when a task loaded from disk references a deleted queue (**F-05**).
6. **Cat Mode Trigger Test (`tests/scheduler-lifecycle.test.ts`)**: Test `DownloadManager.schedule()` with `catMode: true` and verify `onCatMeow` actually fires (**F-06**).
7. **Property / Fuzz Tests for `readJournal` and `parseMediaPlaylist`**: Add randomized/mutated input tests for `src/main/engine/journal.ts` (overlapping segments, negative/NaN offsets, truncated JSON) and `src/main/hls/parser.ts` (adversarial attribute quoting and extreme tag counts).

---

## 10. Dependency and Supply-Chain Assessment

### 10.1 Production & Development Dependency Footprint
Draco maintains a lean direct dependency list in `package.json`:
- **4 direct production dependencies**: `lucide-react` (`^1.16.0`), `undici` (`^7.30.0`), `webtorrent` (`^2.8.5`), `zustand` (`^5.0.12`).
- **13 direct dev/build dependencies**: `@electron-toolkit/preload`, `@electron-toolkit/utils`, `@tailwindcss/vite`, `@types/node`, `@types/react`, `@types/react-dom`, `@typescript/native-preview`, `@vitejs/plugin-react`, `electron`, `electron-builder`, `electron-vite`, `tailwindcss`, `vite`.
- **Total lockfile packages**: 531 packages (the bulk of transitive production dependencies come from `webtorrent`'s peer-to-peer networking stack).

### 10.2 Build & Install Hardening
- **`allowScripts` Policy (`package.json:100-105`)**: Draco explicitly restricts npm lifecycle scripts via `"allowScripts": { "electron": true, "esbuild": true, "node-datachannel": true, "utp-native": false }`, disabling native C++ build scripts for `utp-native`. Furthermore, `npm ci --ignore-scripts` succeeds cleanly for testing and typechecking.
- **Bundled Runtime Manifest (`resources/runtime/manifest.json` & `tools/bundle-runtime.mjs`)**:
  - `ffmpeg.exe`, `ffprobe.exe`, and `yt-dlp.exe` are tracked with explicit version strings, source URLs, byte sizes, and SHA-256 digests in `resources/runtime/manifest.json`.
  - Our Phase 1 SHA-256 verification confirmed that all three binaries in `resources/runtime/` match `manifest.json` byte-for-byte.
- **In-App Binary Updates (`src/main/ipc.ts:1164-1267`, `ytdlp-digest.ts`, `archive-digest.ts`, `hls/replace-executable.ts`)**:
  - Both `yt-dlp.exe` and `ffmpeg.zip` are fetched over HTTPS from pinned GitHub repositories (`yt-dlp/yt-dlp` and `BtbN/FFmpeg-Builds`), verified against SHA-256 digests before extraction, tested via `--version` execution, and swapped atomically via `replaceVerifiedExecutable`.

### 10.3 Packaging & Code Signing Risks
- **Unsigned Windows Executables (`electron-builder.yml:22`)**: `win.signAndEditExecutable: false` is set in `electron-builder.yml`. Both the main NSIS installer (`Draco-Setup-0.2.0.exe`) and the standalone CLI NSIS installer (`resources/cli-installer.nsi`) are currently built unsigned. For public distribution on Windows, unsigned executables trigger SmartScreen warnings and make it harder for users to verify binary authenticity.
- **NSIS Uninstaller Safety (`resources/installer.nsh`, `resources/cli-installer.nsi`)**:
  - We reviewed both `resources/installer.nsh` and `resources/cli-installer.nsi`. The uninstaller removes `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.draco.host` (and Edge/Brave/Chromium/Firefox keys), removes `%APPDATA%\Draco\host`, removes `$INSTDIR\resources\bin` from the user `HKCU\Environment\Path` via custom ` un.RemoveFromPath` string matching (avoiding the classic NSIS `WriteRegExpandStr` PATH-truncation bug on paths >1,024 chars by using PowerShell in `tools/install-cli.ps1`, though note that standard NSIS string buffers in `cli-installer.nsi` default to 1,024 bytes unless compiled with the large-strings NSIS build), and leaves user downloads untouched.

---

## 11. Prioritized Remediation Roadmap

### Phase A — Fix Now (This Week)
*Goal: Eliminate high-severity security and data-waste bugs before further daily or external use.*
1. **[F-01 & F-04] Harden Browser Extension Content & Background Scripts** *(Effort: S, No dependencies)*
   - In `extension/content.js:126`: add `if (!event.isTrusted) return` and `if (!dracoState.active) return`; change `replay()` to invoke `anchor.click()` while `replayingAnchor === anchor`.
   - In `extension/background.js:484-491`: pass `sender` to `cookieHeaderFor(url, sender)` and filter out `SameSite=Strict` (and sub-frame `SameSite=Lax`) cookies when `sender.url` is cross-site to `url`.
   - Re-run `node tools/build-firefox-extension.mjs` to sync `extension-firefox/`.
2. **[F-03] Fix `DashRunner.adoptFinishedHalf` Regression** *(Effort: S, No dependencies)*
   - Remove the synthetic `0.88` / `0.12` mutation of `videoTask.expectedSize` and `audioTask.expectedSize` in `src/main/hls/dash.ts:68-72` (or check `runner.task.size` in `adoptFinishedHalf`), and ensure rejected/stale half files at `finalPath` are unlinked before re-downloading so `uniquePath` never orphans `(1)` copies.
3. **[F-09] Patch Direct Dependency Vulnerabilities** *(Effort: S, No dependencies)*
   - Upgrade `undici` to `^7.30.1`, `electron` to `^43.8.1`, and `vite` to `^7.3.7` in `package.json` / `package-lock.json`.
4. **[F-05, F-06, F-07] Restore Queue Deletion Sync, Cat Mode, and Unapplied `fixes.md` Items** *(Effort: S, No dependencies)*
   - In `Scheduler.remove` (`src/main/queue/scheduler.ts:151-165`) and `Scheduler.synchronizeMembership` (`scheduler.ts:192-217`), clean up dangling `queueId` references, notify `DownloadManager` to persist `tasks.json`, and trigger scheduling.
   - Fix the mutually exclusive guards in `DownloadManager.maybePlayCatMeow` (`src/main/engine/manager.ts:1252-1261`).
   - Apply the four missing fixes in `src/main/ipc.ts` (`prepareTaskInput` `xPostUrl` branch, `tasks:redownload` queue awareness & `dirLocked`, `openable` `ctx.manager.emitTasks()`) and `extension/background.js` (`/i/web/status/` regex).

### Phase B — Next (This Month)
*Goal: Close DNS-rebinding SSRF, seal proxy credentials, and fix UI draft/i18n gaps.*
5. **[F-02] Enforce Socket-Level IP Validation (`connect.lookup`) for `allowPrivate: false`** *(Effort: M, Depends on F-09 `undici` update)*
   - Add a custom `lookup` guard in `src/main/engine/http.ts` and `src/main/fetch-guard.ts` that validates resolved IPv4/IPv6 addresses against `isPrivateHost(address)` at connection time.
6. **[F-08] Seal Proxy Credentials at Rest** *(Effort: M, No dependencies)*
   - Seal `settings.json` via `sealed-json.ts` or move proxy credentials out of `Settings.proxyUrl` into the DPAPI-sealed `CredentialStore` (`credentials.json`).
7. **[F-11] Unify `OptionsDialog` Draft State & Complete Turkish (`tr`) Translations** *(Effort: M, No dependencies)*
   - Wire `AppearanceTab`, `ColumnToggles`, and `CookiesTab` through `draft`/`patchDraft` in `OptionsDialog.tsx`, and translate hardcoded English strings in `OptionsDialog.tsx`, `HandoffWindow.tsx`, `SiteGrabberDialog.tsx`, `ProgressWindow.tsx`, `GroupDetailDialog.tsx`, and `ClipboardPanel.tsx`.
8. **[F-12] Repair `tools/smoke-cli-media.mjs` & Include `tools/` in `tsconfig.node.json`** *(Effort: S, No dependencies)*

### Phase C — Later (Pre-Public Release)
*Goal: Modularize main-process entry points and prepare signed release artifacts.*
9. **[F-10] Extract Pure Admission/Bootstrap Modules & Replace `vm.runInNewContext` Source-Slicing Tests** *(Effort: M, Depends on Phase A `ipc.ts` fixes)*
10. **Configure Windows Authenticode Signing & Detached GPG Verification for `yt-dlp`** *(Effort: M)*

---

## 12. Positive Observations Worth Preserving

1. **Dynamic Tail-Splitting Segmenter (`src/main/engine/segmenter.ts` & `ramp.ts`)**: `Segmenter.split()` picks the active segment with the largest *estimated time remaining* (based on observed per-segment byte velocity rather than raw remaining bytes) and splits only when both halves exceed `minSplitSize`. Combined with `ConnectionRamp` (which only adds connections when aggregate throughput improves by $\ge 8\%$), this avoids hammering servers that throttle per-connection throughput.
2. **Cross-Origin Redirect & Basic Auth Isolation (`src/main/engine/redirect.ts` & `auth.ts`)**: Stripping `Cookie`, `Authorization`, `Referer`, and custom headers on any cross-origin redirect hop—and challenging Basic Auth per-origin rather than pre-sending credentials to untrusted redirect targets—eliminates a class of credential-leak vulnerabilities common in download managers.
3. **Hashed Per-Task Workspace Isolation (`src/main/engine/workspace.ts`)**: Placing in-flight `.dracodl` part files and journals inside `<dir>/.dracodl/<filename>~<sha256(taskId)[0..12]>/part` with automatic migration from legacy layouts (`migrateLegacyIntermediates`) guarantees that two tasks targeting the same filename never clobber each other's partial data.
4. **Symlink/Junction-Safe Torrent Cleanup (`src/main/engine/torrent-files.ts`)**: Before deleting any torrent file or pruning empty parent directories on *"Remove with files"*, `deleteTorrentPayload` resolves `realpath(baseDir)` and `realpath(parent)` and refuses to unlink anything that escapes `baseDir` via a junction or symlink.
5. **Windows Named-Pipe SDDL Hardening (`src/main/bridge/pipe.ts` & `bridge-acl.ps1`)**: Using PowerShell/.NET `PipeSecurity` with an explicit current-user SID SDDL (`D:P(A;;GA;;;<UserSID>)`), `PipeOptions.FirstPipeInstance`, and a 256-bit shared token checked with `timingSafeEqual` provides strong defense-in-depth on multi-user Windows systems.

---

## 13. Appendix

### 13.1 Files Reviewed vs Not Reviewed

#### Reviewed (100% of Authored Text/Code Files — 317 Files Total)
- **Root Configs & Docs (13/13 files)**: `package.json`, `package-lock.json` (inspected via `npm audit` and version checks), `electron-builder.yml`, `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`, `README.md`, `fixes.md`, `docs/AUDIT_2026-10-04.md`, `docs/AUDIT_2026-10-11.md`, `docs/BROWSER_TAKEOVER.md`, `docs/audit/2026-10-10-baseline.json`.
- **Main Process (`src/main/**` — 111/111 files)**:
  - Root (`47` files): `archive-digest.ts`, `clipboard-url.ts`, `clipboard.ts`, `cookie-check.ts`, `cookie-report.ts`, `credentials.ts`, `electron-json-cipher.ts`, `fetch-guard.ts`, `file-Inspection.ts`, `format.ts`, `history.ts`, `index.ts`, `ipc.ts`, `json-file.ts`, `log.ts`, `media-headers.ts`, `media-url.ts`, `page-media.ts`, `postprocess.ts`, `power.ts`, `response-limit.ts`, `runtime-paths.ts`, `sealed-json.ts`, `shell-integration.ts`, `sound.ts`, `startup-tasks.ts`, `store-sanitize.ts`, `store.ts`, `thumbnail-cache.ts`, `tools-version.ts`, `tools.ts`, `torrent-inspect.ts`, `tray.ts`, `transfer-list.ts`, `twitter.ts`, `update-version.ts`, `update.ts`, `windows.ts`, `youtube-error.ts`, `youtube-ladder.ts`, `youtube-playlist.ts`, `youtube-refresh.ts`, `youtube-sessions.ts`, `youtube-url.ts`, `youtube.ts`, `ytdlp-cookies.ts`, `ytdlp-digest.ts`, `ytdlp-runner.ts`.
  - `src/main/bridge/**` (`3` files): `bridge-acl.ps1`, `handoff.ts`, `pipe.ts`.
  - `src/main/engine/**` (`25` files): `auth.ts`, `checksum.ts`, `create.ts`, `disk.ts`, `duplicate.ts`, `http.ts`, `journal.ts`, `limiter.ts`, `manager.ts`, `naming.ts`, `network-rules.ts`, `preallocate.ts`, `probe-helpers.ts`, `probe.ts`, `ramp.ts`, `redirect.ts`, `runner.ts`, `seeding.ts`, `segmenter.ts`, `task.ts`, `torrent-files.ts`, `torrent-metadata.ts`, `torrent-peers.ts`, `torrent.ts`, `worker.ts`, `workspace.ts`.
  - `src/main/grabber/**` (`1` file): `crawler.ts`.
  - `src/main/hls/**` (`5` files): `dash.ts`, `ffmpeg.ts`, `parser.ts`, `replace-executable.ts`, `runner.ts`.
  - `src/main/media/**` (`26` files): `direct.ts`, `embed.ts`, `generic.ts`, `html.ts`, `index.ts`, `instagram.ts`, `jsonld.ts`, `khinsider.ts`, `manifest.ts`, `meta.ts`, `mime.ts`, `nextjs.ts`, `normalize.ts`, `oembed.ts`, `pattern.ts`, `pinterest.ts`, `reddit.ts`, `resolve.ts`, `soundcloud.ts`, `suno.ts`, `tiktok.ts`, `twitch.ts`, `types.ts`, `vimeo.ts`, `youtube-embed.ts`, `ytdlp.ts`.
  - `src/main/queue/**` (`2` files): `scheduler-window.ts`, `scheduler.ts`.
  - `src/main/security/**` (`1` file): `scanner.ts`.
- **Preload (`src/preload/**` — 1/1 file)**: `index.ts`.
- **Shared (`src/shared/**` — 10/10 files)**: `html-entities.ts`, `i18n.ts`, `media-pill-sites.ts`, `torrent-tree.ts`, `types.ts`, `url-display.ts`, `url- safety.ts`, `video-quality.ts`, `x-post.ts`, `youtube-link.ts`.
- **CLI (`src/cli/**` — 16/16 files) & `bin/` (1/1 file)**: `args.ts`, `batch.ts`, `clipboard.ts`, `colors.ts`, `config.ts`, `draco.ts`, `errors.ts`, `format.ts`, `help.ts`, `history.ts`, `interactive.ts`, `media.ts`, `output.ts`, `preferences.ts`, `progress.ts`, `session.ts`, plus `bin/draco.mjs`.
- **Renderer (`src/renderer/**` — 48/48 files)**: `index.html`, `handoff.html`, `progress.html`, `src/main.tsx`, `src/handoff.tsx`, `src/progress.tsx`, `src/App.tsx`, `src/store.ts`, `src/sound.ts`, `src/i18n.ts`, `src/styles.css`, `src/lib/*` (`4` files), and `src/components/*` (`33` files).
- **Extensions (`extension/**` — 5/5 files; `extension-firefox/**` — 4/4 files)**: `manifest.json`, `background.js`, `content.js`, `popup.html`, `popup.js`.
- **Go Native Host (`host/**` — 3/3 files)**: `main.go`, `main_test.go`, `build.ps1`.
- **Resources & Tooling (`resources/**` — 6/6 text files; `tools/**` — 23/23 code/doc files)**: `resources/installer.nsh`, `resources/cli-installer.nsi`, `resources/draco.cfg`, `resources/bin/draco.cmd`, `resources/bin/draco.cjs`, `resources/runtime/manifest.json`, and all 23 scripts/files under `tools/`.
- **Test Suites (`tests/**` — 89/89 files)**: All 88 `.test.ts` files and `tests/helpers/renderer-fixture.ts`.

#### Not Reviewed Line-by-Line (Binary / Media / Cache Assets)
- `host/draco-host.exe` (2,976,256 B — PE64 Go binary; verified build script `host/build.ps1` and `host/main.go` source + `go test`).
- `resources/runtime/ffmpeg.exe` (170,051,584 B), `resources/runtime/ffprobe.exe` (169,836,032 B), `resources/runtime/yt-dlp.exe` (23,575,744 B) — verified SHA-256 hashes against `resources/runtime/manifest.json`.
- Images & Audio: `resources/icon.ico`, `resources/icon.png`, `resources/terminal.ico`, `resources/draco-logo-sm.webp`, `resources/cat-meow.wav`, `extension/icons/*.png`, `extension-firefox/icons/*.png`, `src/renderer/src/assets/*`.
- Local build caches & untracked bundle: `.build-cache/**`, `repomix-output.xml`.

---

### 13.2 Dropped and Downgraded Findings (Phase 6 Self-Challenge)

During Phase 6, we challenged every candidate hypothesis against the full call graph and dropped or downgraded the following items:

1. **[DROPPED] Candidate: "Torrent file deletion (`deleteWithFiles`) could follow a symlink/junction inside a multi-file torrent directory and delete outside user files."**
   - *Why dropped*: We traced `deleteTorrentPayload` in `src/main/engine/torrent-files.ts:69-118`. Before unlinking any target path or rmdir'ing any ancestor directory, `resolveContainedTarget` calls `lstat(targetPath)` and compares `await realpath(dirname(targetPath))` against `await realpath(baseDir)` using `isInsideBaseDir`. If any intermediate directory is a symlink or Windows junction pointing outside `baseDir`, `resolveContainedTarget` returns `null` and skips it. Verified by `tests/torrent-cleanup.test.ts`.
2. **[DROPPED] Candidate: "HLS segment names or `#EXT-X-KEY` URIs could inject flags or arbitrary file paths into `ffmpeg` concat muxing."**
   - *Why dropped*: We traced `HlsRunner` (`src/main/hls/runner.ts:185-248`) and `muxSegments` (`src/main/hls/ffmpeg.ts:122-160`). Segments are written to deterministic sequential filenames (`seg_000000.ts`, `seg_000001.ts`) generated by `padIndex(seg.index)`, never from the remote URL's path. `muxSegments` validates every entry with `isSafeConcatEntry` (rejecting path separators, `..`, or leading `-`) and passes `-f concat -safe 1` to `execFile(ffmpegPath, args)`.
3. **[DROPPED] Candidate: "Overlapping byte writes when `Segmenter.split()` cuts an active worker's segment mid-stream."**
   - *Why dropped*: We traced `Segmenter.split()` (`src/main/engine/segmenter.ts:118-152`) and `runSegment`'s write loop (`src/main/engine/worker.ts:272-312`). Both run on the single-threaded Node.js event loop. `runSegment` checks `const remaining = segment.end >= 0 ? segment.end - segment.position + 1 : Infinity` synchronously **before** each `flush(toWrite)` call and advances `segment.position += toWrite` synchronously before `await fh.write(...)`. Because `Segmenter.split()` only sets `target.end = mid - 1` where `mid > target.position`, no byte at `< mid` can ever be written by the new tail worker, and the incumbent worker stops at `mid - 1` on its next synchronous chunk check before flushing.
4. **[DROPPED] Candidate: "`shell.openExternal` in `ipc.ts` or `update.ts` allows `file://` or `javascript:` execution."**
   - *Why dropped*: `openExternalHttpUrl` in `src/main/ipc.ts:226-232` parses `new URL(url)` and enforces `parsed.protocol === 'http:' || parsed.protocol === 'https:'` before calling `shell.openExternal(parsed.toString())`.
5. **[DOWNGRADED to LOW / F-10] Candidate: "`ipc-admission.test.ts` VM sandbox hides broken IPC admission validation."**
   - *Why downgraded*: While the VM source-slicing pattern is brittle (**F-10**) and did allow `prepareTaskInput`'s missing `xPostUrl` check (**F-07**) to go unnoticed because `ipc-admission.test.ts` didn't test X URLs, the core `assertTrustedRenderer` sender verification in `src/main/ipc.ts:171-196` is sound in production code.

---

### 13.3 Open Questions Needing Runtime Verification on Live Targets

Because this audit operated in an isolated offline/loopback environment without modifying the host Windows registry or live browser profiles, the following three runtime checks are recommended before cutting a public release:

1. **Real Browser Extension Handoff & Popup-Blocker Behavior (Chromium & Firefox)**
   - *Manual test step*: Load `extension/` unpacked in Chrome/Edge and `extension-firefox/` in Firefox. Test clicking: (a) `<a href="blob:..." download="export.csv">`, (b) a same-origin `<a href="/api/export" download="data.json">` without `Content-Disposition: attachment`, and (c) `<a href="https://example.com/file.zip" target="_blank">` both when `Draco.exe` is running (and the user clicks **Cancel** in `HandoffWindow`) and when `Draco.exe` is closed (**F-01**, **F-04**).
2. **Windows `SetFileValidData` / Sparse Preallocation Behavior on Non-Admin vs Admin NTFS/ReFS Volumes**
   - *Manual test step*: `preallocateFile` (`src/main/engine/preallocate.ts`) uses `fh.truncate(size)`. Verify on a standard Windows 11 NTFS volume with a 20+ GB multi-segment download that random positional writes (`fh.write(buf, 0, len, offset)`) into the truncated `.dracodl/.../part` file do not cause synchronous zero-fill UI stalls when the highest-offset worker writes near the end of the file on first chunk arrival.
3. **NSIS CLI Installer `PATH` Length Behaviour on Systems with `HKCU\Environment\Path` > 1,024 Characters**
   - *Manual test step*: In a disposable Windows VM where the user `PATH` exceeds 1,024 characters, run `Draco-CLI-Setup-0.2.0.exe` (`resources/cli-installer.nsi`, which uses NSIS `ReadRegStr` / `WriteRegExpandStr`) and verify whether the NSIS compiler used by `electron-builder` / `makensis` is compiled with `NSIS_MAX_STRLEN=8192` or default `1024` (note that `tools/install-cli.ps1` uses PowerShell `[Environment]::SetEnvironmentVariable`, which is immune to the 1,024-char NSIS buffer limit).
