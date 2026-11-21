# GloriaSetup rollout

Please check:

- Build: Electron app. CI runs `electron-builder --win --dir` and copies `dist/win-unpacked` (Draco.exe, resources, runtime, bridge host, extension) into `app-dist/`. Not built locally.
- Version: `gloria.toml` has 1.1.1 (package.json); the tag overrides it at pack time. The workflow still fails if the tag differs from package.json.
- Icon: `resources/icon.ico` (no root Draco.ico exists).
- Data folder: only `%APPDATA%\Draco` (Electron userData). I did not verify a `%LOCALAPPDATA%` folder, so none is listed.
- `legacy_names = ["Draco"]`: the old electron-builder NSIS installer used productName Draco. Its per-user install is assumed; the CLI-only installer is a separate product and is not migrated.
- Removed: the NSIS installer, portable exe and CLI-only installer outputs, plus the artifact/softprops release jobs. The portable build and the CLI-only installer are no longer published; restore them if wanted.
- Kept the workflow file name `build-installers.yml` (edited in place); it now creates the release with `gh release create --generate-notes` if missing.
- Secrets `WINDOWS_PFX_BASE64` / `WINDOWS_PFX_PASSWORD` must exist, or the setup is unsigned.
