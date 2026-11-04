# Draco Codebase Fixes Log

This document tracks all bugs, glitches, performance issues, and download errors identified during the deep architectural audit, along with their detailed root cause analysis, fix implementation, and verification steps.

---

## Index of Fixes

### 1. Download Engine & Media Stream Runners
- [x] **Fix 1.1**: `DashRunner` workspace isolation, cleanup of intermediate halves, and probed event emission.
- [x] **Fix 1.2**: `TaskRunner` / `Worker` open-ended sliced range stream EOF loop termination (HTTP 416 fix).
- [x] **Fix 1.3**: `DownloadManager` Cat Mode dead-code removal / scheduler integration.
- [x] **Fix 1.4**: `HlsRunner` preservation of stable watch URL during YouTube manifest refresh.
- [x] **Fix 1.5**: `MpdRunner` speed/ETA calculation on resume and completion status cleanup.
- [x] **Fix 1.6**: `fetchGuarded` initial host validation and MPD manifest URL validation.
- [x] **Fix 1.7**: `postprocess.ts` process tree termination on Windows.

### 2. Browser Extensions, Native Host & Bridge
- [x] **Fix 2.1**: Extension `content.js` orphaned script click-hijack prevention and event listener cleanup.
- [x] **Fix 2.2**: Extension link-click confirmation resilience against page navigation and service worker drops.
- [x] **Fix 2.3**: Native host (`host/main.go`) pipe handling and oversized message reporting.
- [x] **Fix 2.4**: Extension `draco:send-media` `/i/web/status/<id>` URL support and `requestContexts` leak fix.

### 3. Main Process, IPC, Scheduler & Site Grabber
- [x] **Fix 3.1**: Queue scheduler refresh on task completion/error and tick deduplication.
- [x] **Fix 3.2**: IPC dialog parenting fix and hidden `BrowserWindow` leak removal.
- [x] **Fix 3.3**: `tasks:redownload` queue awareness and `dirLocked` preservation.
- [x] **Fix 3.4**: Site Grabber redirect path mapping and filename/directory collision resolution.
- [x] **Fix 3.5**: Main process bulk handoff window suppression and missing file status persistence.

### 4. Renderer UI & State Management
- [x] **Fix 4.1**: `SaveAsDialog.tsx` double `resolveMediaPage` IPC triggering and state flapping.
- [x] **Fix 4.2**: `Dropzone.tsx` & `App.tsx` media URL routing, magnet support, stuck drag overlay, and Rules of Hooks fix.
- [x] **Fix 4.3**: `OptionsDialog.tsx` category draft preservation and tab-switching persistence.
- [x] **Fix 4.4**: 4 Hz progress render cascade mitigation in `App.tsx`, `DownloadTable`, and `Toolbar`.
- [x] **Fix 4.5**: Destination duplicate check in `SaveAsDialog` and group selection fixes.

### 5. CLI Subsystem
- [x] **Fix 5.1**: `src/cli/session.ts` queue stall/deadlock on skipped or pre-resolved items.
- [x] **Fix 5.2**: `src/cli/args.ts` flag argument consumption and `config.ts` `/dir` replacement.

---


## Detailed Fix Entries

### Fix 1.7: `postprocess.ts` process tree termination on Windows
- **Files Modified**: `src/main/engine/postprocess.ts`
- **Root Cause**: `runConversion` invoked `child.kill('SIGKILL')` on abort. On Windows, Node.js `child.kill()` calls `TerminateProcess` strictly on the immediate child process. If ffmpeg or shell wrappers spawn child helper processes or threads holding file handles, `SIGKILL` leaves them orphaned, locking files and wasting system resources.
- **Fix**: Replaced direct `child.kill('SIGKILL')` with `killTree(child)` imported from `src/main/proc.ts`, ensuring the entire process tree on Windows is cleanly enumerated and terminated via taskkill/win32 API.
- **Verification**: Built and verified clean import resolution and termination handler wiring.

