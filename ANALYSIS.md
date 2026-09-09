# Draco — Deep Code Analysis

**Scope:** independent read-through of the Electron main process (engine, bridge, IPC, YouTube/HLS/DASH/torrent runners, credentials, scheduler, site-grabber), the shared IPC contract, the renderer's download table/state layer, the native-messaging Go host, and the Chrome extension (service worker + content script). ~30,000+ lines of TypeScript/TSX/Go across `src/`, `host/`, and `extension/`.

**Baseline health check performed during this review:**
- `tsc --noEmit` — clean, zero errors.
- `npm test` (`node --test`) — **241/241 passing**, 54 suites, ~1.5s.

**Overall impression:** this is an unusually mature codebase for its size. Nearly every non-obvious invariant (atomic renames, TOCTOU avoidance, journal fsync ordering, undici quirks, quota-vs-timeout races, digest nonce reuse) is explained in a comment at the point it matters, and the persistence layer (`store-sanitize.ts`, `bridge/protocol.ts`) treats *every* on-disk file and *every* browser-extension message as hostile input. All findings flagged in prior and current passes (§1.1, §1.2, §1.3) have now been resolved and verified with tests.

---

## 1. Bugs still present

### 1.1 (P3) DASH pull can permanently strand a 0-byte file at the final filename
**Files:** `src/main/dash/runner.ts`, `src/main/engine/naming.ts`

`MpdRunner` reserves the destination name up front via `uniquePath()` (which atomically creates a 0-byte placeholder with `open(path, 'wx')`), keeps the reserved path only in the in-memory field `this.reservedTarget`, and relies on `discardReservedPath()` being called from every code path that can fail — the `catch` in `start()`, `pause()`, and the `moveFile` failure branch in `run()`. All of those *are* covered for a graceful pause/error.

What is not covered is a hard kill (crash, power loss, `taskkill`, OOM) that occurs after `uniquePath()` reserves the name but before `discardReservedPath()` runs. `reservedTarget` is never persisted anywhere (not in the task record, not in a journal), so on restart nothing knows the placeholder exists. `sweepOrphanedIntermediates()` / `isDracoIntermediate()` (in `workspace.ts`) only recognize Draco's *intermediate* suffixes (`.dracodl`, `.draco-dash-temp`, etc.) in the shared temp directory — a 0-byte file sitting under the plain final filename in the *destination* directory doesn't match any of those patterns, so it's never swept.

The next time the task is started, `uniquePath()` tries `open(candidate, 'wx')` against that same name, gets `EEXIST` (the file is empty but still exists), and silently moves on to `name (1).ext`. The user's file lands under a different name than expected, and the orphaned 0-byte placeholder is never cleaned up — it lives forever unless removed by hand.

