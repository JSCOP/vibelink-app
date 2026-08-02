# SSH Execution Host Spike

Date: 2026-08-02

## Verdict: NO-GO

SSH execution hosts remain unbuilt. No LAN target and remote repository were configured through `VIBELINK_SSH_SPIKE_TARGET` and `VIBELINK_SSH_SPIKE_REPO`, so none of the five required operations has real-host evidence and the under-500 ms gate is unproven.

This is intentionally a no-go rather than a partial remote workspace: Explorer, Git, terminals, and previews must never disagree about whether a path is local or remote.

## Evidence

The ignored integration test compiles:

```text
cargo test --test ssh_host_spike --no-run
Finished; ssh_host_spike test executable produced.
```

The required run was attempted:

```text
cargo test --test ssh_host_spike -- --ignored --nocapture
VIBELINK_SSH_SPIKE_TARGET must be set for the ignored SSH spike
```

| Operation | Result | Latency | Failure mode / proof required |
| --- | --- | ---: | --- |
| SFTP write and byte-identical read | Not run | Not measured | Must upload, download, remove, and compare a 4 KiB binary payload. |
| Interactive `ssh -tt` command | Not run | Not measured | Must return the interactive marker through a forced TTY. |
| Remote Git status and HEAD | Not run | Not measured | Must run `git status --porcelain` and return a hexadecimal `git rev-parse HEAD`. |
| Kill and reconnect | Not run | Not measured | Must establish a session, kill only the owned local SSH client, reconnect, and resume a command. |
| Changed host-key refusal | Not run | Not measured | Must reject a spike-local wrong `known_hosts` entry with an explicit verification failure. |

## Test contract

File: `src-tauri/tests/ssh_host_spike.rs`

The test uses Windows-bundled `ssh.exe`, `sftp.exe`, and `ssh-keygen.exe`; it adds no SSH crate. Authentication must already work non-interactively through the user's OpenSSH configuration or agent. A go verdict requires every operation to pass and each measured latency to remain below 500 ms.

Run against a disposable LAN host and repository:

```powershell
$env:VIBELINK_SSH_SPIKE_TARGET = 'user@host'
$env:VIBELINK_SSH_SPIKE_REPO = '/absolute/remote/repository'
cargo test --test ssh_host_spike -- --ignored --nocapture
```

Do not add a `RemoteHost` abstraction or renderer surface until this document can be replaced with five passing measurements and a go verdict.
