#![allow(dead_code)]

use anyhow::{bail, Context, Result};
use app_lib::{
    app::spawn_daemon,
    protocol::{
        read_frame, write_frame, ClientToDaemon, DaemonToClient, PaneCommandOrigin, PaneConfig,
        ReplyResult,
    },
};
use interprocess::local_socket::{prelude::*, SendHalf as LocalSocketSendHalf};
use std::{
    env,
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::Duration,
};
use uuid::Uuid;

const READ_TIMEOUT: Duration = Duration::from_secs(8);

struct SmokeCase {
    name: String,
    program: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    cwd: Option<String>,
    expected: ExpectedOutput,
}

enum ExpectedOutput {
    Contains(&'static [u8]),
    AnyVisible,
}

enum PlannedCase {
    Run(SmokeCase),
    Skip { name: &'static str, reason: String },
}

struct DaemonConnection {
    writer: LocalSocketSendHalf,
    frames: Receiver<Result<DaemonToClient, String>>,
}

impl DaemonConnection {
    fn connect() -> Result<Self> {
        let stream = spawn_daemon::connect_daemon().or_else(|_| spawn_daemon::ensure_daemon())?;
        let (mut reader, writer) = stream.split();
        let (tx, frames) = mpsc::channel();

        thread::Builder::new()
            .name("vibelink-smoke-reader".to_string())
            .spawn(move || loop {
                match read_frame::<_, DaemonToClient>(&mut reader) {
                    Ok(frame) => {
                        if tx.send(Ok(frame)).is_err() {
                            break;
                        }
                    }
                    Err(err) => {
                        let _ = tx.send(Err(err.to_string()));
                        break;
                    }
                }
            })
            .context("spawn smoke reader thread")?;

        Ok(Self { writer, frames })
    }

    fn send(&mut self, msg: &ClientToDaemon) -> Result<()> {
        write_frame(&mut self.writer, msg).context("write daemon frame")
    }