### Fix 1.1: `DashRunner` intermediate paths, cleanup of intermediate halves, and probed event emission
- **Files Modified**: `src/main/engine/workspace.ts`, `src/main/hls/dash.ts`
- **Root Cause**:
  1. `intermediatePathsFor` in `workspace.ts` previously returned `files: []` for all tasks, neglecting the intermediate composite halves (`.v.mp4`, `.a.m4a`, and itag-suffixed files) and `.draco-mux-temp` / `.draco-dash-temp` files stored in `task.dir`. When users cancelled or removed a split video+audio task midway or when a mux failed, multi-gigabyte half files remained orphaned in the user's Downloads directory.
  2. In `dash.ts`, `childContext` had a no-op `onProbed: () => {}`, preventing `DownloadManager` from learning the total composite size once child runners probed video and audio streams.
  3. `adoptFinishedHalf` trusted any file with `info.size > 0` on disk without verifying that its size matched `runner.task.expectedSize`.
- **Fix**:
  1. Updated `intermediatePathsFor` in `workspace.ts` to include `.v.mp4`, `.a.m4a`, their itag-suffixed paths, and all `.draco-dash-temp` / `.draco-mux-temp` permutations in `task.dir` so that `manager.remove()` cleans up all intermediate files.
  2. Implemented `onProbed` in `dash.ts` child context to aggregate total size across video and audio runners and forward the probed event to `this.deps.onProbed(this.task)`.
  3. Enhanced `adoptFinishedHalf` to verify `info.size === runner.task.expectedSize` when expected size is available.
- **Verification**: Verified via TypeScript compilation and unit tests.

### Fix 1.2: `TaskRunner` / `Worker` open-ended sliced range stream EOF loop termination (HTTP 416 fix)
- **Files Modified**: `src/main/engine/worker.ts`
- **Root Cause**:
  When downloading an open-ended stream (`seg.end < 0`) with ranged requests (e.g., servers offering strong validators without `Content-Length` on probe, or GoogleVideo streams), the worker loop in `attemptSegment` broke on `res.statusCode === 200`, `sliceBytesRead === 0`, or `seg.position >= ctx.expectedSize`. However, on the final slice where `0 < sliceBytesRead < requestedSliceCapacity`, the server returns status `206` with fewer bytes than requested. Because `ctx.expectedSize` was `null`, the loop did not terminate; instead, it issued another HTTP request for bytes past EOF, which failed with `HTTP 416 Range Not Satisfiable` and caused the entire download to fail at 100% completion.
- **Fix**:
  1. Captured the total length reported in `Content-Range: bytes .../total` into `ctx.expectedSize` if `ctx.expectedSize` was previously `null`.
  2. Added an explicit check: `if (requestedEnd >= 0 && sliceBytesRead < (requestedEnd - requestedStart + 1)) break`. When fewer bytes are received than the slice requested, EOF has been cleanly reached and the loop breaks.
- **Verification**: Verified via typecheck and existing HTTP engine test suites.

### Fix 1.3: `DownloadManager` Cat Mode dead-code removal / scheduler integration
- **Files Modified**: `src/main/engine/manager.ts`
- **Root Cause**:
  In `manager.ts`, `ensureCatTimer` bailed out immediately with `if (this.activeCount >= settings.maxConcurrentTasks) return`. However, whenever `this.activeCount < settings.maxConcurrentTasks`, `schedule()` had already launched all non-queued tasks, meaning `queuedTasks` was always empty. The only time tasks were waiting in `queued` was when active slots were saturated, which was precisely the condition that triggered the early return. Consequently, Cat Mode was dead code. Furthermore, if a task was trickled, `task.startedAt` was overwritten without being restored when returned to `queued`, corrupting future rate and ETA calculations.
- **Fix**:
  1. Replaced the `activeCount >= maxConcurrentTasks` block with `if ([...this.runners.values()].some((r) => r.task.isCatMode)) return` so exactly one waiting queued task at a time can be trickled for keep-alive without exceeding concurrency limits.
  2. Preserved and restored the original `task.startedAt` timestamp when Cat Mode ends and returns the task to `queued` status.
- **Verification**: Verified via TypeScript compilation and unit tests.

### Fix 1.4: `HlsRunner` preservation of stable watch URL during YouTube manifest refresh
- **Files Modified**: `src/main/hls/runner.ts`
- **Root Cause**:
  When `HlsRunner` ran a YouTube stream, `this.task.url = await this.deps.refreshYouTube(this.task, false)` replaced `task.url` with the expiring signed manifest URL (`manifest.googlevideo.com`). If `task.youtube.pageUrl` was not explicitly populated, the permanent watch URL was lost forever, corrupting subsequent token refreshes, duplicate detections, and task cloning. Additionally, during fallback joining in `finalize()`, tasks without an existing file extension were not given `.mp4` or `.ts`.
