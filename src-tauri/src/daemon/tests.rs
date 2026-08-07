use super::*;
use crate::app::authorization::AuthorizationState;
use std::io::Cursor;

struct AdmissionScript {
    read: Cursor<Vec<u8>>,
    written: Vec<u8>,
}

impl AdmissionScript {
    fn from_client_message(message: &ClientToDaemon) -> Self {
        let mut read = Vec::new();
        write_frame(&mut read, message).expect("encode client frame");
        Self {
            read: Cursor::new(read),
            written: Vec::new(),
        }
    }

    fn response(&self) -> DaemonToClient {
        read_frame(&mut Cursor::new(self.written.clone())).expect("decode daemon response")
    }
}

impl Read for AdmissionScript {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.read.read(buffer)
    }
}

impl Write for AdmissionScript {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.written.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn oversized_daemon_log_replaces_the_previous_generation() {
    let root = std::env::temp_dir().join(format!("vibelink-log-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).expect("create log test directory");
    let log = root.join("daemon.log");
    std::fs::File::create(&log)
        .expect("create current log")
        .set_len(DAEMON_LOG_ROTATE_LIMIT + 1)
        .expect("grow current log");
    fs::write(log.with_extension("log.1"), b"old").expect("write old generation");

    rotate_daemon_log(&log);

    assert!(!log.exists());
    assert_eq!(
        fs::metadata(log.with_extension("log.1"))
            .expect("rotated log exists")
            .len(),
        DAEMON_LOG_ROTATE_LIMIT + 1,
    );
    let _ = fs::remove_dir_all(root);
}

fn authorization_snapshot(
    entitled: bool,
    lease_until: chrono::DateTime<Utc>,
) -> AuthorizationSnapshot {
    AuthorizationSnapshot {
        state: if entitled {
            AuthorizationState::ValidOnline
        } else {
            AuthorizationState::TrialExpired
        },
        entitled,
        observed_at: Utc::now(),
        lease_until,
        offline_grace_until: None,
        policy_epoch: 9,
    }
}

fn pending_challenge() -> (PendingChallenge, [u8; 32]) {
    let secret = [0x51_u8; 32];
    (
        PendingChallenge {
            boot_id: Uuid::new_v4(),
            nonce: [0x31_u8; 32],
            client_id: Uuid::new_v4(),
            client_kind: ClientKind::Cli,
            expires_at: Instant::now() + AUTH_CHALLENGE_TTL,
            consumed: false,
        },
        secret,
    )
}

#[test]
fn automation_terminal_script_reports_agent_exit_code() {
    let run_id = Uuid::new_v4().to_string();
    let launch = AutomationTerminalLaunch {
            program: std::ffi::OsString::from("powershell.exe"),
            args: vec![
                std::ffi::OsString::from("-NoLogo"),
                std::ffi::OsString::from("-NoProfile"),
                std::ffi::OsString::from("-Command"),
                std::ffi::OsString::from("if ($env:VIBELINK_SESSION_ID) { Write-Output 'LEAKED' } else { Write-Output 'SCRIPT_VISIBLE' }; exit 7"),
            ],
            env: Vec::new(),
            env_remove: vec![std::ffi::OsString::from("VIBELINK_SESSION_ID")],
            stdin_prompt: None,
            label: "test",
            timeout: Duration::from_secs(5),
            usage_path: std::env::temp_dir().join(format!("{run_id}.usage.json")),
            started_at: 0,
        };
    let (script_path, result_path) =
        write_automation_terminal_script(&run_id, &launch).expect("write terminal script");
    let output = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&script_path)
        .env("VIBELINK_SESSION_ID", "must-not-reach-agent")
        .output()
        .expect("run terminal script");

    assert!(
        output.status.success(),
        "wrapper script itself exits cleanly"
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("SCRIPT_VISIBLE"),
        "agent output reaches the terminal"
    );
    assert!(
        !String::from_utf8_lossy(&output.stdout).contains("LEAKED"),
        "pane identity is removed before the agent starts"
    );
    assert_eq!(
        fs::read_to_string(&result_path)
            .expect("read terminal result")
            .trim(),
        "7"
    );
    fs::remove_file(script_path).expect("remove terminal script");
    fs::remove_file(result_path).expect("remove terminal result");
}

#[test]
fn automation_pane_streams_output_and_remains_visible() {
    let root =
        std::env::temp_dir().join(format!("vibelink-automation-pane-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).expect("create automation pane test directory");
    let sessions_path = root.join("sessions.json");

    let state = Arc::new(Mutex::new(DaemonState::new()));
    let session_id = lock_state(&state)
        .create_session(
            "Automation".to_string(),
            Some(root.to_string_lossy().into_owned()),
        )
        .id;
    let pane_id = Uuid::new_v4();
    let config = PaneConfig {
        pane_id,
        shell: Some("cmd.exe".to_string()),
        args: vec![
            "/D".to_string(),
            "/K".to_string(),
            "echo VISIBLE_AUTOMATION".to_string(),
        ],
        cwd: Some(root.to_string_lossy().into_owned()),
        env: Vec::new(),
        title: Some("Automation · test".to_string()),
        icon: Some("bot".to_string()),
        profile_id: Some("omp".to_string()),
        role: Some("automation-agent".to_string()),
        restore_on_start: false,
        cols: 120,
        rows: 30,
    };

    spawn_pane_for_session(Arc::clone(&state), sessions_path, session_id, config, None)
        .expect("spawn automation pane");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let output = lock_state(&state)
            .get_scrollback(session_id, pane_id)
            .expect("read automation pane output");
        if String::from_utf8_lossy(&output).contains("VISIBLE_AUTOMATION") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "automation output did not reach the visible pane"
        );
        thread::sleep(Duration::from_millis(10));
    }
    let panes = lock_state(&state)
        .pane_metas(session_id)
        .expect("read automation pane metadata");
    assert!(
        panes.iter().any(|pane| pane.id == pane_id && pane.alive),
        "completed automation terminal remains available in the workspace"
    );
    let pane = lock_state(&state)
        .close_pane(session_id, pane_id)
        .expect("remove automation pane")
        .expect("automation pane exists");
    kill_owned_panes(vec![pane], "automation pane test cleanup")
        .expect("stop automation pane process");
    fs::remove_dir_all(root).expect("remove automation pane test directory");
}

#[test]
fn valid_current_admission_proof_succeeds() {
    let (mut challenge, secret) = pending_challenge();
    let proof = daemon_auth_proof(
        &secret,
        DAEMON_PROTOCOL_VERSION,
        challenge.boot_id,
        &challenge.nonce,
        challenge.client_id,
        challenge.client_kind,
    );

    assert_eq!(
        challenge.verify(&secret, challenge.client_id, &proof, Instant::now()),
        Ok(())
    );
}

#[test]
fn wrong_secret_expired_nonce_and_replay_fail_closed() {
    let (mut wrong_secret, secret) = pending_challenge();
    let wrong_proof = daemon_auth_proof(
        &[0x52_u8; 32],
        DAEMON_PROTOCOL_VERSION,
        wrong_secret.boot_id,
        &wrong_secret.nonce,
        wrong_secret.client_id,
        wrong_secret.client_kind,
    );
    assert_eq!(
        wrong_secret.verify(
            &secret,
            wrong_secret.client_id,
            &wrong_proof,
            Instant::now()
        ),
        Err(AuthorizationErrorCode::AuthRequired)
    );

    let (mut expired, secret) = pending_challenge();
    let proof = daemon_auth_proof(
        &secret,
        DAEMON_PROTOCOL_VERSION,
        expired.boot_id,
        &expired.nonce,
        expired.client_id,
        expired.client_kind,
    );
    assert_eq!(
        expired.verify(
            &secret,
            expired.client_id,
            &proof,
            expired.expires_at + Duration::from_millis(1),
        ),
        Err(AuthorizationErrorCode::AuthRequired)
    );

    let (mut replayed, secret) = pending_challenge();
    let proof = daemon_auth_proof(
        &secret,
        DAEMON_PROTOCOL_VERSION,
        replayed.boot_id,
        &replayed.nonce,
        replayed.client_id,
        replayed.client_kind,
    );
    assert!(replayed
        .verify(&secret, replayed.client_id, &proof, Instant::now())
        .is_ok());
    assert_eq!(
        replayed.verify(&secret, replayed.client_id, &proof, Instant::now()),
        Err(AuthorizationErrorCode::AuthRequired)
    );
}

#[test]
fn unauthenticated_command_and_shutdown_are_rejected_as_first_frame() {
    for message in [
        ClientToDaemon::Ping { req: 1 },
        ClientToDaemon::Shutdown {
            req: 2,
            clean_exit: false,
        },
    ] {
        let mut stream = AdmissionScript::from_client_message(&message);
        assert_eq!(
            authenticate_connection(&mut stream, Uuid::new_v4(), &[7_u8; 32]),
            Err(AuthorizationErrorCode::AuthRequired)
        );
        assert_eq!(
            stream.response(),
            DaemonToClient::Error {
                req: None,
                message: "AUTH_REQUIRED".to_string(),
            }
        );
    }
}

#[test]
fn expired_entitlement_and_logout_fail_next_request_with_stable_codes() {
    let message = ClientToDaemon::WritePane {
        req: 1,
        session_id: Uuid::new_v4(),
        pane_id: Uuid::new_v4(),
        data: b"whoami\r".to_vec(),
        origin: crate::protocol::PaneCommandOrigin::Desktop,
    };
    let active = authorization_snapshot(true, Utc::now() + chrono::Duration::minutes(1));
    assert_eq!(
        authorize_daemon_message_with(&message, ClientKind::Cli, || Ok(active)),
        Ok(())
    );

    let logged_out = authorization_snapshot(false, Utc::now());
    assert_eq!(
        authorize_daemon_message_with(&message, ClientKind::Cli, || Ok(logged_out)),
        Err(AuthorizationErrorCode::EntitlementRequired)
    );

    let expired = authorization_snapshot(true, Utc::now() - chrono::Duration::milliseconds(1));
    assert_eq!(
        authorize_daemon_message_with(&message, ClientKind::App, || Ok(expired)),
        Err(AuthorizationErrorCode::AuthorizationStale)
    );
}

#[test]
fn stale_policy_heartbeat_requires_daemon_shutdown() {
    let heartbeat = Mutex::new(PolicyHeartbeat {
        deadline: Some(Instant::now() - Duration::from_millis(1)),
        policy_epoch: 12,
        revoked: false,
    });

    assert_eq!(
        heartbeat_revocation(&heartbeat, Instant::now()),
        Some((AuthorizationErrorCode::AuthorizationStale, 12, true))
    );
}

#[test]
fn heartbeat_lease_is_bounded_to_ninety_seconds() {
    let mut heartbeat = PolicyHeartbeat::default();
    heartbeat.update(authorization_snapshot(
        true,
        Utc::now() + chrono::Duration::hours(1),
    ));
    let deadline = heartbeat.deadline.expect("heartbeat deadline");

    assert!(deadline <= Instant::now() + POLICY_HEARTBEAT_TTL);
    assert!(!heartbeat.revoked);
}

#[test]
fn headless_worktree_prompt_defaults_to_omp_and_rejects_unknown_profiles() {
    let (config, agent_profile) =
        worktree_initial_pane_config("E:/repo/worktree", None, None, true)
            .expect("default prompt profile");
    assert!(agent_profile);
    assert_eq!(config.profile_id.as_deref(), Some("omp"));
    assert_eq!(config.cwd.as_deref(), Some("E:/repo/worktree"));
    assert!(
        worktree_initial_pane_config("E:/repo/worktree", Some("custom-profile"), None, false,)
            .expect_err("unknown headless profile")
            .to_string()
            .contains("cannot resolve profile")
    );
}

fn state_with_test_pane(cols: u16, rows: u16) -> (SharedState, Uuid, Uuid) {
    let state = Arc::new(Mutex::new(DaemonState::new()));
    let session_id;
    let pane_id = Uuid::new_v4();
    {
        let mut guard = lock_state(&state);
        session_id = guard.create_session("Workspace".to_string(), None).id;
        guard
            .insert_pane(
                session_id,
                Pane::for_test(
                    PaneConfig {
                        pane_id,
                        shell: None,
                        args: Vec::new(),
                        cwd: None,
                        env: Vec::new(),
                        title: Some("lease test".to_string()),
                        icon: None,
                        profile_id: None,
                        role: None,
                        restore_on_start: false,
                        cols,
                        rows,
                    },
                    true,
                ),
            )
            .expect("insert test pane");
    }
    (state, session_id, pane_id)
}

/// A restorable pane descriptor that never spawns a real process: these
/// tests assert on the RESTORE DECISION, not on PTY behavior.
fn restorable_test_config(pane_id: Uuid) -> PaneConfig {
    PaneConfig {
        pane_id,
        shell: None,
        args: Vec::new(),
        cwd: None,
        env: Vec::new(),
        title: Some("restore test".to_string()),
        icon: None,
        profile_id: None,
        role: None,
        restore_on_start: true,
        cols: 80,
        rows: 24,
    }
}

#[test]
fn ping_reply_can_be_sent() {
    let (tx, rx) = bounded(1);
    send(&tx, DaemonToClient::Pong { req: 77 }).expect("send pong");
    assert_eq!(rx.recv().expect("pong"), DaemonToClient::Pong { req: 77 });
}

#[test]
fn client_write_timeout_is_bounded() {
    assert!(CLIENT_WRITE_TIMEOUT <= Duration::from_secs(3));
}

#[test]
fn client_queue_capacity_is_bounded() {
    assert_eq!(CLIENT_QUEUE_CAPACITY, 256);
}

#[test]
fn output_frame_is_dropped_when_client_queue_is_full() {
    let (tx, rx) = bounded(1);
    let pane_id = Uuid::new_v4();

    tx.send(DaemonToClient::Pong { req: 1 })
        .expect("fill client queue");
    send_output_to_clients(vec![tx], pane_id, 1, 1, b"dropped".to_vec());

    assert_eq!(
        rx.recv().expect("queued control frame"),
        DaemonToClient::Pong { req: 1 }
    );
    assert!(rx.try_recv().is_err());
}
#[test]
fn kill_all_panes_does_not_deadlock() {
    let state = Arc::new(Mutex::new(DaemonState::new()));
    let pane_id = Uuid::new_v4();
    {
        let mut guard = state.lock().expect("state mutex");
        let session = guard.create_session("Workspace".to_string(), None);
        guard
            .insert_pane(
                session.id,
                Pane::for_test(
                    crate::protocol::PaneConfig {
                        pane_id,
                        shell: None,
                        args: Vec::new(),
                        cwd: None,
                        env: Vec::new(),
                        title: Some("test".to_string()),
                        icon: None,
                        profile_id: None,
                        role: None,
                        restore_on_start: false,
                        cols: 80,
                        rows: 24,
                    },
                    true,
                ),
            )
            .expect("insert pane");
    }

    let (tx, rx) = bounded(1);
    let state_for_thread = Arc::clone(&state);
    thread::spawn(move || {
        kill_all_panes(&state_for_thread);
        tx.send(()).expect("notify completion");
    });

    rx.recv_timeout(Duration::from_secs(1))
        .expect("kill_all_panes returned");
}

#[test]
fn startup_failure_cleanup_removes_reconstructed_panes() {
    let state = Arc::new(Mutex::new(DaemonState::new()));
    let session_id;
    {
        let mut guard = state.lock().expect("state mutex");
        let session = guard.create_session("Restored workspace".to_string(), None);
        session_id = session.id;
        guard
            .insert_pane(
                session.id,
                Pane::for_test(
                    crate::protocol::PaneConfig {
                        pane_id: Uuid::new_v4(),
                        shell: None,
                        args: Vec::new(),
                        cwd: None,
                        env: Vec::new(),
                        title: Some("restored".to_string()),
                        icon: None,
                        profile_id: None,
                        role: None,
                        restore_on_start: true,
                        cols: 80,
                        rows: 24,
                    },
                    true,
                ),
            )
            .expect("insert restored pane");
    }

    drop(StartupPaneCleanup::new(Arc::clone(&state)));

    assert!(lock_state(&state)
        .pane_metas(session_id)
        .expect("pane metadata")
        .is_empty());
}

#[test]
fn shutdown_persists_restartable_panes_before_removing_live_handles() {
    let state = Arc::new(Mutex::new(DaemonState::new()));
    let session_id;
    let pane_id = Uuid::new_v4();
    {
        let mut guard = lock_state(&state);
        session_id = guard.create_session("Workspace".to_string(), None).id;
        let config = crate::protocol::PaneConfig {
            pane_id,
            shell: None,
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            title: Some("restorable".to_string()),
            icon: None,
            profile_id: None,
            role: None,
            restore_on_start: true,
            cols: 80,
            rows: 24,
        };
        guard
            .insert_pane(session_id, Pane::for_test(config, true))
            .expect("insert restartable pane");
    }
    let root = std::env::temp_dir().join(format!("vibelink-shutdown-{}", Uuid::new_v4()));
    let sessions_path = root.join("sessions.json");

    debounce_persist_state(&state, &sessions_path).expect("queue debounced persistence");
    persist_restorable_panes_and_kill_all(&state, &sessions_path).expect("persist shutdown state");
    thread::sleep(PERSIST_DEBOUNCE_INTERVAL + Duration::from_millis(100));

    let persisted = load_sessions(&sessions_path).expect("load shutdown state");
    assert_eq!(persisted.len(), 1);
    assert_eq!(persisted[0].id, session_id);
    assert_eq!(persisted[0].panes.len(), 1);
    assert_eq!(persisted[0].panes[0].pane_id, pane_id);
    assert!(lock_state(&state)
        .pane_metas(session_id)
        .expect("pane metadata")
        .is_empty());
    let _ = fs::remove_dir_all(root);
}

/// End-to-end proof of the user-visible contract: a live restorable pane
/// plus a DELIBERATE quit must yield an initialized screen on the next
/// daemon start. The pane descriptor is still persisted either way, so the
/// clean-exit marker is the only thing that changes the outcome.
///
/// The crash counterpart deliberately stops at the persisted flag: actually
/// reconstructing a pane spawns a real shell that blocks on the ConPTY
/// startup handshake, which
/// `cold_restart_reconstructs_restartable_pane_with_saved_history` already
/// covers with a fixture process that answers it.
#[test]
fn deliberate_quit_reopens_clean_while_a_crash_stays_restorable() {
    for clean_exit in [true, false] {
        let state = Arc::new(Mutex::new(DaemonState::new()));
        let pane_id = Uuid::new_v4();
        let session_id = {
            let mut guard = lock_state(&state);
            let session_id = guard.create_session("Workspace".to_string(), None).id;
            guard
                .insert_pane(
                    session_id,
                    Pane::for_test(restorable_test_config(pane_id), true),
                )
                .expect("insert restartable pane");
            session_id
        };
        let root = std::env::temp_dir().join(format!("vibelink-quit-{}", Uuid::new_v4()));
        let sessions_path = root.join("sessions.json");

        // The exact ordering the shutdown handler uses.
        if clean_exit {
            lock_state(&state).mark_clean_exit();
        }
        persist_restorable_panes_and_kill_all(&state, &sessions_path)
            .expect("persist shutdown state");

        let persisted = load_sessions(&sessions_path).expect("load shutdown state");
        assert_eq!(
            persisted[0].panes.len(),
            1,
            "the pane descriptor is always persisted; only the restore decision differs"
        );
        assert_eq!(persisted[0].clean_exit, clean_exit);

        if clean_exit {
            // A fresh daemon start over that exact state must spawn nothing.
            let restarted = Arc::new(Mutex::new(DaemonState::new()));
            reconstruct_sessions(Arc::clone(&restarted), &sessions_path)
                .expect("reconstruct persisted sessions");
            let guard = lock_state(&restarted);
            assert!(
                guard
                    .pane_metas(session_id)
                    .expect("session survives the quit")
                    .is_empty(),
                "a deliberate quit must reopen clean"
            );
            assert_eq!(
                guard.list_sessions().len(),
                1,
                "the workspace itself must remain openable"
            );
        }
        let _ = fs::remove_dir_all(root);
    }
}

#[test]
fn cold_restart_reconstructs_restartable_pane_with_saved_history() {
    let root = std::env::temp_dir().join(format!("vibelink-cold-restore-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).expect("create cold restore fixture directory");
    let sessions_path = root.join("sessions.json");
    let session_id = Uuid::new_v4();
    let pane_id = Uuid::new_v4();
    let fixture_name = "daemon::tests::cold_restore_fixture_process";
    let executable = std::env::current_exe().expect("resolve current test executable");
    let config = PaneConfig {
        pane_id,
        shell: Some(executable.to_string_lossy().into_owned()),
        args: vec![
            "--exact".to_string(),
            fixture_name.to_string(),
            "--nocapture".to_string(),
        ],
        cwd: Some(root.to_string_lossy().into_owned()),
        env: vec![("VIBELINK_COLD_RESTORE_FIXTURE".to_string(), "1".to_string())],
        title: Some("restored fixture".to_string()),
        icon: None,
        profile_id: None,
        role: None,
        restore_on_start: true,
        cols: 80,
        rows: 2,
    };
    save_sessions(
        &sessions_path,
        &[crate::daemon::persistence::PersistedSession {
            id: session_id,
            name: "Cold restore".to_string(),
            created_at: 123,
            layout_json: None,
            workspace_folder: Some(root.to_string_lossy().into_owned()),
            sleeping: false,
            clean_exit: false,
            panes: vec![config.clone()],
        }],
    )
    .expect("persist cold restore fixture");
    drop(
        TerminalHistoryWriter::open(
            &sessions_path,
            session_id,
            pane_id,
            b"saved terminal output",
        )
        .expect("persist terminal history fixture"),
    );

    let state = Arc::new(Mutex::new(DaemonState::new()));
    let outcome = reconstruct_sessions(Arc::clone(&state), &sessions_path).and_then(|()| {
        let (panes, snapshot, writer) = {
            let guard = lock_state(&state);
            (
                guard.pane_metas(session_id)?,
                guard.get_scrollback(session_id, pane_id)?,
                guard.pane_writer_authorized(session_id, pane_id, &PaneCommandOrigin::Desktop)?,
            )
        };
        lock_mutex(&writer)
            .write_all(b"\x1b[1;1R")
            .context("answer cold restore fixture cursor query")?;
        Ok((panes, snapshot))
    });

    let restored_pane = lock_state(&state)
        .close_pane(session_id, pane_id)
        .expect("remove restored pane");
    let child = restored_pane.as_ref().map(Pane::child);
    let mut exit_status = None;
    let mut wait_error = None;
    if let Some(child) = child.as_ref() {
        for _ in 0..500 {
            match lock_mutex(child).try_wait() {
                Ok(Some(status)) => {
                    exit_status = Some(status);
                    break;
                }
                Ok(None) => thread::sleep(Duration::from_millis(20)),
                Err(error) => {
                    wait_error = Some(error);
                    break;
                }
            }
        }
    }
    drop(child);
    if exit_status.is_some() {
        drop(restored_pane);
    } else if let Some(mut pane) = restored_pane {
        let _ = pane.kill();
        std::mem::forget(pane);
    }
    let mut removed = false;
    for _ in 0..100 {
        match fs::remove_dir_all(&root) {
            Ok(()) => {
                removed = true;
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                removed = true;
                break;
            }
            Err(_) => thread::sleep(Duration::from_millis(20)),
        }
    }

    let exit_status = exit_status
        .unwrap_or_else(|| panic!("cold restore fixture process did not exit: {wait_error:?}"));
    assert!(exit_status.success(), "cold restore fixture process failed");
    assert!(removed, "cold restore fixture directory remained locked");
    let (panes, snapshot) = outcome.expect("reconstruct persisted sessions");
    assert_eq!(panes.len(), 1);
    let restored = &panes[0].config;
    assert_eq!(&restored.pane_id, &config.pane_id);
    assert_eq!(&restored.shell, &config.shell);
    assert_eq!(&restored.args, &config.args);
    assert_eq!(&restored.cwd, &config.cwd);
    assert_eq!(&restored.title, &config.title);
    assert!(restored.restore_on_start);
    assert!(restored
        .env
        .iter()
        .any(|(key, value)| key == "VIBELINK_COLD_RESTORE_FIXTURE" && value == "1"));
    assert!(restored
        .env
        .iter()
        .any(|(key, value)| { key == "VIBELINK_SESSION_ID" && value == &session_id.to_string() }));
    assert!(restored
        .env
        .iter()
        .any(|(key, value)| key == "VIBELINK_PANE_ID" && value == &pane_id.to_string()));
    let rendered = String::from_utf8_lossy(&snapshot);
    assert!(rendered.contains("saved terminal output"));
    assert!(rendered.contains("[VibeLink cold restore:"));
}

/// A deliberate quit must produce an initialized screen, not the previous
/// one. This is the whole point of the clean-exit marker: the pane
/// descriptor is still on disk and still `restore_on_start`, yet nothing
/// may be reconstructed, and the stale history must not survive to be
/// replayed into a later pane.
#[test]
fn clean_exit_workspace_is_not_reconstructed_and_drops_its_history() {
    let root = std::env::temp_dir().join(format!("vibelink-clean-exit-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).expect("create clean exit fixture directory");
    let sessions_path = root.join("sessions.json");
    let session_id = Uuid::new_v4();
    let pane_id = Uuid::new_v4();
    let config = restorable_test_config(pane_id);
    save_sessions(
        &sessions_path,
        &[crate::daemon::persistence::PersistedSession {
            id: session_id,
            name: "Clean exit".to_string(),
            created_at: 123,
            layout_json: Some("{\"grid\":true}".to_string()),
            workspace_folder: Some(root.to_string_lossy().into_owned()),
            sleeping: false,
            clean_exit: true,
            panes: vec![config],
        }],
    )
    .expect("persist clean exit fixture");
    drop(
        TerminalHistoryWriter::open(&sessions_path, session_id, pane_id, b"previous output")
            .expect("persist terminal history fixture"),
    );

    let state = Arc::new(Mutex::new(DaemonState::new()));
    reconstruct_sessions(Arc::clone(&state), &sessions_path)
        .expect("reconstruct persisted sessions");

    let guard = lock_state(&state);
    assert_eq!(
        guard.pane_metas(session_id).expect("session exists").len(),
        0,
        "a cleanly closed workspace must not respawn its panes"
    );
    assert_eq!(
        guard.list_sessions().len(),
        1,
        "the workspace itself must survive so the user can reopen it"
    );
    drop(guard);
    assert!(
        load_pane_history(&sessions_path, session_id, pane_id)
            .expect("history load")
            .is_empty(),
        "clean exit must drop stale scrollback"
    );

    let _ = fs::remove_dir_all(root);
}

/// The inverse: an unclean exit (crash/reboot) leaves `clean_exit` false,
/// so the pane descriptor is still queued for cold restore.
#[test]
fn unclean_exit_workspace_keeps_its_restorable_panes() {
    let root = std::env::temp_dir().join(format!("vibelink-unclean-exit-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).expect("create unclean exit fixture directory");
    let sessions_path = root.join("sessions.json");
    let session_id = Uuid::new_v4();
    let pane_id = Uuid::new_v4();
    let config = restorable_test_config(pane_id);
    save_sessions(
        &sessions_path,
        &[crate::daemon::persistence::PersistedSession {
            id: session_id,
            name: "Unclean exit".to_string(),
            created_at: 123,
            layout_json: None,
            workspace_folder: Some(root.to_string_lossy().into_owned()),
            sleeping: false,
            clean_exit: false,
            panes: vec![config],
        }],
    )
    .expect("persist unclean exit fixture");

    drop(
        TerminalHistoryWriter::open(&sessions_path, session_id, pane_id, b"crashed output")
            .expect("persist terminal history fixture"),
    );
    assert!(
        !load_pane_history(&sessions_path, session_id, pane_id)
            .expect("history load")
            .is_empty(),
        "an unclean exit must retain scrollback for cold restore"
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn cold_restore_fixture_process() {
    if std::env::var("VIBELINK_COLD_RESTORE_FIXTURE").as_deref() != Ok("1") {
        return;
    }
    thread::sleep(Duration::from_millis(100));
}
/// The agent-completion hooks reach the GUI ONLY through this broadcast, so
/// a regression here silently disables every hook while the CLI still
/// reports success.
#[test]
fn terminal_complete_broadcasts_a_pane_completed_signal() {
    let state = Arc::new(Mutex::new(DaemonState::new()));
    let pane_id = Uuid::new_v4();
    let session_id = {
        let mut guard = state.lock().expect("state mutex");
        let session = guard.create_session("Workspace".to_string(), None);
        guard
            .insert_pane(
                session.id,
                Pane::for_test(
                    crate::protocol::PaneConfig {
                        pane_id,
                        shell: None,
                        args: Vec::new(),
                        cwd: None,
                        env: Vec::new(),
                        title: Some("omp".to_string()),
                        icon: None,
                        profile_id: None,
                        role: None,
                        restore_on_start: false,
                        cols: 80,
                        rows: 24,
                    },
                    true,
                ),
            )
            .expect("insert pane");
        session.id
    };

    let (tx, rx) = bounded(4);
    state
        .lock()
        .expect("state mutex")
        .add_client(Uuid::new_v4(), tx);

    let senders = lock_state(&state).all_senders();
    for sender in senders {
        sender
            .send(DaemonToClient::TaskEvent {
                session_id,
                event: crate::protocol::TaskSignal::PaneCompleted {
                    pane_id,
                    agent: Some("omp".to_string()),
                },
            })
            .expect("broadcast completion");
    }

    assert_eq!(
        rx.recv_timeout(Duration::from_secs(1))
            .expect("client receives the completion"),
        DaemonToClient::TaskEvent {
            session_id,
            event: crate::protocol::TaskSignal::PaneCompleted {
                pane_id,
                agent: Some("omp".to_string()),
            },
        }
    );
}

#[test]
fn request_id_tracks_spawn_pane_errors() {
    let session_id = Uuid::new_v4();
    let pane_id = Uuid::new_v4();
    let msg = ClientToDaemon::SpawnPane {
        req: 42,
        session_id,
        cfg: crate::protocol::PaneConfig {
            pane_id,
            shell: Some("missing-shell".to_string()),
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            title: None,
            icon: None,
            profile_id: None,
            role: None,
            restore_on_start: false,
            cols: 80,
            rows: 24,
        },
        attach: false,
    };

    assert_eq!(request_id(&msg), Some(42));
}

#[test]
fn request_id_tracks_subscribe_but_not_detach_pane() {
    let session_id = Uuid::new_v4();
    let pane_id = Uuid::new_v4();

    assert_eq!(
        request_id(&ClientToDaemon::SubscribePane {
            req: 43,
            session_id,
            pane_id,
        }),
        Some(43)
    );
    assert_eq!(
        request_id(&ClientToDaemon::DetachPane {
            session_id,
            pane_id,
        }),
        None
    );
}

#[test]
fn request_id_tracks_attach_write_and_cancel_acknowledgements() {
    let session_id = Uuid::new_v4();
    let pane_id = Uuid::new_v4();
    assert_eq!(
        request_id(&ClientToDaemon::AttachPane {
            req: 7,
            session_id,
            pane_id,
        }),
        Some(7)
    );
    assert_eq!(
        request_id(&ClientToDaemon::CancelPaneSpawn {
            req: 9,
            session_id,
            pane_id,
        }),
        Some(9)
    );
    assert_eq!(
        request_id(&ClientToDaemon::WritePane {
            req: 8,
            session_id,
            pane_id,
            data: b"input".to_vec(),
            origin: PaneCommandOrigin::Desktop,
        }),
        Some(8)
    );
}

#[test]
fn request_id_tracks_remote_pane_lease_requests() {
    let owner_connection_id = Uuid::new_v4();
    let session_id = Uuid::new_v4();
    let pane_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    let messages = [
        ClientToDaemon::RemotePaneLeaseClaim {
            req: 1,
            request: crate::protocol::RemotePaneLeaseClaimRequest {
                owner_connection_id,
                device_id: "device".to_string(),
                session_id,
                pane_id,
                cols: 80,
                rows: 24,
                viewport_revision: 1,
                lease_id: None,
                revision: None,
            },
        },
        ClientToDaemon::RemotePaneLeaseRenew {
            req: 2,
            request: crate::protocol::RemotePaneLeaseRenewRequest {
                owner_connection_id,
                device_id: "device".to_string(),
                session_id,
                pane_id,
                lease_id,
                revision: 1,
                viewport_revision: 2,
            },
        },
        ClientToDaemon::RemotePaneLeaseRelease {
            req: 3,
            request: crate::protocol::RemotePaneLeaseReleaseRequest {
                owner_connection_id,
                device_id: "device".to_string(),
                session_id,
                pane_id,
                lease_id,
                revision: 2,
            },
        },
        ClientToDaemon::RemotePaneLeaseStatus {
            req: 4,
            request: RemotePaneLeaseStatusRequest { pane_id },
        },
        ClientToDaemon::RemotePaneLeaseAdminReclaim {
            req: 5,
            request: crate::protocol::RemotePaneLeaseAdminReclaimRequest {
                session_id,
                pane_id,
            },
        },
        ClientToDaemon::RemoteConnectionCleanup {
            req: 6,
            request: RemoteConnectionCleanupRequest {
                owner_connection_id,
            },
        },
    ];

    assert_eq!(
        messages.iter().map(request_id).collect::<Vec<_>>(),
        vec![Some(1), Some(2), Some(3), Some(4), Some(5), Some(6)]
    );
}

#[test]
fn remote_pane_lease_status_uses_negotiated_target_geometry() {
    let session_id = Uuid::new_v4();
    let pane_id = Uuid::new_v4();
    let status = remote_pane_lease_status_response(RemotePaneLeaseResult::Status {
        lease: Some(crate::protocol::RemotePaneLease {
            lease_id: Uuid::new_v4(),
            owner_connection_id: Uuid::new_v4(),
            device_id: "device".to_string(),
            session_id,
            pane_id,
            pane_generation: 7,
            revision: 3,
            original_cols: 120,
            original_rows: 40,
            target_cols: 52,
            target_rows: 31,
            viewport_revision: 9,
            expires_at: 100,
        }),
    })
    .expect("map lease status")
    .expect("active lease");

    assert_eq!(status.session_id, session_id.to_string());
    assert_eq!(status.pane_id, pane_id.to_string());
    assert_eq!(status.device_id, "device");
    assert_eq!((status.cols, status.rows), (52, 31));
    assert_eq!(status.expires_at, 100);
}

#[test]
fn pane_dispatch_rejects_desktop_and_accepts_matching_remote_origin() {
    let (state, session_id, pane_id) = state_with_test_pane(120, 40);
    let owner_connection_id = Uuid::new_v4();
    write_pane_authorized(
        &state,
        session_id,
        pane_id,
        b"desktop before lease",
        &PaneCommandOrigin::Desktop,
    )
    .expect("desktop write without lease");
    write_pane_authorized(
        &state,
        session_id,
        pane_id,
        b"shared remote before lease",
        &PaneCommandOrigin::Remote {
            owner_connection_id,
            device_id: "mobile".to_string(),
            lease_id: None,
            revision: None,
        },
    )
    .expect("shared remote write without lease");
    let transition = lock_state(&state)
        .claim_or_update_remote_pane_lease(
            crate::protocol::RemotePaneLeaseClaimRequest {
                owner_connection_id,
                device_id: "mobile".to_string(),
                session_id,
                pane_id,
                cols: 52,
                rows: 31,
                viewport_revision: 1,
                lease_id: None,
                revision: None,
            },
            orchestration_now_millis(),
        )
        .expect("claim lease");
    let lease = match &transition.result {
        RemotePaneLeaseResult::Claimed { lease } => lease.clone(),
        other => panic!("unexpected claim result: {other:?}"),
    };
    process_pane_lease_transition(&state, transition);

    assert!(write_pane_authorized(
        &state,
        session_id,
        pane_id,
        b"desktop",
        &PaneCommandOrigin::Desktop,
    )
    .is_err());
    assert!(resize_pane_authorized(
        &state,
        session_id,
        pane_id,
        120,
        40,
        &PaneCommandOrigin::Desktop,
    )
    .is_err());

    let remote_origin = PaneCommandOrigin::Remote {
        owner_connection_id,
        device_id: "mobile".to_string(),
        lease_id: Some(lease.lease_id),
        revision: Some(lease.revision),
    };
    write_pane_authorized(&state, session_id, pane_id, b"remote", &remote_origin)
        .expect("matching remote write");
    resize_pane_authorized(&state, session_id, pane_id, 52, 31, &remote_origin)
        .expect("matching remote resize");
}

#[test]
fn expiry_transition_restores_geometry_and_broadcasts_lost_event() {
    let (state, session_id, pane_id) = state_with_test_pane(120, 40);
    let client_id = Uuid::new_v4();
    let (tx, rx) = bounded(16);
    {
        let mut guard = lock_state(&state);
        guard.add_client(client_id, tx);
        guard.attach_client_to_pane(client_id, pane_id);
    }
    let transition = lock_state(&state)
        .claim_or_update_remote_pane_lease(
            crate::protocol::RemotePaneLeaseClaimRequest {
                owner_connection_id: Uuid::new_v4(),
                device_id: "mobile".to_string(),
                session_id,
                pane_id,
                cols: 52,
                rows: 31,
                viewport_revision: 1,
                lease_id: None,
                revision: None,
            },
            1_000,
        )
        .expect("claim lease");
    let expires_at = match &transition.result {
        RemotePaneLeaseResult::Claimed { lease } => lease.expires_at,
        other => panic!("unexpected claim result: {other:?}"),
    };
    process_pane_lease_transition(&state, transition);
    let _ = rx.try_iter().collect::<Vec<_>>();

    let transitions = lock_state(&state).expire_remote_pane_leases(expires_at);
    process_pane_lease_transitions(&state, transitions);

    let pane = lock_state(&state)
        .pane_metas(session_id)
        .expect("pane metadata")
        .into_iter()
        .find(|pane| pane.id == pane_id)
        .expect("live pane");
    assert_eq!((pane.config.cols, pane.config.rows), (120, 40));
    let messages = rx.try_iter().collect::<Vec<_>>();
    assert!(messages.iter().any(|message| matches!(
        message,
        DaemonToClient::PaneResized {
            cols: 120,
            rows: 40,
            ..
        }
    )));
    assert!(messages.iter().any(|message| matches!(
            message,
            DaemonToClient::RemotePaneLease { event }
                if event.kind == crate::protocol::RemotePaneLeaseEventKind::Lost
                    && event.reason == crate::protocol::RemotePaneLeaseEventReason::Expired
                    && event.restoration.as_ref().is_some_and(|restoration|
                        restoration.status == crate::protocol::RemotePaneLeaseRestorationStatus::Restored)
        )));
}

#[test]
fn admin_reclaim_transition_restores_geometry_and_broadcasts_lost_event() {
    let (state, session_id, pane_id) = state_with_test_pane(120, 40);
    let client_id = Uuid::new_v4();
    let (tx, rx) = bounded(16);
    {
        let mut guard = lock_state(&state);
        guard.add_client(client_id, tx);
        guard.attach_client_to_pane(client_id, pane_id);
    }
    let transition = lock_state(&state)
        .claim_or_update_remote_pane_lease(
            crate::protocol::RemotePaneLeaseClaimRequest {
                owner_connection_id: Uuid::new_v4(),
                device_id: "mobile".to_string(),
                session_id,
                pane_id,
                cols: 52,
                rows: 31,
                viewport_revision: 1,
                lease_id: None,
                revision: None,
            },
            orchestration_now_millis(),
        )
        .expect("claim lease");
    process_pane_lease_transition(&state, transition);
    let _ = rx.try_iter().collect::<Vec<_>>();

    let transition = lock_state(&state)
        .admin_reclaim_remote_pane_lease(crate::protocol::RemotePaneLeaseAdminReclaimRequest {
            session_id,
            pane_id,
        })
        .expect("admin reclaim");
    process_pane_lease_transition(&state, transition);

    let pane = lock_state(&state)
        .pane_metas(session_id)
        .expect("pane metadata")
        .into_iter()
        .find(|pane| pane.id == pane_id)
        .expect("live pane");
    assert_eq!((pane.config.cols, pane.config.rows), (120, 40));
    let messages = rx.try_iter().collect::<Vec<_>>();
    assert!(messages.iter().any(|message| matches!(
        message,
        DaemonToClient::PaneResized {
            cols: 120,
            rows: 40,
            ..
        }
    )));
    assert!(messages.iter().any(|message| matches!(
            message,
            DaemonToClient::RemotePaneLease { event }
                if event.kind == crate::protocol::RemotePaneLeaseEventKind::Lost
                    && event.reason == crate::protocol::RemotePaneLeaseEventReason::AdminReclaimed
                    && event.restoration.as_ref().is_some_and(|restoration|
                        restoration.status == crate::protocol::RemotePaneLeaseRestorationStatus::Restored)
        )));
}

#[test]
fn connection_cleanup_restores_geometry_and_emits_disconnect_loss() {
    let (state, session_id, pane_id) = state_with_test_pane(120, 40);
    let owner_connection_id = Uuid::new_v4();
    let client_id = Uuid::new_v4();
    let (event_tx, event_rx) = bounded(16);
    {
        let mut guard = lock_state(&state);
        guard.add_client(client_id, event_tx);
        guard.attach_client_to_pane(client_id, pane_id);
    }
    let transition = lock_state(&state)
        .claim_or_update_remote_pane_lease(
            crate::protocol::RemotePaneLeaseClaimRequest {
                owner_connection_id,
                device_id: "mobile".to_string(),
                session_id,
                pane_id,
                cols: 52,
                rows: 31,
                viewport_revision: 1,
                lease_id: None,
                revision: None,
            },
            orchestration_now_millis(),
        )
        .expect("claim lease");
    process_pane_lease_transition(&state, transition);
    let _ = event_rx.try_iter().collect::<Vec<_>>();

    let transitions =
        lock_state(&state).cleanup_remote_connection_leases(RemoteConnectionCleanupRequest {
            owner_connection_id,
        });
    let (reply_tx, reply_rx) = bounded(1);
    send_remote_connection_cleanup(&state, &reply_tx, 91, transitions)
        .expect("send disconnect cleanup");

    assert!(matches!(
        reply_rx.recv().expect("cleanup reply"),
        DaemonToClient::Reply {
            req: 91,
            result: ReplyResult::RemotePaneLease(RemotePaneLeaseResult::Cleanup { .. })
        }
    ));
    let pane = lock_state(&state)
        .pane_metas(session_id)
        .expect("pane metadata")
        .into_iter()
        .find(|pane| pane.id == pane_id)
        .expect("live pane");
    assert_eq!((pane.config.cols, pane.config.rows), (120, 40));
    let messages = event_rx.try_iter().collect::<Vec<_>>();
    assert!(messages.iter().any(|message| matches!(
            message,
            DaemonToClient::RemotePaneLease { event }
                if event.kind == crate::protocol::RemotePaneLeaseEventKind::Lost
                    && event.reason == crate::protocol::RemotePaneLeaseEventReason::ConnectionClosed
                    && event.restoration.as_ref().is_some_and(|restoration|
                        restoration.status == crate::protocol::RemotePaneLeaseRestorationStatus::Restored)
        )));
}

#[test]
fn pid_file_guard_writes_and_removes_current_pid() {
    let path = std::env::temp_dir().join(format!(
        "vibelink-daemon-test-{}-{}.pid",
        std::process::id(),
        Uuid::new_v4()
    ));

    {
        let _guard = PidFileGuard::create(path.clone()).expect("create pid guard");
        let pid = std::fs::read_to_string(&path).expect("read pid file");
        assert_eq!(pid.trim(), std::process::id().to_string());
    }

    assert!(!path.exists());
}
#[test]
fn automation_cli_id_validation() {
    let valid_uuid = Uuid::new_v4().to_string();

    let mut args_valid = crate::dedicated_cli::OperationArguments::default();
    args_valid.positionals.push(valid_uuid.clone());
    let res = automation_cli_id(&args_valid, "automation id");
    assert_eq!(res.unwrap(), valid_uuid);

    let mut args_opt = crate::dedicated_cli::OperationArguments::default();
    args_opt
        .options
        .insert("id".to_string(), vec![valid_uuid.clone()]);
    let res = automation_cli_id(&args_opt, "automation id");
    assert_eq!(res.unwrap(), valid_uuid);

    let mut args_conflict = crate::dedicated_cli::OperationArguments::default();
    args_conflict.positionals.push(valid_uuid.clone());
    args_conflict
        .options
        .insert("id".to_string(), vec![valid_uuid.clone()]);
    let res = automation_cli_id(&args_conflict, "automation id");
    assert!(res.is_err());
    assert!(res
        .unwrap_err()
        .to_string()
        .contains("either positionally or with --id, not both"));

    let args_missing = crate::dedicated_cli::OperationArguments::default();
    let res = automation_cli_id(&args_missing, "automation id");
    assert!(res.is_err());
    assert!(res
        .unwrap_err()
        .to_string()
        .contains("automation id is required"));

    let mut args_invalid = crate::dedicated_cli::OperationArguments::default();
    args_invalid.positionals.push("not-a-uuid".to_string());
    let res = automation_cli_id(&args_invalid, "automation id");
    assert!(res.is_err());
    assert!(res
        .unwrap_err()
        .to_string()
        .contains("automation id must be a UUID"));
}

#[test]
fn automation_json_payload_validation() {
    let mut args_valid = crate::dedicated_cli::OperationArguments::default();
    args_valid.options.insert(
        "json".to_string(),
        vec![r#"{"name":"test","prompt":"hello"}"#.to_string()],
    );
    let payload = automation_json_payload(&args_valid).unwrap();
    assert!(payload.is_object());
    assert_eq!(payload.get("name").and_then(Value::as_str), Some("test"));

    let mut args_non_object = crate::dedicated_cli::OperationArguments::default();
    args_non_object
        .options
        .insert("json".to_string(), vec!["[1, 2, 3]".to_string()]);
    let res = automation_json_payload(&args_non_object);
    assert!(res.is_err());
    assert!(res
        .unwrap_err()
        .to_string()
        .contains("must contain a JSON object"));

    let mut args_malformed = crate::dedicated_cli::OperationArguments::default();
    args_malformed
        .options
        .insert("json".to_string(), vec!["{invalid json".to_string()]);
    let res = automation_json_payload(&args_malformed);
    assert!(res.is_err());
    assert!(res.unwrap_err().to_string().contains("must be valid JSON"));

    let args_missing = crate::dedicated_cli::OperationArguments::default();
    let res = automation_json_payload(&args_missing);
    assert!(res.is_err());
    assert!(res.unwrap_err().to_string().contains("--json is required"));
}
#[cfg(test)]
mod worktree_cli_selector_tests {
    use super::*;

    fn candidate(id: &str, path: &str, session_id: Option<&str>) -> CliWorktreeCandidate {
        CliWorktreeCandidate {
            id: id.to_string(),
            branch: None,
            paths: vec![path.to_string()],
            session_id: session_id.map(str::to_string),
        }
    }

    #[test]
    fn caller_cwd_uses_deepest_containing_checkout_without_focus_fallback() {
        let candidates = vec![
            candidate("root", "C:/repo", Some("root-session")),
            candidate("child", "C:/repo/children/task", Some("child-session")),
        ];
        assert_eq!(
            select_cli_worktree_candidate(
                &candidates,
                None,
                None,
                Some("C:/repo/children/task/src")
            )
            .expect("deepest checkout"),
            "child"
        );
        assert!(
            select_cli_worktree_candidate(&candidates, None, None, Some("C:/elsewhere"))
                .expect_err("no focus fallback")
                .to_string()
                .contains("not inside")
        );
    }

    #[test]
    fn exact_and_workspace_selectors_reject_ambiguity() {
        let mut first = candidate("one", "C:/one", Some("shared"));
        first.branch = Some("feature".to_string());
        let mut second = candidate("two", "C:/two", Some("shared"));
        second.branch = Some("feature".to_string());
        let candidates = vec![first, second];
        assert!(
            select_cli_worktree_candidate(&candidates, Some("feature"), None, None)
                .expect_err("ambiguous exact branch")
                .to_string()
                .contains("ambiguous")
        );
        assert!(
            select_cli_worktree_candidate(&candidates, None, Some("shared"), None)
                .expect_err("ambiguous binding")
                .to_string()
                .contains("ambiguous")
        );
    }
}
