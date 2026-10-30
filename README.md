<div align="center">

<h1>
  <img src="resources/appIcon.png" alt="Draco Icon" width="56" height="56" style="vertical-align: middle; margin-right: 10px;" />
  Draco
</h1>

**A personal high-performance download manager crafted for Windows**

*Dynamic segmented acceleration, native browser takeover, queue scheduling, and media stream capture — powered by Electron, React 19, and TypeScript.*

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-00B074.svg?style=flat-square" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/Platform-Windows%20x64-0078D4.svg?style=flat-square&logo=windows" alt="Platform: Windows x64" />
  <img src="https://img.shields.io/badge/Electron-43-47848F.svg?style=flat-square&logo=electron" alt="Electron" />
  <img src="https://img.shields.io/badge/React-19-61DAFB.svg?style=flat-square&logo=react" alt="React 19" />
  <img src="https://img.shields.io/badge/TypeScript-7-3178C6.svg?style=flat-square&logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/TailwindCSS-v4-38B2AC.svg?style=flat-square&logo=tailwind-css" alt="Tailwind CSS" />
  <img src="https://img.shields.io/badge/BitTorrent-WebTorrent-F05032.svg?style=flat-square" alt="WebTorrent" />
  <img src="https://img.shields.io/badge/Tests-577%20Passed-success.svg?style=flat-square" alt="577 Tests Passing" />
</p>

---

<p>
  <a href="#-about-draco">About</a> •
  <a href="#-key-features">Features</a> •
  <a href="#-visual-tour">Visual Tour</a> •
  <a href="#-engine-support-matrix">Engine Matrix</a> •
  <a href="#-browser-takeover">Browser Takeover</a> •
  <a href="#-installation--usage">Installation</a> •
  <a href="#-building-from-source">Building</a> •
  <a href="#-icon--design-philosophy">Design</a> •
  <a href="#-license--credits">License</a>
</p>

<p align="center">
  <img src="resources/downloadButton.png" alt="Draco In-Page Media Sniffer & Download Banner" width="760" />
</p>

</div>

---

## 🐉 About Draco

**Draco** is a modern, privacy-respecting, high-velocity download manager tailored specifically for Windows. Designed to eliminate the bottlenecks, cluttered UI, and incomplete downloads of conventional browser download managers, Draco combines **dynamic multi-connection segmentation**, **deep native browser takeover**, **media stream capture**, and **BitTorrent support** into an ultra-responsive, local-first desktop application.

Whether fetching gigabyte-scale game archives, downloading multi-part media streams, or queuing batches overnight, Draco ensures every byte is accounted for through atomic byte journals and non-overlapping parallel range writers.

- 🚀 **Dynamic Byte Segmentation**: Divides files into dynamic segments across parallel connections, automatically ramping bandwidth and resuming uninterrupted even across restarts.
- 🌐 **Deep Browser Takeover**: Integrates seamlessly with Chromium (Chrome, Edge, Brave) and Firefox via a native messaging host (`draco-host.exe`), suppressing intrusive browser download bubbles and capturing direct links before browsers start saving.
- 🎬 **Unified Media & Torrent Pipeline**: Download anything from direct HTTP/HTTPS files to HLS (AES-128) streams, MPEG-DASH manifests, YouTube format ladders, and BitTorrent magnet links with automatic audio/video muxing via FFmpeg.
- 🛡️ **Reliability First**: Tested over **577 automated tests across 91 suites** with atomic file checkpoints, strong ETag validation, post-transfer checksum verification (MD5, SHA-1, SHA-256), and optional security scanner execution.

---

## ✨ Key Features