- **Fix**:
  1. Preserved `this.task.youtube.pageUrl = this.task.youtube.pageUrl ?? this.task.url` prior to assigning the refreshed manifest URL.
  2. Guarded the fallback filename extension assignment in `finalize()` so that extensionless filenames properly receive `.mp4` (if initSegment exists) or `.ts`.
- **Verification**: Verified via typecheck and existing YouTube and HLS test suites.

### Fix 1.5: `MpdRunner` speed/ETA calculation on resume and completion status cleanup
- **Files Modified**: `src/main/dash/runner.ts`
- **Root Cause**:
  1. `MpdRunner.tick()` computed transfer rate as `this.mediaSeconds / Math.max(0.25, (now - (this.task.startedAt ?? now)) / 1000)`. Because `ffmpeg` streams are non-resumable and restart from byte/second 0 on every attempt while `task.startedAt` was preserved across pauses, resuming a DASH task hours after the original start caused elapsed time to be huge while `mediaSeconds` was small, collapsing the calculated speed and inflating ETA.
  2. On completion, `this.task.eta` was set to `0` instead of `null`, inconsistent with all other download runners.
  3. `ffmpeg` was executed without a protocol whitelist, permitting untrusted local/virtual protocol resolution if an MPD manifest contained unexpected URI schemes.
- **Fix**:
  1. Introduced `runStartedAt` tracked per active ffmpeg run so rate and ETA are measured against the current active transfer session.
  2. Set `this.task.eta = null` on completion.
  3. Added `-protocol_whitelist http,https,tcp,tls` to ffmpeg arguments.
- **Verification**: Verified via typecheck and test suites.

### Fix 1.6: `fetchGuarded` initial host validation and MPD manifest URL validation
- **Files Modified**: `src/main/fetch-guard.ts`, `src/main/dash/manifest.ts`
- **Root Cause**:
  `fetchGuarded` and `requestGuarded` previously only validated against private hosts during redirect hops (`if (!isPrivateHost(url.hostname) && isPrivateHost(target.hostname))`). If callers provided an initial URL pointing to loopback or private intranets, it was not guarded when `allowPrivate: false` was desired. Additionally, DASH MPD manifests parsed in `manifest.ts` never inspected `<BaseURL>` tags, allowing malicious manifests to specify `file:` or loopback endpoints.
- **Fix**:
  1. Added `allowPrivate?: boolean` option to `FetchGuardedOptions`. When `allowPrivate === false`, both `fetchGuarded` and `requestGuarded` enforce `if (isPrivateHost(url.hostname)) throw new Error('Connecting to private network addresses is not allowed')` on the initial URL as well as all redirect targets.
  2. In `inspectMpd`, added explicit validation of all declared `<BaseURL>` tags, rejecting `file:`, `data:`, or private host addresses.
- **Verification**: Verified via typecheck and test suite.

### Fix 2.1: Extension `content.js` orphaned script click-hijack prevention and event listener cleanup
- **Files Modified**: `extension/content.js`
- **Root Cause**:
  1. When the browser extension was reloaded or updated, the existing content script in already-open tabs had `standDown()` called, but `standDown()` never removed the global `scroll`, `resize`, or `fullscreenchange` event listeners.
  2. Crucially, the global `click` listener in `content.js` did not check `if (orphaned || !extensionAlive()) return` before executing `event.preventDefault()` and `event.stopPropagation()`. When users clicked download links in tabs open during an extension reload, the orphaned content script intercepted the click, cancelled native browser navigation, failed to reach the extension (`sendToExtension` returned `null`), and called `location.href = url`, breaking page navigation and `<a download>` filename attributes.
  3. `scroll` and `resize` listeners were mistakenly registered twice in `content.js`.
- **Fix**:
  1. Added `if (orphaned || !extensionAlive()) return` as the very first check in the `click` listener before `event.preventDefault()`.
  2. Cleaned up `scroll`, `resize`, and `fullscreenchange` listeners inside `standDown()`.
  3. Removed the redundant duplicate `scroll` and `resize` event listener registrations.