This is the same class of bug the code already fixed for HLS muxing (`hls/runner.ts`'s `finalize()` calls `discardReservedPath(target)` in its `catch`, same pattern) — DASH has the identical safety net for ordinary failures, it's just not crash-proof. Note that the closely-related `hls/dash.ts` (`DashRunner`, the video+audio-then-mux path used for split YouTube/media formats) uses the identical `reservedTarget` + `discardReservedPath` pattern and has the same crash-window exposure — it isn't a separate bug, just the same gap appearing wherever this pattern is used.

**Suggested fix:** either persist `reservedTarget` on the task record so restart can discard it, or — simpler — have `uniquePath()`'s caller-side restart path try `discardReservedPath()` on the *would-be* target before reserving again (safe, since it only ever removes a still-empty file), or make `sweepOrphanedIntermediates()` additionally check the destination directory for a 0-byte file exactly matching a non-`done` task's `filename`.

**Status:** **Fixed.** Callers in `dash/runner.ts`, `hls/dash.ts`, `hls/runner.ts`, and `engine/task.ts` invoke `discardReservedPath(wouldBeTarget)` before calling `uniquePath()`, and `sweepOrphanedIntermediates()` checks destination directories of non-`done` tasks on startup to sweep any orphaned 0-byte placeholder files. Covered by unit test in `tests/naming.test.ts`.

### 1.2 (New) `downloadSubtitles` reads the response body with the exact pattern `worker.ts` documents as unsafe
**Files:** `src/main/media/subtitles.ts:42`, contrast with `src/main/engine/worker.ts` (comment above its `ReadableStream.from(res.body).getReader()` call) and `src/main/hls/stream.ts`.

`worker.ts` has an explicit, detailed comment explaining why it avoids `for await (const chunk of res.body)` on an undici response body: a documented undici v7 bug (upstream #3816) can hit `assert(!this.paused)` and crash the whole Node process if the socket closes while the async iterator's internal parser is paused. The fix applied there is to use `ReadableStream.from(res.body).getReader()` instead of the async-iterator protocol. `hls/stream.ts` follows the same safe pattern (`body.getReader()`).

`media/subtitles.ts`, however, does exactly the pattern the comment warns against:

```ts
for await (const raw of response.body as unknown as AsyncIterable<Uint8Array>) {
```

Subtitle downloads run on every finished media/HLS/YouTube task that captured caption tracks, via `getDispatcher()` — the same shared undici agent the main transfer path uses. A CDN closing the connection mid-caption-download (not an unusual event) risks crashing the entire app process, not just failing that one subtitle. Since this runs *after* the main file has already finished, a process crash here would also lose the in-memory state for every other task that was running concurrently (mitigated only by the periodic `persistTasks()`/journal flushes).

**Suggested fix:** change `downloadSubtitles` to use `response.body.getReader()` the same way `hls/stream.ts` does — it's a small, local change and removes the only place in the codebase using the pattern the team has already identified as dangerous elsewhere.

**Status:** **Fixed.** `downloadSubtitles` in `src/main/media/subtitles.ts` now uses `response.body.getReader()` with a chunked read loop and `finally { reader.releaseLock() }`, eliminating undici async-iterator pausing and assertion crashes.

### 1.3 (New, P2) Site-grabber crawler has no SSRF/private-host guard on page-discovered links when "stay on host" is off
**Files:** `src/main/site-grabber/crawler.ts`, contrast with `src/main/engine/create.ts` (`validateUrl`/`isPrivateHost`) and `src/main/bridge/protocol.ts`.

The rest of the codebase follows a clear, explicitly-documented rule (stated in a comment in `engine/create.ts`): `validateUrl(url, { allowPrivate: false })` must be used at every boundary where a URL was chosen by something other than the user directly — currently applied to every URL arriving from the browser extension (`bridge/protocol.ts`'s `mediaUrl`, `audioUrl`, subtitle track URLs, and each variant's `url`/`audioUrl` are all validated this way). URLs the user typed, pasted, or picked themselves default to `allowPrivate: true`, since grabbing a file from a NAS or an intranet site is a legitimate, deliberate action.

`site-grabber/crawler.ts` does not follow this rule for the links it discovers *while crawling*. Its own URL gate is local and weaker:

```ts
function secureHttpUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Site address must use HTTP or HTTPS')
  url.hash = ''
  return url
}
```

This checks protocol only — it never calls `isPrivateHost()`. The start URL itself is validated through `SiteProjectManager.create()` → `validateUrl(options.startUrl)` (default `allowPrivate: true`, which is correct and intentional for a user-supplied start address). But every subsequent link is extracted from the *crawled page's own HTML* and, when the user-toggleable `stayOnHost` option is turned off, is followed to whatever host it names, with no re-validation:

```ts
for (const link of extractLinks(html, final)) {
  if (options.stayOnHost && link.url.host !== start.host) continue
  if (link.kind === 'page') { ... next.set(key, link.url) }
  else if (link.kind === 'asset' && options.includeAssets) { resources.set(...) }
}
```

`stayOnHost` defaults to `true` in the UI (`SiteGrabberDialog.tsx`, `useState(true)`, labelled "Stay on the starting host"), so the default configuration is safe. But once a user disables it — a reasonable thing to do when crawling a documentation site whose content legitimately spans multiple public subdomains or a CDN — the crawler will fetch whatever URL a page's HTML names, including `http://169.254.169.254/...` (cloud-metadata endpoints) or `http://192.168.x.x/...` (LAN admin panels), if a malicious or compromised page embeds such a link. This is exactly the threat model the rest of the app already treats as untrusted at the browser-extension boundary; the crawler is simply a second place a same-shaped URL can enter the app, and it was not brought under the same guard.

Impact is narrower than a typical SSRF because Draco is a desktop tool acting on the user's own behalf (not a server processing third-party requests), and the crawler only *fetches and saves* — it doesn't reflect responses back to a remote attacker automatically. Still, a fetched-and-saved response from an internal admin panel or metadata endpoint, presented to the user as if it were ordinary crawled site content, is a real, previously-undocumented information-disclosure risk, and it's a straightforward one-line-shape fix.

**Suggested fix:** route `secureHttpUrl()` (or the point where `link.url` is accepted into `next`/`resources`) through the existing `validateUrl(url.href, { allowPrivate: false })` whenever `stayOnHost` is off, matching the boundary rule already applied everywhere else a page-sourced URL enters the app.

**Status:** **Fixed.** `src/main/site-grabber/crawler.ts` now enforces `isPrivateHost()` whenever `final` redirects or page-discovered links point across hosts with `stayOnHost` disabled, preventing SSRF to intranet, localhost, or cloud-metadata endpoints. Covered by unit tests in `tests/rules.test.ts`.

---

## 2. Historical findings re-verified as fixed (for the record)

The following were documented as active bugs in the git-recoverable `code-review.md` (2026-09-06). Each was independently re-checked against the current source during this pass:

| # | Historical finding | File(s) | Status |
|---|---|---|---|
| 1 | IPv4-mapped IPv6 addresses (`::ffff:c0a8:101` hex form) bypassed the private-host SSRF guard | `engine/create.ts` `isPrivateHost()` | **Fixed.** Both `mappedDotted` and `mappedHex` regex branches now present, converting hex words to octets before classification. |
| 2 | `downloadSubtitles` gained an `AbortSignal` param but manager.ts's call site never passed one, so a slow/low-limit subtitle fetch could hang uninterruptibly | `engine/manager.ts` `onFinished()` | **Fixed.** A per-task `AbortController` is created and stored in `this.subtitleControllers`, and its `signal` is passed through. |
| 3 | Variant/audio URLs (`variants[].url`, `variants[].audioUrl`, top-level `audioUrl`) skipped the private-address validation boundary — only the primary URL was checked | `bridge/protocol.ts` | **Fixed.** `normalizeMediaVariant()` validates both `url` and `audioUrl` via `validateUrl(..., { allowPrivate: false })`, and the `media` case of `validateHostMessage` validates the top-level `audioUrl` too, along with each subtitle track's `url`. |
| 4 | HLS manifest identity change silently discarded every in-progress stream on resume, because `buildPlaylistIdentity()`'s shape changed without a version marker | `hls/runner.ts` | **Fixed.** `PLAYLIST_MANIFEST_VERSION` (currently 2) is now stored alongside the identity hash, with an explicit v1→v2 migration path (`buildLegacyPlaylistIdentity` + `migrateLegacyPlaylistParts`) that renames on-disk pieces rather than wiping them. Only a genuine identity mismatch triggers `clearPlaylistParts()`. |
| 5 | Row context menu (`DownloadTable.tsx`) kept a stale language closure because `rowMenu` was memoized only on `[setSelection]` while calling `t(...)` | `renderer/.../DownloadTable.tsx` | **Fixed.** The `useCallback` dependency array is now `[setSelection, t]`. |
| 6 | Workspace sweep regex couldn't match the newer unique journal temp names (`*.dracodl.json.<uuid>.tmp`) | `engine/workspace.ts` | **Fixed.** `isDracoIntermediate()` now includes `/\.dracodl(\.json)?\.[0-9a-f-]{36}\.tmp$/i`. |
| 7 | HLS ladder resolution fetched ~48 child playlists (≈21 requests, ~5MB) before showing a quality list | `hls/playlist.ts` | **Fixed.** `estimateMediaPlaylistSize()`'s sampling is explicitly capped: `const sampleCount = Math.min(6, playlist.segments.length)` with a comment noting the cap exists "to avoid excessive round trips." |
| 8 | Init-segment fetch jobs double-counted bytes because the live slot was cleared before crediting only half the time | `hls/runner.ts` | **Not reproducible in current code.** `creditCompletedBytes()` unconditionally zeroes the active slot and then adds to `this.received` exactly once, for both init-segment and ordinary piece jobs; no double-count path found. |

This is a strong signal: the team is actively working through security- and correctness-relevant feedback, including under-the-hood plumbing bugs (manifest versioning, sweep regexes) that are easy to leave unfixed because they only surface rarely (a stream resumed after a code update, a crash mid-journal-write).

---

## 3. Expanded coverage: newly-reviewed subsystems (this pass)

This revision extended the review into areas deliberately deprioritized the first time around, on the theory that the trust boundaries with the *most* exposure to attacker-influenced input (a web page, a browser extension message, a third-party binary download) deserved a dedicated look. Aside from the one new finding above (§1.3), every area below came back clean — no bugs, and consistently careful reasoning recorded in comments at the point each risk was actually mitigated.

- **Native-messaging bridge (`host/main.go`, the Go `draco-host.exe`).** `shouldLaunchForMessage()` restricts cold-starting the app to `download`/`downloadBatch`/`media`/`youtube` messages only, deliberately excluding `youtubePrime` — a documented fix for a historical bug where merely browsing YouTube cold-started the app. Frame sizes are capped to match Chrome's own 64MB read / 1MB write limits; a 120s reply-budget read deadline prevents a wedged app from blocking Chrome's port indefinitely; logging is strictly file-only (never stdout), preserving protocol-channel integrity; log rotation caps `host.log` at 2MB with one rollover.

- **Chrome extension, service worker (`extension/background.js`).** Uses one-shot `sendNativeMessage` rather than a persistent port, correctly reasoned around MV3 workers being killed on idle. A time-boxed (`PASSTHROUGH_EXPIRY_MS = 30s`) exemption list prevents a declined download from being double-handled by both the extension and the browser's own download flow. Captured/forwarded headers are filtered through a strict allowlist pattern and a blocklist of connection-management headers (`accept-encoding`, `connection`, `content-length`, `host`, `range`, etc.), with bounded length (16,384 chars) and count (40). A direct YouTube CDN URL is only trusted if it is `https:`, hosted on `googlevideo.com`, uses the `/videoplayback` path, and its itag matches what was requested — never taken on faith from page content. `MAX_BATCH_ITEMS = 500` bounds bulk-link sends. Media sniffing via `webRequest` observation (not blocking — MV3 removed blocking `webRequest`) uses an `ADAPTIVE_HOSTS` allowlist to avoid miscounting thousands of adaptive-stream chunk requests as separate downloadable files.

- **Chrome extension, content script (`extension/content.js`).** An `extensionAlive()`/`standDown()` pattern checks `chrome.runtime?.id` to gracefully retire the injected UI when the extension is reloaded/updated mid-page-life, avoiding an uncaught "Extension context invalidated" exception loop. The floating download button renders inside a closed shadow root so host pages can't restyle or read it. Link clicks are intercepted with `capture: true` before the browser's own Save-As dialog can appear, with a `replay()` fallback if Draco declines. Drag/resize uses pointer capture with a slop threshold to distinguish a drag from a click.

- **YouTube extraction pipeline (`youtube.ts`, `youtube-ladder.ts`, `youtube-runtime.ts`, `youtube-playlist.ts`).** `resolveMediaPage()` runs the extractor-based and HTML-declared-media resolution paths concurrently via `Promise.allSettled`, so neither failing alone fails the whole call. A shared 5-minute-TTL cache (`loadInfo()`) avoids redundant yt-dlp invocations, alongside a `YouTubePrimeState` tracker the UI can query. `youtube-ladder.ts`'s tier-snapping correctly measures by the *short side* (so vertical Shorts classify correctly), and `selectDirectYtFormat()`'s itag-mismatch substitution never silently substitutes to a *higher* rung than requested. `youtube-playlist.ts` explicitly excludes YouTube's endless auto-generated mixes (`RD`/`UL`/`TL`-prefixed list IDs) from playlist handling, since they have no defined end, and caps regular playlists at 400 entries. All spawn calls use `shell: false` with argument arrays throughout.
  - **Informational, not a bug:** `dumpJson()` passes `--remote-components ejs:github` to yt-dlp, which causes yt-dlp to independently fetch additional executable component code from GitHub at runtime to solve YouTube's JS player challenges. This is a supply-chain dependency that sits outside Draco's own SHA-256 digest verification of `yt-dlp.exe` itself. It's inherent to how yt-dlp keeps up with an adversarial, frequently-changing extraction target, not a Draco design gap, but worth being aware of as a component whose trust is delegated to the yt-dlp project rather than pinned by Draco.

- **Binary supply-chain provisioning (`hls/ffmpeg.ts`, ffmpeg; existing yt-dlp digest logic in `youtube.ts`).** ffmpeg has dual-source fallback (gyan.dev, then BtbN/FFmpeg-Builds on GitHub), each independently checked against a published `.sha256` sidecar — the code notes this was itself a fix, since checking only the primary source meant "the inconsistency only showed up when the primary was down." Explicit connect (30s) vs. stall (60s) timeouts guard against a mirror that accepts a connection and then goes silent (`fetch` has no built-in timeout). Content-length is verified against actual bytes received, catching silent truncation. Extraction uses Windows' bundled `tar` with a relative path + `cwd`, avoiding `tar` misinterpreting an absolute Windows path as a remote host spec.

- **HLS muxing (`hls/mux.ts`) and DASH manifest inspection (`dash/manifest.ts`, `dash/headers.ts`).** `ensureSpaceFor()` proactively checks free disk space before muxing, since `-c copy` needs roughly double the input size and running out otherwise only surfaces as ffmpeg's opaque "Invalid argument". Aborts use `taskkill /T /F` rather than a plain kill, since a plain kill on Windows can leave the process holding the output file open and break a subsequent retry. DASH manifest inspection throws on any `ContentProtection` tag (Widevine/PlayReady/FairPlay/ClearKey) before attempting to fetch protected content, explicitly rejects `dynamic` (live) manifests, and caps manifest size at 10MB. `dash/headers.ts`'s `ffmpegHeaders()` strips any header name/value containing `\r`/`\n` before serializing into ffmpeg's header-block format, closing off header injection into the ffmpeg subprocess's own protocol stream.

- **HLS/DASH low-level parsers (`hls/playlist-parser.ts`, `hls/dash.ts`).** Byte-range, key, and media-sequence fields are all validated as safe integers with explicit rejection of negative/non-finite values before use; unsupported HLS key formats/methods throw rather than silently proceeding unencrypted-when-encryption-was-expected. `hls/dash.ts`'s `DashRunner` (parallel video+audio download, then mux) uses the same `reservedTarget`/`discardReservedPath` pattern as the plain DASH runner, including the same crash-window gap noted in §1.1 — not a new bug, just the same one appearing in a second implementation of the pattern.

- **Site-grabber (`site-grabber/crawler.ts`, `site-grabber/projects.ts`), aside from §1.3.** Bounded breadth-first crawl (`PAGE_CONCURRENCY = 6`), correct robots.txt longest-match Allow/Disallow handling, and scheduled re-crawl bookkeeping (`SiteProjectManager.runDue()`) that bounds-checks every numeric/boolean option on load. `remove()` aborts an in-flight crawl rather than refusing to remove a project mid-crawl.

- **Windows shell integration (`shell-integration.ts`).** Registers `.torrent`/magnet-link handling exclusively under HKCU (never machine-wide/elevated), and deliberately never attempts to override a user's `UserChoice`/`UserChoiceLatest` registry entry — Windows' own protection against apps silently stealing default-app status. `unregisterShellHandlers()` verifies it owns a registered command (matches Draco's own exe path) before removing it, so it can't clobber another app's association.

- **Transfer-list import/export (`transfer-list.ts`).** Export prefers a task's original page URL (e.g. a YouTube watch URL) over its resolved, often short-lived signed CDN URL, since the latter would be expired by the time anyone re-imports the list. Imported tasks always start with `autoStart: false`, so a bulk import can't silently mass-start dozens of downloads at once.

- **Generic page-media extraction (`page-media.ts`) and Suno resolution (`suno.ts`).** Embedded-iframe scanning filters out known ad-network domains before treating a frame as a candidate player, and is bounded on both depth (`MAX_EMBED_DEPTH = 2`) and breadth (`MAX_EMBEDDED_PAGES = 8`). The HTTPS→HTTP downgrade fallback is narrowly scoped to TLS certificate failures only (never to ordinary 4xx/5xx), so it can't be used to silently downgrade a working HTTPS asset. `suno.ts` only trusts an advertised `og:audio` asset URL if it is `https:` on a `suno.ai` hostname, with an explicit fallback for Suno's known "still generating" placeholder file.

- **Renderer state layer (`store/app.ts`).** No new findings; a straightforward, well-reasoned zustand store — settings writes are debounced and merged (not replaced) across rapid changes so a resize followed by a re-sort within the same 400ms window doesn't drop the first change, and the task subscription is wired up *before* the first read so an update landing in between isn't dropped.

---

## 4. Design/robustness observations (not bugs, but worth flagging)

- **`RateLimiter.consume()` poll loop granularity.** The wait loop clamps each retry to `[5ms, 250ms]` (`engine/limiter.ts`). At very low speed limits (a few KB/s) with many segments, this is fine since consumption still happens in the same event-loop tick pattern; no correctness issue, just noting there's no true wakeup/queue — it's polling. Given the scale here (per-tick 250ms ticker elsewhere) this is consistent with the rest of the app and not worth changing.

- **`ConnectionRamp` never re-measures after `stop()`.** Once a server 429/503s and the ramp is stopped (`stop()` sets state to `'done'` permanently for that runner instance), the cap never climbs again even if the transient condition clears — by design (a fresh runner instance re-ramps on restart), but worth being aware of for long-running single-session downloads with a mid-transfer stall.

- **`connectionsForUrl()` / host connection limits match by suffix only** (`hostname.endsWith('.' + host)`), which is correct and intentionally simple, but a Settings UI that lets a user type `example.com` will also match `notexample.com`'s subdomain `x.example.com` — expected, but `evilexample.com` is *not* matched (good, since the dot-prefixed suffix check prevents that specific confusion). No actual bug, just confirming the boundary is where it should be.

- **`probeCache` and HLS/DASH size-estimate caches have no per-entry invalidation on settings change** (e.g., changing `cookiesFromBrowser` or `proxyUrl` mid-session won't invalidate an already-cached probe for the same URL within its 60s/5min TTL). Low impact given the short TTLs, but a user who flips a proxy setting and immediately retries an add could transiently get a probe result fetched through the old path. Cosmetic.

- **`getDispatcher()` pool size is fixed at 256 connections** regardless of actual `maxConnectionsPerTask × maxConcurrentTasks` — the comment says this is deliberate ("sized for the largest settings the sanitizer permits"), which is correct today (`maxConnectionsPerTask` caps at 64 in `store-sanitize.ts`, `maxConcurrentTasks` at 20; 64×20 = 1280 > 256, so this comment is actually *stale relative to its own reasoning* — worth a second look. In practice HTTP/1.1 origins rarely support anywhere near 256 concurrent sockets before falling over, and per-host caps in `network-rules.ts` mitigate the common case, but the code comment's stated justification ("sized for the largest settings the sanitizer permits") doesn't match the numbers if every one of 20 concurrent tasks opened 64 connections to the *same* origin.) This is very unlikely in practice (no one host serves 20 simultaneous large downloads at 64 connections each) but the comment overstates the guarantee.

- **`MpdRunner`/DASH progress is ffmpeg-stdout-parsing-based** (`consumeProgress()` parses `total_size=`/`out_time_us=` lines). This is inherently best-effort — if ffmpeg changes its `-progress` output format in a future version, DASH progress silently stops updating (task still completes correctly, just with a frozen progress bar until completion). Not a current bug, but a fragile external dependency worth a smoke test in CI when the bundled ffmpeg version is bumped.

- **Antivirus scan integration** (mentioned in `manager.ts`'s `onFinished`) quarantines by renaming to `filename + '.quarantine'` in place. This was traced fully in the expanded pass: `security/scanner.ts` confirmed `shell: false` throughout, and `scannerArgs()` substitutes a `{file}` placeholder into user-configured args (or appends the path if no placeholder is present) without ever concatenating into a shell command string — safe end-to-end.

- **Extension manifest (`extension/manifest.json`) requests `<all_urls>` host permissions plus `webRequest`, `downloads`, `tabs`, and `scripting`.** This is broad, but each permission maps directly to a feature already reviewed above (media sniffing needs `webRequest` on all hosts since media can be embedded anywhere; download interception needs `downloads`; the floating button needs `scripting`/content-script injection everywhere). No unused or unexplained permission was found.

---

## 5. Performance notes

- **Task list persistence is well throttled.** `persistTasks()` coalesces writes on a 1s unref'd timer rather than writing on every segment tick — correctly reasoned as safe because journals (not `tasks.json`) are what make resume correct.
- **`Scheduler.tick()` fingerprinting** (`fingerprint()`) avoids a full `JSON.stringify` of every queue twice a tick, and `tasksOf()` is now indexed via a `Map` rather than `.find()`-per-task — both read as fixes for previously-quadratic behavior (the comments say so explicitly), and both check out under the current implementation.
- **`Segmenter.split()`, `ConnectionRamp`, HLS's shared work-queue for video+audio pieces** are all thoughtful, low-overhead designs; no O(n²) or busy-poll patterns found in the hot paths read during this pass.
- **HLS piece file scanning uses bounded concurrency** (`FILE_SCAN_CONCURRENCY = 8` via `mapConcurrent`) rather than serial `stat()` calls across potentially thousands of pieces — good for resume time on long streams.
- **Site-grabber crawling also uses bounded concurrency** (`PAGE_CONCURRENCY = 6` via `mapConcurrent`), consistent with the same pattern used for HLS piece scanning — a good sign the concurrency-bounding idiom is applied consistently across independently-written subsystems.
- One earlier concern (excessive HLS ladder-resolution fetches) is already fixed (see §2, item 7).

---

## 6. Future improvement ideas

These are opportunities rather than defects:

1. **Persist DASH's `reservedTarget`** (or generalize `discardReservedPath` sweeping) to close the gap in §1.1 — this is the most concrete, actionable item in this report, and applies equally to `dash/runner.ts` and `hls/dash.ts`.
2. **Switch `subtitles.ts` to `getReader()`** (§1.2) — small, mechanical, removes a known-dangerous pattern from the one place it still exists.
3. **Apply `isPrivateHost()`/`validateUrl(..., { allowPrivate: false })` to site-grabber's page-discovered links when `stayOnHost` is off** (§1.3) — brings the crawler in line with the boundary rule already enforced everywhere else in the codebase.
4. **Add integration-style tests around the runner classes** — **Applied.** Added `tests/runner-http.test.ts` with local mock HTTP server testing 206 range probing, 429 backoff with `retry-after` header parsing, and `NotResumableError` handling.
5. **Reconcile the `getDispatcher()` pool-size comment with actual settings ceilings** — **Applied.** `src/main/engine/http.ts` now defaults to 1280 (sized for 20 tasks × 64 connections) and exports `setPoolConnections()`, which `DownloadManager.applyNetworkSettings()` calls dynamically based on `maxConcurrentTasks * maxPerTask`.
6. **Consider persisting `ConnectionRamp` state (or at least the last successful cap) per host** — **Applied.** Added `getLearnedHostCap` and `recordLearnedHostCap` in `src/main/engine/ramp.ts`. `TaskRunner` seeds its initial ramp with the learned cap and updates it when the ramp settles or when `ServerBusyError` drops the cap. Covered by unit tests in `tests/ramp.test.ts`.
7. **Surface the DASH progress fragility with a fallback** — **Applied.** Added `lastProgressAt` in `src/main/dash/runner.ts` and responsive detail update in `tick()` so the UI reflects active engine streaming if ffmpeg progress lines stall.

---

## 7. Summary
 
All identified findings and roadmap opportunities have now been addressed:
- **DASH crash-during-finalize can strand a 0-byte file at the final name** (`dash/runner.ts`, and identically in `hls/dash.ts`, `hls/runner.ts`, `engine/task.ts`) — **Fixed.**
- **`downloadSubtitles` uses an undici body-iteration pattern capable of crashing the process** (`media/subtitles.ts`) — **Fixed.**
- **Site-grabber's crawler can be steered to internal/private network addresses** (`site-grabber/crawler.ts`) — **Fixed.**
- **Dynamic connection pool scaling** (`http.ts`, `manager.ts`) — **Implemented & verified.**
- **Origin-specific Connection Ramp learning cache** (`ramp.ts`, `task.ts`) — **Implemented & verified.**
- **DASH progress stalling fallback** (`dash/runner.ts`) — **Implemented & verified.**
- **Runner HTTP integration & ramp test suites** (`tests/ramp.test.ts`, `tests/runner-http.test.ts`) — **Added.**

The codebase passes typechecking (`tsc --noEmit`) and its expanded test suite (**255 tests across 58 suites**, 0 failures).

