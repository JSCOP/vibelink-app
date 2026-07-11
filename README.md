# VibeLink

Tauri v2 desktop terminal workspace with dockview splits, workspace sessions, grid templates, xterm.js rendering, and a detached Rust PTY daemon.

## Run

```bash
pnpm install
pnpm tauri:dev
```

Use the npm Tauri CLI. A global `cargo-tauri` install is not required. The `tauri:dev` script merges `src-tauri/tauri.dev.conf.json`, so development runs as **VibeLink Dev** with identifier `com.vibelink.desktop.dev`; production uses **VibeLink** with identifier `com.vibelink.desktop`.

## Build

```bash
pnpm build
pnpm tauri:build
```

`pnpm tauri:build` invokes `scripts/vibelink.ps1 -Action installer-release` and performs the local release-preparation version bump. Versioned bundles are emitted under `src-tauri\target\release\bundle\msi` and `src-tauri\target\release\bundle\nsis`, for example `VibeLink_0.1.13_x64_en-US.msi` and `VibeLink_0.1.13_x64-setup.exe`.

## VibeLink Pro licensing

- Core remains usable without a key for terminal sessions, panes, grids, themes, profiles, and capture/recording.
- Pro gates Agent, Kanban, Todo, Diff, task orchestration, pane roles, Hermes/MCP, git snapshots/worktrees, board writes, and related CLI/native commands.
- Settings → License activates either a VibeLink-issued `VBL-…` key or a Lemon Squeezy key and shows the masked key plus active/review devices. One license supports three devices; current or remote devices can be removed.
- Successful online validation stores only encrypted Windows Credential Manager state. License keys are never persisted in localStorage, Zustand settings, session JSON, or logs.
- The last successful server timestamps grant up to seven days of offline Pro. Explicit refund/revocation/deactivation locks immediately on the next online validation; clock rollback or expired grace returns to Core.
- `VIBELINK_LICENSE_API_URL` is compiled into the application. Debug defaults to `http://localhost:3000`; release builds accept only `https://vibelink.moobang.net`.

## Signed release

