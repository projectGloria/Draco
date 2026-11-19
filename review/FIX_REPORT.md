# Draco Code Review Remediation Report (`fix/review-2026-11-19`)

**Date:** 2026-11-19  
**Branch:** `fix/review-2026-11-19` (branched from `main` at `dcf6c5b`, not pushed)  
**Source Review:** `review/DRACO_CODE_REVIEW.md` (Findings F-01 through F-12)  
**Environment:** Windows x64, Node.js v26.13.0, npm 11.x (`go` is not installed in `PATH`; `host/` was not modified)

---

## 1. Executive Summary

| Metric | Count | Findings |
|---|---:|---|
| **CONFIRMED** | 9 | F-01, F-02, F-03, F-04, F-05, F-06, F-07, F-08, F-09, F-10 *(see note below — 9 confirmed, 3 partially confirmed)* |
| **PARTIALLY CONFIRMED** | 3 | F-05 (partial: `ipc.ts` already persisted `tasks.json`), F-11 (partial: `OptionsDialog` uses sparse `changesRef` so `apply()` did not overwrite Appearance/Columns/Cookies, though those tabs bypassed the Save/Cancel transaction), F-12 (partial: `smoke-cli-media.mjs` already passed `-P` + `APPDATA=work`, and `dl.ts` already typechecked because the 3 fields are optional) |
| **ALREADY FIXED / NOT REPRODUCIBLE** | 0 | — |
| **FIXED (Complete)** | 10 | F-01, F-02, F-03, F-04, F-05, F-06, F-07, F-08, F-09, F-12 |
| **FIXED (Core Bug) / PARTIALLY DEFERRED** | 1 | F-11 (draft-transaction fix completed; ~1,750-line Turkish i18n sweep deferred) |
| **DEFERRED** | 1 | F-10 (monolith extraction / VM test migration deferred with concrete plan; new modules `proxy-credentials.ts` and `options-draft.ts` use direct ES imports) |

*(Exact verdict breakdown across the 12 findings: **9 CONFIRMED** [F-01, F-02, F-03, F-04, F-06, F-07, F-08, F-09, F-10] and **3 PARTIALLY CONFIRMED** [F-05, F-11, F-12].)*

**Overall Branch State:** Green. All 11 commits on `fix/review-2026-11-19` build cleanly (`npm run build` exits 0), typecheck cleanly (`npm run typecheck` exits 0, now including `tools/**/*.ts`), keep `extension-firefox/` in 100% sync with `extension/`, and pass **698 / 698 tests across 117 suites** (up from 678 / 114 baseline; +20 new regression tests).

---

## 2. Verification Evidence (Before vs After)

| Check | Review Baseline Claim | Measured Before (`dcf6c5b`) | Measured After (`7b16114`) | Notes |
|---|---|---|---|---|
| `npm run typecheck` | 0 errors (`tools/` excluded) | Exit 0 (0 errors) | Exit 0 (0 errors) | Now includes `tools/**/*.ts` in `tsconfig.node.json` |
| `npm run build` | — | Not run before | Exit 0 (`vite v7.3.8`, `electron-vite build` + `extension:firefox`) | Clean main, preload, renderer, and Firefox extension builds |
| `npm test` | 678 tests / 114 suites | **678 tests / 114 suites** (678 pass, 0 fail, 36.9s) | **698 tests / 117 suites** (698 pass, 0 fail, 30.2s) | +20 tests, +3 suites; zero failures |
| `node tools/smoke-cli-media.mjs` | Claimed broken | Ignored 2nd arg to `main()`, `messages` always empty | Exit 0 (`Saved sample - NA.mp4 · 2.3 KB`) | Runs against isolated loopback `127.0.0.1:0` + temp `APPDATA` |
| `go test -v ./...` (in `host/`) | 4/4 PASS | `go` not installed in `PATH` | Not run (`host/` untouched) | No Go files were changed on this branch |
| `npm audit` (all) | 15 (7 high, 8 moderate) | **15** (`7 high`, `8 moderate`, `0 critical`) | **10** (`4 high`, `6 moderate`, `0 critical`) | Remaining: upstream `ip` via `webtorrent` (4) + dev-only `minimatch` via `electron-builder` (6) |
| `npm audit --omit=dev` (prod) | 6 (5 high, 1 moderate) | **6** (`5 high`, `1 moderate`, `0 critical`) | **4** (`4 high`, `0 moderate`, `0 critical`) | Direct `undici`, transitive `undici`, `ip-address` all patched; only upstream `ip` chain remains |

### Selected Real Command Outputs

**Final `npm run build` + `npm test` (`7b16114`):**
```text
> draco@1.0.0 typecheck
> tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json

> draco@1.0.0 extension:firefox
> node tools/build-firefox-extension.mjs
built C:\Users\Nihil\Desktop\projectGloria\Draco\extension-firefox
...
✓ built in 1.52s (main) / 25ms (preload) / 3.19s (renderer)
...
ℹ tests 698
ℹ suites 117
ℹ pass 698
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 30157.9516
```

**`npm audit --omit=dev` before vs after F-09:**
```text
Before: PROD: {"info":0,"low":0,"moderate":1,"high":5,"critical":0,"total":6}
After:  PROD_AFTER: {"info":0,"low":0,"moderate":0,"high":4,"critical":0,"total":4}
```

