# AGENTS.md — Draco

Draco is a Windows-only download manager and standalone CLI built with Electron, React, TypeScript, and a Go native-messaging host. Node.js 22.18+ is required for source TypeScript and tests. Release CI uses Node.js 26.

## Commands

- Install dependencies with `npm ci`. Start the Electron dev app with `npm run dev`.
- Run all tests with `npm test`. It regenerates the Firefox extension before running Node's test runner.
- Run one file with `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/journal.test.ts`. Run `npm run extension:firefox` first when running extension-dependent tests directly.
- Run `npm run typecheck` for both TS projects or `npm run build` to typecheck, generate the Firefox extension, and bundle the app.
- Run `npm run host` to test and rebuild the Go bridge. Run `go test ./...` from `host/` for host tests alone.
- Run `npm run runtime` to fetch bundled Node.js, yt-dlp, and ffmpeg. Run `npm run pack` to build the unpacked Windows application in `dist/win-unpacked/`.
- Run `npm run dist:cli` for the local standalone CLI installer. `npm run dist` runs the legacy local NSIS, portable, and CLI packaging scripts.
- Run the source CLI with `npm run cli -- https://example.com/file.zip` or the engine harness with `npm run dl -- https://example.com/file.zip`.
- For packaged checks, use `npm run smoke:profile`, `npm run smoke:bridge`, `npm run smoke:cli`, and `npm run verify:package`.

## Architecture

- `electron.vite.config.ts` bundles `src/main/index.ts`, the embedded CLI entry `src/cli/run.ts`, and the legacy NSIS PATH helper `src/cli/path-setup.ts`. It builds the main, splash, handoff, and progress renderer windows.
- `src/main/engine/manager.ts` owns tasks and scheduling shared by Electron, the CLI, and the engine harness. `src/main/engine/runner.ts` defines the runner contract. `src/main/engine/finalization-pool.ts` and `src/main/engine/postprocess.ts` handle post-transfer work.
- `src/main/ipc.ts` and `src/main/index.ts` register Electron IPC. `src/preload/index.ts` exposes renderer capabilities using contracts from `src/shared/types.ts`. The Zustand renderer store is `src/renderer/src/store/app.ts`.
- `src/main/store.ts` persists settings and task state under the profile resolved by `src/main/bootstrap/paths.ts` (normally `%APPDATA%\Draco`). JSON writes are atomic, loaded settings are sanitized, and secrets use Electron safeStorage.
- `extension/` hands off through `host/draco-host.exe` to the authenticated Windows named pipe in `src/main/bridge/pipe-server.ts`. `src/main/bridge/protocol.ts` and `src/main/bridge/admission.ts` handle protocol validation and handoff admission.
- `bin/draco.mjs` launches the source CLI in `src/cli/draco.ts`. The CLI reads flags from `draco.cfg` (sample `resources/draco.cfg`), maintains separate settings and tasks, and delegates yt-dlp-only features to yt-dlp.
- Site resolution lives in `src/main/youtube.ts`, `src/main/twitter.ts`, `src/main/suno.ts`, `src/main/khinsider.ts`, and `src/main/site-grabber/`.
- **Version Manifests:** Keep `package.json`, both root version fields in `package-lock.json`, and `gloria.toml` in sync. `extension/manifest.json` carries the browser extension's independent version.

## Personal Rules (Brain)

- **Commit Format:** Use one plain sentence stating what changed and why. Omit conventional-commit prefixes.
- **Path Privacy:** Use `C:\Users\you` in documentation, comments, and examples.
- **Git Branching:** Work directly on `main` until explicitly told otherwise. Branches and worktrees require explicit instruction.
- **Versioning (Minimal Changes):** For runtime or packaging changes to an alpha version, increment the alpha number once per uncommitted change set. Check `git diff HEAD` for a prior bump. Docs-only and read-only work skips version bumps.
- **Versioning (Major/Minor Changes):** Ask for the exact target before changing major or minor versions or removing `-alpha` for breaking or major feature work.
- **Window Chrome:** Use integrated frameless chrome with a drag region, double-click maximize, and custom window controls.
- **Desktop Shell Lock:** Keep the shell at `100vw x 100vh` with `overflow: hidden`, internal scrolling, and `user-select: none` on UI chrome.
- **Scrollbars:** Use themed 4–6 px scrollbars with transparent tracks and zero layout shift.
- **Interactive Controls:** Style all form controls with explicit hover, active, focus-visible, and disabled states and 120–180 ms transitions.

## Playbooks (Read Before Task)

- **Packaging:** Read `.brain/building-the-project.md` before packaging, compiling release binaries, or building an installer.
- **Release automation:** Read `.brain/github-actions.md` before editing workflow YAML, setting up release automation, or preparing a first release push. Follow Draco’s release workflow below for this repo.

## Repo Guardrails & Gotchas

- **Commit & Push Policy:** Commit, tag, or push only on explicit request. Keep `main` free of force pushes. For a requested commit and push, verify tests, build, and any applicable app version bump and push `main` to `origin/main`. A commit-and-push request does not authorize a release tag.
- **Release Workflow:** Dispatch `.github/workflows/release.yml` from `main`. The workflow builds `dist/win-unpacked/` and uploads it as the `app` artifact. The shared GloriaSetup jobs validate the version and manifest, pack and verify the installer, and publish the GitHub Release and matching tag.
- **Source Imports:** Preserve explicit `.ts` extensions on relative imports in main, CLI, shared and tests. Code run by plain Node uses relative paths. The bundler maps `@shared/*` to `src/shared/` and renderer-only `@/*` to `src/renderer/src/`.
- **TypeScript Boundary:** Keep shared code compatible with both `tsconfig.node.json` and `tsconfig.web.json`. Keep the shared engine Electron-free and renderer capabilities behind preload.
- **IPC Channels:** Use string literals at channel call sites so `tests/contract-parity.test.ts` can match handlers, calls, and event subscriptions.
- **HTTP Resume:** Byte-journal resume and parallel ranges require a strong ETag at the same final URL. Without one, restart in a single stream. A changed ETag fails the task and a new final URL invalidates the journal.
- **Runner Guarantees:** Update `docs/ENGINE_SUPPORT.md` when runner behavior changes. The provider-specific YouTube path uses sequential chunks of at most 10 MiB bound to the exact signed URL.
- **Browser Bridge:** Keep host stdout reserved for native-messaging frames (4-byte little-endian length plus UTF-8 JSON). Rebuild the tracked `host/draco-host.exe` with `npm run host` after Go host changes.
- **Extension Source:** Edit `extension/` and regenerate `extension-firefox/` with `npm run extension:firefox`. Consult `docs/BROWSER_TAKEOVER.md` for takeover behavior and its 10-second deadline.
- **Audit Records:** Preserve dated `docs/AUDIT_*.md` and `docs/audit/` records as historical evidence.

## Done Criteria

- Run `npm test` and `npm run build` for runtime changes. For Go bridge changes, run `npm run host`. For package changes, build with `npm run pack` and run the relevant packaged checks listed above.
- When the application version changes, check all app version fields against one another and verify any authorized release tag matches the package version with a leading `v`.

<!-- brain-sync: 6e57cfeb21b1 -->
