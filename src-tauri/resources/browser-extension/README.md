# VibeLink Browser Control

This Manifest V3 extension lets VibeLink control tabs in the user's already-running Chrome through `chrome.debugger` and a paired loopback WebSocket.

## How it pairs

The Chrome Web Store zip contains `manifest.json`, `service-worker.js`,
`bridge-port.json` (committed with the release port `9332`), and both icons.
This README is deliberately left out of that zip.

For an unpacked install, VibeLink copies the bundle and rewrites
`bridge-port.json` with that flavor's runtime port (`9332` for release or
`19399` for a developer build). The service worker fetches that file, falls
back to `9332` if it cannot read a valid port, and opens exactly one loopback
WebSocket instead of probing both flavors.
Chrome sets `Origin: chrome-extension://<id>` on that upgrade and page script
cannot forge it, so the daemon authenticates the peer from the header alone: the
first extension id to connect is remembered in `<dataDir>/browser-extension.json`
and every later connection must present the same id. `vibelink browser chrome
--unpair` forgets it, which is what a user runs after swapping an unpacked copy
for the Chrome Web Store build.

## Installation

Published — the intended path once the extension is on the Web Store. Chrome
installs it from the store, and a production build whose `STORE_EXTENSION_ID` is
set has `vibelink browser chrome --install` pre-register it by writing
`update_url` under `HKCU\Software\Google\Chrome\Extensions\<id>`, so Chrome picks
it up on its next start and asks the user once to enable it; `--unpair` removes
that registration again. `STORE_EXTENSION_ID` is `None` today, and a DEV build
never writes that key at all, so both cases write only the unpacked bundle below.

Off-store: `vibelink browser chrome --install` writes this bundle into the
flavor-specific app-data `browser-extension/` directory (for example
`%APPDATA%\vibelink\VibeLink\data\browser-extension\`) and the user enables
Developer mode at `chrome://extensions`, chooses **Load unpacked**, and selects
that directory. VibeLink installs no native-messaging host.

## Chrome debugging notice

When VibeLink attaches, Chrome shows a notice that **VibeLink Browser Control started debugging this browser**. This is Chrome's mandatory disclosure for `chrome.debugger`; it is expected and cannot, and should not, be suppressed.