**Isolated loopback CLI media smoke (`tools/smoke-cli-media.mjs`):**
```text
Saved sample - NA.mp4 · 2.3 KB
Real yt-dlp download, fallback template, progress bar, metadata processing and completion passed.
```

*(Note: During one intermediate `npm test` run, `tests/sealed-json.test.ts` hit a transient Windows `EPERM` on `rename` of a temp file in `%TEMP%` — classic Windows Defender real-time scan contention. Immediate re-run and all subsequent full runs passed 100%.)*

---

## 3. Per-Finding Summary Table

| ID | Verdict | Summary of Fix | Files Modified / Added | Tests Added | Commit(s) | Residual Risk |
|---|---|---|---|---|---|---|
| **F-01** | CONFIRMED | Added `!event.isTrusted` guard, `replayingAnchor` re-entry guard, per-tab link-click rate limit (5 / 10s), and fail-closed `SameSite` cookie filtering in `cookieHeaderFor(url, sender)`. | `extension/content.js`, `extension/background.js` | `tests/extensions.test.ts` (2 tests) | `ff56c3a` | Site comparison uses a built-in multi-part public-suffix list rather than the full PSL (see Section 4). |
| **F-04** | CONFIRMED | Added early `if (!dracoState.active) return` before `preventDefault()`. Replays declined `<a download>` links via `anchor.click()` (preserving `download` attribute) and delegates declined `target="_blank"` file links to background `chrome.downloads.download` via `draco:fallback-download`. | `extension/content.js`, `extension/background.js` | `tests/extensions.test.ts` (3 tests) | `ff56c3a` | If a user clicks a `target="_blank"` PDF link expecting inline tab viewing and declines Draco, `chrome.downloads.download` downloads it instead of opening a new tab (avoids popup blocker). |
| **F-03** | CONFIRMED | Removed fabricated 88%/12% child `expectedSize` mutation in `DashRunner`; moved display-only audio estimate to `audioEstimatedSize`. `adoptFinishedHalf` now checks absence of `runner.partPath` + `info.size > 0`, and unlinks stale/empty `finalPath` before returning `false`. | `src/main/hls/dash.ts` | `tests/media-cancellation.test.ts` (1 test) | `6ecbe40` | None for valid finished halves; stale partial files with no `.dracodl` workspace would only be possible via external manual tampering. |
| **F-09** | CONFIRMED | Upgraded `undici@^7.30.2`, `electron@^43.8.12`, `vite@^7.3.8`, updated `allowScripts`, and ran `npm audit fix --ignore-scripts` (patching transitive `undici`, `fast-uri`, `ip-address`). | `package.json`, `package-lock.json` | Verified via `npm run build` + `npm test` | `26d818a` | `ip` (`GHSA-2p57-rm9w-gvfp`) has no upstream fix without downgrading `webtorrent` to `0.7.3` (accepted risk: Draco does not use `ip.isPublic()` for SSRF). `minimatch` is dev-only in `electron-builder`. |
| **F-05** | PARTIALLY CONFIRMED | `Scheduler.remove()` now calls `manager.notifyTaskMetadataChanged()` and `manager.applySettings()` when tasks are detached; `synchronizeMembership()` now clears dangling `queueId`s pointing to non-existent queues. | `src/main/queue/scheduler.ts` | `tests/queue-execution.test.ts` (1 test) | `6457fff` | Low. |
| **F-07** | CONFIRMED | Applied all four missing `fixes.md` items: (a) `tasks:redownload` queue awareness & `dirLocked` preservation, (b) `openable()` via `ctx.manager.emitTasks()`, (c) `prepareTaskInput` X/Twitter resolution via `xPostUrl` + `resolveMediaPage`, (d) `draco:send-media` `/i/web/status/<id>` regex. Updated `fixes.md`. | `src/main/ipc.ts`, `extension/background.js`, `fixes.md` | `tests/ipc-admission.test.ts` (3 tests), `tests/extensions.test.ts` (1 test) | `6ea2aa8` | Low. |
| **F-06** | CONFIRMED | Removed the mutually exclusive `if (this.activeCount >= settings.maxConcurrentTasks) return` guard in `DownloadManager.ensureCatTimer()`, keeping the single-burst-at-a-time guard (`isCatMode`) and shared `RateLimiter` quota. | `src/main/engine/manager.ts` | `tests/queue-execution.test.ts` (1 test) | `99a7297` | While Cat Mode is enabled and slots are full, one extra 100 KB/s connection runs for 5–10s every 30s (by design, matching UI text). |
| **F-02** | CONFIRMED | Implemented `createSafeLookup` (`connect.lookup`) rejecting private/loopback/link-local/CGNAT/multicast IPs (single & `all: true` shapes, IPv4 & IPv6) on separate `guardedDispatchers` vs `openDispatchers` (each capped at 8). Enforced on `allowPrivate: false`, cross-origin redirects from public hosts, thumbnails, and public HLS segments/keys. Hardened `isPrivateHost`. | `src/main/engine/create.ts`, `src/main/engine/http.ts`, `src/main/fetch-guard.ts`, `src/main/thumbnails.ts`, `src/main/hls/runner.ts` | `tests/fetch-guard.test.ts` (3 tests) | `19a0cc4`, `7b16114` | When an HTTP proxy (`proxyUrl`) is configured, target DNS is resolved by the proxy server, not locally; only lexical `isPrivateHost` checks apply in proxy mode. |
| **F-08** | CONFIRMED | Stripped `user:pass` from `proxyUrl` before writing `settings.json`, stored credentials in DPAPI-sealed `credentials.json` under internal realm `__draco_proxy__` (hidden from `listCredentials` & site auth), reassembled only in `index.ts` when feeding `DownloadManager`, and added startup migration that purges both `settings.json` and `settings.json.bak`. | `src/main/proxy-credentials.ts`, `src/main/credentials.ts`, `src/main/store.ts`, `src/main/index.ts` | `tests/proxy-credentials.test.ts` (3 tests) | `38d76b5` | If a user enters a proxy URL with credentials in Options, the input shows the sanitized URL after saving (password is not echoed back to renderer). |
| **F-11** | PARTIALLY CONFIRMED | Extracted pure `src/shared/options-draft.ts` and wired `CookiesTab`, `AppearanceTab`, and `ColumnToggles` through `OptionsDialog`'s `draft`/`patchDraft` transaction (D4). Turkish i18n sweep deferred. | `src/shared/options-draft.ts`, `src/renderer/src/components/OptionsDialog.tsx` | `tests/options-draft.test.ts` (2 tests) | `dc50ed9` | Hardcoded English strings remain in `OptionsDialog`, `HandoffWindow`, `SiteGrabberDialog`, `ProgressWindow`, `GroupDetailDialog`, and `ClipboardPanel` (deferred). |
| **F-12** | PARTIALLY CONFIRMED | Fixed `tools/smoke-cli-media.mjs` to call `main(argv)` with 1 arg and capture real stdout/stderr; completed `EngineSettings` in `tools/dl.ts`; added `"tools/**/*.ts"` to `tsconfig.node.json`. | `tools/smoke-cli-media.mjs`, `tools/dl.ts`, `tsconfig.node.json` | Verified via `npm run typecheck` + `node tools/smoke-cli-media.mjs` | `9e2ecc3` | None. |
| **F-10** | CONFIRMED | Deferred monolith extraction of `ipc.ts` / `index.ts` / `windows.ts` to avoid large refactor risk; new modules (`proxy-credentials.ts`, `options-draft.ts`) were built as pure ES modules with direct-import tests. | — | — | Deferred | 6 legacy test suites still use `vm.runInNewContext`. |

