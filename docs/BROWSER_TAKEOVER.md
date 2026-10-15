# Browser download UI

The Chromium extension requests `downloads.ui` and hides the browser's download
bubble while Draco is running, takeover is enabled, and integration is not paused.
This is a browser-profile setting: it also hides the bubble for downloads excluded
from Draco's takeover rules. Downloads remain accessible through the browser's
Downloads page. Pausing integration, disabling takeover, or detecting that Draco
has stopped restores the browser UI. The extension checks status on startup,
page refreshes, and its recovery alarm.

For downloads that reach the browser, `onDeterminingFilename` defers filename
selection while Draco decides ownership. Accepted downloads are cancelled before
the filename callback is released. Declined downloads resume in the browser with
the browser's normal filename and Save As behavior. A 10-second deadline releases
the callback if the handoff or confirmation is still pending; Chromium also has
its own timeout. This cannot guarantee suppression of every Save As dialog.

Direct file-link interception can avoid creating a browser download entirely.
Other downloads, including redirects and downloads started by page scripts, use
the browser download events. Blob/data downloads and files excluded by takeover
rules remain browser-owned.

Firefox does not expose Chromium's UI suppression or filename-determination APIs.
Its generated extension retains link interception and pause/handoff recovery, but
cannot promise suppression of all native download UI.

After updating an unpacked extension, reload it from the browser's extensions
page and refresh existing tabs. Chromium must grant the added `downloads.ui`
permission. Restarting Draco alone does not reload the extension.

Tests cover UI state changes, acceptance and fallback ordering, filename timeout,
storage failure, and worker recovery. Real-browser Save As and bubble behavior
still needs manual verification, including slow confirmations and redirects.

API reference: [Chromium downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads).
