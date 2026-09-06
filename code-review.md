# Draco diff review

Date: 2026-09-06
Revision reviewed: working tree over `1259ae053ab28ce5ac717b029c0ec103c3e23f91`
Scope: the uncommitted working-tree diff — `extension`, `host`, `src/main`, `src/preload`, `src/renderer`, `src/shared`, `tests`. Roughly 2,100 added and 600 removed lines across 47 files.

`git diff main...HEAD` is empty; everything under review is uncommitted, so the diff was taken with `git diff HEAD`. This is a diff pass, not a whole-codebase audit — it asks whether the changes are correct, not whether the surrounding design is. No application code was changed.

Findings that overlap the previous audit are marked; the [2026-09-05 review](../2026-09-05/codebase-review.md) is the fuller treatment of those.

## Verification

- `npm run typecheck` — passed.
- `npm test` — 181 passed, 0 failed.
- `go test ./...` and `npm run build` were not run in this pass.

The suite does not cover the language-switch path, HLS resume across a manifest format change, or the private-address boundary for media variants, which is where the findings below sit.

## Findings

### P1 — Private IPv4-mapped IPv6 addresses still bypass the takeover SSRF check

Refs: [create.ts:165](../../src/main/engine/create.ts:165), [index.ts:565](../../src/main/index.ts:565), [index.ts:747](../../src/main/index.ts:747)

`isPrivateHost()` recognises IPv4-mapped IPv6 only in dotted form:

```ts
const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host)
```

WHATWG URL always serialises those hosts in hex, so the branch is unreachable. Confirmed under Node:

```
new URL('http://[::ffff:192.168.1.1]/').hostname  ->  [::ffff:c0a8:101]
new URL('http://[::ffff:7f00:1]/').hostname       ->  [::ffff:7f00:1]
```

Neither survivor matches `::1`, the `fc00::/7` or `fe80::/10` regexes, the dotted mapped regex, or the IPv4 octet regex, so the function returns `false` and `validateUrl(url, { allowPrivate: false })` accepts it. A page can hand the extension `http://[::ffff:7f00:1]:8080/` and have the app fetch loopback with the cookies the extension attached for that address.

This is the same bypass the 2026-09-05 review recorded as P2; the guard was moved into `create.ts` and applied at the message boundary, but the mapped-address case was not fixed.

Normalise the host to a canonical IP before classifying: expand the mapped hex form (`::ffff:7f00:1` → `127.0.0.1`) and reject on the resulting IPv4, rather than pattern-matching the textual form.

### P1 — The HLS manifest identity change silently discards every in-progress stream

Refs: [runner.ts:336](../../src/main/hls/runner.ts:336), [runner.ts:884](../../src/main/hls/runner.ts:884), [runner.ts:415](../../src/main/hls/runner.ts:415)

`buildPlaylistIdentity()` changed shape — `type` became `id`/`role`, and `label`, `language` and `isDefault` were added — and piece filenames changed with it, from `audio_NNNNNN.part` to `audio_000_NNNNNN.part`. Neither carries a version marker.

`run()` compares the stored identity against the freshly built one and, on any difference, wipes the parts directory:

```ts
const playlistIdentity = buildPlaylistIdentity(this.tracks)
const previousIdentity = await readPlaylistIdentity(this.manifestPath)
if (previousIdentity !== playlistIdentity) {
  await clearPlaylistParts(this.partsDir)
}
```

Every partially downloaded HLS task therefore fails the check on its first resume after this build and restarts from zero, discarding whatever is on disk — tens of gigabytes for a long stream. The renamed audio pieces would be re-fetched regardless, since `existingPieces()` matches on `^{track.id}_(\d{6})\.part$`.

`journal.ts` already solves this with `JOURNAL_VERSION`. Give the playlist manifest the same treatment: store a version alongside the identity, and on a version bump migrate the old piece names rather than clearing, or at minimum tell the user the stream is restarting.

### P2 — `downloadSubtitles` gained an abort signal that its only caller never passes

Refs: [manager.ts:466](../../src/main/engine/manager.ts:466), [subtitles.ts:20](../../src/main/media/subtitles.ts:20), [subtitles.ts:45](../../src/main/media/subtitles.ts:45)