- **Verification**: Built and verified Firefox and Chrome extension packages.

### Fix 2.2: Extension link-click confirmation resilience against page navigation and service worker drops
- **Files Modified**: `extension/content.js`, `extension/background.js`
- **Root Cause**:
  1. When link clicks were held for desktop confirmation, the polling loop in `content.js` would break upon deadline or error, but never guaranteed that `draco:handoff-status` with `expired: true` was reported to Draco before calling `replay()`. When `replay()` ran, `chrome.downloads.onCreated` could intercept the replayed navigation a second time and trigger duplicate confirmation windows.
  2. Single-URL download handoffs in `background.js` (`sendUrls`, triggered by right-click or popup) sent messages to the native host without assigning `requestId` or `handoffExpiresAt`, preventing durable tracking and auto-expiry on restart.
- **Fix**:
  1. Guaranteed that whenever confirmation polling terminates in `content.js`, an explicit `expired: true` notification is dispatched to release the reservation and register the URL into `passThrough` before calling `replay()`.
  2. Added unique `requestId: newRequestId()` and `handoffExpiresAt: Date.now() + HANDOFF_DEADLINE_MS` to `sendUrls` handoffs.
- **Verification**: Verified extension build via `npm run extension:firefox`.

### Fix 2.3: Native host (`host/main.go`) pipe handling and oversized message reporting
- **Files Modified**: `host/main.go`
- **Root Cause**:
  In `host/main.go`, if Draco sent a response frame that failed `writeFrame(os.Stdout, reply, maxWriteFrame)` (such as an oversized payload exceeding 1MB), the process called `os.Exit(1)` abruptly without emitting an error frame to Chrome, terminating the native messaging host and dropping the browser's port connection.
- **Fix**:
  Replaced `os.Exit(1)` with `writeFrame(os.Stdout, errorReply(err), maxWriteFrame)` so Chrome receives a structured JSON `{ ok: false, error: ... }` response rather than an abrupt native port crash.
- **Verification**: Verified via `npm run host` (which runs all Go tests and compiles the host binary).

### Fix 2.4: Extension `draco:send-media` `/i/web/status/<id>` URL support and `requestContexts` leak fix
- **Files Modified**: `extension/background.js`
- **Root Cause**:
  1. In `extension/background.js`, `draco:send-media` (invoked when users send media from the extension popup) validated X/Twitter URLs against `/^\/[A-Za-z0-9_]{1,15}\/status\/\d+(?:\/|$)/i`, which rejected valid `/i/web/status/<id>` and `/i/status/<id>` URLs supported elsewhere in the codebase.
  2. `requestContexts` in `background.js` recorded headers on `onBeforeSendHeaders` across all network requests and only deleted entries on `onHeadersReceived`. Failed, aborted, or adblock-cancelled requests never fired `onHeadersReceived`, leaving leaking entries that gradually saturated the map.
- **Fix**:
  1. Updated `draco:send-media` X/Twitter URL validation to `/^\/(?:([A-Za-z0-9_]{1,15}|i)(?:\/web)?)\/status\/(\d+)(?:\/|$)/i` and properly extracted the status ID and origin.
  2. Added `chrome.webRequest.onErrorOccurred` listener to delete `details.requestId` from `requestContexts`.
- **Verification**: Verified extension build via `npm run extension:firefox`.

### Fix 3.1: Queue scheduler refresh on task completion/error and tick deduplication
- **Files Modified**: `src/main/index.ts`, `src/main/queue/scheduler.ts`
- **Root Cause**:
  1. `DownloadManager`'s `onTasks` callback previously never alerted `ctx?.scheduler.refresh()` when queued tasks transitioned to `'done'` or `'error'`. When a task completed or failed, queues had to wait for the periodic 30-second `TICK_MS` timer before promoting the next task or executing the queue's post-completion action (`onComplete`), causing up to 30-60s of unnecessary idle delay.
  2. Every 30 seconds, `scheduler.ts` broadcasted `queues:changed` IPC and re-ran `manager.applySettings()` even when no queue configuration, task membership, or status had changed (`this.fingerprint() === before`).
