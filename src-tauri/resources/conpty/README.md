# Bundled Windows ConPTY runtime

VibeLink ships a pinned Microsoft ConPTY host instead of relying on whatever
`conpty.dll` happens to be reachable through `PATH`. `portable-pty` loads the
pseudo-console entry points with a bare `LoadLibrary("conpty.dll")`, so any
third-party install on `PATH` (WezTerm ships one under
`C:\Program Files\WezTerm`) silently became VibeLink's PTY host and its
`OpenConsole.exe` became the per-pane console host process.

| Field | Value |
| --- | --- |
| Package | `Microsoft.Windows.Console.ConPTY` |
| Version | `1.24.260710001` |
| Source | <https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/1.24.260710001/microsoft.windows.console.conpty.1.24.260710001.nupkg> |
| Upstream project | <https://github.com/microsoft/terminal> |
| License | MIT (© Microsoft Corporation) |

Vendored files (x64 only; VibeLink ships an x64 Windows bundle):

| File | Package path | SHA-256 |
| --- | --- | --- |
| `x64/conpty.dll` | `runtimes/win-x64/native/conpty.dll` | `39fba2713e2495117b1591ae8c32a3b904bea7aa66069cf7815e2844c76d75d8` |
| `x64/OpenConsole.exe` | `build/native/runtimes/x64/OpenConsole.exe` | `b7fd936c2668b87b9ecf7b3366dc6568afc1c6f981874cba3e955a1c35cf8160` |

`conpty.dll` starts `OpenConsole.exe` from its own directory, so the two files
must always be copied together into the same folder.

## Refreshing the pinned version

1. Pick a stable version from
   <https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/index.json>
   (avoid `-preview`).
2. Download the `.nupkg`, extract `runtimes/win-x64/native/conpty.dll` and
   `build/native/runtimes/x64/OpenConsole.exe` into `x64/`.
3. Update the version, URL, and SHA-256 values in this file.
4. Rebuild and confirm a pane's console host really is the bundled binary:
   the `OpenConsole.exe` child of the daemon must live in the daemon's own
   directory, never in `C:\Program Files\WezTerm` or `System32`.