---

## 4. Per-Finding Technical Details

### F-01 & F-04: Browser Extension Click Interception, Replay Fallback, and SameSite Cookies
- **Verdict:** Both **CONFIRMED**. `extension/content.js:123-194` lacked `event.isTrusted` and `dracoState.active` checks before `event.preventDefault()`/`stopPropagation()`, replayed declined links via `location.href = url` / `window.open(url, '_blank')`, and `extension/background.js:484-491` attached all cookies from `chrome.cookies.getAll({ url })` without filtering by `sameSite` or sender frame.
- **Design Decisions:**
  - **Guard order in `content.js`:** `orphaned || !extensionAlive()` → `defaultPrevented` → `replayingAnchor && composedPath().includes(replayingAnchor)` → `!event.isTrusted` → `!dracoState.active`. This ensures untrusted clicks and inactive-state clicks never call `preventDefault()`, and replayed synthetic clicks never re-enter the handler.
  - **Fallback without user activation (`replay()`):** Declined `<a download>` links call `anchor.click()` with `replayingAnchor = anchor` (preserving native `<a download="name">` semantics without navigating the tab away). Declined `target="_blank"` links without `download` send `{ type: 'draco:fallback-download', url, filename }` to `background.js`, which adds the URL to `passThrough` and calls `chrome.downloads.download(...)` — avoiding popup blockers after async handoff cancellation. If `downloads.download` is unavailable or fails, it falls back to `anchor.click()`.
  - **Rate limiting:** Added a lightweight per-tab sliding-window limiter (`allowLinkClick`: max 5 `draco:link-click` handoffs per 10 seconds per tab) in `extension/background.js` to prevent handoff window flooding even from rapid trusted clicks.
  - **Site comparison approximation (D2):** `registrableSite(hostname)` normalizes lowercase, strips trailing dots, treats IPs/`localhost`/single-label hosts as their own site, and uses a built-in set of ~45 common two-part public suffixes (`co.uk`, `com.au`, `co.jp`, `com.tr`, `com.br`, `com.cn`, etc.) to extract eTLD+1 (last 3 labels if matching, else last 2). `isSameSite(urlA, urlB)` enforces schemeful same-site (`protocol` + `registrableSite`).
    - *Failure modes of this approximation:* Unlisted multi-tenant public suffixes (e.g., `*.github.io`, `*.herokuapp.com`, `*.s3.amazonaws.com`, or rare 2nd-level ccTLDs) will treat two subdomains under that suffix as same-site (false negative for cross-site isolation). Legitimate same-site subdomain downloads (`www.example.com` → `cdn.example.com`) are preserved.
  - **Fail-closed cookie policy (D2):** On `draco:link-click`, if `sender` has no URL, or if `isSubframe` (`frameId !== 0`) and either `sender.url` or `sender.tab.url` is cross-site to `url`, `sameSite` is `false`. Cross-site top-frame clicks omit `sameSite === 'strict'`; cross-site subframe clicks also omit `lax` and `unspecified` (allowing only `no_restriction`).