<table>
  <tr>
    <td width="50%">
      <h3>⚡ Dynamic Multi-Connection Segmentation</h3>
      <p>Accelerate downloads with parallel byte-range streams, dynamic split ramping, atomic journal persistence, and crash-safe resume without corrupted overlaps.</p>
    </td>
    <td width="50%">
      <h3>🌐 Seamless Browser Takeover</h3>
      <p>Full Chromium (MV3) and Firefox browser integration via native messaging. Suppresses the native download bubble, intercepts download links, and respects custom exclusion rules.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🧲 Native BitTorrent &amp; Magnet Support</h3>
      <p>WebTorrent-powered BitTorrent client featuring selective multi-file tree downloading, live peer and tracker statistics, bandwidth choking, and configurable background seeding.</p>
    </td>
    <td width="50%">
      <h3>🎬 Adaptive Media &amp; HLS/DASH Streaming</h3>
      <p>Sniff and download adaptive streams (HLS VOD with AES-128 decryption, MPEG-DASH). Automatically fetches separate video/audio renditions and muxes them losslessly via FFmpeg.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>📺 YouTube &amp; Video Platform Integration</h3>
      <p>Inspects format ladders, sequential 10 MiB chunking for Google video servers, yt-dlp cookie passing, external subtitle sidecar downloads, and batch playlist grabbing.</p>
    </td>
    <td width="50%">
      <h3>⏱️ Queue Manager &amp; Time-Window Scheduler</h3>
      <p>Organize downloads into custom queues, set concurrency limits, enforce global speed caps and transfer quotas, and schedule queue starts/stops within automated time windows.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>📁 Intelligent Categories &amp; Auto-Routing</h3>
      <p>Automatic file sorting into Videos, Music, Documents, Programs, and Compressed archives with customizable destination rules, group folders, and Windows file sanitization.</p>
    </td>
    <td width="50%">
      <h3>🛡️ Cryptographic Integrity &amp; Security Scanners</h3>
      <p>Validate downloads against MD5, SHA-1, or SHA-256 digests. Automatically trigger Windows Defender or your configured security scanner immediately after file finalization.</p>
    </td>
  </tr>
</table>

---

## 📸 Visual Tour

### 1. In-Page Media Sniffer & Browser Download Integration
Draco pins a clean download button outside the corner of HTML5 video and media players, rendered inside an isolated closed Shadow DOM to avoid interfering with page styles.

<p align="center">
  <img src="resources/downloadButton.png" alt="In-Page Media Sniffer Overlay" width="680" />
</p>

### 2. High-Performance BitTorrent Engine
Manage `.torrent` files and `magnet:` URIs with full file-tree selection, peer analytics, and piece-state persistence.

<p align="center">
  <img src="resources/torrent.webp" alt="BitTorrent & Magnet Transfer Engine" width="380" />
</p>

### 3. Native Browser Integration Status
Monitor integration state in real time directly from your browser extension bar. The extension communicates with Draco via a dedicated native messaging host.

<p align="center">
  <img src="extension/status-icons/active-128.png" alt="Active Takeover" width="80" height="80" style="margin: 0 16px;" />
  <img src="extension/status-icons/inactive-128.png" alt="Standby / Paused" width="80" height="80" style="margin: 0 16px;" />
</p>
<p align="center"><em>Active Takeover (Left) • Paused / Inactive Integration (Right)</em></p>

### 4. Fast Startup & System Tray Experience
A lightweight startup splash window loads state rapidly, transitioning seamlessly to the background tray when minimized with dedicated mini progress indicators.

<p align="center">
  <img src="resources/icon-splash.png" alt="Draco Fast Startup Splash" width="96" height="96" />
</p>

---

## ⚙️ Engine Support Matrix

Draco features dedicated transfer runners tuned for specific protocols and stream formats:

| Engine | Resume After Pause/Restart | Expected Checksum | Speed Cap | Transfer Quota | Authentication | Encrypted Media |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **HTTP/HTTPS File Transfer** | Full (Byte journal & parallel ranges with strong ETag) | MD5, SHA-1, SHA-256 before final rename | Yes, shared limiter | Yes, shared limiter for body bytes | Origin-scoped headers & HTTP challenge credentials | HTTPS transport |
| **Separate Video / Audio URLs** | Dual-stream resume (Finished halves reused) | Muxed output verification | Yes, shared across halves | Yes, shared across halves | Captured headers for each stream half | HTTPS transport |
| **HLS VOD (`hls/runner.ts`)** | Piece-level reuse with playlist identity check | Muxed output verification | Yes, segment bodies share limiter | Segment body byte charging | Request headers passed to segment runner | AES-128 segments supported |
| **MPEG-DASH MPD (`dash/runner.ts`)** | Clean restart from manifest | Verified on FFmpeg output | Bounded process execution | Managed transfer flow | Headers forwarded to FFmpeg demuxer | DRM rejected |
| **BitTorrent (`engine/torrent.ts`)** | Protocol piece-state resume | BitTorrent piece hash validation | Per-torrent & queue-level choking | Task-level tracking | Tracker URL & passkey handling | Standard BitTorrent peer encryption |

