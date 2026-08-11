# Agent Operating Rules

VibeLink is an agentic terminal, so a coding agent is a first-class contributor here.
These are the rules that keep an agent's changes safe in this repository. Humans should
read them too; nothing below is agent-specific ceremony.

Start with `docs/ARCHITECTURE.md` for the process/IPC map, `docs/GLOSSARY.md` for the
canonical UI and domain vocabulary, and `CONTRIBUTING.md` for toolchain and PR rules.

## Windows only

The product does not build on macOS or Linux. Win32 UI Automation, ConPTY, Job Objects,
HWND subclassing, the Windows Credential Manager backend, and the PowerShell build scripts
are load-bearing, not incidental. Do not "fix" a compile error by stubbing a Windows API;
cross-platform support is a separate, unstarted project.

## Use the glossary

Any change touching UI, layout, terminals, workspaces, the sidebar, or the remote protocol
MUST use `docs/GLOSSARY.md` terms in code, comments, commits, and PR text. When a request
uses an ambiguous word — `window`, `session`, `tab`, `group`, `pane`, `active` — map it to
the glossary term and say so in one line before editing.

## Process safety

VibeLink spawns and adopts real OS processes: a detached daemon, ConPTY hosts, browser
child processes, and the user's own agent CLIs. Getting cleanup wrong kills a developer's
unrelated work.

- NEVER terminate processes by image name. Not `OpenConsole.exe`, not `node.exe`, not
  `app.exe`, not `cargo.exe`.
- Prove ownership before stopping anything: match the exact executable path inside this
  checkout, or a verified parent/child relationship to a process this checkout started.
- Stop exact PIDs only. If ownership is ambiguous, ask instead of guessing.
- `OpenConsole.exe` is a shared Windows ConPTY host. Only stop a specific PID whose
  ancestor you have confirmed is this VibeLink build.
- Prefer graceful shutdown through the daemon protocol; force-kill only a confirmed leaked
  process that this checkout owns.

## Two runtimes, one machine

A development build (`VibeLink Dev`, identifier `com.vibelink.desktop.dev`) and an
installed release build (`VibeLink`) can run side by side. They deliberately use separate
data roots, daemon sockets, executables, credentials, and ports.

- An installed release runtime is the user's working environment. Never stop it, never
  attach automation to it, and never treat its behavior as evidence about your changes.
- Verify you are talking to the dev runtime before any mutation: the window title is
  exactly `VibeLink Dev`, and `vibelink.exe --json --flavor dev status` reports
  `flavor: "dev"` and `hostProtected: false`. If any signal is missing or contradictory,
  stop rather than guess.
- Never copy, link, or synchronize data roots, session state, sockets, credentials, or
  browser profiles between the two flavors.

## Verify before claiming

- Run the smallest check that actually covers the change, then the relevant gate. The full
  set is in `CONTRIBUTING.md`.
- A UI change needs a real interaction on a running dev build, not a passing unit test.
  Judge layout from a maximized window; a cramped window hides the defect you introduced.
- Most of this repository does not take effect from source. The Rust host, the daemon, the
  CLI, and every `include_str!` resource ship inside the installed app. If your change
  touches them, say plainly that a rebuild and reinstall are required before a user sees it.
- `scripts/check-quality-ratchets.mjs` enforces per-file line budgets and bundle sizes.
  When a file legitimately grows, raise its budget in the same commit with a one-line
  reason. Do not raise a budget to avoid splitting something that should be split.

## Scope discipline

- Fix causes, not symptoms. A guard added in one caller usually belongs in the shared
  function every caller routes through.
- Clean cutover: migrate every caller and delete the old path. No shims, aliases, or dead
  flags left behind.
- Treat unexpected working-tree changes as someone else's in-flight work. Preserve them and
  keep them out of your commits.
- Do not reformat code you did not otherwise change.

## What this repository does not do

- There is no license check, entitlement, trial, or feature gate, and none may be added.
  VibeLink is free software; signing in is optional and exists only to file bug reports.
- The app never writes into a user's repository and never edits their global agent
  configuration. Integration happens through installed skills and session-scoped metadata.
- Telemetry is not collected. A bug report carries only what the user typed plus the app
  version and platform.

## Memory

Durable project knowledge — architecture decisions, regression lessons, and the task ledger
— lives in a separate private repository and is not part of this one. Contributors do not
need it; everything required to build, test, and change VibeLink is in this repository and
its documentation. If something needed to make a correct change is missing here, that is a
documentation bug worth reporting.
