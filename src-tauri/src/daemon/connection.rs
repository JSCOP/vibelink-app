use super::*;

#[derive(Default)]
pub(super) struct BrowserHostRouter {
    host: Option<(Uuid, Sender<DaemonToClient>)>,
    pending: HashMap<Uuid, Sender<RemoteBrowserHostResponse>>,
}

pub(super) fn register_browser_host(client_id: Uuid, sender: Sender<DaemonToClient>) {
    lock_mutex(&BROWSER_HOST_ROUTER).host = Some((client_id, sender));
}

fn unregister_browser_host(client_id: Uuid) {
    let mut router = lock_mutex(&BROWSER_HOST_ROUTER);
    if router
        .host
        .as_ref()
        .is_some_and(|(host_id, _)| *host_id == client_id)
    {
        router.host = None;
        router.pending.clear();
    }
}

pub(super) fn dispatch_browser_host_request(
    operation_id: Uuid,
    method: String,
    payload_json: String,
) -> Result<String> {
    let request_id = Uuid::new_v4();
    let (response_tx, response_rx) = bounded(1);
    let host = {
        let mut router = lock_mutex(&BROWSER_HOST_ROUTER);
        let host = router
            .host
            .as_ref()
            .map(|(_, sender)| sender.clone())
            .context("browser_unavailable: desktop browser host is not connected")?;
        router.pending.insert(request_id, response_tx);
        host
    };
    let request = RemoteBrowserHostRequest {
        request_id,
        operation_id,
        method,
        payload_json,
    };
    if host
        .send(DaemonToClient::RemoteBrowserRequest { request })
        .is_err()
    {
        lock_mutex(&BROWSER_HOST_ROUTER).pending.remove(&request_id);
        anyhow::bail!("browser_unavailable: desktop browser host disconnected");
    }
    let response = match response_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(response) => response,
        Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
            lock_mutex(&BROWSER_HOST_ROUTER).pending.remove(&request_id);
            anyhow::bail!("browser_unavailable: desktop browser host timed out");
        }
        Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
            lock_mutex(&BROWSER_HOST_ROUTER).pending.remove(&request_id);
            anyhow::bail!("browser_unavailable: desktop browser host disconnected");
        }
    };
    if response.request_id != request_id {
        anyhow::bail!("conflict: browser host response identity mismatch");
    }
    if let Some(error) = response.error {
        anyhow::bail!(error);
    }
    response
        .result_json
        .context("browser host returned no result")
}

pub(super) fn resolve_browser_host_response(
    client_id: Uuid,
    response: RemoteBrowserHostResponse,
) -> Result<()> {
    let sender = {
        let mut router = lock_mutex(&BROWSER_HOST_ROUTER);
        if router
            .host
            .as_ref()
            .is_none_or(|(host_id, _)| *host_id != client_id)
        {
            anyhow::bail!("capability_denied: client is not the registered browser host");
        }
        router.pending.remove(&response.request_id)
    };
    if let Some(sender) = sender {
        let _ = sender.send(response);
    }
    Ok(())
}

#[derive(Clone)]
pub(super) struct ConnectionControl {
    pub(super) sender: Sender<DaemonToClient>,
    pub(super) cancelled: Arc<AtomicBool>,
}

