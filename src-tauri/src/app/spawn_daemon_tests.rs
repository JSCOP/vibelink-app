use super::*;
use crate::protocol::{constant_time_eq, read_frame, write_frame};
use std::io::{Cursor, Read, Result as IoResult, Write};
#[cfg(windows)]
struct TempDir {
    path: PathBuf,
}

#[cfg(windows)]
impl TempDir {
    fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(windows)]
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[cfg(windows)]
fn tempdir() -> io::Result<TempDir> {
    let path = std::env::temp_dir().join(format!(
        "vibelink-spawn-conpty-test-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    fs::create_dir(&path)?;
    Ok(TempDir { path })
}
#[cfg(windows)]
#[test]
fn conpty_bundle_is_copied_into_fresh_daemon_bin() {
    let source = tempdir().expect("create source dir");
    let destination_root = tempdir().expect("create destination root");
    let destination = destination_root.path().join(DAEMON_BIN_DIR);
    fs::write(source.path().join(CONPTY_FILES[0]), b"dll bytes").expect("write dll");
    fs::write(source.path().join(CONPTY_FILES[1]), b"console bytes").expect("write console host");

    copy_conpty_bundle_from_candidates([source.path().to_path_buf()], &destination)
        .expect("copy bundle");

    assert_eq!(
        fs::read(destination.join(CONPTY_FILES[0])).expect("read copied dll"),
        b"dll bytes"
    );
    assert_eq!(
        fs::read(destination.join(CONPTY_FILES[1])).expect("read copied console host"),
        b"console bytes"
    );
}

#[cfg(windows)]
#[test]
#[allow(clippy::permissions_set_readonly_false)]
fn identical_conpty_bundle_files_are_left_untouched() {
    let source = tempdir().expect("create source dir");
    let destination = tempdir().expect("create destination dir");
    for file_name in CONPTY_FILES {
        fs::write(source.path().join(file_name), b"identical bytes").expect("write source");
        let target = destination.path().join(file_name);
        fs::write(&target, b"identical bytes").expect("write destination");
        let mut permissions = fs::metadata(&target)
            .expect("destination metadata")
            .permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&target, permissions).expect("make destination read-only");
    }

    copy_conpty_bundle_from_candidates([source.path().to_path_buf()], destination.path())
        .expect("identical bundle is a no-op");

    for file_name in CONPTY_FILES {
        let target = destination.path().join(file_name);
        assert_eq!(
            fs::read(&target).expect("read destination"),
            b"identical bytes"
        );
        let mut permissions = fs::metadata(&target)
            .expect("destination metadata")
            .permissions();
        permissions.set_readonly(false);
        fs::set_permissions(target, permissions).expect("restore destination permissions");
    }
}

#[cfg(windows)]
#[test]
fn missing_conpty_source_is_a_successful_noop() {
    let missing = tempdir().expect("create missing source parent");
    let destination = tempdir().expect("create destination dir");

    copy_conpty_bundle_from_candidates([missing.path().join("not-present")], destination.path())
        .expect("missing source must not block daemon startup");

    for file_name in CONPTY_FILES {
        assert!(!destination.path().join(file_name).exists());
    }
}

#[cfg(windows)]
#[test]
fn daemon_cleanup_keeps_conpty_bundle_files() {
    let temp = tempdir().expect("create daemon bin dir");
    let current = temp.path().join(format!(
        "{}-{}-current.exe",
        DAEMON_EXE_PREFIX,
        paths::app_flavor()
    ));
    let old = temp.path().join(format!(
        "{}-{}-old.exe",
        DAEMON_EXE_PREFIX,
        paths::app_flavor()
    ));
    fs::write(&current, b"current").expect("write current daemon");
    fs::write(&old, b"old").expect("write old daemon");
    for file_name in CONPTY_FILES {
        fs::write(temp.path().join(file_name), b"bundle").expect("write bundle file");
    }

    cleanup_old_daemon_executables(temp.path(), &current);

    assert!(current.exists());
    assert!(!old.exists());
    for file_name in CONPTY_FILES {
        assert!(temp.path().join(file_name).exists());
    }
}

struct ScriptedStream {
    read: Cursor<Vec<u8>>,
    written: Vec<u8>,
}

impl ScriptedStream {
    fn with_response(response: DaemonToClient) -> Self {
        let mut read_bytes = Vec::new();
        write_frame(&mut read_bytes, &response).expect("encode scripted response");
        Self {
            read: Cursor::new(read_bytes),
            written: Vec::new(),
        }
    }

    fn with_responses(responses: &[DaemonToClient]) -> Self {
        let mut read_bytes = Vec::new();
        for response in responses {
            write_frame(&mut read_bytes, response).expect("encode scripted response");
        }
        Self {
            read: Cursor::new(read_bytes),
            written: Vec::new(),
        }
    }

    fn written_messages(&self) -> Vec<ClientToDaemon> {
        let mut cursor = Cursor::new(self.written.clone());
        let mut messages = Vec::new();
        while cursor.position() < cursor.get_ref().len() as u64 {
            messages.push(read_frame(&mut cursor).expect("decode written request"));
        }
        messages
    }

    fn written_message(&self) -> ClientToDaemon {
        read_frame(&mut Cursor::new(self.written.clone())).expect("decode written request")
    }
}

impl Read for ScriptedStream {
    fn read(&mut self, buf: &mut [u8]) -> IoResult<usize> {
        self.read.read(buf)
    }
}

impl Write for ScriptedStream {
    fn write(&mut self, buf: &[u8]) -> IoResult<usize> {
        self.written.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> IoResult<()> {
        Ok(())
    }
}

#[test]
fn authenticated_client_sends_valid_current_proof() {
    let secret = [0x44_u8; 32];
    let client_id = Uuid::new_v4();
    let boot_id = Uuid::new_v4();
    let nonce = [0x33_u8; 32];
    let challenge = DaemonToClient::Challenge {
        protocol_version: DAEMON_PROTOCOL_VERSION,
        boot_id,
        nonce,
        expires_at_unix_ms: unix_time_millis_for_test() + 3_000,
    };
    let authenticated = DaemonToClient::Authenticated;
    let mut stream = ScriptedStream::with_responses(&[challenge, authenticated]);

    let result =
        authenticate_daemon_stream_with_client_id(&mut stream, ClientKind::Cli, &secret, client_id)
            .expect("valid proof accepted");
    let messages = stream.written_messages();

    assert_eq!(result, AuthenticatedDaemon);
    assert_eq!(
        messages[0],
        ClientToDaemon::Hello {
            protocol_version: DAEMON_PROTOCOL_VERSION,
            client_id,
            client_kind: ClientKind::Cli,
        }
    );
    let ClientToDaemon::Authenticate {
        client_id: proof_client_id,
        proof,
    } = messages[1]
    else {
        panic!("second frame must authenticate");
    };
    assert_eq!(proof_client_id, client_id);
    assert!(constant_time_eq(
        &proof,
        &daemon_auth_proof(
            &secret,
            DAEMON_PROTOCOL_VERSION,
            boot_id,
            &nonce,
            client_id,
            ClientKind::Cli,
        )
    ));
}

#[test]
fn authenticated_client_rejects_expired_challenge_without_sending_proof() {
    let challenge = DaemonToClient::Challenge {
        protocol_version: DAEMON_PROTOCOL_VERSION,
        boot_id: Uuid::new_v4(),
        nonce: [5_u8; 32],
        expires_at_unix_ms: unix_time_millis_for_test() - 1,
    };
    let mut stream = ScriptedStream::with_responses(&[challenge]);
    let error = authenticate_daemon_stream_with_client_id(
        &mut stream,
        ClientKind::App,
        &[6_u8; 32],
        Uuid::new_v4(),
    )
    .expect_err("expired challenge must fail");

    assert_eq!(error.to_string(), DAEMON_AUTH_REQUIRED);
    assert_eq!(stream.written_messages().len(), 1);
}

fn unix_time_millis_for_test() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[test]
fn ping_probe_writes_ping_and_requires_matching_pong() {
    let mut stream = ScriptedStream::with_response(DaemonToClient::Pong {
        req: STARTUP_PING_REQ,
    });

    ping_daemon_io(&mut stream).expect("matching pong should pass startup probe");

    assert_eq!(
        stream.written_message(),
        ClientToDaemon::Ping {
            req: STARTUP_PING_REQ
        }
    );
}

#[test]
fn ping_probe_rejects_non_matching_response() {
    let mut stream = ScriptedStream::with_response(DaemonToClient::Pong {
        req: STARTUP_PING_REQ + 1,
    });

    let err = ping_daemon_io(&mut stream).expect_err("mismatched pong must reject stale daemon");

    assert!(err.to_string().contains("unexpected startup ping response"));
}

#[test]
fn daemon_step_timeout_returns_without_waiting_for_blocked_io() {
    let started = Instant::now();
    let error = run_daemon_step_with_timeout(
        (),
        Duration::from_millis(25),
        "vibelink-daemon-timeout-test",
        "daemon timeout test",
        |_| {
            thread::sleep(Duration::from_millis(500));
            Ok(())
        },
    )
    .expect_err("blocked daemon step must time out");

    assert!(error.to_string().contains("timed out after 25ms"));
    assert!(started.elapsed() < Duration::from_millis(250));
}

#[cfg(windows)]
#[test]
fn windows_detached_flags_match_process_contract() {
    assert_eq!(
        windows_creation_flags(true),
        0x0800_0000 | 0x0000_0008 | 0x0000_0200 | 0x0100_0000
    );
    assert_eq!(
        windows_creation_flags(false),
        0x0800_0000 | 0x0000_0008 | 0x0000_0200
    );
}

#[cfg(windows)]
#[test]
fn breakaway_fallback_is_limited_to_permission_denied() {
    let denied: anyhow::Result<()> = Err(std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        "job does not allow breakaway",
    ))
    .context("spawn detached daemon");
    let not_found = anyhow::Error::new(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "missing exe",
    ));

    let denied = denied.expect_err("permission denied error");

    assert!(should_retry_without_breakaway(&denied));
    assert!(!should_retry_without_breakaway(&not_found));
}

