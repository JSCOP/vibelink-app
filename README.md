# Agentic Workspace Terminal

Tauri v2 desktop terminal workspace with dockview splits, workspace sessions, grid templates, xterm.js rendering, and a detached Rust PTY daemon.

## Run

```bash
pnpm install
pnpm tauri dev
```

Use the npm Tauri CLI. A global `cargo-tauri` install is not required.

## Build

```bash
pnpm build
pnpm tauri build
```

## Architecture

- React owns layout, workspace UI, dockview panels, and xterm.js rendering.
- The Tauri app is a thin bridge. Frontend calls Rust commands via `invoke`; terminal output arrives through one `Channel` keyed by `paneId`.
- The daemon is the same binary launched with `--daemon`. It owns live PTYs, sessions, scrollback, layouts, and durable session metadata.
- IPC uses `interprocess` local sockets with MessagePack frames and a 4-byte big-endian length prefix.
- Sessions persist under the platform app data directory as `sessions.json`. Panes are intentionally not persisted or reconstructed after daemon restart.

## UI

- Left workspace drawer: hover the left edge to open, move away to close; create, switch, rename, delete.
- Workspace creation opens a popup for name, native folder selection, and starting template. New panes launched in that workspace use the selected folder as their cwd.
- Templates: 1×1 through 6×2 grid presets. Applying a template is non-destructive: existing panes stay alive, missing panes are added, overflow panes are kept as tabs.
- Pane header: split right, split down, new tab, maximize, close, and double-click title rename.
- Pane titles follow terminal OSC 0/2 title updates from tools such as Codex, Claude Code, and OMP unless the title was manually renamed.
- Settings dialog: installed Windows font dropdown, terminal theme presets, terminal appearance, and editable Windows Terminal-compatible keybindings that still work while terminal input is focused.

## CLI control

The same binary exposes a lightweight CLI for agents and scripts. A skill can call these commands on demand without any separate integration setup.

```powershell
.\target\debug\app.exe cli sessions
.\target\debug\app.exe cli panes --session <session-id>
.\target\debug\app.exe cli read --pane <pane-id>
.\target\debug\app.exe cli write --pane <pane-id> --text "pwd" --enter
```

`sessions` and `panes` print JSON. `read` prints pane scrollback with ANSI CSI escape sequences stripped for LLM readability. `write --enter` appends a newline so the terminal executes the command.

## Daemon smoke checks

From `src-tauri`, start the daemon in one terminal:

```powershell
cargo build
.\target\debug\app.exe --daemon
```

Then run the focused examples from another terminal:

```powershell
cargo run --example ping_daemon
cargo run --example smoke_terminal
cargo run --example check_no_smoke_leak
```

`smoke_terminal` creates a temporary `Smoke` session and verifies that `PaneConfig` preserves and launches requested profile fields (`shell`, `args`, `env`, `cwd`) while capturing PTY output. It deletes that session before exit so smoke panes are not reconstructed on the next daemon startup. On Windows it tries `cmd.exe` and `pwsh.exe`; unavailable commands are reported as `SKIP` instead of failing. It also tries the first available generic CLI candidate from `claude`, `codex`, or `omp` with `--version`; if none are installed, that case is skipped.

`check_no_smoke_leak` guards the restart path by failing if any persisted `Smoke` session still has panes that would be respawned into PTYs/OpenConsole hosts.

To force a specific generic CLI command path, set `AWT_SMOKE_CLI` before running the smoke example. Optional whitespace-separated args can be supplied through `AWT_SMOKE_CLI_ARGS`.

```powershell
$env:AWT_SMOKE_CLI = "codex"
$env:AWT_SMOKE_CLI_ARGS = "--version"
cargo run --example smoke_terminal
```