pub(super) fn handle_connection(
    mut stream: LocalSocketStream,
    state: SharedState,
    sessions_path: Arc<PathBuf>,
    control: Arc<ControlPlane>,
    coordinator: Arc<CoordinatorService>,
    worktree_registry: Arc<WorktreeRegistry>,
    worktree_lifecycle: Arc<WorktreeLifecycleService>,
    worktrees: Arc<WorktreeManager>,
    automation: Arc<AutomationService>,
    remote: Arc<RemoteServer>,
    shutdown: Arc<AtomicBool>,
    computer: SharedComputerHost,
    boot_id: Uuid,
    ipc_secret: Arc<[u8; 32]>,
    policy_heartbeat: Arc<Mutex<PolicyHeartbeat>>,
    connections: SharedConnections,
) {
    if let Err(err) = stream.set_send_timeout(Some(CLIENT_WRITE_TIMEOUT)) {
        warn!(?err, "failed to set daemon client write timeout");
    }
    if let Err(err) = stream.set_recv_timeout(Some(AUTH_CHALLENGE_TTL)) {
        warn!(?err, "failed to set daemon admission timeout");
    }
    let authenticated = match authenticate_connection(&mut stream, boot_id, &ipc_secret) {
        Ok(authenticated) => authenticated,
        Err(error) => {
            warn!(code = error.as_str(), "daemon client admission rejected");
            return;
        }
    };
    if let Err(err) = stream.set_recv_timeout(Some(Duration::from_secs(1))) {
        warn!(?err, "failed to set daemon client read timeout");
    }
    if authenticated.client_kind == ClientKind::App {
        lock_mutex(&policy_heartbeat).note_app_connection();
    }

    let client_id = authenticated.client_id;
    let client_kind = authenticated.client_kind;
    let (mut reader, mut writer) = stream.split();
    let (tx, rx) = bounded::<DaemonToClient>(CLIENT_QUEUE_CAPACITY);
    let cancelled = Arc::new(AtomicBool::new(false));

    lock_state(&state).add_client(client_id, tx.clone());
    lock_mutex(&connections).insert(
        client_id,
        ConnectionControl {
            sender: tx.clone(),
            cancelled: Arc::clone(&cancelled),
        },
    );
    let writer_thread = thread::Builder::new()
        .name("vibelink-daemon-client-writer".to_string())
        .spawn(move || {
            while let Ok(msg) = rx.recv() {
                if let Err(err) = write_frame(&mut writer, &msg) {
                    error!(?err, "failed to write daemon reply");
                    break;
                }
            }
        });

    loop {
        if cancelled.load(Ordering::Acquire) {
            break;
        }
        if let Some((code, epoch, terminate_daemon)) =
            heartbeat_revocation(&policy_heartbeat, Instant::now())
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
            break;
        }

        let msg = match read_frame::<_, ClientToDaemon>(&mut reader) {
            Ok(msg) => msg,
            Err(crate::protocol::FrameError::Io(err))
                if err.kind() == io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(crate::protocol::FrameError::Io(err))
                if matches!(
                    err.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) =>
            {
                continue
            }
            Err(err) => {
                error!(?err, "failed to read daemon frame");
                break;
            }
        };

        let request_id = request_id(&msg);
        if let Err(code) = authorize_daemon_message(&msg, client_kind) {
            let _ = tx.send(DaemonToClient::Error {
                req: request_id,
                message: code.as_str().to_string(),
            });
            if matches!(
                code,
                AuthorizationErrorCode::EntitlementRequired
                    | AuthorizationErrorCode::AuthorizationStale
            ) {
                let epoch = lock_mutex(&policy_heartbeat).policy_epoch;
                revoke_daemon_authorization(
                    &state,
                    &sessions_path,
                    &connections,
                    &shutdown,
                    code,
                    epoch,
                    false,
                );
            } else {
                cancelled.store(true, Ordering::Release);
            }
            break;
        }

        if let ClientToDaemon::AuthorizationHeartbeat { snapshot } = &msg {
            if client_kind != ClientKind::App {
                let _ = tx.send(DaemonToClient::Error {
                    req: request_id,
                    message: DAEMON_AUTH_REQUIRED.to_string(),
                });
                break;
            }
            let authorization_snapshot: AuthorizationSnapshot = snapshot.clone().into();
            if let Err(error) = remote.update_authorization(authorization_snapshot.clone()) {
                warn!(?error, "remote authorization update failed");
            }
            let mut heartbeat = lock_mutex(&policy_heartbeat);
            heartbeat.update(authorization_snapshot);
            let revoked = heartbeat.revoked;
            let epoch = heartbeat.policy_epoch;
            drop(heartbeat);
            if revoked {
                revoke_daemon_authorization(
                    &state,
                    &sessions_path,
                    &connections,
                    &shutdown,
                    AuthorizationErrorCode::EntitlementRequired,
                    epoch,
                    false,
                );
                break;
            }
        }

        if let Err(err) = dispatch_message(
            Arc::clone(&state),
            &sessions_path,
            client_id,
            &tx,
            Arc::clone(&control),
            Arc::clone(&coordinator),
            Arc::clone(&worktree_registry),
            Arc::clone(&worktree_lifecycle),
            Arc::clone(&worktrees),
            Arc::clone(&automation),
            Arc::clone(&remote),
            computer.clone(),
            msg,
            &shutdown,
        ) {
            let _ = tx.send(DaemonToClient::Error {
                req: request_id,
                message: err.to_string(),
            });
        }

        if shutdown.load(Ordering::Acquire) {
            break;
        }
    }

    let lease_transitions = {
        let mut guard = lock_state(&state);
        guard.remove_client(client_id);
        guard.cleanup_remote_connection_leases(RemoteConnectionCleanupRequest {
            owner_connection_id: client_id,
        })
    };
    process_pane_lease_transitions(&state, lease_transitions);
    unregister_browser_host(client_id);
    lock_mutex(&connections).remove(&client_id);
    drop(tx);
    if let Ok(writer_thread) = writer_thread {
        let _ = writer_thread.join();
    }
}
