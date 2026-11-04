# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Draco is a Windows-only download manager: Electron 43 + React 19 + TypeScript 7 + Tailwind v4, with a Go native-messaging host and an MV3 browser extension. It also ships a standalone `draco` CLI built on the same engine. Node ≥ 22.18 is required, because the engine and tests run as raw `.ts` through Node's type stripping.

## Commands

```bash
npm run dev            # electron-vite dev (HMR renderer)
npm run typecheck      # tsc for both projects: tsconfig.node.json + tsconfig.web.json
npm run build          # typecheck + generate extension-firefox/ + electron-vite build
npm test               # node --test "tests/**/*.test.ts" (pretest regenerates extension-firefox/)
npm run host           # go test + go build host/draco-host.exe (downloads Go into .build-cache/ if missing)
npm run runtime        # fetch the bundled runtime (yt-dlp, ffmpeg, node) into resources/runtime/
npm run pack           # unpacked electron-builder build in dist/
npm run dist           # NSIS installer + portable + CLI-only installer
npm run cli -- <url>   # run the CLI from source (bin/draco.mjs → src/cli/draco.ts, no build)
node tools/dl.ts <url> # bare engine harness: prints the live segment table, no Electron
```

Run a single test file or a single test by name:

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/journal.test.ts
```

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-name-pattern="strong ETag" "tests/**/*.test.ts"
```

Tests use `node:test` + `node:assert/strict` only, with no framework. A few tests read `extension-firefox/`, so run `npm run extension:firefox` first if you call `node --test` directly. Smoke checks against the packaged build: `smoke:profile`, `smoke:bridge`, `smoke:cli`, `verify:package`.

## Import conventions (these break things if ignored)

- Code under `src/main`, `src/cli`, `src/shared` and `tests` imports its siblings with **explicit `.ts` extensions** (`allowImportingTsExtensions`). That lets `node --test`, `tools/dl.ts` and `bin/draco.mjs` run source without a build. Don't drop the extensions.
- Path aliases: `@shared/*` → `src/shared` (main, preload, renderer); `@/*` → `src/renderer/src` (renderer only). Engine code that must run under plain Node uses relative paths like `../../shared/types.ts`, because Node doesn't resolve the aliases.
- Two TS projects: `tsconfig.node.json` (main, cli, preload, shared, tests) and `tsconfig.web.json` (renderer, preload, shared, with DOM). `src/shared` must typecheck under both, so it can't use Node or DOM-only APIs.

## Architecture

**Process layout (electron-vite, see `electron.vite.config.ts`).** The main build has three entries: `src/main/index.ts` (the app), `src/cli/run.ts` (the CLI as bundled into Draco.exe, launched by `resources/bin/draco.cmd`) and `src/cli/path-setup.ts` (run by the NSIS installer). The renderer has four HTML entries: `index` (main window), `splash`, `handoff` (the browser-handoff confirmation dialog) and `progress` (per-download progress window).

**Engine is Electron-free.** `src/main/engine/manager.ts` (`DownloadManager`) owns every task and its scheduling. It must not import Electron. The GUI wires it to IPC and the JSON store, while the CLI and `tools/dl.ts` wire it to a terminal. All of them drive the same engine. Runners implement `engine/runner.ts`:
- `engine/task.ts`: HTTP segmented transfer (`segmenter.ts` dynamic splitting, `ramp.ts` connection ramp-up, `journal.ts` crash-safe byte journal, `limiter.ts` shared speed/quota limiter)
- `hls/runner.ts`, `hls/dash.ts` (separate video+audio URLs), `dash/runner.ts` (MPD via ffmpeg), `engine/torrent.ts` (WebTorrent)
- Post-transfer work (checksum, mux, subtitles, security scan) goes through `finalization-pool.ts` / `postprocess.ts`.

`docs/ENGINE_SUPPORT.md` is the source of truth for what each runner actually guarantees on resume, checksums, caps, quotas and auth. Keep it accurate when you change runner behavior; it explicitly marks partial guarantees. Key invariant: HTTP resume and parallel ranges require a **strong ETag at one final URL**. Without one, the download restarts in a single stream. A changed ETag fails the task, and a new final URL invalidates the journal.

**IPC surface.** `src/preload/index.ts` is the renderer's only capability surface (no Node in the renderer). Handlers live in `src/main/ipc.ts` (plus a few in `index.ts`). `tests/contract-parity.test.ts` text-scans both files to check that every handler has a preload caller, every push has a subscriber, and the reverse of both. **Channel names must be string literals at every call site**, otherwise the scan misses them. Shared types (`RendererApi`, `DownloadTask`, `Settings`, …) are in `src/shared/types.ts`.

**Renderer.** React 19 + Zustand (`src/renderer/src/store/app.ts`). Progress reaches it as throttled diff updates of about 4 Hz, not as raw byte events. `tests/helpers/renderer-fixture.ts` esbuild-bundles components against a stub hook implementation, so renderer command logic is tested without a window. Stores and IPC calls in those tests are real code.

**Persistence.** `src/main/store.ts` is a JSON-file store in `%APPDATA%\Draco` (paths from `bootstrap/paths.ts`). Writes are atomic (temp file + rename, `json-file.ts`), and secrets are sealed via Electron safeStorage (`sealed-json.ts`, `electron-json-cipher.ts`). Everything loaded passes through `store-sanitize*.ts`.

**Browser bridge.** The pipeline is extension (`extension/`, Chromium MV3) → `host/draco-host.exe` (Go, stdlib-only) → Windows named pipe → `src/main/bridge/pipe-server.ts`.
- Wire format is Chrome's native-messaging framing: 4-byte LE length + UTF-8 JSON. `bridge/protocol.ts` defines and validates the messages, and the host relays frames without re-encoding them.
- The host must **never write anything to stdout except protocol frames**. On a cold start it launches Draco and waits for the pipe.
- The pipe is authenticated with a per-install secret in `%APPDATA%\Draco`, because the default pipe DACL isn't user-scoped. `bridge/admission.ts` decides whether Draco accepts a handoff.
- `extension-firefox/` is **generated** (gitignored) by `tools/build-firefox-extension.mjs`, which rewrites `chrome.` → `browser.`. Edit only `extension/`.
- `docs/BROWSER_TAKEOVER.md` covers the `downloads.ui` suppression and `onDeterminingFilename` handoff semantics, including the 10 s deadline.

**CLI (`src/cli/`).** It uses yt-dlp-style flags (`args.ts`) and reads default flags from `draco.cfg` (`config.ts`). The repo-root `draco.cfg` is gitignored; the installer sample is `resources/draco.cfg`. It has an interactive queue UI (`interactive.ts`, `terminal-view.ts`). Some yt-dlp-only options (`-S`, `--cookies`, embedding, …) hand the whole download to yt-dlp instead of the Draco engine. The CLI shares the managed yt-dlp/ffmpeg with the app but never its settings or task list.

**Site resolvers** live flat in `src/main/` (`youtube*.ts`, `twitter.ts`, `suno.ts`, `khinsider.ts`, `site-grabber/`). YouTube's Google media URLs use sequential ≤10 MiB chunks keyed on the signed URL identity (see ENGINE_SUPPORT.md).

## Repo notes

- `host/draco-host.exe` is committed. Rebuild it with `npm run host` after changing `host/main.go`, and run `go test ./...` from `host/` for the host's own tests.
- `docs/AUDIT_*.md` and `docs/audit/<date>/` are dated verification records. Treat them as history and don't edit them to match new behavior.
