use super::*;

pub(super) fn spawn_pane_for_session(
    state: SharedState,
    sessions_path: PathBuf,
    session_id: Uuid,
    cfg: crate::protocol::PaneConfig,
    attach_client: Option<Uuid>,
) -> Result<crate::protocol::PaneMeta> {
    spawn_pane_for_session_internal(
        state,
        sessions_path,
        session_id,
        cfg,
        attach_client,
        None,
        None,
    )
}

pub(super) fn restore_pane_for_session(
    state: SharedState,
    sessions_path: PathBuf,
    session_id: Uuid,
    cfg: crate::protocol::PaneConfig,
    scrollback: Vec<u8>,
) -> Result<crate::protocol::PaneMeta> {
    spawn_pane_for_session_internal(
        state,
        sessions_path,
        session_id,
        cfg,
        None,
        None,
        Some(scrollback),
    )
}

pub(super) fn spawn_orchestration_pane_for_session(
    state: SharedState,
    sessions_path: PathBuf,
    session_id: Uuid,
    cfg: crate::protocol::PaneConfig,
    coordinator: Arc<CoordinatorService>,
) -> Result<crate::protocol::PaneMeta> {
    spawn_pane_for_session_internal(
        state,
        sessions_path,
        session_id,
        cfg,
        None,
        Some(coordinator),
        None,
    )
}

fn spawn_pane_for_session_internal(
    state: SharedState,
    sessions_path: PathBuf,
    session_id: Uuid,
    mut cfg: crate::protocol::PaneConfig,
    attach_client: Option<Uuid>,
    coordinator: Option<Arc<CoordinatorService>>,
    restored_scrollback: Option<Vec<u8>>,
) -> Result<crate::protocol::PaneMeta> {
    if lock_state(&state).pane_spawn_cancelled(session_id, cfg.pane_id) {
        bail!("PANE_SPAWN_CANCELLED");
    }
    lock_state(&state).pane_metas(session_id)?;

    let pane_id = cfg.pane_id;
    cfg.env = pty::inject_pane_identity(std::mem::take(&mut cfg.env), session_id, pane_id);
    let spawned = match restored_scrollback {
        Some(scrollback) => Pane::spawn_restored(cfg, scrollback)?,
        None => Pane::spawn(cfg)?,
    };
    let child = spawned.pane.child();
    let reader = spawned.reader;
    let history_snapshot = spawned
        .pane
        .config
        .restore_on_start
        .then(|| spawned.pane.scrollback_snapshot());
    let (meta, generation) = {
        let mut guard = lock_state(&state);
        if guard.pane_spawn_cancelled(session_id, pane_id) {
            drop(guard);
            let mut pane = spawned.pane;
            if let Err(error) = pane.kill() {
                warn!(?error, %pane_id, "failed to kill pane cancelled during spawn");
            }
            bail!("PANE_SPAWN_CANCELLED");
        }
        let meta = match guard.insert_pane_or_recover(session_id, spawned.pane) {
            Ok(meta) => meta,
            Err((err, mut pane)) => {
                drop(guard);
                if let Err(kill_err) = pane.kill() {
                    warn!(?kill_err, %pane_id, "failed to kill pane after insert error");
                }
                return Err(err);
            }
        };
        if let Some(client_id) = attach_client {
            guard.attach_client_to_pane(client_id, pane_id);
        }
        let generation = guard
            .pane_output_generation(pane_id)
            .expect("inserted pane has an output generation");
        (meta, generation)
    };

    let history = history_snapshot.and_then(|snapshot| {
        match TerminalHistoryWriter::open(&sessions_path, session_id, pane_id, &snapshot) {
            Ok(writer) => Some(writer),
            Err(error) => {
                warn!(?error, %session_id, %pane_id, "failed to open terminal history");
                None
            }
        }
    });

    thread::Builder::new()
        .name(format!("vibelink-pty-{pane_id}"))
        .spawn(move || {
            read_pane_loop(
                state,
                pane_id,
                generation,
                reader,
                child,
                Arc::new(sessions_path),
                coordinator,
                history,
            )
        })?;

    Ok(meta)
}

