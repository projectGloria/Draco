# Repository Guidelines

## Project Structure & Module Organization

Draco is a Windows-only Electron download manager. Electron main-process code,
the download engine, IPC, and browser bridge live in `src/main/`; shared API
types are in `src/shared/types.ts`. The React/Zustand renderer is in
`src/renderer/src/`, with entry HTML files in `src/renderer/`. `src/preload/`
defines the renderer's only privileged API surface. The Chrome MV3 extension is
in `extension/`, and the Go native-messaging host is in `host/`. Keep generated
artifacts in `out/` and `dist/` out of source changes. Node tests live in
`tests/`; command-line diagnostics are in `tools/`.

## Build, Test, and Development Commands

- `npm run dev` starts Electron Vite with renderer hot reload.
- `npm run build` type-checks and builds production output into `out/`.
- `npm run typecheck` runs both Node and web TypeScript projects without output.
- `npm test` runs all `node:test` suites; run one with `node --experimental-strip-types --test tests/segmenter.test.mjs`.
- `npm run pack` creates an unpacked Windows build; `npm run dist` creates Windows installers.
- `npm run host` builds `host/draco-host.exe` (requires Go).

## Coding Style & Naming Conventions

Use the existing TypeScript style: two-space indentation, single quotes, no
semicolons, and descriptive camelCase identifiers. React components use PascalCase
file names (for example, `DownloadTable.tsx`); test files use `*.test.mjs`.
There is no linter, so run `npm run typecheck` before submitting. Preserve each
file's line endings—some renderer and configuration files are CRLF.

Use `import type` for `@shared/types`. Modules loaded by Node tests or `tools/`
must remain Electron-free and use relative runtime imports with explicit `.ts`
extensions; Node does not resolve TypeScript path aliases.

## Testing Guidelines

Write focused `node:test` cases alongside related suites in `tests/`, naming
tests by the behavior they protect. Add coverage for edge cases and regressions,
especially for downloader state, parsing, scheduling, and input validation. Keep
Electron-dependent code behind small Electron-free helpers when it needs unit
tests.

## Commit & Pull Request Guidelines

History currently contains only terse `V` commits, so use concise imperative
subjects instead, such as `Fix resume journal reconciliation`. Keep commits
single-purpose. Pull requests should explain user-visible behavior, list tests
run, link relevant issues, and include screenshots for renderer or extension UI
changes. Never commit `extension/key.pem`, downloaded binaries, or generated
build output.