> For architectural details and verification logs, consult [ENGINE_SUPPORT.md](docs/ENGINE_SUPPORT.md) and [AUDIT_2026-10-11.md](docs/AUDIT_2026-10-11.md).

---

## 🧩 Browser Takeover

Draco's browser integration goes far beyond simple extension download prompts:

- **Chromium Download UI Suppression (`downloads.ui`)**: While Draco is running, takeover is active, and the integration is unpaused, Chromium's native download bubble is hidden. Downloads land directly in Draco without annoying duplicate prompts.
- **`onDeterminingFilename` Handoff**: For browser-initiated downloads, Draco evaluates ownership and URL rules before Chrome writes to disk. Accepted downloads are transferred directly to Draco and cancelled in the browser; declined downloads revert cleanly to Chrome's standard "Save As" flow.
- **Link Interception in Shadow DOM**: Clicks on direct download links are intercepted on the web page before Chrome can create a browser download session.
- **Session Header & Cookie Preservation**: Cookies, Referer headers, User-Agent, and authorization headers are securely forwarded through the native host so private downloads behind session logins succeed without re-authentication.

For technical details on Chrome and Firefox integration, refer to [BROWSER_TAKEOVER.md](docs/BROWSER_TAKEOVER.md).

---

## 🚀 Installation & Usage

### Windows Installer (Recommended)

Download and run the installer from the latest release:

```powershell
dist/Draco-1.0.0-x64.exe
```

The installer configures:
- Start Menu and Desktop shortcuts with the custom Draco dragon emblem.
- Registry file associations for `.torrent` files (`Draco.Torrent`) and `magnet:` URL schemes.
- Unpacked browser extensions directory and native messaging host manifests.
- Isolated user data and journal state in `%APPDATA%\Draco`.

### Portable Version

If you prefer a zero-install portable deployment:

```powershell
dist/Draco-0.1.2-portable.exe
```

### Browser Extension Setup

1. **Chromium (Google Chrome, Microsoft Edge, Brave, Opera, Vivaldi)**:
   - Navigate to `chrome://extensions` and enable **Developer mode** (top-right toggle).
   - Click **Load unpacked** and select the `extension` directory from your Draco installation or repository.
   - Run `tools/register-host.ps1` to register the native messaging host manifest in the Windows registry:
     ```powershell
     powershell -ExecutionPolicy Bypass -File tools/register-host.ps1
     ```

2. **Mozilla Firefox**:
   - Navigate to `about:debugging#/runtime/this-firefox`.
   - Click **Load Temporary Add-on...** and select `extension-firefox/manifest.json` (generated via `npm run extension:firefox`).

### Command Line (`draco`)

Run `draco` with no arguments in a terminal to open the interactive download interface. Paste a link and press Enter. The first media download offers a quality picker; later links reuse your choice automatically.

The link box stays open while downloading, so pasting another link (or several at once) adds it to the **queue**. One download moves bytes at a time, and the next one starts as soon as the current one reaches its merge step. `-c` in `draco.cfg` allows more lanes. A playlist link queues every video and plays them in order into `<playlist>\NN - <title>`, looking up each entry just before its turn. From an empty link box, **↓** steps into the "Up next" list, where **Del** removes an item.

Files are saved to the folder you started `draco` from, so `cd Desktop\a; draco` downloads into `a`. Started from your home folder (where Windows Terminal opens) or from System32, it uses the `-P` in `draco.cfg`, or `Downloads` if there is none. The header shows which rule applied. **F2** changes quality or the folder, and a new folder can apply to this session only or become the `draco.cfg` default. **F4** opens the folder in Explorer, including during a download. Quality persists in `%APPDATA%\Draco\cli-preferences.json`.