    fn read_next(&self) -> Result<Option<DaemonToClient>> {
        match self.frames.recv_timeout(READ_TIMEOUT) {
            Ok(Ok(frame)) => Ok(Some(frame)),
            Ok(Err(err)) => bail!("read daemon frame: {err}"),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => bail!("daemon reader disconnected"),
        }
    }
}

fn main() -> Result<()> {
    let mut daemon = DaemonConnection::connect()?;
    let session_id = create_session(&mut daemon, "Smoke")?;

    let mut failures = Vec::new();
    let mut passed = 0usize;
    let mut skipped = 0usize;

    for planned in planned_cases()? {
        match planned {
            PlannedCase::Run(case) => match run_case(&mut daemon, session_id, &case) {
                Ok(sample) => {
                    passed += 1;
                    println!("PASS {} via {}: {}", case.name, case.program, sample);
                }
                Err(err) => failures.push(format!("{} via {}: {err:#}", case.name, case.program)),
            },
            PlannedCase::Skip { name, reason } => {
                skipped += 1;
                println!("SKIP {name}: {reason}");
            }
        }
    }

    if let Err(err) = delete_session(&mut daemon, session_id) {
        failures.push(format!("cleanup Smoke session: {err:#}"));
    }

    println!("smoke profile launch summary: {passed} passed, {skipped} skipped");
    if failures.is_empty() {
        Ok(())
    } else {
        bail!(
            "{} smoke case(s) failed:\n{}",
            failures.len(),
            failures.join("\n")
        )
    }
}

fn create_session(daemon: &mut DaemonConnection, name: &str) -> Result<Uuid> {
    match request_reply(
        daemon,
        1,
        ClientToDaemon::CreateSession {
            req: 1,
            name: name.to_string(),
            workspace_folder: None,
        },
    )? {
        ReplyResult::SessionCreated(meta) => Ok(meta.id),
        other => bail!("unexpected create response: {other:?}"),
    }
}

fn delete_session(daemon: &mut DaemonConnection, session_id: Uuid) -> Result<()> {
    match request_reply(
        daemon,
        3,
        ClientToDaemon::DeleteSession { req: 3, session_id },
    )? {
        ReplyResult::Ok => Ok(()),
        other => bail!("unexpected delete response: {other:?}"),
    }
}

fn planned_cases() -> Result<Vec<PlannedCase>> {
    let cwd = Some(env::current_dir()?.to_string_lossy().into_owned());
    let mut cases = Vec::new();

    #[cfg(windows)]
    {
        if let Some(cmd) = resolve_windows_cmd() {
            cases.push(PlannedCase::Run(SmokeCase {
                name: "cmd.exe profile command".to_string(),
                program: cmd.to_string_lossy().into_owned(),
                args: vec![
                    "/D".to_string(),
                    "/Q".to_string(),
                    "/C".to_string(),
                    "echo VIBELINK_PROFILE_CMD:%VIBELINK_SMOKE_PROFILE%".to_string(),
                ],
                env: vec![("VIBELINK_SMOKE_PROFILE".to_string(), "cmd".to_string())],
                cwd: cwd.clone(),
                expected: ExpectedOutput::Contains(b"VIBELINK_PROFILE_CMD:cmd"),
            }));
        } else {
            cases.push(PlannedCase::Skip {
                name: "cmd.exe profile command",
                reason: "cmd.exe was not found through COMSPEC or PATH".to_string(),
            });
        }

        if let Some(pwsh) = resolve_program("pwsh.exe").or_else(|| resolve_program("pwsh")) {
            cases.push(PlannedCase::Run(SmokeCase {
                name: "pwsh profile command".to_string(),
                program: pwsh.to_string_lossy().into_owned(),
                args: vec![
                    "-NoLogo".to_string(),
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-Command".to_string(),
                    "Write-Output \"VIBELINK_PROFILE_PWSH:$env:VIBELINK_SMOKE_PROFILE\""
                        .to_string(),
                ],
                env: vec![("VIBELINK_SMOKE_PROFILE".to_string(), "pwsh".to_string())],
                cwd: cwd.clone(),
                expected: ExpectedOutput::Contains(b"VIBELINK_PROFILE_PWSH:pwsh"),
            }));
        } else {
            cases.push(PlannedCase::Skip {
                name: "pwsh profile command",
                reason: "pwsh.exe was not found on PATH".to_string(),
            });
        }
    }

    #[cfg(not(windows))]
    {
        if Path::new("/bin/sh").is_file() {
            cases.push(PlannedCase::Run(SmokeCase {
                name: "sh profile command".to_string(),
                program: "/bin/sh".to_string(),
                args: vec![
                    "-lc".to_string(),
                    "printf 'VIBELINK_PROFILE_SH:%s\\n' \"$VIBELINK_SMOKE_PROFILE\"".to_string(),
                ],
                env: vec![("VIBELINK_SMOKE_PROFILE".to_string(), "sh".to_string())],
                cwd: cwd.clone(),
                expected: ExpectedOutput::Contains(b"VIBELINK_PROFILE_SH:sh"),
            }));
        } else {
            cases.push(PlannedCase::Skip {
                name: "sh profile command",
                reason: "/bin/sh was not found".to_string(),
            });
        }
    }

    cases.push(generic_cli_case(cwd));
    Ok(cases)
}

fn generic_cli_case(cwd: Option<String>) -> PlannedCase {
    if let Ok(program) = env::var("VIBELINK_SMOKE_CLI") {
        let args = env::var("VIBELINK_SMOKE_CLI_ARGS")
            .map(|value| value.split_whitespace().map(str::to_string).collect())
            .unwrap_or_else(|_| vec!["--version".to_string()]);
        return match resolve_program(&program) {
            Some(path) => PlannedCase::Run(SmokeCase {
                name: "generic CLI from VIBELINK_SMOKE_CLI".to_string(),
                program: path.to_string_lossy().into_owned(),
                args,
                env: Vec::new(),
                cwd,
                expected: ExpectedOutput::AnyVisible,
            }),
            None => PlannedCase::Skip {
                name: "generic CLI from VIBELINK_SMOKE_CLI",
                reason: format!("{program} was not found"),
            },
        };
    }

    for candidate in ["claude", "codex", "omp"] {
        if let Some(path) = resolve_program(candidate) {
            return PlannedCase::Run(SmokeCase {
                name: format!("generic CLI candidate {candidate}"),
                program: path.to_string_lossy().into_owned(),
                args: vec!["--version".to_string()],
                env: Vec::new(),
                cwd,
                expected: ExpectedOutput::AnyVisible,
            });
        }
    }

    PlannedCase::Skip {
        name: "generic CLI command path",
        reason: "none of claude, codex, or omp were found; set VIBELINK_SMOKE_CLI to a command path to exercise this case".to_string(),
    }
}

fn run_case(daemon: &mut DaemonConnection, session_id: Uuid, case: &SmokeCase) -> Result<String> {
    let pane_id = Uuid::new_v4();
    let cfg = PaneConfig {
        pane_id,
        shell: Some(case.program.clone()),
        args: case.args.clone(),
        cwd: case.cwd.clone(),
        env: case.env.clone(),
        title: Some(case.name.clone()),
        icon: None,
        profile_id: None,
        role: None,
        cols: 80,
        rows: 24,
        restore_on_start: false,
    };

    match request_reply(
        daemon,
        2,
        ClientToDaemon::SpawnPane {
            req: 2,
            session_id,
            cfg,
            attach: false,
        },
    )? {
        ReplyResult::PaneSpawned(meta) if meta.id == pane_id => {
            if meta.config.shell.as_ref() != Some(&case.program)
                || meta.config.args != case.args
                || meta.config.env != case.env
                || meta.config.cwd != case.cwd
            {
                bail!(
                    "spawned pane config did not preserve the requested profile fields: {meta:?}"
                );
            }
        }
        other => bail!("unexpected spawn response: {other:?}"),
    }

    match request_reply(
        daemon,
        3,
        ClientToDaemon::AttachPane {
            req: 3,
            session_id,
            pane_id,
        },
    )? {
        ReplyResult::Ok => {}
        other => bail!("unexpected attach response: {other:?}"),
    }
    let output = collect_output(daemon, session_id, pane_id, &case.expected)
        .with_context(|| format!("capture output for {}", case.name))?;
    Ok(sample_output(&output))
}

fn request_reply(
    daemon: &mut DaemonConnection,
    req: u64,
    msg: ClientToDaemon,
) -> Result<ReplyResult> {
    daemon.send(&msg)?;
    loop {
        match daemon.read_next()? {
            Some(DaemonToClient::Reply {
                req: reply_req,
                result,
            }) if reply_req == req => return Ok(result),
            Some(DaemonToClient::Error { message, .. }) => bail!(message),
            Some(DaemonToClient::Output { .. } | DaemonToClient::PaneExited { .. }) => {}
            Some(other) => {
                bail!("unexpected daemon response while waiting for req {req}: {other:?}")
            }
            None => bail!("daemon request {req} timed out"),
        }
    }
}

fn collect_output(
    daemon: &mut DaemonConnection,
    session_id: Uuid,
    pane_id: Uuid,
    expected: &ExpectedOutput,
) -> Result<String> {
    let mut collected = Vec::new();

    for _ in 0..64 {
        match daemon.read_next()? {
            Some(DaemonToClient::Output {
                pane_id: out_pane,
                data,
                ..
            }) if out_pane == pane_id => {
                collected.extend_from_slice(&data);
                if data
                    .windows(b"\x1b[6n".len())
                    .any(|window| window == b"\x1b[6n")
                {
                    daemon.send(&ClientToDaemon::WritePane {
                        req: 4,
                        session_id,
                        pane_id,
                        data: b"\x1b[1;1R".to_vec(),
                        origin: PaneCommandOrigin::Desktop,
                    })?;
                }
                if expected.matches(&collected) {
                    return Ok(String::from_utf8_lossy(&collected).into_owned());
                }
            }
            Some(DaemonToClient::PaneExited {
                pane_id: out_pane, ..
            }) if out_pane == pane_id => {
                if expected.matches(&collected) {
                    return Ok(String::from_utf8_lossy(&collected).into_owned());
                }
                break;
            }
            Some(DaemonToClient::Reply {
                req: 4,
                result: ReplyResult::Ok,
            }) => {}
            Some(DaemonToClient::Error { message, .. }) => bail!(message),
            Some(DaemonToClient::Output { .. } | DaemonToClient::PaneExited { .. }) => {}
            Some(other) => bail!("unexpected terminal frame: {other:?}"),
            None => break,
        }
    }

    bail!(
        "expected output was not captured; collected: {}",
        String::from_utf8_lossy(&collected)
    )
}

impl ExpectedOutput {
    fn matches(&self, bytes: &[u8]) -> bool {
        match self {
            ExpectedOutput::Contains(needle) => {
                bytes.windows(needle.len()).any(|window| window == *needle)
            }
            ExpectedOutput::AnyVisible => plain_text(bytes).chars().any(|ch| !ch.is_whitespace()),
        }
    }
}

#[cfg(windows)]
fn resolve_windows_cmd() -> Option<PathBuf> {
    env::var_os("ComSpec")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .or_else(|| resolve_program("cmd.exe"))
}

fn resolve_program(program: &str) -> Option<PathBuf> {
    let path = Path::new(program);
    if path.components().count() > 1 {
        return path.is_file().then(|| path.to_path_buf());
    }

    let path_var = env::var_os("PATH")?;
    for dir in env::split_paths(&path_var) {
        for candidate in executable_candidates(&dir, program) {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(windows)]
fn executable_candidates(dir: &Path, program: &str) -> Vec<PathBuf> {
    if Path::new(program).extension().is_some() {
        return vec![dir.join(program)];
    }

    let mut candidates = vec![dir.join(program)];
    let pathext = env::var_os("PATHEXT")
        .and_then(|value| value.into_string().ok())
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());
    for ext in pathext.split(';').filter(|ext| !ext.is_empty()) {
        candidates.push(dir.join(format!("{program}{ext}")));
    }
    candidates
}

#[cfg(not(windows))]
fn executable_candidates(dir: &Path, program: &str) -> Vec<PathBuf> {
    vec![dir.join(program)]
}

fn sample_output(output: &str) -> String {
    let sample = plain_text(output.as_bytes())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut truncated = sample.chars().take(160).collect::<String>();
    if truncated.len() < sample.len() {
        truncated.push_str("...");
    }
    truncated
}

fn plain_text(bytes: &[u8]) -> String {
    let mut text = String::new();
    let mut index = 0usize;

    while index < bytes.len() {
        match bytes[index] {
            0x1b => {
                index += 1;
                if index >= bytes.len() {
                    break;
                }
                match bytes[index] {
                    b'[' => {
                        index += 1;
                        while index < bytes.len() {
                            let byte = bytes[index];
                            index += 1;
                            if (0x40..=0x7e).contains(&byte) {
                                break;
                            }
                        }
                    }
                    b']' => {
                        index += 1;
                        while index < bytes.len() {
                            if bytes[index] == 0x07 {
                                index += 1;
                                break;
                            }
                            if bytes[index] == 0x1b
                                && index + 1 < bytes.len()
                                && bytes[index + 1] == b'\\'
                            {
                                index += 2;
                                break;
                            }
                            index += 1;
                        }
                    }
                    _ => index += 1,
                }
            }
            b'\r' | b'\n' | b'\t' => {
                text.push(' ');
                index += 1;
            }
            0x20..=0x7e => {
                text.push(bytes[index] as char);
                index += 1;
            }
            _ => index += 1,
        }
    }

    text
}