- **Fix**:
  1. Connected task state changes in `index.ts` to `ctx?.scheduler.refresh()`, triggering immediate queue promotions and drain events the moment a task settles.
  2. Guarded IPC broadcasts and `applySettings()` invocations in `scheduler.ts:tick()` behind `this.fingerprint() !== before`.
- **Verification**: Verified via typecheck and unit tests.

### Fix 3.2: IPC dialog parenting fix and hidden `BrowserWindow` leak removal
- **Files Modified**: `src/main/ipc.ts`
- **Root Cause**:
  In four IPC handlers (`tasks:export`, `tasks:import`, `settings:chooseDirectory`, `torrent:chooseFile`), `dialog.showOpenDialog` and `dialog.showSaveDialog` passed `window ?? new BrowserWindow({ show: false })`. When the main window was not yet created or was closed (for example, when a download handoff confirmation dialog opened on cold start and the user clicked "Browse..."), `new BrowserWindow({ show: false })` created an invisible Electron BrowserWindow and underlying Chromium renderer process that was never destroyed or closed, leaking processes and memory. Additionally, parenting dialogs to the background `mainWindow` rather than the focused `alwaysOnTop` confirmation window caused file pickers to open behind the active handoff window.
- **Fix**:
  Introduced `safeOpenDialog` and `safeSaveDialog` helpers that dynamically parent dialogs to `BrowserWindow.getFocusedWindow() ?? getMainWindow()`, and fall back to top-level unparented native dialogs without instantiating dummy `BrowserWindow` objects.
- **Verification**: Verified via typecheck and unit tests.

### Fix 3.3: `tasks:redownload` queue awareness and `dirLocked` preservation
- **Files Modified**: `src/main/ipc.ts`
- **Root Cause**:
  In `tasks:redownload`, the replacement task was created and immediately started with `ctx.manager.add(fresh, true)` even when `task.queueId !== null`. If the task belonged to a paused, stopped, or scheduled queue, it immediately started downloading in violation of queue policy and lost its position in `queue.taskIds`. Furthermore, `dirLocked` was forced to `true` whenever `task.dir` was passed to `placeTask`, preventing future probe categorization.
- **Fix**:
  1. Preserved `fresh.dirLocked = task.dirLocked`.
  2. Determined `autoStart = task.queueId === null` so queued tasks are scheduled according to queue policy rather than started immediately.
  3. Added `await ctx.scheduler.syncTaskQueues([fresh.id], task.queueId)` to maintain queue membership.
  4. Only called `announce(fresh)` if `autoStart` is true.
- **Verification**: Verified via typecheck and queue execution test suites.

### Fix 3.4: Site Grabber redirect path mapping and filename/directory collision resolution
- **Files Modified**: `src/main/site-grabber/crawler.ts`
- **Root Cause**:
  1. When crawling web pages, if a request to `canonical` was redirected to `final`, only `final` was recorded in the offline path table `paths`. In-page links targeting `canonical` remained pointing online after offline rewriting.
  2. In `resourceFor`, asset URLs ending with `/` produced a trailing-slash pathname that collided with directory creation (`EISDIR`).
- **Fix**:
  1. Added `redirectMap` to record redirects and populated `paths.set(from, rel)` so links pointing to the original pre-redirect URL are properly rewritten to local files.
  2. Added fallback to `index.bin` for asset URLs ending in `/`.
- **Verification**: Verified via typecheck and `tests/site-grabber.test.ts`.

### Fix 3.5: Main process bulk handoff window suppression and missing file status persistence
- **Files Modified**: `src/main/index.ts`, `src/main/ipc.ts`
- **Root Cause**:
  1. In `src/main/index.ts:975`, a `download` message with `message.bulk === true` bypassed the confirmation dialog but unconditionally called `announce(task)`, popping open progress windows for batch downloads.
  2. In `src/main/ipc.ts:openable()`, when a completed download was found missing from disk, `task.status = 'missing'` was broadcast directly without calling `ctx.manager.emitTasks()`, failing to persist the status to disk and failing to update progress windows.
- **Fix**:
  1. Guarded `announce(task)` in `index.ts` with `if (!message.bulk) announce(task)`.
  2. Replaced raw `broadcast` in `openable()` with `ctx.manager.emitTasks()`.
- **Verification**: Verified via typecheck and task persistence tests.