fn read_pane_loop(
    state: SharedState,
    pane_id: Uuid,
    generation: u64,
    mut reader: Box<dyn Read + Send>,
    child: SharedChild,
    sessions_path: Arc<PathBuf>,
    coordinator: Option<Arc<CoordinatorService>>,
    mut history: Option<TerminalHistoryWriter>,
) {
    let mut buf = [0_u8; 65536];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let bytes = &buf[..n];
                let capture_snapshot = history
                    .as_ref()
                    .is_some_and(|writer| writer.should_compact(bytes.len()));
                let Some(PaneOutputEffect {
                    pane_generation,
                    output_sequence,
                    senders,
                    snapshot,
                }) = lock_state(&state).record_output_and_push_for_generation(
                    pane_id,
                    generation,
                    bytes,
                    capture_snapshot,
                )
                else {
                    continue;
                };
                if let Some(writer) = history.as_mut() {
                    if let Err(error) = writer.record(bytes, snapshot.as_deref()) {
                        warn!(?error, %pane_id, "failed to persist terminal output");
                    }
                }
                if !senders.is_empty() {
                    send_output_to_clients(
                        senders,
                        pane_id,
                        pane_generation,
                        output_sequence,
                        bytes.to_vec(),
                    );
                }
            }
            Err(err) => {
                warn!(?err, pane_id = %pane_id, "pty reader stopped");
                break;
            }
        }
    }

    let exit_code = lock_mutex(&child)
        .wait()
        .ok()
        .and_then(|status| i32::try_from(status.exit_code()).ok());
    let Some(PaneExitEffect { senders, lease }) =
        lock_state(&state).mark_exited_for_generation(pane_id, generation)
    else {
        return;
    };
    if let Some(history) = history {
        if let Err(error) = history.remove() {
            warn!(?error, %pane_id, "failed to remove exited pane history");
        }
    }
    for sender in senders {
        let _ = sender.send(DaemonToClient::PaneExited { pane_id, exit_code });
    }
    if let Some(transition) = lease {
        process_pane_lease_transition(&state, transition);
    }
    if let Some(coordinator) = coordinator {
        if let Err(error) = coordinator.record_pane_exit(
            Uuid::new_v4(),
            &pane_id.to_string(),
            exit_code,
            orchestration_now_millis(),
        ) {
            warn!(?error, %pane_id, "failed to reconcile orchestration pane exit");
        }
    }
    if let Err(err) = persist_state(&state, &sessions_path) {
        error!(?err, %pane_id, "failed to persist pane exit");
    }
}

pub(super) fn send_output_to_clients(
    senders: Vec<Sender<DaemonToClient>>,
    pane_id: Uuid,
    pane_generation: u64,
    output_sequence: u64,
    data: Vec<u8>,
) {
    if senders.is_empty() {
        return;
    }

    let last_index = senders.len() - 1;
    let mut original = Some(data);
    for (index, sender) in senders.into_iter().enumerate() {
        let data = if index == last_index {
            original.take().expect("original output frame present")
        } else {
            original
                .as_ref()
                .expect("original output frame present")
                .clone()
        };
        match sender.try_send(DaemonToClient::Output {
            pane_id,
            pane_generation,
            output_sequence,
            data,
        }) {
            Ok(()) | Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {}
        }
    }
}

pub(super) fn send(tx: &Sender<DaemonToClient>, msg: DaemonToClient) -> Result<()> {
    tx.send(msg)?;
    Ok(())
}

pub(super) fn send_ok(tx: &Sender<DaemonToClient>, req: Req) -> Result<()> {
    send(
        tx,
        DaemonToClient::Reply {
            req,
            result: ReplyResult::Ok,
        },
    )
}

pub(super) fn write_pane_authorized(
    state: &SharedState,
    session_id: Uuid,
    pane_id: Uuid,
    data: &[u8],
    origin: &PaneCommandOrigin,
) -> Result<()> {
    let writer = lock_state(state).pane_writer_authorized(session_id, pane_id, origin)?;
    let mut writer = lock_mutex(&writer);
    writer.write_all(data)?;
    writer.flush()?;
    Ok(())
}

pub(super) fn resize_pane_authorized(
    state: &SharedState,
    session_id: Uuid,
    pane_id: Uuid,
    cols: u16,
    rows: u16,
    origin: &PaneCommandOrigin,
) -> Result<()> {
    let senders =
        lock_state(state).resize_pane_authorized(session_id, pane_id, cols, rows, origin)?;
    broadcast_pane_resize(senders, session_id, pane_id, cols.max(1), rows.max(1));
    Ok(())
}

fn broadcast_pane_resize(
    senders: Vec<Sender<DaemonToClient>>,
    session_id: Uuid,
    pane_id: Uuid,
    cols: u16,
    rows: u16,
) {
    for sender in senders {
        let _ = sender.send(DaemonToClient::PaneResized {
            session_id,
            pane_id,
            cols,
            rows,
        });
    }
}