The signature grew a `signal?: AbortSignal`, threaded into `fetch` and into `limiter.consume(chunk.length, signal)` with the comment that it exists so "a low speed limit cannot leave this stuck on 'Saving subtitles' with no way to interrupt it". The sole call site does not supply one:

```ts
const result = await downloadSubtitles(task, this.limiter, this.options.getSettings().timeoutMs)
```

So `consume()` still blocks in its token-bucket loop with `signal` undefined. With a 10 KB/s global cap and a large caption file the task sits on "Saving subtitles…" and neither Pause nor Remove interrupts it — the behaviour the change was written to fix.

Pass the runner's `AbortController.signal`, or a controller the manager owns per task and aborts from `pause`/`remove`.

### P2 — The private-address boundary skips media variants and `audioUrl`

Refs: [index.ts:747](../../src/main/index.ts:747), [protocol.ts:468](../../src/main/bridge/protocol.ts:468), [ipc.ts:989](../../src/main/ipc.ts:989)

The `media` handler validates the primary URL and each related playlist:

```ts
validateUrl(message.mediaUrl, { allowPrivate: false })
for (const relatedUrl of message.relatedMediaUrls ?? []) {
  validateUrl(relatedUrl, { allowPrivate: false })
}
```

`message.variants[].url`, `variants[].audioUrl` and `message.audioUrl` get no such check — `normalizeMediaVariant()` only confirms they parse as URLs. `recordMedia()` copies the variant array onto the candidate, the handoff window lists it, and `handoff:acceptMedia` → `placeTask` downloads the chosen entry with the captured cookies.

The current extension never populates `variants`, so this is a latent gap rather than a live path. It is still the same boundary two lines above, and the asymmetry is the kind that stops being latent the next time the extension grows a feature.

Apply `validateUrl(..., { allowPrivate: false })` inside `normalizeMediaVariant` and to `audioUrl`, so the guard lives with the parser rather than with one caller.

### P3 — The row context menu keeps the language it was created with

Refs: [DownloadTable.tsx:228](../../src/renderer/src/components/DownloadTable.tsx:228), [DownloadTable.tsx:293](../../src/renderer/src/components/DownloadTable.tsx:293), [i18n.ts:58](../../src/renderer/src/i18n.ts:58)

`rowMenu` is memoised on `[setSelection]` but now calls `t(...)`. `useT()` returns a fresh closure over `settings.language` on every render, so the memoised callback holds the translator from the render that created it.

Switching from English to Türkçe re-renders the table and translates the headings — `headerMenu` is a plain function, so it is fine — but right-clicking a row still shows "Download again", "Open", "Copy address" until the component remounts.

Add `t` to the dependency list, or read the language from the store inside the handler the way `rowsRef`/`queuesRef` already do for the other render-varying values.

Unrelated but adjacent: inside `rowMenu` the `running` computation shadows the translator with `const t = currentRows.find(...)`. It is confined to that arrow function and is not a defect, but it is a rename waiting to become one.

### P3 — Resolving an HLS candidate now costs megabytes and hundreds of round trips

Refs: [ipc.ts:828](../../src/main/ipc.ts:828), [playlist.ts:71](../../src/main/hls/playlist.ts:71), [playlist.ts:139](../../src/main/hls/playlist.ts:139)

Two new costs stack on the confirm dialog's critical path. `inspectHlsMedia()` runs for the primary URL plus up to twenty related ones, and each call loads a playlist and then fetches up to 256 KB of a segment to read its PAT/PMT. `estimateMediaPlaylistSize()` then samples up to 48 segments per playlist with ranged requests, for every variant and every distinct audio rendition, at concurrency 2 over variants.

On a page with a master playlist and twenty sniffed children that is ~21 playlist fetches, ~5 MB of segment prefixes, and several hundred ranged requests before a quality list appears. The previous code fetched one media playlist.

The bitrate reasoning behind the sampling is sound — `BANDWIDTH` really is unreliable — but it does not have to be synchronous with the dialog. Show the ladder from the manifest immediately and refine the sizes in the background, cap `sampleCount` far below 48, and skip `inspectHlsMedia` for playlists whose kind the master already states.