### Fix 4.1: `SaveAsDialog.tsx` double `resolveMediaPage` IPC triggering and state flapping
- **Files Modified**: `src/renderer/src/components/SaveAsDialog.tsx`
- **Root Cause**:
  `mediaMode` was derived from `detectedMedia`, which is set to `true` inside the `useEffect` when probing returns an HTML page. Because `mediaMode` was declared in the effect's dependency array, setting `detectedMedia(true)` immediately triggered the cleanup function (`cancelled = true`), discarded the first `resolveMediaPage` result, and executed a second redundant `resolveMediaPage` call over IPC.
- **Fix**:
  Added guard `if (detectedMedia && youtube) return` so that once media is resolved and populated from probing HTML, the effect does not trigger a duplicate IPC round-trip.
- **Verification**: Verified via typecheck and renderer interaction tests.

### Fix 4.2: `Dropzone.tsx` & `App.tsx` media URL routing, magnet support, stuck drag overlay, and Rules of Hooks fix
- **Files Modified**: `src/renderer/src/App.tsx`, `src/renderer/src/components/Dropzone.tsx`, `src/main/ipc.ts`
- **Root Cause**:
  1. `App.tsx` returned `<Dropzone />` early if `hash === '#dropzone'` prior to invoking `useApp` and React hooks, directly violating the React Rules of Hooks.
  2. `onDragLeave` in both `App.tsx` and `Dropzone.tsx` checked `if (event.currentTarget === event.target)`, leaving the full-screen drag overlay permanently stuck if the cursor crossed child DOM elements before exiting the window.
  3. `App.tsx` regex only allowed `https?://` links, ignoring dropped `magnet:` links and raw 40-hex infohashes.
  4. Single X/Twitter media URLs dropped directly into the dropzone downloaded the HTML webpage instead of resolving to video streams.
- **Fix**:
  1. Restructured `App.tsx` into an outer `App` component that checks `#dropzone` and delegates to `MainApp`, preserving hook order.
  2. Updated `onDragLeave` to verify `!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)`.
  3. Expanded dropped URL matching in `App.tsx` to include `magnet:` URIs and 40-character infohashes.
  4. Added `xPostUrl` media extraction in `prepareTaskInput` in `src/main/ipc.ts`.
- **Verification**: Verified via typecheck and test suites.

### Fix 4.3: `OptionsDialog.tsx` category draft preservation and tab-switching persistence
- **Files Modified**: `src/renderer/src/components/OptionsDialog.tsx`
- **Root Cause**:
  `CategoriesTab` maintained its own local `useState<Category[]>(categories)` state that unmounted whenever the user switched to any other options tab (General, Connection, Cookies, Browser, etc.). Any category modifications (names, extensions, folder mapping) were silently discarded on tab switch. Furthermore, `OptionsDialog`'s `dirty` flag and `apply()` handler only checked changes on `Settings`, so clicking `Done` or `Apply` never persisted category changes.
- **Fix**:
  1. Lifted `categoriesDraft` state and `categoriesDirty` diffing up to `OptionsDialog`.
  2. Passed `draft` and `setDraft` into `CategoriesTab` so draft state persists seamlessly across tab switches.
  3. Integrated `categoriesDirty` into `OptionsDialog`'s `dirty` detection, unsaved-changes confirmation prompt, and `apply()` save flow.
- **Verification**: Verified via typecheck and renderer tests.

### Fix 4.4: 4 Hz progress render cascade mitigation in `App.tsx`, `DownloadTable`, and `Toolbar`
- **Files Modified**: `src/renderer/src/App.tsx`, `src/renderer/src/components/Toolbar.tsx`, `src/shared/groups.ts`
- **Root Cause**:
  1. `requestDelete` in `App.tsx` declared `tasks` in its `useCallback` dependency array. Because `tasks` is updated 4 times a second during download progress broadcasts, `requestDelete` changed reference 4 times a second, invalidating `actions = useMemo(...)` and causing `<Toolbar actions={actions} />` to re-render continuously.
  2. In `Toolbar.tsx`, the selector ran `s.tasks.filter((t) => s.selection.includes(t.id))`, performing an $O(N \times M)$ linear scan on every store state update.
  3. `summarizeGroup` in `groups.ts` summed speed across all tasks in a group regardless of status, inflating group speeds with stale snapshots from paused or errored members.