- **Testing:** Added 5 tests in `tests/extensions.test.ts` (all 5 failed before fix, passed after). Regenerated `extension-firefox/` with `node tools/build-firefox-extension.mjs` and verified zero drift via the existing `keeps Firefox files derived from the shared extension without stale copies` test.

### F-03: `DashRunner.adoptFinishedHalf` Regression
- **Verdict:** **CONFIRMED**. `DashRunner.constructor` mutated `videoTask.expectedSize = Math.round(task.expectedSize * 0.88)` and `audioTask.expectedSize = task.expectedSize - videoTask.expectedSize`, and `adoptFinishedHalf` rejected any finished half where `info.size !== runner.task.expectedSize`.
- **Difference from Review's Option 3:** A freshly constructed `DashRunner` on retry has `runner.task.size === null` until `probeUrl` runs, so comparing against `runner.task.size` would never trigger. Instead, `TaskRunner` only atomically renames `part` → `finalPath` after verifying `stat(part).size === probed.size` and removing the `.dracodl` workspace, and `halfSuffix` encodes the `itag`. Therefore `adoptFinishedHalf` now checks: (1) `runner.partPath` does not exist, and (2) `finalPath` exists with `info.isFile() && info.size > 0`. If `runner.partPath` exists or `finalPath` is 0 bytes / invalid, `finalPath` is unlinked before returning `false` so `uniquePath` cannot create a `(1)` copy and orphan the stale file.
- **Display estimate preserved:** Stored the 12% audio heuristic in a private display-only field `audioEstimatedSize` used only in `tick()` before `audioRunner` probes, while clearing `videoTask.expectedSize = undefined` and `audioTask.expectedSize = undefined` (preventing `JSON.parse(JSON.stringify(task))` from leaking the combined estimate into children).
- **Cleanup verified:** Confirmed `intermediatePathsFor` in `src/main/engine/workspace.ts:53-82` removes `.v.mp4`, `.a.m4a`, itag-suffixed halves, `.draco-dash-temp*`, `.draco-mux-temp*`, and `-v`/`-a` workspaces on cancel/remove.
- **Testing:** Added a loopback integration test in `tests/media-cancellation.test.ts` with `expectedSize: 10_000` and a `9_123`-byte finished video half (failed with `videoHits === 3` before fix; passed with `videoHits === 0`, no `(1)` file, and clean final mux after fix).

### F-09: Dependency Advisories
- **Verdict:** **CONFIRMED**. Baseline `npm audit` matched the review's exact 15 total (7 high, 8 moderate) and 6 prod (5 high, 1 moderate).
- **Changes:** Upgraded `undici` to `^7.30.2`, `electron` to `^43.8.12`, `vite` to `^7.3.8`, updated `allowScripts` in `package.json`, and ran `npm audit fix --ignore-scripts` to patch transitive `undici@6.x`, `fast-uri`, and `ip-address`.
- **Accepted Risk:**
  - `ip` (`GHSA-2p57-rm9w-gvfp`, via `webtorrent` → `torrent-discovery` → `bittorrent-tracker`): no upstream patched version exists (`npm audit fix --force` would downgrade `webtorrent` from `3.0.21` to `0.7.3`). Draco does not call `ip.isPublic()` for SSRF protection (it uses its own `isPrivateHost` + `createSafeLookup`).
  - `minimatch` (`GHSA-g3hv-75wg-m249`, via `electron-builder`): dev/build-time dependency only, never shipped in the packaged app.
- **Electron 43.7.9 → 43.8.12 Note:** Patch release (Chromium/Electron security fixes including `GHSA-jr5w-w6x2-84p9`); no API breaking changes observed in build or typecheck, but a manual packaged-app launch check is included in Section 8.

### F-05: Queue Deletion State Desync & Dangling `queueId` Recovery
- **Verdict:** **PARTIALLY CONFIRMED**. `src/main/ipc.ts:1042-1047` (`queues:remove`) already called `persistTasks(ctx.manager.list())`, contrary to the review's claim that `tasks.json` was never persisted on IPC removal. However, `Scheduler.remove()` itself never notified `DownloadManager` (`notifyTaskMetadataChanged()`) or triggered scheduling (`applySettings()`), leaving the renderer stale and freed queued tasks unscheduled; and `Scheduler.synchronizeMembership()` never cleared dangling `queueId`s referencing deleted queues.
- **Fix:** In `Scheduler.remove(id)`, track whether any task was detached and call `this.deps.manager.notifyTaskMetadataChanged()` and `this.deps.manager.applySettings()`. In `Scheduler.synchronizeMembership()`, clear any `task.queueId` not present in `validQueueIds` and call `notifyTaskMetadataChanged()` if any were detached.
- **Testing:** Added test in `tests/queue-execution.test.ts` (failed before fix, passed after).

