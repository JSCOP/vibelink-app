# VibeLink Browser Control

This Manifest V3 extension lets VibeLink control tabs in the user's already-running Chrome through `chrome.debugger` and a paired loopback WebSocket.

## How it pairs

Every file here is identical on every machine — no per-user secret is baked in —
so this same folder is what gets zipped for the Chrome Web Store.

The service worker opens a loopback WebSocket to `127.0.0.1:9332` (a VibeLink
developer build listens on `19399`; it tries both and keeps whichever answers).
Chrome sets `Origin: chrome-extension://<id>` on that upgrade and page script
cannot forge it, so the daemon authenticates the peer from the header alone: the
first extension id to connect is remembered in `<dataDir>/browser-extension.json`
and every later connection must present the same id. `vibelink browser chrome
--unpair` forgets it, which is what a user runs after swapping an unpacked copy
for the Chrome Web Store build.

## Installation

Published: Chrome installs it from the Web Store, and the VibeLink installer can
pre-register it by writing `update_url` under
`HKLM\Software\Google\Chrome\Extensions\<id>`; Chrome then asks the user once to
enable it.

Off-store: `vibelink browser chrome --install` writes this bundle into the
flavor-specific app-data `browser-extension/` directory (for example
`%APPDATA%\vibelink\VibeLink\data\browser-extension\`) and the user enables
Developer mode at `chrome://extensions`, chooses **Load unpacked**, and selects
that directory. VibeLink installs no native-messaging host.

## Chrome debugging notice

When VibeLink attaches, Chrome shows a notice that **VibeLink Browser Control started debugging this browser**. This is Chrome's mandatory disclosure for `chrome.debugger`; it is expected and cannot, and should not, be suppressed.
