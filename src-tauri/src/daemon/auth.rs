use super::*;

fn send_admission_error<S: Write>(stream: &mut S, code: AuthorizationErrorCode) {
    let _ = write_frame(
        stream,
        &DaemonToClient::Error {
            req: None,
            message: code.as_str().to_string(),
        },
    );
}

pub(super) fn authenticate_connection<S: Read + Write>(
    stream: &mut S,
    boot_id: Uuid,
    secret: &[u8; 32],
) -> std::result::Result<AuthenticatedClient, AuthorizationErrorCode> {
    let (client_id, client_kind) = match read_frame::<_, ClientToDaemon>(stream) {
        Ok(ClientToDaemon::Hello {
            protocol_version,
            client_id,
            client_kind,
        }) if protocol_version == DAEMON_PROTOCOL_VERSION => (client_id, client_kind),
        Ok(ClientToDaemon::Hello { .. }) => {
            send_admission_error(stream, AuthorizationErrorCode::DaemonProtocolMismatch);
            return Err(AuthorizationErrorCode::DaemonProtocolMismatch);
        }
        Ok(_) | Err(_) => {
            send_admission_error(stream, AuthorizationErrorCode::AuthRequired);
            return Err(AuthorizationErrorCode::AuthRequired);
        }
    };

    let mut nonce = [0_u8; 32];
    OsRng.fill_bytes(&mut nonce);
    let mut pending = PendingChallenge {
        boot_id,
        nonce,
        client_id,
        client_kind,
        expires_at: Instant::now() + AUTH_CHALLENGE_TTL,
        consumed: false,
    };
    write_frame(
        stream,
        &DaemonToClient::Challenge {
            protocol_version: DAEMON_PROTOCOL_VERSION,
            boot_id,
            nonce,
            expires_at_unix_ms: unix_time_millis() + AUTH_CHALLENGE_TTL.as_millis() as i64,
        },
    )
    .map_err(|_| AuthorizationErrorCode::AuthRequired)?;

    let (authenticate_client_id, proof) = match read_frame::<_, ClientToDaemon>(stream) {
        Ok(ClientToDaemon::Authenticate { client_id, proof }) => (client_id, proof),
        Ok(_) | Err(_) => {
            send_admission_error(stream, AuthorizationErrorCode::AuthRequired);
            return Err(AuthorizationErrorCode::AuthRequired);
        }
    };
    if let Err(code) = pending.verify(secret, authenticate_client_id, &proof, Instant::now()) {
        send_admission_error(stream, code);
        return Err(code);
    }

    let (policy_epoch, lease_until_unix_ms) = HeadlessLicenseCache::load()
        .map(|cache| {
            let snapshot = cache.authorization_snapshot(0);
            (
                snapshot.policy_epoch,
                snapshot.lease_until.timestamp_millis(),
            )
        })
        .unwrap_or_else(|_| (0, unix_time_millis()));
    write_frame(
        stream,
        &DaemonToClient::Authenticated {
            policy_epoch,
            lease_until_unix_ms,
        },
    )
    .map_err(|_| AuthorizationErrorCode::AuthRequired)?;
    Ok(AuthenticatedClient {
        client_id,
        client_kind,
    })
}

fn request_capability(
    msg: &ClientToDaemon,
) -> std::result::Result<Capability, AuthorizationErrorCode> {
    match msg {
        ClientToDaemon::Hello { .. } | ClientToDaemon::Authenticate { .. } => {
            Err(AuthorizationErrorCode::AuthRequired)
        }
        ClientToDaemon::Ping { .. }
        | ClientToDaemon::AuthorizationHeartbeat { .. }
        | ClientToDaemon::RegisterBrowserHost => Ok(Capability::AccountStatus),
        ClientToDaemon::Shutdown { .. } => Ok(Capability::DaemonShutdown),
        ClientToDaemon::ListSessions { .. }
        | ClientToDaemon::RemoteWorkspaceProjection { .. }
        | ClientToDaemon::AttachSession { .. }
        | ClientToDaemon::DetachSession { .. }
        | ClientToDaemon::SubscribePane { .. }
        | ClientToDaemon::DetachPane { .. }
        | ClientToDaemon::GetScrollback { .. }
        | ClientToDaemon::ResourceSnapshot { .. }
        | ClientToDaemon::AttentionSnapshot { .. }
        | ClientToDaemon::RemotePaneLeaseStatus { .. } => Ok(Capability::WorkspaceRead),
        ClientToDaemon::AttachPane { .. } => Ok(Capability::TerminalRead),
        ClientToDaemon::WritePane { .. } => Ok(Capability::TerminalWrite),
        ClientToDaemon::Cli { .. } => Ok(Capability::CliControl),
        ClientToDaemon::Remote { .. } => Ok(Capability::RemoteConnect),
        ClientToDaemon::SetDesktopSelection { .. }
        | ClientToDaemon::CreateSession { .. }
        | ClientToDaemon::RenameSession { .. }
        | ClientToDaemon::SetSessionWorkspaceFolder { .. }
        | ClientToDaemon::DeleteSession { .. }
        | ClientToDaemon::SaveLayout { .. }
        | ClientToDaemon::SpawnPane { .. }
        | ClientToDaemon::CancelPaneSpawn { .. }
        | ClientToDaemon::ResizePane { .. }
        | ClientToDaemon::NotifySessionChanged { .. }
        | ClientToDaemon::SetPaneTitle { .. }
        | ClientToDaemon::SetPaneRole { .. }
        | ClientToDaemon::ClosePane { .. }
        | ClientToDaemon::ClearSession { .. }
        | ClientToDaemon::TaskEvent { .. }
        | ClientToDaemon::Control { .. }
        | ClientToDaemon::Worktree { .. }
        | ClientToDaemon::Orchestration { .. }
        | ClientToDaemon::Computer { .. }
        | ClientToDaemon::RemoteBrowser { .. }
        | ClientToDaemon::RemoteBrowserResponse { .. }
        | ClientToDaemon::RemotePaneLeaseClaim { .. }
        | ClientToDaemon::RemotePaneLeaseRenew { .. }
        | ClientToDaemon::RemotePaneLeaseRelease { .. }
        | ClientToDaemon::RemotePaneLeaseAdminReclaim { .. }
        | ClientToDaemon::RemoteConnectionCleanup { .. } => Ok(Capability::WorkspaceMutate),
    }
}