**Ctrl+C** pauses what is downloading and keeps the queue (merges in progress finish). **F5** continues, and a second **Ctrl+C** exits. In Windows Terminal, progress also shows on the tab and taskbar, and a bell rings when a long queue finishes. The header, download bars and animated indicators adapt to the terminal size and repaint after resizing. Set `NO_COLOR` for monochrome output.

The same engine and resolvers, from a terminal, with yt-dlp-style flags:

```powershell
draco "https://www.youtube.com/watch?v=..." -best      # tallest rung, video+audio merged
draco "https://www.youtube.com/watch?v=..." -F         # list formats
draco "https://www.youtube.com/watch?v=..." -f 720 -P D:\Videos
draco "https://www.youtube.com/watch?v=..." -x         # best audio only
draco "https://www.youtube.com/playlist?list=..."      # whole playlist into its own folder
draco https://example.com/file.iso -N 16 -r 4M         # 16 connections, 4 MiB/s cap
draco URL -o "%(uploader)s/%(title)s.%(ext)s"          # one folder per uploader
```

`-best` is the default. It picks the highest video quality, including enhanced HLS renditions, plus the best audio and merges them with ffmpeg without re-encoding. Within a resolution, source preference, frame rate and codec come before bitrate; AAC is not forced over Opus. The output container can be WebM or MKV to preserve the selected streams. Downloads land in the current directory unless `-P` says otherwise. From your home folder, they go to `draco.cfg`'s `-P`, or to `Downloads`. A playlist's videos download one after another, numbered in playlist order. Ctrl-C pauses and saves progress, and running the same command again resumes it. A file that already exists is skipped (`--force` overrides). The CLI shares the app's managed yt-dlp/ffmpeg but not its settings, and it never touches the GUI's download list. See `draco --help` for every flag.

**yt-dlp media configs.** `-S` / `--format-sort`, `--merge-output-format`, `--cookies`, thumbnail conversion/embedding, metadata/chapters, `--windows-filenames` and `--no-mtime` are supported. When these options are present, yt-dlp performs the download and postprocessing, including full output templates such as `%(channel,uploader)s`. Its downloads run sequentially; `-c` controls only Draco engine downloads. Choose quality in F2 when using this mode. Other unknown options still report an error.

**Output templates.** `-o` accepts yt-dlp-style fields: `title`, `ext`, `id`, `uploader`, `upload_date`, `height`, `resolution`, `format_id`, `playlist`, `playlist_index` (`%(playlist_index)03d` pads numbers). A field with no value becomes `NA`. A `/` in the template creates folders, but values cannot: a title such as `../x` is sanitised to a plain file name. A media extension left in a title (`clip.mp4`) is dropped, so you don't get `clip.mp4.mp4`.

**Config file (`draco.cfg`).** This file holds default flags, written exactly as on the command line, one or more per line, with `#` for comments. It lives in Draco's root folder: next to `Draco.exe` when installed, or the repository root when running from source. The installer writes a fully commented sample. Your edits survive updates, and uninstalling keeps a copy at `%APPDATA%\Draco\draco.cfg.bak` that a reinstall restores. The command line always overrides the file. Use `--ignore-config` to skip it, `--config-location PATH` to read another file, and `-v` to see which file was used.

```ini
-P "D:\Videos"
-N 16
--cookies-from-browser firefox
-o "%(uploader)s/%(title)s.%(ext)s"
```

