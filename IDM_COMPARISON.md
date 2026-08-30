# Internet Download Manager (IDM) Comparison

## Scope

This is a source-based comparison: IDM features are taken from its public
documentation, while Draco capabilities are verified against the current
repository. It is not a benchmark or a reverse-engineering report.

## What IDM Does

IDM is a Windows download manager centered on browser takeover, dynamic file
segmentation, resume/recovery, and a mature media-download panel. Its documented
feature set includes HTTP, HTTPS, FTP, and MMS downloads; broad browser
integration; automatic categorization; queues and scheduled synchronization;
site mirroring; proxy/authentication support; bandwidth quotas; antivirus
execution; and configurable UI/updates.

Primary references: [IDM feature list](https://www.internetdownloadmanager.com/features2.html),
[scheduler guide](https://www.internetdownloadmanager.com/support/idm-scheduler/idm_scheduler.html),
and [site-grabber guide](https://www.internetdownloadmanager.com/support/idm-grabber/idm_grabber.html).

## Current Comparison After the Draco Upgrade

| Area | Draco today | IDM lead / missing Draco capability |
| --- | --- | --- |
| Download engine | Dynamic segmentation, range resume journals, retry, per-task connections, global speed cap | IDM has years of server-compatibility hardening and connection reuse; Draco needs field testing across more hosts. |
| Browser takeover | MV3 packages and native-host registration for Chrome, Edge, Brave, Opera, Vivaldi, and Firefox; context menus and direct-link takeover | Safari and takeover from unrelated desktop applications remain out of scope for this Windows Electron project. |
| Video/media | Direct files, HLS, YouTube quality selection, paired A/V muxing, generic unencrypted VOD MPEG-DASH, codec/quality summaries, page subtitle sidecars, and explicit live/DRM errors | DRM is diagnosed but intentionally not bypassed. Unusual site-specific players still require compatibility work. |
| Recovery | Persisted tasks and quotas, atomic JSON, journals, redirect/cookie tests, strict range validation, and automatic sticky single-connection fallback for dishonest range servers | IDM still has a much larger real-world compatibility history. |
| Categories | Built-in/custom extension categories plus host-suffix rules | Draco does not import IDM category definitions. |
| Queues/scheduling | Ordered/reorderable queues, synchronized membership, one-time/periodic windows, bounded delayed retries, error-aware drain state, power/exit actions, and shell-free completion programs | Queue state is local rather than shared between several PCs. |
| Network controls | Global speed cap, rolling durable quotas, proxy URLs (including URL credentials), timeout/retry controls, browser request headers, and most-specific per-host connection caps | SOCKS/PAC and an interactive credential vault are not implemented. |
| Automation/security | Clipboard watcher, completion programs, optional shell-free antivirus scanner with timeout, and an HTTPS JSON update channel with manual install | Draco does not silently install updates or claim a failed scanner means a file is safe. |
| Interface | Progress windows, configurable columns/accent, dark/light/system themes, English/Turkish core localization, and single/multi-URL drag-and-drop | Localization coverage is currently concentrated on the main workflow; IDM ships more languages and mature skins. |
| Web/site capture | Extension bulk actions plus saved, bounded site projects with depth/page/host controls, robots.txt, asset capture, rewritten offline page links, and scheduled incremental discovery | Sync adds new URLs and refreshes HTML; it does not content-diff or overwrite every previously downloaded binary asset. |

## Important Product Difference

Draco now covers the complete implementation roadmap below. It is a credible
personal IDM-style manager, but it should still not be marketed as a drop-in IDM
replacement: IDM supports legacy FTP/MMS protocols and has decades more field
compatibility, translations, and site-specific handling.

## Recommended Roadmap

1. **Completed — reliability:** redirect/cookie/range-liar integration tests,
   durable journals/quotas, and compatibility fallback.
2. **Completed — media breadth:** generic clear DASH, subtitles, and DRM/live
   diagnostics.
3. **Completed — network controls:** proxy, host caps, and rolling quotas.
4. **Completed — automation:** bounded queue retries, completion programs, and
   optional scanning.
5. **Completed — integration/UX:** Firefox and Chromium-family registration,
   drag-and-drop, themes, localization scaffolding, and update feeds.
6. **Completed — site projects:** saved/scheduled crawling and offline page-link
   rewriting with explicit safety bounds.

## Is Reverse Engineering Needed?

Not for this roadmap. Public documentation and real compatibility tests reveal
the meaningful gaps. Installing IDM would be useful later only for controlled
black-box comparisons—timing browser handoff, handling expired links, queue
semantics, and UX—not to inspect or copy its binaries, protocols, or protected
implementation.