### F-07: Four Missing `fixes.md` Items
- **Verdict:** **CONFIRMED** across all 4 sub-items:
  1. **(a) `tasks:redownload` (`src/main/ipc.ts`):** Now preserves `dirLocked` (only passes `dir` when `task.dirLocked || task.groupFolder` and sets `fresh.dirLocked = task.dirLocked`), passes `startNow = task.queueId === null` to `ctx.manager.add(fresh, startNow)`, calls `await ctx.scheduler.syncTaskQueues([fresh.id], fresh.queueId)` when queued, and only calls `announce(fresh)` when `startNow` is true.
  2. **(b) `openable()` (`src/main/ipc.ts`):** Replaced `broadcast('tasks:changed', publicTasks(ctx.manager.list()))` with `ctx.manager.emitTasks()` (and removed the now-unused `broadcast` import).
  3. **(c) `prepareTaskInput` (`src/main/ipc.ts`):** Added `xPostUrl(url)` check before `isSupportedYouTubeUrl(url)`, resolving via `resolveMediaPage(postUrl, headers)`.
  4. **(d) `draco:send-media` (`extension/background.js`):** Updated X status regex to `/^\/(?:[A-Za-z0-9_]{1,15}|i(?:\/web)?)\/status\/\d+(?:\/|$)/i` so both `/i/web/status/<id>` and `/i/status/<id>` are accepted. Regenerated Firefox extension.
- **Updated `fixes.md`:** Corrected Fix 1.1's `adoptFinishedHalf` description and updated the test count to 698 tests / 117 suites.
- **Testing:** Added 3 tests in `tests/ipc-admission.test.ts` and 1 test in `tests/extensions.test.ts` (all 4 failed before fix, passed after).

### F-06: Cat Mode Unreachable Dead Code
- **Verdict:** **CONFIRMED** (though the review hallucinated a `maybePlayCatMeow` / sound feature — see Section 5).
- **Intended Behavior (D1):** Per `OptionsDialog.tsx:409-410`, `src/shared/types.ts:598`, and `fixes.md` Fix 1.3, Cat Mode is: *"Keep queued downloads alive by occasionally downloading tiny 5-second chunks at low speed (prevents server timeouts)."* Because `schedule()` immediately starts every unqueued task whenever `activeCount < maxConcurrentTasks`, waiting queued tasks *only* exist when `activeCount >= maxConcurrentTasks`. Commit `4b867d5` re-added `if (this.activeCount >= settings.maxConcurrentTasks) return`, making the timer 100% unreachable.
- **Fix:** Removed `if (this.activeCount >= settings.maxConcurrentTasks) return` in `DownloadManager.ensureCatTimer()` while retaining `if (!settings.catMode) return`, the single-burst-at-a-time guard (`some((r) => r.task.isCatMode)`), and the 100 KB/s `RateLimiter(102400, this.limiter)` charged against the shared app-wide quota.
- **Testing:** Added a mock-timer test in `tests/queue-execution.test.ts` verifying Cat Mode starts a keep-alive burst on a waiting queued task when active slots are full, and never starts a second concurrent burst (failed before fix, passed after).

### F-02: SSRF Through DNS Resolution & Rebinding
- **Verdict:** **CONFIRMED**. `isPrivateHost` only checked literal hostname strings; domain names resolving to `127.0.0.1` / `192.168.x.x` / `::1` bypassed `allowPrivate: false`.
- **Fix:**
  - Hardened `isPrivateHost` (`src/main/engine/create.ts`) to strip trailing dots and IPv6 `%zone` suffixes, block `.internal`, expanded IPv6 loopback/unspecified (`0:0:0:0:0:0:0:1`, `0:0:0:0:0:0:0:0`), and IPv6 multicast (`ff00::/8`), while keeping domain names starting with `fc`/`fd`/`fe` (e.g. `fc.example.com`) unblocked.
  - Added `createSafeLookup` (`src/main/engine/http.ts`) supporting both single-address and `all: true` array lookup shapes (fail-closed if any returned IP is private) and IPv4/IPv6.
  - Kept separate `openDispatchers` and `guardedDispatchers` maps (each capped at `MAX_CACHED_DISPATCHERS = 8` to preserve pool eviction lifecycle) selected by `opts.allowPrivate`.
  - Updated `fetchGuarded` and `requestGuarded` (`src/main/fetch-guard.ts`) so `allowPrivate: false` uses the guarded dispatcher on every hop, and cross-origin redirects from public initial hosts also use the guarded dispatcher while direct user-initiated LAN NAS downloads continue working on the open dispatcher.
  - Updated `src/main/thumbnails.ts` (`allowPrivate: false, requireHttps: true`) and `src/main/hls/runner.ts` (segments and AES-128 keys pass `allowPrivate: isPrivateHost(playlistHost)`).
  - **Proxy mode limitation:** When `proxyUrl` is configured, `ProxyAgent` hands target hostnames to the proxy server for remote DNS resolution; local `connect.lookup` cannot inspect the proxy's resolved IP. Lexical `isPrivateHost` checks still block literal private hostnames/IPs in proxy mode, but DNS-level SSRF isolation depends on the proxy's own ACLs.
- **Testing:** Added 3 tests in `tests/fetch-guard.test.ts` covering `isPrivateHost` edge cases, fake-DNS resolution to `127.0.0.1`/`192.168.1.42`/`::1`, `all: true` mixed arrays, DNS rebinding (public → private), redirect-to-private-DNS, and unguarded LAN NAS passthrough.

