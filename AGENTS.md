# Repository Guidelines

## Project Structure & Module Organization

Draco is a Windows-focused Electron download manager. Main-process code, the download engine, IPC, and browser integration live in `src/main/`. Shared contracts are in `src/shared/types.ts`; privileged renderer access is isolated in `src/preload/`. The React/Zustand UI is under `src/renderer/src/`, with page entry files in `src/renderer/`. Browser extensions live in `extension/` and `extension-firefox/`, while `host/` contains the Go native-messaging host. Put automated tests in `tests/`, utilities in `tools/`, and static images in `resources/`. Treat `out/`, `dist-v2/`, and compiled host binaries as generated artifacts.

## Build, Test, and Development Commands

- `npm run dev` starts Electron Vite with renderer hot reload.
- `npm run typecheck` checks the Node and web TypeScript projects.
- `npm run build` type-checks and builds production files into `out/`.
- `npm test` runs all Node test suites.
- `node --experimental-strip-types --test tests/segmenter.test.mjs` runs one suite.
- `npm run host` builds `host/draco-host.exe` and requires Go.
- `npm run pack` creates an unpacked app; `npm run dist` builds the Windows installer.

## Coding Style & Naming Conventions

Follow the existing TypeScript style: two-space indentation, single quotes, no semicolons, and descriptive `camelCase` names. Use `PascalCase` for React components and filenames such as `DownloadTable.tsx`; use kebab-case for focused non-component modules such as `destination-path.ts`. Prefer `import type` for type-only dependencies. Electron-free modules used by tests or `tools/` should retain explicit `.ts` relative imports. No linter is configured, so `npm run typecheck` is the required static check.

## Testing Guidelines

Tests use Node's built-in `node:test` runner with `node:assert/strict` and follow `*.test.mjs`. Name cases by observable behavior. Add regression and edge-case coverage for parsing, path handling, downloader state, scheduling, and validation. Keep testable logic outside Electron-dependent modules where practical. Run `npm test` before submitting.

## Commit & Pull Request Guidelines

Recent history uses terse version markers (`V`, `V1`), but new commits should use concise imperative subjects, for example `Fix resume journal reconciliation`. Keep each commit single-purpose. Pull requests should describe user-visible behavior, list verification commands, link relevant issues, and include screenshots for renderer or extension UI changes. Do not commit `extension/key.pem`, generated builds, downloaded tools, or local `.dracoTemp/` data.