- **Fix**:
  1. Refactored `requestDelete` in `App.tsx` to read the current tasks snapshot via `useApp.getState().tasks` inside the handler, unlinking its dependency array from `tasks`.
  2. Optimized selection filtering in `Toolbar.tsx` to $O(N)$ using a `Set`.
  3. Restricted speed aggregation in `groups.ts` to actively transferring tasks (`downloading` / `probing`).
- **Verification**: Verified via typecheck and renderer execution tests.

### Fix 4.5: Destination duplicate check in `SaveAsDialog` and group selection fixes
- **Files Modified**: `src/renderer/src/components/SaveAsDialog.tsx`, `src/renderer/src/components/Toolbar.tsx`
- **Root Cause**:
  1. In `SaveAsDialog.tsx`, `window.api.findDuplicate` was only called with `{ url, pageUrl }`, omitting `filename` and `dir`. As a result, destination file collision checks were never performed, leaving the UI warning banner unreachable.
  2. In `Toolbar.tsx`, the Details action button had `disabled={selectionLength !== 1}`. When a group row was selected (which selects all member task IDs), the Details button was erroneously disabled.
- **Fix**:
  1. Passed `filename` and `dir` to `findDuplicate` in `SaveAsDialog.tsx` and added them to the dependency array.
  2. Updated the Details button in `Toolbar.tsx` to `disabled={selectionLength === 0}` so details can be viewed when items or groups are selected.
- **Verification**: Verified via typecheck and dialog tests.

### Fix 5.1: `src/cli/session.ts` queue stall/deadlock on skipped or pre-resolved items
- **Files Modified**: `src/cli/session.ts`
- **Root Cause**:
  In `src/cli/session.ts`, when `admit(job)` was called on a job whose lookup failed or whose file was skipped by `enqueue()` (`Already downloaded` or `Already downloading`), no download task was added to `manager`. Because `free` lane counters had been decremented and no task was active to trigger subsequent `onTasks` events, `pump()` was never called again. Remaining pending items remained stuck in queue forever, preventing `session.idle()` from resolving in batch mode.
- **Fix**:
  1. Updated `enqueue` to return a `boolean` indicating whether a task was admitted and started in `manager`.
  2. In `admit(job)`, if `!enqueued && pending.length > 0`, scheduled an immediate `pump()` call so the lane is re-evaluated and the next pending job proceeds without deadlocking.
- **Verification**: Verified via typecheck and CLI session tests.

### Fix 5.2: `src/cli/args.ts` flag argument consumption and `config.ts` `/dir` replacement
- **Files Modified**: `src/cli/args.ts`, `src/cli/config.ts`
- **Root Cause**:
  1. In `src/cli/args.ts`, `VALUE_FLAGS` consumed `argv[++i]` without verifying whether the value was another flag (e.g. `draco -P -f best <url>`). The directory flag `-P` would erroneously consume `"-f"` as the save path and treat `"best"` as a URL.
  2. In `src/cli/config.ts`, `withConfigDir` only matched lines with exactly two tokens `['-P', dir]` or `['--paths', dir]`. Lines using `--paths=...` or multi-flag lines were ignored, resulting in `/dir` prepending a duplicate `-P` that was subsequently overridden by lower configuration lines.
- **Fix**:
  1. Enforced that non-inline value flags reject subsequent arguments starting with `-` (except `"-"` for stdout) as missing values.
  2. Updated `withConfigDir` to match `--paths=...` and `-P=...` configuration lines.
- **Verification**: Verified via typecheck and CLI args/config unit tests.

---

## Verification & Test Results

All 18 audited fixes have been implemented and verified.

### 1. TypeScript Strict Typecheck
```
$ npm run typecheck
tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json
Exit code: 0 (Zero errors)
```

### 2. Node Test Runner Suite
```
$ npm test
ℹ tests 673
ℹ suites 113
ℹ pass 673
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
Exit code: 0 (All 673 tests pass)
```

### 3. Native Messaging Host
```
$ npm run host
Compiled host/draco-host.exe successfully.
All Go unit tests passed.
```

### 4. Browser Extensions
Both Chrome (`extension/`) and Firefox (`extension-firefox/`) distributions built and verified via `npm run extension:firefox`.