- **CLI-only installer**: `npm run dist` also creates `dist/Draco-CLI-<version>-x64-Setup.exe`. Use `npm run dist:cli` to build only this installer. It installs its own Node runtime, download engine, yt-dlp and ffmpeg; the desktop app is not required. It has its own installation directory, PATH entry, Start menu shortcut and uninstaller. Its `draco.cfg` stays in the installation folder across updates and uninstall. If both editions are installed, the first entry on PATH handles `draco`; use the CLI Start menu shortcut to explicitly launch the standalone edition.
- **Installed desktop copy**: the setup puts `draco` on your user `PATH`. Open a new terminal afterwards and it works. `draco.cmd` in `<install dir>\resources\bin` runs the CLI inside `Draco.exe`, so no separate Node is needed. You can switch it off in Options → General, and uninstalling removes it.
- **Portable copy**: no `draco` command, because the portable build unpacks to a new temp folder on every launch.
- **From source**: `npm link` (Node ≥ 22.18), or `npm run cli -- <url> -best`.

---

## 🛠️ Building from Source

### Prerequisites

Ensure the following tools are installed on your Windows development environment:
- **Node.js** (v22.18.0 or newer)
- **npm** (v10+)
- **Python 3** (used for asset generation and native dependency compilation)
- **Visual Studio C++ Build Tools** (Desktop development with C++)
- **Git for Windows**

### Build Steps

1. **Clone the repository:**
   ```powershell
   git clone https://github.com/projectGloria/Draco.git
   cd Draco
   ```

2. **Install project dependencies:**
   ```powershell
   npm install
   ```

3. **Build the native messaging host:**
   ```powershell
   npm run host
   ```

4. **Prepare runtime dependencies & build application:**
   ```powershell
   npm run runtime
   npm run build
   ```

5. **Package Windows Installer & Portable Executable:**
   ```powershell
   npm run dist
   ```
   Packaged artifacts will be generated inside the `dist/` directory:
   - `dist/Draco-1.0.0-x64.exe` (NSIS Installer)
   - `dist/Draco-0.1.2-portable.exe` (Portable Binary)

### Running Tests & Benchmarks

Draco includes an extensive test and profiling suite:

```powershell
# Run all unit and integration tests (577 tests in 91 suites)
npm test

# Run HTTP transfer benchmark with segmentation
npm run bench:http

# Run download list virtualization profiling
npm run bench:list

# Verify package dependencies and bundle integrity
npm run verify:package
```

---

## 🎨 Icon & Design Philosophy

<p align="center">
  <img src="resources/appIcon.png" alt="Draco Dragon Icon" width="120" height="120" />
</p>

> *"A fierce, glowing amber-and-crimson dragon forged in deep obsidian — symbolizing untamed download velocity, precision range segmentation, and unwavering reliability."*

Draco is built on key core design principles:

- **Uncompromising Throughput**: Multi-connection segmented pipelines maximize network bandwidth utilization without saturating disk I/O.
- **Zero UI Stutter**: Download lists, progress bars, and high-frequency byte updates run through throttled 4 Hz diff updates, ensuring the UI remains silky smooth even under dozens of active multi-gigabyte transfers.
- **Crash Resilience**: Every active download maintains an atomic segment journal on disk. A system reboot, sudden power loss, or network drop will resume right from the last synced byte.
- **Windows First**: Thoughtfully designed with Windows desktop conventions, native shortcuts, notification center integration, and taskbar progress indicators.

---

## 📜 License & Credits

Draco is open-source software licensed under the **[MIT License](LICENSE)**.

### Credits & Dependencies

Draco is powered by these excellent open-source projects:

- **[Electron](https://www.electronjs.org/)** & **[electron-vite](https://electron-vite.org/)** — Desktop runtime and rapid development tooling.
- **[React 19](https://react.dev/)** & **[Zustand](https://zustand-demo.pmnd.rs/)** — Declarative UI and reactive state management.
- **[Tailwind CSS v4](https://tailwindcss.com/)** — Modern design styling and fluid layout.
- **[WebTorrent](https://webtorrent.io/)** & **[parse-torrent](https://github.com/webtorrent/parse-torrent)** — BitTorrent streaming engine.
- **[Undici](https://undici.nodejs.org/)** — High-performance HTTP/1.1 client for Node.js.
- **[FFmpeg](https://ffmpeg.org/)** & **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — Media extraction, transcode, and stream muxing toolchain.

---

<div align="center">
  <sub>Crafted with passion for high-speed downloads. Copyright &copy; 2026 Nihil.</sub>
</div>
