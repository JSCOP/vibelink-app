# Architecture

VibeLink is a Windows-only Tauri 2 desktop application. It depends directly on Win32 UI Automation, ConPTY, Windows Job Objects, HWND subclassing, Windows Credential Manager, WebView2, and PowerShell. It does not build on macOS or Linux, and cross-platform support is out of scope.

## Runtime at a glance

```text
React + Vite in the Tauri WebView
        │  Tauri invoke commands
        │  one shared terminal event Channel
        ▼
Tauri Rust host (app.exe)
        │  interprocess local socket
        │  protocol.rs MessagePack frames
        ▼
Detached daemon (the same executable with --daemon)
        │
        ├─ workspaces and terminal panes
        ├─ ConPTY processes and scrollback
        ├─ automation and orchestration state
        └─ Remote server
```

### 1. React/Vite frontend

`src/main.tsx` selects the main application or capture overlay and mounts React. `src/App.tsx` starts shared event streams, bootstraps application state, and renders the app shell. Most user actions flow through Zustand state and small wrappers in `src/ipc/` before calling a Tauri command.

The frontend runs inside the Tauri WebView. Vite supplies the development server and production bundle; it is not a separate backend service.

### 2. Tauri Rust host

`src-tauri/src/main.rs` starts the desktop application unless the executable was launched with `--daemon`. `src-tauri/src/app/mod.rs` builds the Tauri host, initializes native services, connects to the daemon, and registers the commands callable from TypeScript.

The host owns work that must remain attached to the desktop process: the OS window, tray, dialogs, notifications, native browser surfaces, capture UI, account sign-in for bug reports, and the bridge between the WebView and daemon.

### 3. Detached daemon

The daemon is the same application executable launched with `--daemon`. Before spawning it, `src-tauri/src/app/spawn_daemon.rs` copies the executable and bundled ConPTY files into the flavor-specific app-data `daemon-bin` directory, so the detached process does not lock the executable in the build or installation directory.

The daemon owns long-lived workspaces, terminal panes, PTYs, scrollback, automation, orchestration, and Remote connections. It can outlive the WebView and Tauri host so reopening the app can reattach to processes that are still running.

#### Daemon identity and replacement

Because the GUI and the daemon are one executable, "is this daemon current?" cannot be asked of the executable's bytes: every rebuild, frontend change, and version bump would answer no, replace the running daemon, and kill every terminal pane with it. `build.rs` therefore fingerprints the daemon-side sources into `VIBELINK_DAEMON_CONTRACT` (include by default, exclude GUI-only modules explicitly), the daemon records it in `daemon-info.json`, and the app replaces a running daemon only when that contract differs from its own. The staged `daemon-bin` copy is keyed by the same contract. `vibelink status --json` reports it as `daemonUpToDate`.

Replacement overlaps two processes, and `src-tauri/src/daemon/handoff.rs` owns that overlap: the outgoing daemon acknowledges the shutdown request before it persists panes and releases `daemon.lock`, so the app waits for the process to actually exit, an incoming daemon waits out a lock a predecessor still holds, and neither deletes pid or identity files that describe the other. A daemon binds its socket last and logs each startup phase at INFO, so a start that outruns the app's readiness budget is readable in `daemon.log`.

## IPC boundaries

### Frontend to Tauri host

TypeScript calls Rust with Tauri `invoke(...)`. The command registry is the `tauri::generate_handler!` list in `src-tauri/src/app/mod.rs`; frontend wrappers live under `src/ipc/`.

Terminal events use one shared `Channel<TerminalEvent>`, registered by `src/ipc/output.ts` through `init_terminal_output` in `src-tauri/src/app/commands.rs`. Pane-scoped events carry a `paneId` and are routed to the matching xterm instance in `src/terminal/TerminalManager.ts`. High-volume PTY bytes use a separate authenticated loopback WebSocket and are multiplexed by pane id, pane generation, and output sequence.

### Tauri host to daemon

The host and daemon communicate over `interprocess` local sockets. `src-tauri/src/protocol.rs` is the wire contract:

- `ClientToDaemon` and `DaemonToClient` define messages in each direction.
- `Req` correlates request and reply messages.
- Frames contain a 4-byte big-endian payload length followed by MessagePack encoded with `rmp-serde`.
- Frames are capped at 16 MiB.
- Connection admission uses a challenge/response proof over a machine-local secret stored through Windows Credential Manager.

`DAEMON_PROTOCOL_VERSION` also lives in `src-tauri/src/protocol.rs`. Bump it whenever a wire message, field, framing rule, or handshake expectation changes. A version mismatch tells the desktop app to replace an incompatible daemon instead of interpreting the wrong contract.

## Frontend directory map

