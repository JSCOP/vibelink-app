# VibeLink Browser Control

This Manifest V3 extension lets VibeLink control tabs in the user's already-running Chrome through `chrome.debugger` and a paired loopback WebSocket.

## Installation

`vibelink browser chrome --install` copies this bundle into the flavor-specific app-data `browser-extension/` directory (for example, `%APPDATA%\vibelink\VibeLink Dev\data\browser-extension\`) and writes a fresh `pairing.json` beside it. Until a Chrome Web Store package is available, the user enables Developer mode at `chrome://extensions`, chooses **Load unpacked**, and selects that directory. VibeLink does not install a native-messaging host or register the extension through the Windows registry.

## Chrome debugging notice

When VibeLink attaches, Chrome shows a notice that **VibeLink Browser Control started debugging this browser**. This is Chrome's mandatory disclosure for `chrome.debugger`; it is expected and cannot, and should not, be suppressed.