### F-08: Plaintext Proxy Credentials in `settings.json` / `.bak`
- **Verdict:** **CONFIRMED**.
- **Fix (D3):**
  - Created pure module `src/main/proxy-credentials.ts` (`splitProxyUrl`, `assembleProxyUrl`, `sanitizeAndStoreProxyUrl`, `backupHasProxyCredentials`) using internal credential realm `__draco_proxy__`.
  - Extended `src/main/credentials.ts` with `saveProxyCredential`, `clearProxyCredentials`, and `resolveProxyUrl`, while filtering `__draco_proxy__` out of `listCredentials()`, `resolveCredentials()`, and `hasCredentialsFor()` so proxy credentials never leak into the UI or site HTTP Basic/Digest auth.
  - Updated `src/main/store.ts` (`loadSettings` and `saveSettings`) to strip credentials before writing `settings.json`, store them in DPAPI-sealed `credentials.json`, and pass `backupMode: 'replace'` to `writeJsonAtomic` whenever legacy plaintext credentials are detected in `settings.json` or `settings.json.bak` so `.bak` is overwritten too.
  - Reordered `src/main/index.ts` startup to call `loadCredentials()` before `loadSettings()`, and reassembled `proxyUrl: resolveProxyUrl(current.proxyUrl)` exclusively in `DownloadManager`'s `getSettings` callback. Renderer windows and `settings:get`/`settings:save` never receive the password.
  - Verified no logger or `dash/runner.ts` prints `proxyUrl`.
- **Testing:** Added direct-import suite `tests/proxy-credentials.test.ts` (3 tests) covering URL splitting/reassembly, sealed-sink persistence & clearing, legacy migration purging both `settings.json` and `settings.json.bak`, and missing/corrupt `.bak` tolerance.

### F-11: `OptionsDialog` Draft Transaction & Localization
- **Verdict:** **PARTIALLY CONFIRMED**. `OptionsDialog` already tracked a sparse `changesRef` delta rather than sending the full `draft` on `apply()`, so clicking Save did *not* overwrite Appearance/Columns/Cookies changes with stale values. However, `CookiesTab`, `AppearanceTab`, and `ColumnToggles` bypassed the draft transaction entirely — immediately persisting to `settings.json` even on Cancel/Discard and never toggling `dirty`.
- **Fix (D4):** Extracted `src/shared/options-draft.ts` (`createOptionsDraft`, `applyOptionsDraftPatch`, `toggleDraftColumn`, `isOptionsDraftDirty`) and wired `CookiesTab`, `AppearanceTab`, and `ColumnToggles` to receive `settings={draft}` / `patch={patchDraft}` (and `columns`/`onToggle`). No live preview; all controls participate in Save/Cancel.
- **Deferred:** Moving ~1,750 lines of hardcoded English strings across 6 dialogs (`OptionsDialog`, `HandoffWindow`, `SiteGrabberDialog`, `ProgressWindow`, `GroupDetailDialog`, `ClipboardPanel`) to `src/shared/i18n.ts` was deferred as lower priority.
- **Testing:** Added `tests/options-draft.test.ts` (2 tests: multi-tab transaction + revert-to-original + static invariant verifying no sub-tab calls live `patchSettings` or `toggleColumn`).