| Directory | What lives there |
| --- | --- |
| `src/terminal/` | xterm instance lifecycle, pane attach/write/resize, output buffering and replay, search, links, geometry, and renderer recovery. |
| `src/layout/` | The Dockview workspace shell, content windows, terminal pane grids, layout persistence, activation, drag/drop, and resize behavior. |
| `src/components/` | React panels, dialogs, settings, Git views, workspaces, Hermes UI, Kanban, automation, capture, status, and shared controls. |
| `src/ipc/` | Typed TypeScript wrappers around Tauri commands and the shared terminal and Hermes event streams. |
| `src/styles/` | Shared and feature-level CSS for app chrome, workspace layout, terminal shell, Git, Kanban, memory, automation, and orchestration. |
| `src/state/` | Zustand stores and state models for workspaces, settings, profiles, Git, explorer data, Hermes, themes, and persisted UI preferences. |
| `src/editor/` | Monaco editor integration, document models, save/conflict handling, navigation, language selection, and theme translation. |
| `src/memory/` | Pure graph construction and layout helpers used by the memory graph UI. |
| `src/browser/` | React presentation and state for native browser content, address bar behavior, page lifecycle, annotations, and device emulation. |
| `src/assets/` | Bundled fonts and static images used by the frontend. |
| `src/notifications/` | Agent-completion sound selection and Windows notification policy. |
| `src/remote/` | Frontend projections for Remote appearance, desktop selection, and phone-owned pane geometry leases. |

## Rust module map

| Module | What lives there |
| --- | --- |
| `src-tauri/src/daemon/` | The detached socket server, workspace and pane state, ConPTY process ownership, persistence, scrollback, automation scheduling, and lifecycle guards. |
| `src-tauri/src/app/` | Tauri host setup, invoke commands, daemon client, native integrations, Git and filesystem services, Hermes ACP, browser hosting, capture, tray, and account-backed bug reports. |
| `src-tauri/src/dedicated_cli/` | The current `vibelink.exe` command grammar, contracts, selectors, output envelopes, control-socket client, browser automation, and bundled agent guides. |
| `src-tauri/src/browser/` | Native browser manager, policy, provider abstraction, WebView2 implementation, page state, snapshots, downloads, and annotations. |
| `src-tauri/src/mcp/` | The workspace-scoped JSON-RPC stdio server that exposes VibeLink tools through the daemon and dedicated CLI command contracts. |
| `src-tauri/src/remote/` | Mobile pairing, device identity, firewall setup, Remote server state, and the v1/v2 protocol bridges. |
| `src-tauri/src/orchestration/` | Durable runs, tasks, dispatches, messages, decision gates, cleanup records, and the coordinator service that mutates them. |
| `src-tauri/src/cli/` | The basic direct-daemon command implementation for sessions, panes, terminal I/O, tasks, and skills; most new CLI surface belongs in `dedicated_cli/`. |
| `src-tauri/src/agent_runtime/` | Agent process runtimes and guarded Git worktree operations used by orchestration. |
| `src-tauri/src/computer_use/` | Framing, policy, provider abstractions, the Windows UI Automation backend, and supervision of the separate computer-use host. |

## Session persistence and flavor isolation

The daemon stores `sessions.json` under its flavor-specific data root. On Windows, the normal roots are:

| Flavor | Data root | Local socket | Main ports |
| --- | --- | --- | --- |
| Release | `%APPDATA%/vibelink/VibeLink/data` | `vibelink-prod-daemon-<user-hash>` | WebView CDP `9333`, browser profiles `9334-9589`, extension bridge `9332`, Remote `42811` |
| Development | `%APPDATA%/vibelink/VibeLink Dev/data` | `vibelink-dev-daemon-<user-hash>` | Vite `1420-1439`, WebView CDP `19333-19363`, browser profiles `19400-19655`, extension bridge `19399`, Remote `42812` |

The split is deliberate: release and development use separate data roots, sockets, daemon executables, credentials, browser profiles, and network ports. Do not point development tooling at release endpoints or copy state between the roots.

`sessions.json` persists workspace metadata, workspace folders, serialized layouts, clean-exit state, and descriptors for panes marked for restore. It does not serialize a live PTY or child process. Panes are deliberately not reconstructed as the same live PTYs on daemon restart: a clean shutdown starts none, while recovery after an unclean exit may launch a fresh process from a saved descriptor and replay retained terminal history. During a normal desktop-host restart, the daemon remains alive and the frontend reattaches to the existing PTYs instead.

## Where to start reading

1. `src/main.tsx` and `src/App.tsx` — frontend bootstrap, global event registration, startup ordering, and the top-level app shell.
2. `src/state/store.ts` — the central frontend workspace and pane lifecycle, settings, persistence, and command coordination.
3. `src/layout/WorkspaceView.tsx` and `src/terminal/TerminalManager.ts` — how Dockview content maps to terminal panes and how each pane maps to an xterm instance and daemon PTY.
4. `src-tauri/src/app/mod.rs` — native service initialization and the complete frontend command registry.
5. `src-tauri/src/protocol.rs` and `src-tauri/src/daemon/bootstrap.rs` — the host/daemon contract, daemon startup order, persistence recovery, and local socket listener.