Tag releases require `vX.Y.Z` to match `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. The protected `release` environment builds `app.exe` without bundles, signs it through SSL.com eSigner, bundles the signed executable, signs and verifies NSIS/MSI with Authenticode plus `signtool`, creates `SHA256SUMS.txt`, and publishes exactly three assets to the public binary-only `JSCOP/vibelink-releases` repository through a repository-scoped GitHub App. The private source repository is never a public download target.

## Architecture

- React owns layout, workspace UI, dockview panels, and xterm.js rendering.
- The Tauri app is a thin bridge. Frontend calls Rust commands via `invoke`; terminal output arrives through one `Channel` keyed by `paneId`.
- The daemon is the same executable code launched with `--daemon`. On Windows app startup copies the current executable into the app data `daemon-bin` directory first, so the detached daemon does not lock `src-tauri\target\debug\app.exe` during rebuilds.
- Dev and production daemons are isolated. `ProjectDirs::from("com", "vibelink", ...)` resolves production under `C:\Users\<user>\AppData\Roaming\vibelink\VibeLink\data` and development under `C:\Users\<user>\AppData\Roaming\vibelink\VibeLink Dev\data`; their sockets are `vibelink-prod-daemon-*` and `vibelink-dev-daemon-*`.
- IPC uses `interprocess` local sockets with MessagePack frames and a 4-byte big-endian length prefix.
- Sessions persist under the flavor-specific data root as `sessions.json`. Panes are intentionally not persisted or reconstructed after daemon restart.
- The Kanban Orchestrator panel embeds Hermes Agent through ACP stdio (`hermes-acp`). Each workspace gets its own `HERMES_HOME` under app data, plus `mcp_servers.vibelink` running `app.exe mcp serve` so Hermes can list/read/write panes and update board tasks. Hermes Agent is MIT licensed: https://github.com/NousResearch/hermes-agent.

## UI

- Left workspace drawer: hover the left edge to open, move away to close; create, switch, rename, delete.
- Workspace creation opens a popup for name, native folder selection, recent/favorite folders, and starting template. New panes launched in that workspace use the selected folder as their cwd.
- Templates: 1×1 through 6×2 grid presets. Applying a template is non-destructive: existing panes stay alive, missing panes are added, overflow panes are kept as tabs.
- Topbar: template shortcuts, active font size/profile controls, workspace terminal-buffer clear, and settings.
- Pane header: split right, split down, new tab, maximize, close, and double-click title rename.
- Pane titles follow terminal OSC 0/2 title updates from tools such as Codex, Claude Code, and OMP unless the title was manually renamed.
- Settings dialog: flat terminal-style panels, submenu navigation, Apply/OK/Cancel staging, installed Windows font dropdown with font weight, UI scale, terminal scrollbar visibility, Windows Terminal-inspired themes, and editable Windows Terminal-compatible keybindings that still work while terminal input is focused.

## CLI control

The same binary exposes a lightweight CLI for agents and scripts. A skill can call these commands on demand without any separate integration setup.

```powershell
.\target\debug\app.exe cli sessions
.\target\debug\app.exe cli panes [--session <session-id>]
.\target\debug\app.exe cli read [--session <session-id>] --pane <pane-id>
.\target\debug\app.exe cli write [--session <session-id>] --pane <pane-id> --text "pwd" --enter
.\target\debug\app.exe cli task done --task <task-id> [--session <session-id>] [--pane <pane-id>] [--commit-msg "summary"]
.\target\debug\app.exe cli task note --task <task-id> --message "progress" [--session <session-id>] [--pane <pane-id>]
.\target\debug\app.exe cli skill list [--session <session-id>]
.\target\debug\app.exe cli skill apply --id <skill-id> --content "# Skill\n\nInstructions" [--scope global|workspace] [--session <session-id>]
.\target\debug\app.exe cli skill show <skill-id> [--scope global|workspace] [--session <session-id>]
.\target\debug\app.exe cli skill delete <skill-id> [--scope global|workspace] [--session <session-id>]
.\target\debug\app.exe mcp serve
```

`sessions` and `panes` print JSON. `read` prints pane scrollback with ANSI CSI escape sequences stripped for LLM readability. `write --enter` appends carriage return so PowerShell and shells execute the command. `task done` and `task note` are Kanban callbacks used by assigned agents to move cards to done or append progress notes. `skill` commands manage VibeLink-owned Markdown skills under app data; enabled persisted skills are injected into VibeLink Agent prompts for the matching workspace. The built-in terminal integration skill is `vibelink-terminal`.
VibeLink-launched panes receive `VIBELINK_SESSION_ID`, `VIBELINK_PANE_ID`, `VIBELINK_APP_EXE`, and `VIBELINK_APP_FLAVOR`; `panes`, `read`, `write`, `task`, and workspace-scoped `skill` commands use `VIBELINK_SESSION_ID` when `--session` is omitted, so agents should run `$env:VIBELINK_APP_EXE cli ...` and stay current-workspace scoped instead of scanning every workspace. Spawned PTYs advertise `TERM_PROGRAM=VibeLink`.

Core CLI can list sessions and use role-free terminal panes. Task commands, pane-role access, and `mcp serve` require an entitled Pro cache; unlicensed callers receive `VibeLink Pro license required.` rather than an unguarded native operation.

`mcp serve` is the stdio MCP server configured as `mcp_servers.vibelink` in each workspace's Hermes `config.yaml`; it is normally launched by Hermes, not by a user shell. The server requires `VIBELINK_SESSION_ID`, receives `VIBELINK_APP_FLAVOR`, and exposes `vibelink_pane_*`, `vibelink_terminal_grid_launch`, `vibelink_skill_*`, and `vibelink_task_*` tools. The Orchestrator provisions `hermes-agent[acp,mcp]==0.17.0` with bundled `uv`, stores secrets only in `<HERMES_HOME>\.env`, and mirrors Kanban board state to `<appData>\kanban\<session-id>.json`.

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

To force a specific generic CLI command path, set `VIBELINK_SMOKE_CLI` before running the smoke example. Optional whitespace-separated args can be supplied through `VIBELINK_SMOKE_CLI_ARGS`.

```powershell
$env:VIBELINK_SMOKE_CLI = "codex"
$env:VIBELINK_SMOKE_CLI_ARGS = "--version"
cargo run --example smoke_terminal
```