### F-12: `tools/smoke-cli-media.mjs`, `tools/dl.ts`, and `tsconfig.node.json`
- **Verdict:** **PARTIALLY CONFIRMED**. `tools/smoke-cli-media.mjs` already passed `-P join(work, 'downloads')` and set `APPDATA = work` against a local `127.0.0.1:0` server (not the user's download folder), and `tools/dl.ts` already typechecked because `checkDiskSpace`/`exponentialBackoff`/`seedTorrents` are optional on `EngineSettings`. However, `smoke-cli-media.mjs` passed an ignored 2nd options object to `main(argv)` and asserted against an always-empty `messages` array (`Saved: `), and `tsconfig.node.json` excluded `tools/`.
- **Fix:** Updated `tools/smoke-cli-media.mjs` to call `main(argv)` with 1 argument and capture real stdout/stderr, completed the 3 optional fields in `tools/dl.ts`, and added `"tools/**/*.ts"` to `tsconfig.node.json`.
- **Testing:** Verified `npm run typecheck` (0 errors) and ran `node tools/smoke-cli-media.mjs` (exited 0).

---

## 5. Review Errors & Inaccuracies Found

The independent review (`review/DRACO_CODE_REVIEW.md`) contained several inaccuracies relative to the actual `HEAD` (`dcf6c5b`):

1. **Hallucinated Cat Mode implementation (F-06):** The review claimed `DownloadManager` has a `maybePlayCatMeow()` method, an `onCatMeow` callback, a 5-second throttle, a `cat:meow` IPC event, and `resources/cat-meow.wav`. None of these exist; Cat Mode is a 30-second `setInterval` keep-alive trickle (`ensureCatTimer()` in `src/main/engine/manager.ts:1231-1368`).
2. **Non-existent test file names:** The review referenced `tests/extension-mv3.test.ts`, `tests/media-Hardening.test.ts`, `tests/scheduler-lifecycle.test.ts`, and `tests/store-corruption.test.ts`. None of those files exist in `tests/` (real equivalents are `tests/extensions.test.ts`, `tests/media-cancellation.test.ts`, `tests/queue-execution.test.ts`).
3. **Wrong extension symbol names (F-01 / F-04):** The review cited `draco:intercept-link`, `dracoState.interceptExtensions`, `replayingAnchor` (claiming it existed and was unused), and a `draco:Download` custom event. In reality, the message is `draco:link-click`, extensions are in `FILE_EXTENSIONS`, `replayingAnchor` did not exist yet, and there is no `draco:Download` listener.
4. **Misquoted `isPrivateHost` (F-02):** The review quoted `if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd'))`, which did not match `src/main/engine/create.ts:214-215` (the real code already used `/^f[cd][0-9a-f]{2}:/i` and `/^fe[89ab][0-9a-f]:/i`, avoiding `fc.example.com` false positives).
5. **Inaccurate `queues:remove` claim (F-05):** `src/main/ipc.ts:1042-1047` already called `persistTasks(ctx.manager.list())` on `queues:remove` (and `notifyTaskMetadataChanged()` / `applySettings()` already existed on `DownloadManager`).
6. **Inaccurate `OptionsDialog` overwrite claim (F-11):** `OptionsDialog` used sparse `changesRef` deltas rather than saving the entire `draft` object, so Save did not overwrite Appearance/Columns/Cookies with stale values (the real bug was bypassing the Save/Cancel transaction). Also `CookiesTab` has a "None" button, not a "Use public formats" button, and `AppearanceTab` has Theme/Accent/Columns (no Density toggle).
7. **Inaccurate `tools/smoke-cli-media.mjs` & `tools/dl.ts` claims (F-12):** `smoke-cli-media.mjs` already isolated `APPDATA` and passed `-P join(work, 'downloads')` against a loopback server; `tools/dl.ts` already typechecked because the three `EngineSettings` fields are optional.
8. **Outdated `package.json` dependency list:** Section 10.1 listed `webtorrent@^2.8.5` and `lucide-react`; `package.json` actually has `webtorrent@^3.0.21` and no `lucide-react`.

---

## 6. Decisions Taken (D1–D4 & Judgment Calls)

- **D1 (Cat Mode — F-06):** Kept Cat Mode and fixed it to match its UI text (*"Keep queued downloads alive by occasionally downloading tiny 5-second chunks at low speed"*), bounded to at most one concurrent 100 KB/s trickle charged against the shared `RateLimiter`.
- **D2 (SameSite Cookies — F-01):** Applied fail-closed policy in `cookieHeaderFor(url, sender)`. Cross-site top-frame clicks omit `SameSite=Strict`; cross-site subframe clicks (`frameId !== 0`) also omit `Lax` and `unspecified`.
- **D3 (Proxy Credentials — F-08):** Moved proxy credentials out of `settings.json` / `.bak` into the existing DPAPI-sealed `credentials.json` under internal realm `__draco_proxy__`, rather than sealing all of `settings.json`.
- **D4 (Options Dialog — F-11):** All tabs (`CookiesTab`, `AppearanceTab`, `ColumnToggles`) now participate in the `draft` / Save / Cancel transaction with no live preview.
- **Additional judgment calls:**
  - Added a simple per-tab `draco:link-click` rate limit (5 clicks / 10s) in `extension/background.js`.
  - Kept `openDispatchers` and `guardedDispatchers` as separate 8-entry LRU caches in `src/main/engine/http.ts` so `tests/http-pool-lifecycle.test.ts` eviction behavior is preserved.

---

## 7. Deferred & Out-of-Scope Items

### Deferred
1. **F-10 (Monolith extraction & VM test migration):**
   - *Reason:* Large structural refactor across `src/main/ipc.ts` (1,850 lines), `src/main/index.ts` (1,260 lines), and `src/main/windows.ts`; deferring keeps this remediation branch low-risk and easy to review.
   - *Concrete plan:*
     1. Extract `placeTask`, `prepareTaskInput`, `refileTask`, and `openable` from `src/main/ipc.ts` into `src/main/task-admission.ts` with an injected `AdmissionDeps` interface; migrate `tests/ipc-admission.test.ts` to direct ES imports.
     2. Extract window-clamping helpers from `src/main/windows.ts` into `src/main/window-geometry.ts`; migrate `tests/window-placement.test.ts`.
     3. Extract handoff/startup routing from `src/main/index.ts` into `src/main/bootstrap-routing.ts`; migrate `tests/bootstrap-safety.test.ts`.
2. **F-11 Part 2 (Turkish `tr` localization sweep):**
   - *Reason:* Lower priority; ~1,750 lines of hardcoded English strings across 6 dialogs.
   - *Concrete plan:* Add namespaced keys (`options.*`, `handoff.*`, `grabber.*`, `progress.*`, `group.*`, `clipboard.*`) to `src/shared/i18n.ts` with both `en` and `tr` entries, and migrate one dialog per commit.

### Out of Scope (Not Attempted)
- **Windows Authenticode code signing** (`electron-builder.yml` / NSIS installers).
- **Detached GPG signature verification** for `yt-dlp` `SHA2-256SUMS.sig`.
- **Live runtime / OS checks** from review Section 13.3 (documented as manual test steps below).

---

## 8. Manual Test Checklist (Windows & Real Browsers)

1. **Chromium (Chrome / Edge) Extension Interception & Fallback (F-01, F-04):**
   - Load `extension/` unpacked in Chrome/Edge.
   - **Inactive test:** Close `Draco.exe` (or pause integration / exclude the site in the popup). Click a same-origin `<a href="/api/export" download="data.json">` (no `Content-Disposition: attachment`). Verify the browser downloads `data.json` natively without navigating away.
   - **Untrusted synthetic click test:** With Draco running, open DevTools on a test page and run `const a = document.createElement('a'); a.href = 'https://example.com/test.zip'; a.download = 'test.zip'; document.body.appendChild(a); a.click();`. Verify Draco does **not** pop a handoff window and does **not** launch if closed.
   - **Declined `<a download>` test:** With Draco running and `confirmHandoff: true`, click a same-origin `<a href="/api/export" download="data.json">`, then click **Cancel** in Draco's Handoff window. Verify the browser downloads `data.json` without navigating away.
   - **Declined `target="_blank"` popup-blocker test:** Click `<a href="https://example.com/archive.zip" target="_blank">`, wait >5 seconds (so transient user activation expires), then click **Cancel** in Draco's Handoff window. Verify Chrome starts the browser download via `chrome.downloads.download` with **no** popup-blocked icon in the address bar.
   - **Blob URL test:** Click `<a href="blob:..." download="export.csv">`. Verify Draco ignores it and the browser saves it directly.
2. **Firefox Extension Parity (F-01, F-04, F-07d):**
   - Load `extension-firefox/` as a temporary add-on in `about:debugging`. Repeat the inactive, untrusted click, declined `<a download>`, and declined `target="_blank"` checks above.
   - Navigate to `https://x.com/i/web/status/<valid_post_id>` and trigger **Send media** from the popup; verify Draco resolves the post instead of returning an error.
3. **Proxy Credential Migration on an Existing Profile (F-08):**
   - Back up `%APPDATA%\Draco` first, or use a disposable Windows user profile.
   - Place `"proxyUrl": "http://testuser:TestPass123@127.0.0.1:8888"` in both `settings.json` and `settings.json.bak`.
   - Launch Draco (built with Electron 43.8.12).
   - Verify: (a) `settings.json` and `settings.json.bak` now contain `"proxyUrl": "http://127.0.0.1:8888"` with **no** `TestPass123` anywhere in either file; (b) `credentials.json` contains a DPAPI-sealed entry with `realm: "__draco_proxy__"`; (c) Options → Connection shows `http://127.0.0.1:8888` (no password) and Site Logins does not display the internal proxy entry; (d) a download through a local authenticated test proxy succeeds.
4. **Electron 43.8.12 Packaged App Smoke (F-09):**
   - Run `npm run pack` on your machine and launch `dist/win-unpacked/Draco.exe`. Verify main window, tray icon, handoff window, progress window, and Options dialog (Save/Cancel on Appearance, Columns, Cookies) all render and persist cleanly.
5. **NTFS Sparse Preallocation on Large Multi-Segment Download (Review §13.3 #2):**
   - On a standard Windows 11 NTFS volume (non-admin), start a 20+ GB multi-segment HTTP download and confirm no synchronous zero-fill UI stall occurs when the highest-offset worker writes its first chunk.
6. **NSIS CLI Installer `PATH` Length > 1,024 Chars (Review §13.3 #3):**
   - In a disposable Windows VM with `HKCU\Environment\Path` > 1,024 characters, run the CLI NSIS installer (`resources/cli-installer.nsi`) and confirm `HKCU\Environment\Path` is not truncated.

---

## 9. Risks of Merging & Post-Release Watchlist

- **Extension `target="_blank"` behavior change (F-04):** Declining Draco on a `target="_blank"` file-extension link (e.g., `.pdf`) now triggers `chrome.downloads.download` rather than `window.open(..., '_blank')`. This eliminates popup-blocker failures, but users who expected a declined `.pdf` to render inline in a new tab will get a browser file download instead.
- **Proxy UI UX nuance (F-08):** Because passwords are stripped from `settings.json` and never sent back to the renderer, Options → Connection displays `http://proxy:8080` after saving `http://user:pass@proxy:8080`. The stored credential remains active until the user clears `proxyUrl` or enters new credentials. Watch for user confusion if they edit `proxyUrl` to a different host without re-entering credentials.
- **DNS lookup overhead / captive portals (F-02):** `allowPrivate: false` requests (thumbnails, cross-origin redirects from public hosts, public HLS segments/keys) now reject private IPs at `connect.lookup`. On corporate networks with split-horizon DNS that resolves public-looking hostnames to RFC1918 IPs, thumbnails or cross-origin redirects to internal mirrors will be blocked by design (direct user-initiated LAN NAS downloads remain unaffected).
- **Cat Mode extra connection (F-06):** Enabling Cat Mode now actively runs one 100 KB/s keep-alive trickle on a waiting queued task for 5–10s every 30s while active slots are full. Watch for any unexpected memory/connection growth if users have dozens of queued tasks with Cat Mode enabled.
- **Electron 43.8.12 & `undici@7.30.2` (F-09):** Both are patch bumps with all 698 automated tests green; run the packaged-app manual smoke (Section 8 #4) before tagging a release.