### P3 — A crash during a DASH pull strands a 0-byte file wearing the final name

Refs: [runner.ts:143](../../src/main/dash/runner.ts:143), [naming.ts:141](../../src/main/engine/naming.ts:141), [manager.ts:872](../../src/main/engine/manager.ts:872)

`uniquePath()` now reserves the name by creating the file with `open(candidate, 'wx')`, which is the right fix for the concurrent-naming race. `MpdRunner` reserves at the start of the pull and holds it for the whole transfer; only `pause()` and the error branch call `discardReservedPath()`.

A power loss or kill during a two-hour DASH download therefore leaves an empty `movie.mp4` in the download folder permanently. Nothing reclaims it: `sweepOrphanedIntermediates()` only reads `tempDir`, and `isDracoIntermediate()` would not match the name in any case. The next attempt reserves `movie (1).mp4` beside the empty original.

Reserve the name at the point the bytes are ready to move rather than at the start of the pull, or record reservations somewhere the startup sweep can see them.

### P3 — The workspace sweep cannot match the new unique journal temp names

Refs: [workspace.ts:33](../../src/main/engine/workspace.ts:33), [workspace.ts:95](../../src/main/engine/workspace.ts:95), [journal.ts:39](../../src/main/engine/journal.ts:39)

`writeJournal()` moved to unique temp names — `${path}.${randomUUID()}.tmp` — for a good reason, but `PART_SUFFIXES` still lists the old fixed `.dracodl.json.tmp`. A real temp file ends `.dracodl.json.<uuid>.tmp`, so `isDracoIntermediate()` returns false for it.

A kill between `writeFile` and `rename` leaves `foo.dracodl.json.3f2a….tmp` in `%APPDATA%/Draco/incomplete`. `removeJournal()` sweeps that family only when called with the exact journal path, i.e. while the task still exists; once the row is gone the startup sweep skips the file, and they accumulate across crashes — in the one directory the sweep was added to keep bounded.

Match the pattern rather than the literal: `/\.dracodl(\.json)?\.[0-9a-f-]{36}\.tmp$/` alongside the existing suffixes.

### P3 — The init-segment job leaves its bytes counted twice

Refs: [runner.ts:363](../../src/main/hls/runner.ts:363), [runner.ts:518](../../src/main/hls/runner.ts:518)

`fetchPiece()` clears the live slot before promoting bytes into the completed total, with a comment explaining exactly why:

```ts
const active = this.active.get(slot)
if (active) active.bytes = 0
this.received += bytes
```

The init-segment job does the second half without the first — it calls `this.received += bytes` and leaves `active.get(slot).bytes` holding the same amount. `tick()` computes `liveReceived = this.received + sum(active.bytes)`, so any tick in that window reports the init segment twice and produces a matching speed spike, until the worker's next `transfer()` calls `state.bytes = 0`.

Small and transient — init segments are typically well under a megabyte — but it is the same slot-clearing discipline, so it should be the same code. Factor the clear-then-credit step into a helper both paths call.

## Notes on changes that hold up

Worth recording, since several of these fix real defects and should not be second-guessed later:

- The `uniquePath()` move from `access()` to `open(…, 'wx')` closes a genuine TOCTOU window where two downloads finishing together were handed the same free name.
- `workspace.ts` centralising intermediate paths addresses the stranded-partial class of bug directly, and `intermediatePathsFor()` enumerating both the workspace and the destination is the right shape for cleaning up records written by older builds.
- The scheduler's `drained` latch is correct across modes: `finished` counts only `done` and exhausted-`error` tasks, and `releaseDrainedWithWork()` treats exactly those as non-work, so the latch cannot oscillate.
- Dropping `youtubePrime` from `shouldLaunchForMessage` in the host stops idle YouTube browsing from cold-starting the app.
- The `TaskRunner` stall check simplification is sound — nothing awaits between the `segmenter.complete` test and the `inflight.size === 0` test, so the removed `break` was unreachable.
- Removing `https:` from the main window's `img-src` is safe; every `<img>` in the renderer is fed a data URL over IPC.