fn broadcast_pane_lease_event(state: &SharedState, event: crate::protocol::RemotePaneLeaseEvent) {
    let senders = lock_state(state).all_senders();
    for sender in senders {
        let _ = sender.send(DaemonToClient::RemotePaneLease {
            event: event.clone(),
        });
    }
}

fn process_pane_lease_effect(state: &SharedState, effect: PaneLeaseEffect) {
    if let Some(resize) = effect.resize {
        broadcast_pane_resize(
            resize.senders,
            resize.session_id,
            resize.pane_id,
            resize.cols,
            resize.rows,
        );
    }
    if let Some(event) = effect.event {
        broadcast_pane_lease_event(state, event);
    }
}

pub(super) fn process_pane_lease_transition(state: &SharedState, transition: PaneLeaseTransition) {
    for effect in transition.effects {
        process_pane_lease_effect(state, effect);
    }
}

pub(super) fn process_pane_lease_transitions(
    state: &SharedState,
    transitions: Vec<PaneLeaseTransition>,
) {
    for transition in transitions {
        process_pane_lease_transition(state, transition);
    }
}

pub(super) fn send_pane_lease_transition(
    state: &SharedState,
    tx: &Sender<DaemonToClient>,
    req: Req,
    transition: PaneLeaseTransition,
) -> Result<()> {
    let result = transition.result.clone();
    process_pane_lease_transition(state, transition);
    send(
        tx,
        DaemonToClient::Reply {
            req,
            result: ReplyResult::RemotePaneLease(result),
        },
    )
}

pub(super) fn send_remote_connection_cleanup(
    state: &SharedState,
    tx: &Sender<DaemonToClient>,
    req: Req,
    transitions: Vec<PaneLeaseTransition>,
) -> Result<()> {
    let mut releases = Vec::with_capacity(transitions.len());
    for transition in &transitions {
        let RemotePaneLeaseResult::Cleanup {
            releases: transition_releases,
        } = &transition.result
        else {
            anyhow::bail!("unexpected remote connection cleanup transition");
        };
        releases.extend(transition_releases.iter().cloned());
    }
    process_pane_lease_transitions(state, transitions);
    send(
        tx,
        DaemonToClient::Reply {
            req,
            result: ReplyResult::RemotePaneLease(RemotePaneLeaseResult::Cleanup { releases }),
        },
    )
}

pub(super) fn notify_session_changed(state: &SharedState, session_id: Uuid) -> Result<()> {
    let senders = lock_state(state).all_senders();
    for sender in senders {
        let _ = sender.send(DaemonToClient::SessionChanged { session_id });
    }
    Ok(())
}

pub(super) fn notify_all_sessions_changed(state: &SharedState) {
    let (session_ids, senders) = {
        let guard = lock_state(state);
        (guard.session_ids(), guard.all_senders())
    };
    for session_id in session_ids {
        for sender in &senders {
            let _ = sender.send(DaemonToClient::SessionChanged { session_id });
        }
    }
}

pub(super) fn persist_restorable_panes_and_kill_all(
    state: &SharedState,
    sessions_path: &Path,
) -> Result<()> {
    stop_debounced_persister();
    let persist_result = persist_state(state, sessions_path);
    kill_all_panes(state);
    persist_result
}

pub(super) fn kill_owned_panes(panes: Vec<Pane>, operation: &str) -> Result<()> {
    let mut first_error = None;
    for mut pane in panes {
        let pane_id = pane.id;
        if let Err(error) = pane.kill_and_wait(Duration::from_secs(5)) {
            warn!(?error, %pane_id, operation, "failed to terminate owned pane");
            if first_error.is_none() {
                first_error =
                    Some(error.context(format!("terminate pane {pane_id} for {operation}")));
            }
        }
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    Ok(())
}

pub(super) fn kill_all_panes(state: &SharedState) {
    let pane_ids: Vec<Uuid> = {
        let guard = lock_state(state);
        guard
            .list_sessions()
            .into_iter()
            .flat_map(|meta| {
                guard
                    .pane_metas(meta.id)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|p| p.id)
            })
            .collect()
    };

    for pane_id in pane_ids {
        let pane = {
            let mut guard = lock_state(state);
            match guard.close_pane_any(pane_id) {
                Ok(pane) => pane,
                Err(err) => {
                    warn!(?err, %pane_id, "failed to remove pane during shutdown");
                    continue;
                }
            }
        };
        let Some(mut pane) = pane else {
            continue;
        };
        if let Err(err) = pane.kill() {
            warn!(?err, %pane_id, "failed to kill pane during shutdown");
        }
    }
}