fn client_capability(
    client_kind: ClientKind,
    msg: &ClientToDaemon,
) -> std::result::Result<Option<Capability>, AuthorizationErrorCode> {
    match client_kind {
        ClientKind::App => Ok(None),
        ClientKind::Cli => Ok(Some(Capability::CliControl)),
        ClientKind::Mcp => Ok(Some(Capability::McpCall)),
        ClientKind::Remote => Ok(Some(Capability::RemoteConnect)),
        ClientKind::StartupProbe if matches!(msg, ClientToDaemon::Ping { .. }) => Ok(None),
        ClientKind::Shutdown
            if matches!(
                msg,
                ClientToDaemon::Ping { .. } | ClientToDaemon::Shutdown { .. }
            ) =>
        {
            Ok(None)
        }
        ClientKind::StartupProbe | ClientKind::Shutdown => {
            Err(AuthorizationErrorCode::AuthRequired)
        }
    }
}

pub(super) fn authorize_daemon_message(
    msg: &ClientToDaemon,
    client_kind: ClientKind,
) -> std::result::Result<(), AuthorizationErrorCode> {
    authorize_daemon_message_with(msg, client_kind, || {
        HeadlessLicenseCache::load().map(|cache| cache.authorization_snapshot(0))
    })
}

pub(super) fn authorize_daemon_message_with<F>(
    msg: &ClientToDaemon,
    client_kind: ClientKind,
    load_snapshot: F,
) -> std::result::Result<(), AuthorizationErrorCode>
where
    F: FnOnce() -> Result<AuthorizationSnapshot>,
{
    let operation = request_capability(msg)?;
    let ingress = client_capability(client_kind, msg)?;
    let snapshot = load_snapshot().map_err(|_| AuthorizationErrorCode::AuthorizationStale)?;
    let now = Utc::now();
    if let Some(ingress) = ingress {
        snapshot
            .authorize(ingress, now)
            .map_err(|denied| denied.code)?;
    }
    snapshot
        .authorize(operation, now)
        .map_err(|denied| denied.code)
}

pub(super) fn revoke_daemon_authorization(
    state: &SharedState,
    sessions_path: &Path,
    connections: &SharedConnections,
    shutdown: &Arc<AtomicBool>,
    code: AuthorizationErrorCode,
    policy_epoch: u64,
    terminate_daemon: bool,
) {
    let controls = lock_mutex(connections)
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for control in controls {
        let _ = control.sender.send_timeout(
            DaemonToClient::AuthorizationChanged {
                code: code.as_str().to_string(),
                policy_epoch,
            },
            Duration::from_millis(250),
        );
        control.cancelled.store(true, Ordering::Release);
    }
    kill_all_panes(state);
    if let Err(error) = persist_state(state, sessions_path) {
        warn!(?error, "failed to persist authorization revocation cleanup");
    }
    if terminate_daemon {
        shutdown.store(true, Ordering::Release);
        let _ = crate::app::spawn_daemon::connect_daemon();
    }
}

pub(super) fn heartbeat_revocation(
    heartbeat: &Mutex<PolicyHeartbeat>,
    now: Instant,
) -> Option<(AuthorizationErrorCode, u64, bool)> {
    let mut heartbeat = lock_mutex(heartbeat);
    if heartbeat.revoked {
        return Some((
            AuthorizationErrorCode::EntitlementRequired,
            heartbeat.policy_epoch,
            false,
        ));
    }
    if heartbeat.stale(now) {
        heartbeat.revoked = true;
        return Some((
            AuthorizationErrorCode::AuthorizationStale,
            heartbeat.policy_epoch,
            true,
        ));
    }
    None
}

pub(super) fn spawn_policy_monitor(
    state: SharedState,
    sessions_path: Arc<PathBuf>,
    connections: SharedConnections,
    heartbeat: Arc<Mutex<PolicyHeartbeat>>,
    shutdown: Arc<AtomicBool>,
) -> Result<()> {
    thread::Builder::new()
        .name("vibelink-daemon-policy".to_string())
        .spawn(move || {
            while !shutdown.load(Ordering::Acquire) {
                thread::sleep(Duration::from_secs(1));
                if let Some((code, epoch, terminate_daemon)) =
                    heartbeat_revocation(&heartbeat, Instant::now())
                {
                    revoke_daemon_authorization(
                        &state,
                        &sessions_path,
                        &connections,
                        &shutdown,
                        code,
                        epoch,
                        terminate_daemon,
                    );
                    if terminate_daemon {
                        break;
                    }
                }
            }
        })?;
    Ok(())
}

fn unix_time_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