#[test]
fn parse_daemon_pid_accepts_trimmed_positive_pid() {
    assert_eq!(parse_daemon_pid(" 42\n").expect("parse pid"), Some(42));
    assert_eq!(parse_daemon_pid("\n").expect("empty pid"), None);
}

#[test]
fn parse_daemon_pid_rejects_zero_and_invalid_values() {
    assert!(parse_daemon_pid("0").is_err());
    assert!(parse_daemon_pid("not-a-pid").is_err());
}

#[test]
fn failed_termination_is_complete_when_pid_already_exited() {
    assert!(termination_attempt_completed(false, false));
    assert!(!termination_attempt_completed(false, true));
    assert!(termination_attempt_completed(true, true));
}

#[test]
fn shutdown_missing_pid_file_is_noop() {
    let path = std::env::temp_dir().join(format!(
        "vibelink-missing-daemon-{}-{}.pid",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));

    assert!(!shutdown_daemon_from_pid_file(&path).expect("missing pid is ok"));
}

/// A daemon acknowledges the shutdown request before it persists panes, kills
/// their process trees, and releases `daemon.lock`. Spawning the replacement on
/// the acknowledgement raced the teardown: the replacement lost the lock, quit,
/// and the app — which had just killed the only daemon — ran out its startup
/// budget and died. The caller waits for the process to be gone instead.
#[cfg(windows)]
#[test]
fn waiting_for_a_daemon_to_exit_reports_exit_and_survival() {
    let mut child = Command::new("cmd.exe")
        .args(["/C", "exit"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn short-lived process");
    let exiting = child.id();
    assert!(wait_for_daemon_exit(exiting, Duration::from_secs(5)).expect("wait for exit"));
    let _ = child.wait();

    let own_pid = std::process::id();
    assert!(!wait_for_daemon_exit(own_pid, Duration::from_millis(150))
        .expect("wait for a live process"));
}

#[test]
fn stale_recovery_is_limited_to_unhealthy_existing_daemon() {
    let connect_error = StartupAttemptError::connect(anyhow!("connect failed"));
    let unhealthy_error = StartupAttemptError::unhealthy(anyhow!("probe failed"));

    assert!(!connect_error.should_recover_stale_daemon());
    assert!(unhealthy_error.should_recover_stale_daemon());
}

/// Shipped once as an executable-bytes comparison, and every reinstall then
/// replaced the daemon: the GUI and the daemon are one binary, so a frontend
/// change, a version bump, or a plain rebuild all produced a "new" daemon and
/// killed the user's terminal panes. Only the daemon contract may decide this.
#[test]
fn daemon_staleness_follows_the_daemon_contract_not_the_app_build() {
    let expected_contract = "0004a1-1122334455667788";
    let matching = paths::DaemonInfo {
        version: "0.5.24".to_string(),
        exe: PathBuf::from(r"C:\VibeLink\daemon-bin\app-daemon-prod-current.exe"),
        pid: 35_588,
        contract: expected_contract.to_string(),
    };
    // Older app build, different executable, same daemon behaviour: keep it.
    let older_app_same_daemon = paths::DaemonInfo {
        version: "0.4.18".to_string(),
        exe: PathBuf::from(r"C:\VibeLink\daemon-bin\app-daemon-prod-older.exe"),
        ..matching.clone()
    };
    let changed_daemon = paths::DaemonInfo {
        contract: "0004a1-8877665544332211".to_string(),
        ..matching.clone()
    };
    // An identity file written before the contract field existed.
    let legacy = paths::DaemonInfo {
        contract: String::new(),
        ..matching.clone()
    };

    assert!(!daemon_info_is_stale(Some(&matching), expected_contract));
    assert!(!daemon_info_is_stale(
        Some(&older_app_same_daemon),
        expected_contract
    ));
    assert!(daemon_info_is_stale(
        Some(&changed_daemon),
        expected_contract
    ));
    assert!(daemon_info_is_stale(Some(&legacy), expected_contract));
    assert!(daemon_info_is_stale(None, expected_contract));
}

/// Shipped once and caused a live daemon restart loop. The identity comparison
/// is against `current_exe`, and `vibelink.exe` is not `app.exe`, so a CLI call
/// judged the app's daemon stale, killed it, and spawned itself as the daemon;
/// the app then judged THAT stale and killed it back. Every cycle destroyed the
/// user's terminal panes. Only the app owns daemon lifecycle.
#[test]
fn only_the_app_may_replace_a_daemon() {
    for kind in [ClientKind::Cli, ClientKind::Remote] {
        assert!(
            !client_kind_may_replace_daemon(kind),
            "{kind:?} must never replace a running daemon"
        );
    }
    assert!(client_kind_may_replace_daemon(ClientKind::App));
}

#[test]
fn spawned_daemon_cleanup_removes_only_matching_pid_file() {
    let path = std::env::temp_dir().join(format!(
        "vibelink-spawned-daemon-{}-{}.pid",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    fs::write(&path, "42").expect("write pid");

    assert!(!remove_pid_file_if_matching(&path, 7).expect("non-matching pid check"));
    assert!(path.exists());
    assert!(remove_pid_file_if_matching(&path, 42).expect("matching pid check"));
    assert!(!path.exists());
}

#[test]
fn stale_recovery_does_not_kill_daemon_spawned_by_current_startup() {
    let unhealthy_error = StartupAttemptError::unhealthy(anyhow!("probe failed"));

    assert!(should_recover_stale_daemon(&unhealthy_error, false, false));
    assert!(!should_recover_stale_daemon(&unhealthy_error, true, false));
    assert!(!should_recover_stale_daemon(&unhealthy_error, false, true));
}

#[test]
fn unrecorded_recovery_requires_stale_process_evidence() {
    let connect_error = StartupAttemptError::connect(anyhow!("connect failed"));
    let unhealthy_error = StartupAttemptError::unhealthy(anyhow!("probe failed"));

    assert!(!should_recover_unrecorded_stale_daemon(
        &connect_error,
        false,
        false,
        RecordedDaemonState::Missing,
        None,
    ));
    assert!(should_recover_unrecorded_stale_daemon(
        &connect_error,
        false,
        false,
        RecordedDaemonState::Dead,
        None,
    ));
    assert!(should_recover_unrecorded_stale_daemon(
        &unhealthy_error,
        false,
        false,
        RecordedDaemonState::Missing,
        None,
    ));
    assert!(!should_recover_unrecorded_stale_daemon(
        &unhealthy_error,
        false,
        false,
        RecordedDaemonState::Alive,
        Some(RECORDED_UNHEALTHY_RECOVERY_DELAY - Duration::from_millis(1)),
    ));
    assert!(should_recover_unrecorded_stale_daemon(
        &unhealthy_error,
        false,
        false,
        RecordedDaemonState::Alive,
        Some(RECORDED_UNHEALTHY_RECOVERY_DELAY),
    ));
    assert!(!should_recover_unrecorded_stale_daemon(
        &unhealthy_error,
        true,
        false,
        RecordedDaemonState::Dead,
        None,
    ));
    assert!(!should_recover_unrecorded_stale_daemon(
        &unhealthy_error,
        false,
        true,
        RecordedDaemonState::Dead,
        None,
    ));
}

#[test]
fn unrecorded_recovery_after_spawn_exit_accepts_missing_or_dead_pid_record() {
    assert!(should_recover_unrecorded_after_spawn_exit(
        false,
        RecordedDaemonState::Dead
    ));
    assert!(should_recover_unrecorded_after_spawn_exit(
        false,
        RecordedDaemonState::Missing
    ));
    assert!(!should_recover_unrecorded_after_spawn_exit(
        true,
        RecordedDaemonState::Dead
    ));
}

#[test]
fn unhealthy_probe_after_spawn_keeps_retrying_until_deadline() {
    let unhealthy_error = StartupAttemptError::unhealthy(anyhow!("probe timed out"));

    assert!(should_retry_startup_attempt(&unhealthy_error, true));
    assert!(!should_retry_startup_attempt(&unhealthy_error, false));
}

/// `build.rs` must keep emitting the fingerprint: an empty contract would make
/// every daemon look current and never replace one that actually changed.
#[test]
fn the_build_emits_a_daemon_contract() {
    let contract = paths::daemon_contract();

    assert!(contract.contains('-'), "contract shape: {contract}");
    let (bytes, hash) = contract.split_once('-').expect("contract separator");
    assert!(u64::from_str_radix(bytes, 16).expect("hashed byte count") > 0);
    assert_eq!(hash.len(), 16);
}

#[test]
fn socket_name_converts_to_namespaced_socket_name() {
    let name = socket_name().expect("namespaced socket name");

    assert!(format!("{name:?}").contains(&format!("vibelink-{}-daemon", paths::app_flavor())));
}

#[cfg(windows)]
#[test]
fn daemon_executable_copy_uses_data_dir_instead_of_source_exe() {
    let temp = std::env::temp_dir().join(format!(
        "vibelink-daemon-copy-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let source = temp.join("target").join("debug").join("app.exe");
    let data_dir = temp.join("data");
    fs::create_dir_all(source.parent().expect("source parent")).expect("create source dir");
    fs::write(&source, b"fake exe bytes").expect("write source exe");

    let daemon_exe = prepare_daemon_executable_in(&source, &data_dir).expect("prepare daemon exe");

    assert!(daemon_exe.starts_with(daemon_bin_dir(&data_dir)));
    assert_ne!(daemon_exe, source);
    assert_eq!(
        fs::read(&daemon_exe).expect("read copied daemon exe"),
        b"fake exe bytes"
    );
    assert!(daemon_exe
        .file_name()
        .and_then(|name| name.to_str())
        .expect("daemon exe file name")
        .starts_with(&format!("{}-{}-", DAEMON_EXE_PREFIX, paths::app_flavor())));

    let _ = fs::remove_dir_all(temp);
}

/// The staged daemon is keyed by contract, so a rebuilt app whose daemon
/// sources did not change reuses the copy already on disk instead of writing
/// ~45 MB again while the window is frozen waiting for it.
#[cfg(windows)]
#[test]
fn a_rebuilt_app_reuses_the_staged_daemon_for_the_same_contract() {
    let temp = std::env::temp_dir().join(format!(
        "vibelink-daemon-restage-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let source = temp.join("target").join("debug").join("app.exe");
    let data_dir = temp.join("data");
    fs::create_dir_all(source.parent().expect("source parent")).expect("create source dir");
    fs::write(&source, b"first app build").expect("write source exe");

    let first = prepare_daemon_executable_in(&source, &data_dir).expect("stage daemon exe");
    fs::write(&source, b"second app build, same daemon").expect("rebuild source exe");
    let second = prepare_daemon_executable_in(&source, &data_dir).expect("restage daemon exe");

    assert_eq!(first, second);
    assert_eq!(
        fs::read(&second).expect("read staged daemon exe"),
        b"first app build"
    );

    let _ = fs::remove_dir_all(temp);
}
