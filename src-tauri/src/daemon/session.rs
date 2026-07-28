use crate::daemon::persistence::PersistedSession;
use crate::daemon::pty::Pane;
use crate::orchestration::PaneProjectionState;
use crate::protocol::{
    DaemonToClient, DesktopSelection, PaneCommandOrigin, PaneMeta, RemoteConnectionCleanupRequest,
    RemotePaneLease, RemotePaneLeaseAdminReclaimRequest, RemotePaneLeaseClaimRequest,
    RemotePaneLeaseEvent, RemotePaneLeaseEventKind, RemotePaneLeaseEventReason,
    RemotePaneLeaseReleaseOutcome, RemotePaneLeaseReleaseRequest, RemotePaneLeaseRenewRequest,
    RemotePaneLeaseRestoration, RemotePaneLeaseRestorationStatus, RemotePaneLeaseResult,
    RemotePaneLeaseStaleReason, RemotePaneLeaseStatusRequest, RemoteWorkspaceProjection,
    RemoteWorkspaceProjectionPane, RemoteWorkspaceProjectionWorkspace, SessionMeta,
    TerminalSnapshot, REMOTE_PANE_LEASE_TTL_MS,
};
use crate::remote::layout_order::pane_layout_positions;
use crossbeam_channel::Sender;
use indexmap::IndexMap;
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub struct Session {
    pub meta: SessionMeta,
    pub layout_json: Option<String>,
    pub panes: IndexMap<Uuid, Pane>,
    pub sleeping: bool,
    /// Mirrors the persisted clean-exit marker so a workspace reloaded from a
    /// deliberate shutdown stays non-restorable until it is opened again.
    pub clean_exit: bool,
}

pub struct PaneLeaseResize {
    pub session_id: Uuid,
    pub pane_id: Uuid,
    pub cols: u16,
    pub rows: u16,
    pub senders: Vec<Sender<DaemonToClient>>,
}

pub struct PaneLeaseEffect {
    pub event: Option<RemotePaneLeaseEvent>,
    pub resize: Option<PaneLeaseResize>,
}

pub struct PaneLeaseTransition {
    pub result: RemotePaneLeaseResult,
    pub effects: Vec<PaneLeaseEffect>,
}

pub struct PaneExitEffect {
    pub senders: Vec<Sender<DaemonToClient>>,
    pub lease: Option<PaneLeaseTransition>,
}

pub struct PaneOutputEffect {
    pub senders: Vec<Sender<DaemonToClient>>,
    pub snapshot: Option<Vec<u8>>,
}

pub struct DaemonState {
    sessions: HashMap<Uuid, Session>,
    clients: HashMap<Uuid, Sender<DaemonToClient>>,
    pane_clients: HashMap<Uuid, HashSet<Uuid>>,
    session_clients: HashMap<Uuid, HashSet<Uuid>>,
    pane_leases: HashMap<Uuid, RemotePaneLease>,
    next_pane_generation: u64,
    next_pane_lease_revision: u64,
    desktop_selection: DesktopSelection,
}

impl DaemonState {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            clients: HashMap::new(),
            pane_clients: HashMap::new(),
            session_clients: HashMap::new(),
            pane_leases: HashMap::new(),
            next_pane_generation: 1,
            next_pane_lease_revision: 1,
            desktop_selection: DesktopSelection {
                workspace_id: None,
                pane_id: None,
            },
        }
    }

    pub fn add_client(&mut self, client_id: Uuid, tx: Sender<DaemonToClient>) {
        self.clients.insert(client_id, tx);
    }

    pub fn remove_client(&mut self, client_id: Uuid) {
        self.clients.remove(&client_id);
        for clients in self.pane_clients.values_mut() {
            clients.remove(&client_id);
        }
        for clients in self.session_clients.values_mut() {
            clients.remove(&client_id);
        }
    }

    pub fn create_session(
        &mut self,
        name: String,
        workspace_folder: Option<String>,
    ) -> SessionMeta {
        let id = Uuid::new_v4();
        let meta = SessionMeta {
            id,
            name,
            pane_count: 0,
            created_at: now_unix_secs(),
            workspace_folder,
        };
        self.sessions.insert(
            id,
            Session {
                meta: meta.clone(),
                layout_json: None,
                panes: IndexMap::new(),
                sleeping: false,
                clean_exit: false,
            },
        );
        meta
    }

    pub fn insert_session(
        &mut self,
        meta: SessionMeta,
        layout_json: Option<String>,
        sleeping: bool,
        clean_exit: bool,
    ) {
        self.sessions.insert(
            meta.id,
            Session {
                meta,
                layout_json,
                sleeping,
                clean_exit,
                panes: IndexMap::new(),
            },
        );
    }

    /// Marks every workspace as deliberately shut down. Called once on the
    /// daemon's own shutdown path, immediately before the final persist, so
    /// the next start can tell a clean quit from a crash.
    pub fn mark_clean_exit(&mut self) {
        for session in self.sessions.values_mut() {
            session.clean_exit = true;
        }
    }

    /// Clears the clean-exit marker for one workspace. Attaching to a
    /// workspace makes it live again, so a later crash must restore it.
    pub fn clear_clean_exit(&mut self, session_id: Uuid) {
        if let Some(session) = self.sessions.get_mut(&session_id) {
            session.clean_exit = false;
        }
    }

    pub fn list_sessions(&self) -> Vec<SessionMeta> {
        let mut sessions: Vec<_> = self
            .sessions
            .values()
            .map(|session| {
                let mut meta = session.meta.clone();
                meta.pane_count = session.panes.len();
                meta
            })
            .collect();
        sessions.sort_by_key(|meta| meta.created_at);
        sessions
    }

    pub fn remote_workspace_projection(
        &self,
        workspace_id: Option<Uuid>,
        pane_states: &HashMap<String, PaneProjectionState>,
    ) -> anyhow::Result<RemoteWorkspaceProjection> {
        let workspaces = self
            .list_sessions()
            .into_iter()
            .map(|session| RemoteWorkspaceProjectionWorkspace {
                id: session.id.to_string(),
                name: session.name,
                pane_count: u32::try_from(session.pane_count).unwrap_or(u32::MAX),
                workspace_folder: session.workspace_folder,
            })
            .collect();
        let Some(workspace_id) = workspace_id else {
            return Ok(RemoteWorkspaceProjection {
                workspaces,
                attached_workspace_id: None,
                panes: Vec::new(),
            });
        };
        let session = self.session(workspace_id)?;
        let metas = session.panes.values().map(Pane::meta).collect::<Vec<_>>();
        let positions = pane_layout_positions(session.layout_json.as_deref(), &metas);
        let mut panes = session
            .panes
            .values()
            .map(|pane| {
                let position = positions
                    .get(&pane.id)
                    .expect("layout projection covers every live pane");
                let state = pane_states.get(&pane.id.to_string());
                RemoteWorkspaceProjectionPane {
                    activity: state
                        .map(|state| state.activity)
                        .unwrap_or(crate::protocol::RemotePaneActivity::Idle),
                    alive: pane.alive,
                    cols: pane.config.cols,
                    desktop_active: self.desktop_selection.workspace_id == Some(workspace_id)
                        && self.desktop_selection.pane_id == Some(pane.id),
                    group_id: position.group_id.clone(),
                    group_order: position.group_order,
                    id: pane.id.to_string(),
                    last_output_at: pane.last_output_at(),
                    order: position.order,
                    pane_generation: pane.output_cursor().0,
                    role: pane.config.role.clone().unwrap_or_default(),
                    rows: pane.config.rows,
                    tab_order: position.tab_order,
                    title: pane
                        .config
                        .title
                        .clone()
                        .or_else(|| pane.config.shell.clone())
                        .unwrap_or_else(|| "Shell".to_string()),
                    unread_count: state.map(|state| state.unread_count).unwrap_or(0),
                    workspace_id: workspace_id.to_string(),
                }
            })
            .collect::<Vec<_>>();
        panes.sort_by_key(|pane| pane.order);
        Ok(RemoteWorkspaceProjection {
            workspaces,
            attached_workspace_id: Some(workspace_id.to_string()),
            panes,
        })
    }

    pub fn set_desktop_selection(
        &mut self,
        selection: DesktopSelection,
    ) -> anyhow::Result<Vec<Uuid>> {
        if selection.pane_id.is_some() && selection.workspace_id.is_none() {
            anyhow::bail!("desktop pane selection requires a workspace");
        }
        if let Some(workspace_id) = selection.workspace_id {
            self.session(workspace_id)?;
            if let Some(pane_id) = selection.pane_id {
                self.pane_in_session(workspace_id, pane_id)?;
            }
        }
        if selection == self.desktop_selection {
            return Ok(Vec::new());
        }
        let mut affected = Vec::new();
        if let Some(workspace_id) = self.desktop_selection.workspace_id {
            affected.push(workspace_id);
        }
        if let Some(workspace_id) = selection.workspace_id {
            if !affected.contains(&workspace_id) {
                affected.push(workspace_id);
            }
        }
        self.desktop_selection = selection;
        Ok(affected)
    }

    #[cfg(test)]
    pub fn desktop_selection(&self) -> DesktopSelection {
        self.desktop_selection.clone()
    }

    pub fn resource_targets(&self) -> Vec<(Uuid, Uuid, Option<u32>)> {
        let mut out = Vec::new();
        for (session_id, session) in &self.sessions {
            for (pane_id, pane) in &session.panes {
                out.push((*session_id, *pane_id, pane.root_pid()));
            }
        }
        out
    }

    pub fn rename_session(&mut self, session_id: Uuid, name: String) -> anyhow::Result<()> {
        let session = self.session_mut(session_id)?;
        session.meta.name = name;
        Ok(())
    }

    pub fn set_session_workspace_folder(
        &mut self,
        session_id: Uuid,
        workspace_folder: String,
    ) -> anyhow::Result<()> {
        let session = self.session_mut(session_id)?;
        session.meta.workspace_folder = Some(workspace_folder);
        Ok(())
    }

    pub fn delete_session(&mut self, session_id: Uuid) -> anyhow::Result<Vec<Pane>> {
        let mut session = self
            .sessions
            .remove(&session_id)
            .ok_or_else(|| anyhow::anyhow!("unknown session {session_id}"))?;
        let pane_ids: Vec<_> = session.panes.keys().copied().collect();
        for pane_id in &pane_ids {
            self.pane_clients.remove(pane_id);
        }
        self.session_clients.remove(&session_id);
        if self.desktop_selection.workspace_id == Some(session_id) {
            self.desktop_selection = DesktopSelection {
                workspace_id: None,
                pane_id: None,
            };
        }
        Ok(session.panes.drain(..).map(|(_, pane)| pane).collect())
    }

    pub fn sleep_session(&mut self, session_id: Uuid) -> anyhow::Result<Vec<Pane>> {
        let session = self
            .sessions
            .get_mut(&session_id)
            .ok_or_else(|| anyhow::anyhow!("unknown session {session_id}"))?;
        session.sleeping = true;
        let pane_ids = session.panes.keys().copied().collect::<Vec<_>>();
        for pane_id in pane_ids {
            self.pane_clients.remove(&pane_id);
        }
        Ok(session.panes.drain(..).map(|(_, pane)| pane).collect())
    }

    pub fn wake_session(&mut self, session_id: Uuid) -> anyhow::Result<()> {
        self.session_mut(session_id)?.sleeping = false;
        Ok(())
    }

    pub fn session_sleeping(&self, session_id: Uuid) -> anyhow::Result<bool> {
        Ok(self.session(session_id)?.sleeping)
    }

    pub fn attach_session(
        &self,
        session_id: Uuid,
    ) -> anyhow::Result<(Option<String>, Vec<PaneMeta>)> {
        let session = self.session(session_id)?;
        Ok((
            session.layout_json.clone(),
            session.panes.values().map(Pane::meta).collect(),
        ))
    }

    pub fn detach_session(&mut self, client_id: Uuid, session_id: Uuid) {
        let Some(session) = self.sessions.get(&session_id) else {
            self.session_clients.remove(&session_id);
            return;
        };
        for pane_id in session.panes.keys() {
            if let Some(clients) = self.pane_clients.get_mut(pane_id) {
                clients.remove(&client_id);
            }
        }
        if let Some(clients) = self.session_clients.get_mut(&session_id) {
            clients.remove(&client_id);
        }
    }

    pub fn save_layout(&mut self, session_id: Uuid, layout_json: String) -> anyhow::Result<()> {
        self.session_mut(session_id)?.layout_json = Some(layout_json);
        Ok(())
    }

    #[cfg(test)]
    pub fn insert_pane(&mut self, session_id: Uuid, pane: Pane) -> anyhow::Result<PaneMeta> {
        self.insert_pane_or_recover(session_id, pane)
            .map_err(|(err, _pane)| err)
    }

    pub fn insert_pane_or_recover(
        &mut self,
        session_id: Uuid,
        mut pane: Pane,
    ) -> std::result::Result<PaneMeta, (anyhow::Error, Pane)> {
        if !self.sessions.contains_key(&session_id) {
            return Err((anyhow::anyhow!("unknown session {session_id}"), pane));
        }
        pane.assign_output_generation(self.take_pane_generation());
        let meta = pane.meta();
        let session = self
            .sessions
            .get_mut(&session_id)
            .expect("session existence checked before pane insertion");
        session.panes.insert(meta.id, pane);
        session.meta.pane_count = session.panes.len();
        Ok(meta)
    }

    pub fn close_pane(&mut self, session_id: Uuid, pane_id: Uuid) -> anyhow::Result<Option<Pane>> {
        self.session(session_id)?;
        if !self
            .sessions
            .get(&session_id)
            .is_some_and(|session| session.panes.contains_key(&pane_id))
        {
            if let Some((owner_session_id, _)) = self.find_pane(pane_id) {
                anyhow::bail!(
                    "pane {pane_id} belongs to session {owner_session_id}, not {session_id}"
                );
            }
            self.pane_clients.remove(&pane_id);
            return Ok(None);
        }
        Ok(self.remove_pane(session_id, pane_id))
    }

    pub fn close_pane_any(&mut self, pane_id: Uuid) -> anyhow::Result<Option<Pane>> {
        let Some((session_id, _)) = self.find_pane(pane_id) else {
            self.pane_clients.remove(&pane_id);
            return Ok(None);
        };
        Ok(self.remove_pane(session_id, pane_id))
    }

    fn remove_pane(&mut self, session_id: Uuid, pane_id: Uuid) -> Option<Pane> {
        let session = self.sessions.get_mut(&session_id)?;
        let pane = session.panes.shift_remove(&pane_id);
        session.meta.pane_count = session.panes.len();
        self.pane_clients.remove(&pane_id);
        if self.desktop_selection.workspace_id == Some(session_id)
            && self.desktop_selection.pane_id == Some(pane_id)
        {
            self.desktop_selection.pane_id = None;
        }
        pane
    }

    pub fn pane_writer_authorized(
        &self,
        session_id: Uuid,
        pane_id: Uuid,
        origin: &PaneCommandOrigin,
    ) -> anyhow::Result<Arc<Mutex<Box<dyn Write + Send>>>> {
        self.authorize_pane_command(session_id, pane_id, origin)?;
        let pane = self.pane_in_session(session_id, pane_id)?;
        Ok(Arc::clone(&pane.writer))
    }

    pub fn resize_pane_authorized(
        &mut self,
        session_id: Uuid,
        pane_id: Uuid,
        cols: u16,
        rows: u16,
        origin: &PaneCommandOrigin,
    ) -> anyhow::Result<Vec<Sender<DaemonToClient>>> {
        self.authorize_pane_command(session_id, pane_id, origin)?;
        if matches!(origin, PaneCommandOrigin::Remote { .. }) {
            validate_remote_geometry(cols, rows)?;
            if let Some(lease) = self
                .pane_leases
                .get(&pane_id)
                .filter(|lease| lease.expires_at > now_unix_millis())
            {
                if (cols, rows) != (lease.target_cols, lease.target_rows) {
                    anyhow::bail!("remote pane resize must match the negotiated lease target");
                }
            }
        }
        self.resize_pane_unchecked(session_id, pane_id, cols, rows)
    }

    pub fn claim_or_update_remote_pane_lease(
        &mut self,
        request: RemotePaneLeaseClaimRequest,
        now_ms: u64,
    ) -> anyhow::Result<PaneLeaseTransition> {
        validate_remote_geometry(request.cols, request.rows)?;
        self.pane_in_session(request.session_id, request.pane_id)?;

        let mut effects = Vec::new();
        if self
            .pane_leases
            .get(&request.pane_id)
            .is_some_and(|lease| lease.expires_at <= now_ms)
        {
            let expired = self
                .finish_remote_pane_lease(
                    request.pane_id,
                    RemotePaneLeaseEventKind::Lost,
                    RemotePaneLeaseEventReason::Expired,
                    true,
                    false,
                )
                .expect("expired pane lease disappeared before transition");
            effects.extend(expired.effects);
        }

        let (pane_generation, original_cols, original_rows) = {
            let pane = self.pane_in_session(request.session_id, request.pane_id)?;
            let (pane_generation, _) = pane.output_cursor();
            (pane_generation, pane.config.cols, pane.config.rows)
        };

        if let Some(current) = self.pane_leases.get(&request.pane_id).cloned() {
            if current.owner_connection_id != request.owner_connection_id {
                return Ok(busy_transition(current));
            }
            if current.device_id != request.device_id {
                return Ok(stale_transition(
                    Some(current),
                    RemotePaneLeaseStaleReason::Device,
                ));
            }
            if current.session_id != request.session_id {
                return Ok(stale_transition(
                    Some(current),
                    RemotePaneLeaseStaleReason::Session,
                ));
            }
            if current.pane_generation != pane_generation {
                return Ok(stale_transition(
                    Some(current),
                    RemotePaneLeaseStaleReason::PaneGeneration,
                ));
            }
            if request.lease_id != Some(current.lease_id) {
                return Ok(stale_transition(
                    Some(current),
                    RemotePaneLeaseStaleReason::LeaseId,
                ));
            }
            if request.revision != Some(current.revision) {
                return Ok(stale_transition(
                    Some(current),
                    RemotePaneLeaseStaleReason::Revision,
                ));
            }

            let mut lease = current;
            lease.revision = self.take_pane_lease_revision();
            lease.target_cols = request.cols;
            lease.target_rows = request.rows;
            lease.viewport_revision = request.viewport_revision;
            lease.expires_at = now_ms.saturating_add(REMOTE_PANE_LEASE_TTL_MS);
            let resize = self.resize_for_lease(&lease, request.cols, request.rows)?;
            self.pane_leases.insert(request.pane_id, lease.clone());
            effects.push(PaneLeaseEffect {
                event: Some(lease_event(
                    &lease,
                    RemotePaneLeaseEventKind::Updated,
                    RemotePaneLeaseEventReason::TargetUpdated,
                    None,
                )),
                resize,
            });
            return Ok(PaneLeaseTransition {
                result: RemotePaneLeaseResult::Updated { lease },
                effects,
            });
        }

        let lease = RemotePaneLease {
            lease_id: Uuid::new_v4(),
            owner_connection_id: request.owner_connection_id,
            device_id: request.device_id,
            session_id: request.session_id,
            pane_id: request.pane_id,
            pane_generation,
            revision: self.take_pane_lease_revision(),
            original_cols,
            original_rows,
            target_cols: request.cols,
            target_rows: request.rows,
            viewport_revision: request.viewport_revision,
            expires_at: now_ms.saturating_add(REMOTE_PANE_LEASE_TTL_MS),
        };
        let resize = self.resize_for_lease(&lease, request.cols, request.rows)?;
        self.pane_leases.insert(request.pane_id, lease.clone());
        effects.push(PaneLeaseEffect {
            event: Some(lease_event(
                &lease,
                RemotePaneLeaseEventKind::Claimed,
                RemotePaneLeaseEventReason::Claimed,
                None,
            )),
            resize,
        });
        Ok(PaneLeaseTransition {
            result: RemotePaneLeaseResult::Claimed { lease },
            effects,
        })
    }

    pub fn renew_remote_pane_lease(
        &mut self,
        request: RemotePaneLeaseRenewRequest,
        now_ms: u64,
    ) -> anyhow::Result<PaneLeaseTransition> {
        let Some(current) = self.pane_leases.get(&request.pane_id).cloned() else {
            return Ok(stale_transition(None, RemotePaneLeaseStaleReason::Missing));
        };
        if let Some(reason) = lease_request_stale_reason(
            &current,
            request.owner_connection_id,
            &request.device_id,
            request.session_id,
            request.lease_id,
            request.revision,
        ) {
            return Ok(stale_transition(Some(current), reason));
        }
        let pane_generation = self
            .pane_in_session(request.session_id, request.pane_id)?
            .output_cursor()
            .0;
        if current.pane_generation != pane_generation {
            return Ok(stale_transition(
                Some(current),
                RemotePaneLeaseStaleReason::PaneGeneration,
            ));
        }
        let mut lease = current;
        lease.revision = self.take_pane_lease_revision();
        lease.viewport_revision = request.viewport_revision;
        lease.expires_at = now_ms.saturating_add(REMOTE_PANE_LEASE_TTL_MS);
        self.pane_leases.insert(request.pane_id, lease.clone());
        Ok(PaneLeaseTransition {
            result: RemotePaneLeaseResult::Renewed {
                lease: lease.clone(),
            },
            effects: vec![PaneLeaseEffect {
                event: Some(lease_event(
                    &lease,
                    RemotePaneLeaseEventKind::Updated,
                    RemotePaneLeaseEventReason::Renewed,
                    None,
                )),
                resize: None,
            }],
        })
    }

    pub fn release_remote_pane_lease(
        &mut self,
        request: RemotePaneLeaseReleaseRequest,
    ) -> anyhow::Result<PaneLeaseTransition> {
        let Some(current) = self.pane_leases.get(&request.pane_id).cloned() else {
            return Ok(stale_transition(None, RemotePaneLeaseStaleReason::Missing));
        };
        if let Some(reason) = lease_request_stale_reason(
            &current,
            request.owner_connection_id,
            &request.device_id,
            request.session_id,
            request.lease_id,
            request.revision,
        ) {
            return Ok(stale_transition(Some(current), reason));
        }
        self.finish_remote_pane_lease(
            request.pane_id,
            RemotePaneLeaseEventKind::Released,
            RemotePaneLeaseEventReason::Released,
            true,
            true,
        )
        .ok_or_else(|| anyhow::anyhow!("remote pane lease disappeared"))
    }

    pub fn remote_pane_lease_status(
        &self,
        request: RemotePaneLeaseStatusRequest,
        now_ms: u64,
    ) -> RemotePaneLeaseResult {
        let lease = self
            .pane_leases
            .get(&request.pane_id)
            .filter(|lease| lease.expires_at > now_ms)
            .cloned();
        RemotePaneLeaseResult::Status { lease }
    }

    pub fn admin_reclaim_remote_pane_lease(
        &mut self,
        request: RemotePaneLeaseAdminReclaimRequest,
    ) -> anyhow::Result<PaneLeaseTransition> {
        if let Some(lease) = self.pane_leases.get(&request.pane_id) {
            if lease.session_id != request.session_id {
                anyhow::bail!(
                    "pane {} does not belong to session {}",
                    request.pane_id,
                    request.session_id
                );
            }
        }
        self.finish_remote_pane_lease(
            request.pane_id,
            RemotePaneLeaseEventKind::Lost,
            RemotePaneLeaseEventReason::AdminReclaimed,
            true,
            false,
        )
        .ok_or_else(|| anyhow::anyhow!("no active remote lease for pane {}", request.pane_id))
    }

    pub fn expire_remote_pane_leases(&mut self, now_ms: u64) -> Vec<PaneLeaseTransition> {
        let pane_ids = self
            .pane_leases
            .iter()
            .filter_map(|(pane_id, lease)| (lease.expires_at <= now_ms).then_some(*pane_id))
            .collect::<Vec<_>>();
        pane_ids
            .into_iter()
            .filter_map(|pane_id| {
                self.finish_remote_pane_lease(
                    pane_id,
                    RemotePaneLeaseEventKind::Lost,
                    RemotePaneLeaseEventReason::Expired,
                    true,
                    false,
                )
            })
            .collect()
    }

    pub fn cleanup_remote_connection_leases(
        &mut self,
        request: RemoteConnectionCleanupRequest,
    ) -> Vec<PaneLeaseTransition> {
        let pane_ids = self
            .pane_leases
            .iter()
            .filter_map(|(pane_id, lease)| {
                (lease.owner_connection_id == request.owner_connection_id).then_some(*pane_id)
            })
            .collect::<Vec<_>>();
        pane_ids
            .into_iter()
            .filter_map(|pane_id| {
                self.finish_remote_pane_lease(
                    pane_id,
                    RemotePaneLeaseEventKind::Lost,
                    RemotePaneLeaseEventReason::ConnectionClosed,
                    true,
                    false,
                )
            })
            .collect()
    }

    pub fn cleanup_remote_pane_lease_on_exit(
        &mut self,
        pane_id: Uuid,
    ) -> Option<PaneLeaseTransition> {
        self.finish_remote_pane_lease(
            pane_id,
            RemotePaneLeaseEventKind::Lost,
            RemotePaneLeaseEventReason::PaneExited,
            false,
            false,
        )
    }

    pub fn cleanup_remote_pane_leases_on_exit<I>(&mut self, pane_ids: I) -> Vec<PaneLeaseTransition>
    where
        I: IntoIterator<Item = Uuid>,
    {
        pane_ids
            .into_iter()
            .filter_map(|pane_id| self.cleanup_remote_pane_lease_on_exit(pane_id))
            .collect()
    }

    fn authorize_pane_command(
        &self,
        session_id: Uuid,
        pane_id: Uuid,
        origin: &PaneCommandOrigin,
    ) -> anyhow::Result<()> {
        let pane = self.pane_in_session(session_id, pane_id)?;
        let pane_generation = pane.output_cursor().0;
        let active_lease = self
            .pane_leases
            .get(&pane_id)
            .filter(|lease| lease.expires_at > now_unix_millis());
        match (origin, active_lease) {
            (PaneCommandOrigin::Desktop, None) => Ok(()),
            (PaneCommandOrigin::Desktop, Some(_)) => {
                anyhow::bail!("desktop pane command rejected while remote lease is active")
            }
            (
                PaneCommandOrigin::Remote {
                    lease_id: None,
                    revision: None,
                    ..
                },
                None,
            ) => Ok(()),
            (PaneCommandOrigin::Remote { .. }, None) => {
                anyhow::bail!("remote pane lease is stale or missing")
            }
            (
                PaneCommandOrigin::Remote {
                    owner_connection_id,
                    device_id,
                    lease_id,
                    revision,
                },
                Some(lease),
            ) if lease.owner_connection_id == *owner_connection_id
                && lease.device_id == *device_id
                && Some(lease.lease_id) == *lease_id
                && Some(lease.revision) == *revision
                && lease.session_id == session_id
                && lease.pane_id == pane_id
                && lease.pane_generation == pane_generation =>
            {
                Ok(())
            }
            (PaneCommandOrigin::Remote { .. }, Some(_)) => {
                anyhow::bail!("remote pane command does not match the active lease")
            }
        }
    }

    fn take_pane_generation(&mut self) -> u64 {
        let generation = self.next_pane_generation;
        self.next_pane_generation = self
            .next_pane_generation
            .checked_add(1)
            .expect("pane generation exhausted");
        generation
    }

    fn take_pane_lease_revision(&mut self) -> u64 {
        let revision = self.next_pane_lease_revision;
        self.next_pane_lease_revision = self
            .next_pane_lease_revision
            .checked_add(1)
            .expect("remote pane lease revision exhausted");
        revision
    }

    fn resize_for_lease(
        &mut self,
        lease: &RemotePaneLease,
        cols: u16,
        rows: u16,
    ) -> anyhow::Result<Option<PaneLeaseResize>> {
        let senders = self.resize_pane_unchecked(lease.session_id, lease.pane_id, cols, rows)?;
        Ok((!senders.is_empty()).then_some(PaneLeaseResize {
            session_id: lease.session_id,
            pane_id: lease.pane_id,
            cols,
            rows,
            senders,
        }))
    }

    fn finish_remote_pane_lease(
        &mut self,
        pane_id: Uuid,
        event_kind: RemotePaneLeaseEventKind,
        reason: RemotePaneLeaseEventReason,
        restore: bool,
        explicit_release: bool,
    ) -> Option<PaneLeaseTransition> {
        let mut lease = self.pane_leases.remove(&pane_id)?;
        lease.revision = self.take_pane_lease_revision();
        let (restoration, resize) = if restore {
            self.restore_remote_pane_lease(&lease)
        } else {
            (
                RemotePaneLeaseRestoration {
                    session_id: lease.session_id,
                    pane_id: lease.pane_id,
                    pane_generation: lease.pane_generation,
                    cols: lease.original_cols,
                    rows: lease.original_rows,
                    status: RemotePaneLeaseRestorationStatus::PaneMissing,
                },
                None,
            )
        };
        let release = RemotePaneLeaseReleaseOutcome {
            lease: lease.clone(),
            restoration: restoration.clone(),
        };
        let result = if explicit_release {
            RemotePaneLeaseResult::Released { release }
        } else if reason == RemotePaneLeaseEventReason::AdminReclaimed {
            RemotePaneLeaseResult::Reclaimed { release }
        } else {
            RemotePaneLeaseResult::Cleanup {
                releases: vec![release],
            }
        };
        Some(PaneLeaseTransition {
            result,
            effects: vec![PaneLeaseEffect {
                event: Some(lease_event(&lease, event_kind, reason, Some(restoration))),
                resize,
            }],
        })
    }

    fn restore_remote_pane_lease(
        &mut self,
        lease: &RemotePaneLease,
    ) -> (RemotePaneLeaseRestoration, Option<PaneLeaseResize>) {
        let current_generation = self
            .sessions
            .get(&lease.session_id)
            .and_then(|session| session.panes.get(&lease.pane_id))
            .map(|pane| pane.output_cursor().0);
        let (status, resize) = match current_generation {
            None => (RemotePaneLeaseRestorationStatus::PaneMissing, None),
            Some(generation) if generation != lease.pane_generation => {
                (RemotePaneLeaseRestorationStatus::GenerationMismatch, None)
            }
            Some(_) => match self.resize_for_lease(lease, lease.original_cols, lease.original_rows)
            {
                Ok(resize) => (RemotePaneLeaseRestorationStatus::Restored, resize),
                Err(_) => (RemotePaneLeaseRestorationStatus::ResizeFailed, None),
            },
        };
        (
            RemotePaneLeaseRestoration {
                session_id: lease.session_id,
                pane_id: lease.pane_id,
                pane_generation: lease.pane_generation,
                cols: lease.original_cols,
                rows: lease.original_rows,
                status,
            },
            resize,
        )
    }

    fn resize_pane_unchecked(
        &mut self,
        session_id: Uuid,
        pane_id: Uuid,
        cols: u16,
        rows: u16,
    ) -> anyhow::Result<Vec<Sender<DaemonToClient>>> {
        let pane = self.pane_in_session_mut(session_id, pane_id)?;
        let cols = cols.max(1);
        let rows = rows.max(1);
        if pane.config.cols == cols && pane.config.rows == rows {
            return Ok(Vec::new());
        }
        pane.resize(cols, rows)?;
        Ok(self.senders_for_pane_or_session(session_id, pane_id))
    }

    pub fn set_pane_title(
        &mut self,
        session_id: Uuid,
        pane_id: Uuid,
        title: String,
    ) -> anyhow::Result<()> {
        let pane = self.pane_in_session_mut(session_id, pane_id)?;
        pane.config.title = Some(title);
        Ok(())
    }

    pub fn set_pane_role(
        &mut self,
        session_id: Uuid,
        pane_id: Uuid,
        role: Option<String>,
    ) -> anyhow::Result<()> {
        let pane = self.pane_in_session_mut(session_id, pane_id)?;
        pane.config.role = role;
        Ok(())
    }

    pub fn get_scrollback(&self, session_id: Uuid, pane_id: Uuid) -> anyhow::Result<Vec<u8>> {
        let session = self.session(session_id)?;
        let pane = session.panes.get(&pane_id).ok_or_else(|| {
            anyhow::anyhow!("pane {pane_id} does not belong to session {session_id}")
        })?;
        Ok(pane.scrollback_snapshot())
    }

    pub fn terminal_snapshot(
        &self,
        session_id: Uuid,
        pane_id: Uuid,
    ) -> anyhow::Result<(u64, u64, bool, Vec<u8>)> {
        let pane = self.pane_in_session(session_id, pane_id)?;
        let (generation, sequence) = pane.output_cursor();
        Ok((generation, sequence, pane.alive, pane.scrollback_snapshot()))
    }

    pub fn close_session_panes(&mut self, session_id: Uuid) -> anyhow::Result<Vec<Pane>> {
        let pane_ids: Vec<Uuid> = {
            let session = self.session_mut(session_id)?;
            session.panes.keys().copied().collect()
        };
        for pane_id in &pane_ids {
            self.pane_clients.remove(pane_id);
        }
        let session = self.session_mut(session_id)?;
        let mut removed = Vec::new();
        for pane_id in pane_ids {
            if let Some(pane) = session.panes.shift_remove(&pane_id) {
                removed.push(pane);
            }
        }
        session.meta.pane_count = session.panes.len();
        Ok(removed)
    }

    pub fn subscribe_pane(
        &mut self,
        client_id: Uuid,
        session_id: Uuid,
        pane_id: Uuid,
    ) -> anyhow::Result<TerminalSnapshot> {
        let snapshot = {
            let pane = self.pane_in_session(session_id, pane_id)?;
            let (pane_generation, output_sequence) = pane.output_cursor();
            TerminalSnapshot {
                session_id,
                pane_id,
                pane_generation,
                output_sequence,
                cols: pane.config.cols,
                rows: pane.config.rows,
                alive: pane.alive,
                data: pane.scrollback_snapshot(),
            }
        };
        self.attach_client_to_pane(client_id, pane_id);
        Ok(snapshot)
    }

    pub fn detach_pane(
        &mut self,
        client_id: Uuid,
        session_id: Uuid,
        pane_id: Uuid,
    ) -> anyhow::Result<()> {
        self.pane_in_session(session_id, pane_id)?;
        let remove_entry = self.pane_clients.get_mut(&pane_id).is_some_and(|clients| {
            clients.remove(&client_id);
            clients.is_empty()
        });
        if remove_entry {
            self.pane_clients.remove(&pane_id);
        }
        Ok(())
    }

    pub fn attach_pane(
        &mut self,
        client_id: Uuid,
        session_id: Uuid,
        pane_id: Uuid,
    ) -> anyhow::Result<()> {
        let (snapshot, alive) = {
            let pane = self.pane_in_session(session_id, pane_id)?;
            (pane.scrollback_snapshot(), pane.alive)
        };
        // A client that is already attached (e.g. it spawned the pane and was
        // attached at spawn time) has received every byte live; replaying the
        // snapshot would duplicate screen content.
        let already_attached = self
            .pane_clients
            .get(&pane_id)
            .is_some_and(|clients| clients.contains(&client_id));
        if let Some(tx) = self.clients.get(&client_id) {
            if !snapshot.is_empty() && !already_attached {
                // Strip terminal queries (DA1/DSR/DECRQM/...) so the client's
                // emulator does not answer them a second time — the TUI's
                // capability detection ended long ago and late replies leak
                // into its prompt as stray keystrokes.
                let data = crate::daemon::query_filter::strip_terminal_queries(&snapshot);
                if !data.is_empty() {
                    let _ = tx.try_send(DaemonToClient::Output { pane_id, data });
                }
            }
            if !alive {
                let _ = tx.send(DaemonToClient::PaneExited {
                    pane_id,
                    exit_code: None,
                });
            }
        }
        self.attach_client_to_pane(client_id, pane_id);
        Ok(())
    }

    pub fn attach_client_to_pane(&mut self, client_id: Uuid, pane_id: Uuid) {
        self.pane_clients
            .entry(pane_id)
            .or_default()
            .insert(client_id);
    }

    pub fn attach_client_to_session(&mut self, client_id: Uuid, session_id: Uuid) {
        self.session_clients
            .entry(session_id)
            .or_default()
            .insert(client_id);
    }

    #[cfg(test)]
    pub fn attached_clients(&self, pane_id: Uuid) -> Vec<Uuid> {
        self.pane_clients
            .get(&pane_id)
            .map(|clients| clients.iter().copied().collect())
            .unwrap_or_default()
    }

    #[cfg(test)]
    pub fn attached_session_clients(&self, session_id: Uuid) -> Vec<Uuid> {
        self.session_clients
            .get(&session_id)
            .map(|clients| clients.iter().copied().collect())
            .unwrap_or_default()
    }

    pub fn record_output_and_push(
        &mut self,
        pane_id: Uuid,
        bytes: &[u8],
    ) -> Vec<Sender<DaemonToClient>> {
        if let Ok(pane) = self.pane_any_mut(pane_id) {
            pane.record_output(bytes);
        }
        self.senders_for_pane(pane_id)
    }

    pub fn pane_output_generation(&self, pane_id: Uuid) -> Option<u64> {
        let (session_id, _) = self.find_pane(pane_id)?;
        self.sessions
            .get(&session_id)
            .and_then(|session| session.panes.get(&pane_id))
            .map(|pane| pane.output_cursor().0)
    }

    pub fn record_output_and_push_for_generation(
        &mut self,
        pane_id: Uuid,
        generation: u64,
        bytes: &[u8],
        capture_snapshot: bool,
    ) -> Option<PaneOutputEffect> {
        if self.pane_output_generation(pane_id) != Some(generation) {
            return None;
        }
        let record = self.pane_any_mut(pane_id).ok()?.record_output(bytes);
        let snapshot = (capture_snapshot || record.reset)
            .then(|| {
                self.pane_any_mut(pane_id)
                    .ok()
                    .map(|pane| pane.scrollback_snapshot())
            })
            .flatten();
        Some(PaneOutputEffect {
            senders: self.senders_for_pane(pane_id),
            snapshot,
        })
    }

    pub fn mark_exited_for_generation(
        &mut self,
        pane_id: Uuid,
        generation: u64,
    ) -> Option<PaneExitEffect> {
        if self.pane_output_generation(pane_id) != Some(generation) {
            return None;
        }
        Some(self.mark_exited(pane_id))
    }

    pub fn mark_exited(&mut self, pane_id: Uuid) -> PaneExitEffect {
        let owner = self.find_pane(pane_id).map(|(session_id, _)| session_id);
        let senders = owner
            .map(|session_id| self.senders_for_pane_or_session(session_id, pane_id))
            .unwrap_or_else(|| self.senders_for_pane(pane_id));
        let lease = self.cleanup_remote_pane_lease_on_exit(pane_id);
        if let Some(session_id) = owner {
            self.remove_pane(session_id, pane_id);
        } else {
            self.pane_clients.remove(&pane_id);
        }
        PaneExitEffect { senders, lease }
    }

    pub fn pane_metas(&self, session_id: Uuid) -> anyhow::Result<Vec<PaneMeta>> {
        Ok(self
            .session(session_id)?
            .panes
            .values()
            .map(Pane::meta)
            .collect())
    }

    pub fn persisted_sessions(&self) -> Vec<PersistedSession> {
        let mut sessions: Vec<_> = self
            .sessions
            .values()
            .map(|session| PersistedSession {
                id: session.meta.id,
                name: session.meta.name.clone(),
                created_at: session.meta.created_at,
                layout_json: session.layout_json.clone(),
                workspace_folder: session.meta.workspace_folder.clone(),
                sleeping: session.sleeping,
                clean_exit: session.clean_exit,
                panes: session
                    .panes
                    .values()
                    .filter(|pane| pane.alive && pane.config.restore_on_start)
                    .map(|pane| pane.config.clone())
                    .collect(),
            })
            .collect();
        sessions.sort_by_key(|session| session.created_at);
        sessions
    }

    pub fn senders_for_pane(&self, pane_id: Uuid) -> Vec<Sender<DaemonToClient>> {
        self.pane_clients
            .get(&pane_id)
            .into_iter()
            .flat_map(|clients| clients.iter())
            .filter_map(|client_id| self.clients.get(client_id))
            .cloned()
            .collect()
    }

    pub fn senders_for_session(&self, session_id: Uuid) -> Vec<Sender<DaemonToClient>> {
        self.session_clients
            .get(&session_id)
            .into_iter()
            .flat_map(|clients| clients.iter())
            .filter_map(|client_id| self.clients.get(client_id))
            .cloned()
            .collect()
    }

    pub fn senders_for_pane_or_session(
        &self,
        session_id: Uuid,
        pane_id: Uuid,
    ) -> Vec<Sender<DaemonToClient>> {
        let mut client_ids = self.pane_clients.get(&pane_id).cloned().unwrap_or_default();
        if let Some(session_clients) = self.session_clients.get(&session_id) {
            client_ids.extend(session_clients.iter().copied());
        }
        client_ids
            .into_iter()
            .filter_map(|client_id| self.clients.get(&client_id))
            .cloned()
            .collect()
    }

    pub fn session_ids(&self) -> Vec<Uuid> {
        self.sessions.keys().copied().collect()
    }

    pub fn all_senders(&self) -> Vec<Sender<DaemonToClient>> {
        self.clients.values().cloned().collect()
    }

    fn session(&self, session_id: Uuid) -> anyhow::Result<&Session> {
        self.sessions
            .get(&session_id)
            .ok_or_else(|| anyhow::anyhow!("unknown session {session_id}"))
    }

    fn session_mut(&mut self, session_id: Uuid) -> anyhow::Result<&mut Session> {
        self.sessions
            .get_mut(&session_id)
            .ok_or_else(|| anyhow::anyhow!("unknown session {session_id}"))
    }

    fn pane_in_session(&self, session_id: Uuid, pane_id: Uuid) -> anyhow::Result<&Pane> {
        let session = self.session(session_id)?;
        if let Some(pane) = session.panes.get(&pane_id) {
            return Ok(pane);
        }
        if let Some((owner_session_id, _)) = self.find_pane(pane_id) {
            anyhow::bail!("pane {pane_id} belongs to session {owner_session_id}, not {session_id}");
        }
        anyhow::bail!("unknown pane {pane_id} in session {session_id}");
    }

    fn pane_in_session_mut(
        &mut self,
        session_id: Uuid,
        pane_id: Uuid,
    ) -> anyhow::Result<&mut Pane> {
        let belongs_to_target = self
            .sessions
            .get(&session_id)
            .is_some_and(|session| session.panes.contains_key(&pane_id));
        if belongs_to_target {
            return self
                .sessions
                .get_mut(&session_id)
                .and_then(|session| session.panes.get_mut(&pane_id))
                .ok_or_else(|| anyhow::anyhow!("unknown pane {pane_id} in session {session_id}"));
        }
        self.session(session_id)?;
        if let Some((owner_session_id, _)) = self.find_pane(pane_id) {
            anyhow::bail!("pane {pane_id} belongs to session {owner_session_id}, not {session_id}");
        }
        anyhow::bail!("unknown pane {pane_id} in session {session_id}");
    }

    fn pane_any_mut(&mut self, pane_id: Uuid) -> anyhow::Result<&mut Pane> {
        let Some((session_id, pane_id)) = self.find_pane(pane_id) else {
            anyhow::bail!("unknown pane {pane_id}");
        };
        self.sessions
            .get_mut(&session_id)
            .and_then(|session| session.panes.get_mut(&pane_id))
            .ok_or_else(|| anyhow::anyhow!("unknown pane {pane_id}"))
    }

    fn find_pane(&self, pane_id: Uuid) -> Option<(Uuid, Uuid)> {
        self.sessions.iter().find_map(|(session_id, session)| {
            session
                .panes
                .contains_key(&pane_id)
                .then_some((*session_id, pane_id))
        })
    }
}

fn validate_remote_geometry(cols: u16, rows: u16) -> anyhow::Result<()> {
    if !(20..=360).contains(&cols) {
        anyhow::bail!("remote pane columns must be between 20 and 360");
    }
    if !(5..=200).contains(&rows) {
        anyhow::bail!("remote pane rows must be between 5 and 200");
    }
    Ok(())
}

fn busy_transition(lease: RemotePaneLease) -> PaneLeaseTransition {
    PaneLeaseTransition {
        result: RemotePaneLeaseResult::Busy { lease },
        effects: Vec::new(),
    }
}

fn stale_transition(
    lease: Option<RemotePaneLease>,
    reason: RemotePaneLeaseStaleReason,
) -> PaneLeaseTransition {
    PaneLeaseTransition {
        result: RemotePaneLeaseResult::Stale { lease, reason },
        effects: Vec::new(),
    }
}

fn lease_request_stale_reason(
    lease: &RemotePaneLease,
    owner_connection_id: Uuid,
    device_id: &str,
    session_id: Uuid,
    lease_id: Uuid,
    revision: u64,
) -> Option<RemotePaneLeaseStaleReason> {
    if lease.owner_connection_id != owner_connection_id {
        Some(RemotePaneLeaseStaleReason::Owner)
    } else if lease.device_id != device_id {
        Some(RemotePaneLeaseStaleReason::Device)
    } else if lease.session_id != session_id {
        Some(RemotePaneLeaseStaleReason::Session)
    } else if lease.lease_id != lease_id {
        Some(RemotePaneLeaseStaleReason::LeaseId)
    } else if lease.revision != revision {
        Some(RemotePaneLeaseStaleReason::Revision)
    } else {
        None
    }
}

fn lease_event(
    lease: &RemotePaneLease,
    kind: RemotePaneLeaseEventKind,
    reason: RemotePaneLeaseEventReason,
    restoration: Option<RemotePaneLeaseRestoration>,
) -> RemotePaneLeaseEvent {
    let leased = matches!(
        kind,
        RemotePaneLeaseEventKind::Claimed | RemotePaneLeaseEventKind::Updated
    );
    RemotePaneLeaseEvent {
        kind,
        reason,
        session_id: lease.session_id,
        pane_id: lease.pane_id,
        leased,
        cols: leased.then_some(lease.target_cols),
        rows: leased.then_some(lease.target_rows),
        lease_id: lease.lease_id,
        owner_connection_id: lease.owner_connection_id,
        device_id: lease.device_id.clone(),
        pane_generation: lease.pane_generation,
        revision: lease.revision,
        original_cols: lease.original_cols,
        original_rows: lease.original_rows,
        target_cols: lease.target_cols,
        target_rows: lease.target_rows,
        viewport_revision: lease.viewport_revision,
        expires_at: lease.expires_at,
        restoration,
    }
}

impl Default for DaemonState {
    fn default() -> Self {
        Self::new()
    }
}

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn now_unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crossbeam_channel::unbounded;

    #[test]
    fn create_session_updates_list_metadata() {
        let mut state = DaemonState::new();

        let created = state.create_session("Workspace 1".to_string(), None);
        let listed = state.list_sessions();

        assert_eq!(listed, vec![created]);
        assert_eq!(listed[0].pane_count, 0);
    }

    #[test]
    fn create_session_records_workspace_folder() {
        let mut state = DaemonState::new();

        let created = state.create_session("Repo".to_string(), Some("C:\\".to_string()));

        assert_eq!(created.workspace_folder.as_deref(), Some("C:\\"));
        assert_eq!(
            state.list_sessions()[0].workspace_folder.as_deref(),
            Some("C:\\")
        );
    }

    #[test]
    fn set_session_workspace_folder_updates_existing_workspace_metadata() {
        let mut state = DaemonState::new();
        let created = state.create_session("Workspace 1".to_string(), None);

        state
            .set_session_workspace_folder(created.id, "E:\\repo".to_string())
            .expect("set workspace folder");

        assert_eq!(
            state.list_sessions()[0].workspace_folder.as_deref(),
            Some("E:\\repo")
        );
    }

    #[test]
    fn workspace_sleep_and_wake_preserve_session_identity() {
        let mut state = DaemonState::new();
        let workspace = state.create_session("Workspace".to_string(), Some("C:\\repo".to_string()));
        let pane_id = Uuid::new_v4();
        state
            .insert_pane(workspace.id, Pane::for_test(test_config(pane_id), true))
            .expect("insert pane");

        let stopped = state.sleep_session(workspace.id).expect("sleep workspace");
        assert_eq!(stopped.len(), 1);
        assert!(state.session_sleeping(workspace.id).expect("sleep state"));
        assert_eq!(state.persisted_sessions()[0].id, workspace.id);
        assert!(state.persisted_sessions()[0].sleeping);

        state.wake_session(workspace.id).expect("wake workspace");
        assert!(!state.session_sleeping(workspace.id).expect("wake state"));
    }

    #[test]
    fn removing_client_detaches_it_from_panes() {
        let mut state = DaemonState::new();
        let client_id = uuid::Uuid::new_v4();
        let pane_id = uuid::Uuid::new_v4();
        let (tx, _rx) = unbounded();

        state.add_client(client_id, tx);
        state.attach_client_to_pane(client_id, pane_id);
        state.remove_client(client_id);

        assert!(state.attached_clients(pane_id).is_empty());
    }

    #[test]
    fn removing_client_detaches_it_from_sessions() {
        let mut state = DaemonState::new();
        let session_id = state.create_session("Test".to_string(), None).id;
        let client_id = Uuid::new_v4();
        let (tx, _rx) = unbounded();
        state.add_client(client_id, tx);
        state.attach_client_to_session(client_id, session_id);

        state.remove_client(client_id);

        assert!(state.attached_session_clients(session_id).is_empty());
    }

    #[test]
    fn persisted_sessions_include_layout_metadata() {
        let mut state = DaemonState::new();
        let meta = state.create_session("Workspace".to_string(), None);
        state
            .save_layout(meta.id, "{\"layout\":true}".to_string())
            .expect("save layout");

        let persisted = state.persisted_sessions();

        assert_eq!(persisted.len(), 1);
        assert_eq!(persisted[0].id, meta.id);
        assert_eq!(
            persisted[0].layout_json.as_deref(),
            Some("{\"layout\":true}")
        );
        assert!(persisted[0].panes.is_empty());
    }

    #[test]
    fn close_pane_removes_and_returns_pane_without_killing_inline() {
        let mut state = DaemonState::new();
        let meta = state.create_session("Workspace".to_string(), None);
        let pane_id = Uuid::new_v4();
        let config = test_config(pane_id);
        let pane = Pane::for_test(config.clone(), true);
        state.insert_pane(meta.id, pane).expect("insert pane");

        let closed = state.close_pane(meta.id, pane_id).expect("close pane");

        assert_eq!(closed.expect("closed pane").meta().config, config);
        assert!(state.pane_metas(meta.id).expect("pane metas").is_empty());
        assert!(state.persisted_sessions()[0].panes.is_empty());
    }

    #[test]
    fn persisted_sessions_include_only_restartable_live_panes() {
        let mut state = DaemonState::new();
        let meta = state.create_session("Workspace".to_string(), None);
        let restartable_id = Uuid::new_v4();
        let mut restartable = test_config(restartable_id);
        restartable.restore_on_start = true;
        state
            .insert_pane(meta.id, Pane::for_test(restartable.clone(), true))
            .expect("insert restartable pane");
        state
            .insert_pane(meta.id, Pane::for_test(test_config(Uuid::new_v4()), true))
            .expect("insert transient pane");

        let persisted = state.persisted_sessions();

        assert_eq!(persisted[0].panes, vec![restartable]);
    }

    #[test]
    fn persisted_sessions_exclude_exited_panes() {
        let mut state = DaemonState::new();
        let meta = state.create_session("Workspace".to_string(), None);
        let pane_id = Uuid::new_v4();
        let pane = Pane::for_test(test_config(pane_id), true);
        state.insert_pane(meta.id, pane).expect("insert pane");

        state.mark_exited(pane_id);

        let persisted = state.persisted_sessions();
        assert!(persisted[0].panes.is_empty());
    }
    #[test]
    fn get_scrollback_rejects_panes_from_other_sessions() {
        let mut state = DaemonState::new();
        let workspace_a = state.create_session("Workspace A".to_string(), None);
        let workspace_b = state.create_session("Workspace B".to_string(), None);
        let pane_id = Uuid::new_v4();
        let pane = Pane::for_test(test_config(pane_id), true);
        state
            .insert_pane(workspace_a.id, pane)
            .expect("insert pane");

        let err = state
            .get_scrollback(workspace_b.id, pane_id)
            .expect_err("cross-session read should fail");

        assert!(err.to_string().contains("does not belong"));
    }

    #[test]
    fn close_session_panes_removes_only_target_workspace_panes() {
        let mut state = DaemonState::new();
        let workspace_a = state.create_session("Workspace A".to_string(), None);
        let workspace_b = state.create_session("Workspace B".to_string(), None);
        let pane_a_id = Uuid::new_v4();
        let pane_b_id = Uuid::new_v4();
        let pane_a = Pane::for_test(test_config(pane_a_id), true);
        let pane_b = Pane::for_test(test_config(pane_b_id), true);
        state
            .insert_pane(workspace_a.id, pane_a)
            .expect("insert pane a");
        state
            .insert_pane(workspace_b.id, pane_b)
            .expect("insert pane b");

        let removed = state
            .close_session_panes(workspace_a.id)
            .expect("close workspace a panes");

        assert_eq!(removed.len(), 1);
        let sessions = state.list_sessions();
        let workspace_a_meta = sessions
            .iter()
            .find(|meta| meta.id == workspace_a.id)
            .expect("workspace a metadata");
        assert_eq!(workspace_a_meta.pane_count, 0);
        let workspace_b_meta = sessions
            .iter()
            .find(|meta| meta.id == workspace_b.id)
            .expect("workspace b metadata");
        assert_eq!(workspace_b_meta.pane_count, 1);
    }

    #[test]
    fn delete_session_returns_panes_without_killing_inline() {
        let mut state = DaemonState::new();
        let workspace = state.create_session("Workspace".to_string(), None);
        let client_id = Uuid::new_v4();
        let pane_a_id = Uuid::new_v4();
        let pane_b_id = Uuid::new_v4();
        let (tx, _rx) = unbounded();
        state.add_client(client_id, tx);
        state
            .insert_pane(workspace.id, Pane::for_test(test_config(pane_a_id), true))
            .expect("insert pane a");
        state
            .insert_pane(workspace.id, Pane::for_test(test_config(pane_b_id), true))
            .expect("insert pane b");
        state.attach_client_to_pane(client_id, pane_a_id);
        state.attach_client_to_pane(client_id, pane_b_id);
        state.attach_client_to_session(client_id, workspace.id);

        let panes = state.delete_session(workspace.id).expect("delete session");

        assert_eq!(panes.len(), 2);
        assert!(panes.iter().all(|pane| pane.alive));
        assert!(state.list_sessions().is_empty());
        assert!(state.attached_clients(pane_a_id).is_empty());
        assert!(state.attached_clients(pane_b_id).is_empty());
        assert!(state.attached_session_clients(workspace.id).is_empty());
    }

    #[test]
    fn pane_writer_can_be_used_after_state_lock_released() {
        let state = Arc::new(Mutex::new(DaemonState::new()));
        let workspace_id = {
            let mut guard = state.lock().expect("state mutex");
            let workspace = guard.create_session("Workspace".to_string(), None);
            let pane_id = Uuid::new_v4();
            guard
                .insert_pane(workspace.id, Pane::for_test(test_config(pane_id), true))
                .expect("insert pane");
            (workspace.id, pane_id)
        };

        let writer = {
            let guard = state.lock().expect("state mutex");
            guard
                .pane_writer_authorized(workspace_id.0, workspace_id.1, &PaneCommandOrigin::Desktop)
                .expect("pane writer")
        };

        assert!(state.try_lock().is_ok());
        let mut writer = writer.lock().expect("pty writer mutex");
        writer.write_all(b"hello").expect("write pane bytes");
        writer.flush().expect("flush pane bytes");
    }

    #[test]
    fn set_pane_title_updates_live_pane_metadata() {
        let mut state = DaemonState::new();
        let meta = state.create_session("Workspace".to_string(), None);
        let pane_id = Uuid::new_v4();
        let pane = Pane::for_test(test_config(pane_id), true);
        state.insert_pane(meta.id, pane).expect("insert pane");

        state
            .set_pane_title(meta.id, pane_id, "Codex: refactor terminal".to_string())
            .expect("set title");

        let panes = state.pane_metas(meta.id).expect("pane metas");
        assert_eq!(
            panes[0].config.title.as_deref(),
            Some("Codex: refactor terminal")
        );
    }

    #[test]
    fn resize_updates_metadata_and_notifies_subscribed_clients() {
        let mut state = DaemonState::new();
        let workspace = state.create_session("Workspace".to_string(), None);
        let pane_id = Uuid::new_v4();
        let client_id = Uuid::new_v4();
        let (tx, rx) = unbounded();
        state.add_client(client_id, tx);
        state
            .insert_pane(workspace.id, Pane::for_test(test_config(pane_id), true))
            .expect("insert pane");
        state.attach_client_to_pane(client_id, pane_id);

        let senders = state
            .resize_pane_authorized(workspace.id, pane_id, 132, 41, &PaneCommandOrigin::Desktop)
            .expect("resize pane");
        assert_eq!(senders.len(), 1);
        let panes = state.pane_metas(workspace.id).expect("pane metadata");
        assert_eq!((panes[0].config.cols, panes[0].config.rows), (132, 41));

        senders[0]
            .send(DaemonToClient::PaneResized {
                session_id: workspace.id,
                pane_id,
                cols: 132,
                rows: 41,
            })
            .expect("send resize event");
        assert_eq!(
            rx.recv().expect("resize event"),
            DaemonToClient::PaneResized {
                session_id: workspace.id,
                pane_id,
                cols: 132,
                rows: 41,
            }
        );
        assert!(state
            .resize_pane_authorized(workspace.id, pane_id, 132, 41, &PaneCommandOrigin::Desktop,)
            .expect("same-size resize")
            .is_empty());
    }

    #[test]
    fn record_output_pushes_scrollback_and_returns_senders() {
        let mut state = DaemonState::new();
        let workspace = state.create_session("Workspace".to_string(), None);
        let pane_id = Uuid::new_v4();
        let client_id = Uuid::new_v4();
        let (tx, rx) = unbounded();
        state.add_client(client_id, tx);
        state
            .insert_pane(workspace.id, Pane::for_test(test_config(pane_id), true))
            .expect("insert pane");
        state.attach_client_to_pane(client_id, pane_id);

        let senders = state.record_output_and_push(pane_id, b"hello");

        assert_eq!(senders.len(), 1);
        assert_eq!(
            state.get_scrollback(workspace.id, pane_id).unwrap(),
            b"hello"
        );
        senders[0]
            .send(DaemonToClient::Output {
                pane_id,
                data: b"hello".to_vec(),
            })
            .expect("send output");
        assert_eq!(
            rx.recv().expect("output event"),
            DaemonToClient::Output {
                pane_id,
                data: b"hello".to_vec(),
            }
        );
    }

    #[test]
    fn subscribe_pane_returns_existing_bytes_once_and_routes_later_output() {
        let mut state = DaemonState::new();
        let workspace = state.create_session("Workspace".to_string(), None);
        let pane_id = Uuid::new_v4();
        let client_id = Uuid::new_v4();
        let (tx, rx) = unbounded();
        state.add_client(client_id, tx);
        state
            .insert_pane(workspace.id, Pane::for_test(test_config(pane_id), true))
            .expect("insert pane");
        assert!(state
            .record_output_and_push(pane_id, b"before subscribe")
            .is_empty());

        let snapshot = state
            .subscribe_pane(client_id, workspace.id, pane_id)
            .expect("subscribe pane");

        assert_eq!(snapshot.data, b"before subscribe");
        assert!(
            rx.try_recv().is_err(),
            "atomic subscription must not enqueue a legacy snapshot Output"
        );

        let senders = state.record_output_and_push(pane_id, b"after subscribe");
        assert_eq!(senders.len(), 1);
        senders[0]
            .send(DaemonToClient::Output {
                pane_id,
                data: b"after subscribe".to_vec(),
            })
            .expect("send live output");
        assert_eq!(
            rx.recv().expect("live output"),
            DaemonToClient::Output {
                pane_id,
                data: b"after subscribe".to_vec(),
            }
        );
    }

    #[test]
    fn subscribe_pane_returns_exact_cursor_generation_and_geometry() {
        let mut state = DaemonState::new();
        let workspace = state.create_session("Workspace".to_string(), None);
        let pane_id = Uuid::new_v4();
        let client_id = Uuid::new_v4();
        let (tx, _rx) = unbounded();
        let mut config = test_config(pane_id);
        config.cols = 137;
        config.rows = 43;
        state.add_client(client_id, tx);
        state
            .insert_pane(workspace.id, Pane::for_test(config, true))
            .expect("insert pane");
        state.record_output_and_push(pane_id, b"first");
        state.record_output_and_push(pane_id, b"second");

        let snapshot = state
            .subscribe_pane(client_id, workspace.id, pane_id)
            .expect("subscribe pane");

        assert_eq!(snapshot.session_id, workspace.id);
        assert_eq!(snapshot.pane_id, pane_id);
        assert_eq!(snapshot.pane_generation, 1);
        assert_eq!(snapshot.output_sequence, 2);
        assert_eq!((snapshot.cols, snapshot.rows), (137, 43));
        assert!(snapshot.alive);
        assert_eq!(snapshot.data, b"firstsecond");
    }

    #[test]
    fn detach_pane_removes_only_the_requested_live_route() {
        let mut state = DaemonState::new();
        let workspace = state.create_session("Workspace".to_string(), None);
        let pane_a = Uuid::new_v4();
        let pane_b = Uuid::new_v4();
        let client_a = Uuid::new_v4();
        let client_b = Uuid::new_v4();
        let (tx_a, rx_a) = unbounded();
        let (tx_b, rx_b) = unbounded();
        state.add_client(client_a, tx_a);
        state.add_client(client_b, tx_b);
        state
            .insert_pane(workspace.id, Pane::for_test(test_config(pane_a), true))
            .expect("insert pane a");
        state
            .insert_pane(workspace.id, Pane::for_test(test_config(pane_b), true))
            .expect("insert pane b");
        state
            .subscribe_pane(client_a, workspace.id, pane_a)
            .expect("subscribe client a to pane a");
        state
            .subscribe_pane(client_a, workspace.id, pane_b)
            .expect("subscribe client a to pane b");
        state
            .subscribe_pane(client_b, workspace.id, pane_a)
            .expect("subscribe client b to pane a");

        state
            .detach_pane(client_a, workspace.id, pane_a)
            .expect("detach client a from pane a");

        assert_eq!(state.attached_clients(pane_a), vec![client_b]);
        assert_eq!(state.attached_clients(pane_b), vec![client_a]);
        let senders = state.record_output_and_push(pane_a, b"live");
        assert_eq!(senders.len(), 1);
        senders[0]
            .send(DaemonToClient::Output {
                pane_id: pane_a,
                data: b"live".to_vec(),
            })
            .expect("send remaining route");
        assert!(rx_a.try_recv().is_err());
        assert_eq!(
            rx_b.recv().expect("client b live output"),
            DaemonToClient::Output {
                pane_id: pane_a,
                data: b"live".to_vec(),
            }
        );
    }

    #[test]
    fn subscribe_pane_preserves_dead_pane_metadata() {
        let mut state = DaemonState::new();
        let workspace = state.create_session("Workspace".to_string(), None);
        let pane_id = Uuid::new_v4();
        let client_id = Uuid::new_v4();
        let (tx, rx) = unbounded();
        let mut config = test_config(pane_id);
        config.cols = 91;
        config.rows = 27;
        state.add_client(client_id, tx);
        state
            .insert_pane(workspace.id, Pane::for_test(config, false))
            .expect("insert dead pane");
        state.record_output_and_push(pane_id, b"final output");

        let snapshot = state
            .subscribe_pane(client_id, workspace.id, pane_id)
            .expect("subscribe dead pane");

        assert_eq!(snapshot.pane_generation, 1);
        assert_eq!(snapshot.output_sequence, 1);
        assert_eq!((snapshot.cols, snapshot.rows), (91, 27));
        assert!(!snapshot.alive);
        assert_eq!(snapshot.data, b"final output");
        assert_eq!(state.attached_clients(pane_id), vec![client_id]);
        assert!(
            rx.try_recv().is_err(),
            "dead metadata belongs in the snapshot reply, not a side event"
        );
    }

    #[test]
    fn attach_pane_skips_replay_for_already_attached_clients() {
        let mut state = DaemonState::new();
        let workspace = state.create_session("Workspace".to_string(), None);
        let pane_id = Uuid::new_v4();
        let client_id = Uuid::new_v4();
        let (tx, rx) = unbounded();
        state.add_client(client_id, tx);
        state
            .insert_pane(workspace.id, Pane::for_test(test_config(pane_id), true))
            .expect("insert pane");
        state.record_output_and_push(pane_id, b"banner");

        state
            .attach_pane(client_id, workspace.id, pane_id)
            .expect("first attach");
        assert_eq!(
            rx.try_recv().expect("snapshot replay"),
            DaemonToClient::Output {
                pane_id,
                data: b"banner".to_vec(),
            }
        );

        state
            .attach_pane(client_id, workspace.id, pane_id)
            .expect("second attach");
        assert!(
            rx.try_recv().is_err(),
            "already-attached client must not receive a second replay"
        );
    }

    #[test]
    fn attach_pane_strips_terminal_queries_from_replay() {
        let mut state = DaemonState::new();
        let workspace = state.create_session("Workspace".to_string(), None);
        let pane_id = Uuid::new_v4();
        let client_id = Uuid::new_v4();
        let (tx, rx) = unbounded();
        state.add_client(client_id, tx);
        state
            .insert_pane(workspace.id, Pane::for_test(test_config(pane_id), true))
            .expect("insert pane");
        state.record_output_and_push(pane_id, b"omp \x1b[c\x1b[?2026$p\x1b]11;?\x07ready");

        state
            .attach_pane(client_id, workspace.id, pane_id)
            .expect("attach");

        assert_eq!(
            rx.try_recv().expect("snapshot replay"),
            DaemonToClient::Output {
                pane_id,
                data: b"omp ready".to_vec(),
            }
        );
    }

    #[test]
    fn mark_exited_removes_pane_handles_and_allows_later_close() {
        let mut state = DaemonState::new();
        let meta = state.create_session("Workspace".to_string(), None);
        let pane_id = Uuid::new_v4();
        let pane = Pane::for_test(test_config(pane_id), true);
        state.insert_pane(meta.id, pane).expect("insert pane");

        state.mark_exited(pane_id);

        assert!(state.pane_metas(meta.id).expect("pane metas").is_empty());
        assert!(state.persisted_sessions()[0].panes.is_empty());
        assert!(state
            .close_pane(meta.id, pane_id)
            .expect("close exited pane")
            .is_none());
    }

    #[test]
    fn stale_reader_cannot_exit_replacement_with_reused_pane_id() {
        let mut state = DaemonState::new();
        let workspace = state.create_session("Workspace".to_string(), None);
        let pane_id = Uuid::new_v4();
        state
            .insert_pane(workspace.id, Pane::for_test(test_config(pane_id), true))
            .expect("insert original pane");
        let original_generation = state
            .pane_output_generation(pane_id)
            .expect("original generation");

        state
            .close_pane(workspace.id, pane_id)
            .expect("close original pane");
        state
            .insert_pane(workspace.id, Pane::for_test(test_config(pane_id), true))
            .expect("insert replacement pane");
        let replacement_generation = state
            .pane_output_generation(pane_id)
            .expect("replacement generation");
        assert_ne!(original_generation, replacement_generation);

        assert!(state
            .record_output_and_push_for_generation(pane_id, original_generation, b"stale", false)
            .is_none());
        assert!(state
            .mark_exited_for_generation(pane_id, original_generation)
            .is_none());
        assert_eq!(
            state
                .pane_metas(workspace.id)
                .expect("replacement pane")
                .len(),
            1
        );
        assert!(state
            .record_output_and_push_for_generation(
                pane_id,
                replacement_generation,
                b"current",
                false
            )
            .is_some());
        assert!(state
            .mark_exited_for_generation(pane_id, replacement_generation)
            .is_some());
        assert!(state
            .pane_metas(workspace.id)
            .expect("pane removed")
            .is_empty());
    }

    #[test]
    fn pane_updates_reject_panes_from_other_sessions() {
        let mut state = DaemonState::new();
        let workspace_a = state.create_session("Workspace A".to_string(), None);
        let workspace_b = state.create_session("Workspace B".to_string(), None);
        let pane_id = Uuid::new_v4();
        let pane = Pane::for_test(test_config(pane_id), true);
        state
            .insert_pane(workspace_a.id, pane)
            .expect("insert pane");

        let err = state
            .set_pane_title(workspace_b.id, pane_id, "Wrong workspace".to_string())
            .expect_err("cross-session title update should fail");

        assert!(err.to_string().contains("belongs to session"));
    }

    #[test]
    fn same_owner_claim_updates_target_and_preserves_original_geometry() {
        let (mut state, session_id, pane_id, owner_connection_id, device_id) = lease_state();
        let claimed = claim_lease(
            &mut state,
            session_id,
            pane_id,
            owner_connection_id,
            &device_id,
            100,
            30,
            1,
            None,
            1_000,
        );
        let first = result_lease(&claimed.result).clone();

        let updated = claim_lease(
            &mut state,
            session_id,
            pane_id,
            owner_connection_id,
            &device_id,
            120,
            40,
            2,
            Some((&first.lease_id, first.revision)),
            2_000,
        );
        let lease = result_lease(&updated.result);

        assert!(matches!(
            &updated.result,
            RemotePaneLeaseResult::Updated { .. }
        ));
        assert_eq!((lease.original_cols, lease.original_rows), (80, 24));
        assert_eq!((lease.target_cols, lease.target_rows), (120, 40));
        assert!(lease.revision > first.revision);
        assert_eq!(lease.viewport_revision, 2);
    }

    #[test]
    fn competing_owner_receives_busy_with_current_lease() {
        let (mut state, session_id, pane_id, owner_connection_id, device_id) = lease_state();
        claim_lease(
            &mut state,
            session_id,
            pane_id,
            owner_connection_id,
            &device_id,
            100,
            30,
            1,
            None,
            1_000,
        );

        let competing = claim_lease(
            &mut state,
            session_id,
            pane_id,
            Uuid::new_v4(),
            "other-device",
            90,
            25,
            1,
            None,
            2_000,
        );

        assert!(matches!(
            competing.result,
            RemotePaneLeaseResult::Busy { .. }
        ));
        assert!(competing.effects.is_empty());
    }

    #[test]
    fn active_lease_rejects_desktop_and_accepts_only_matching_remote_origin() {
        let (mut state, session_id, pane_id, owner_connection_id, device_id) = lease_state();
        let claimed = claim_lease(
            &mut state,
            session_id,
            pane_id,
            owner_connection_id,
            &device_id,
            100,
            30,
            1,
            None,
            now_unix_millis(),
        );
        let lease = result_lease(&claimed.result);

        assert!(state
            .pane_writer_authorized(session_id, pane_id, &PaneCommandOrigin::Desktop)
            .is_err());
        assert!(state
            .resize_pane_authorized(session_id, pane_id, 110, 35, &PaneCommandOrigin::Desktop,)
            .is_err());
        assert!(state
            .pane_writer_authorized(session_id, pane_id, &remote_origin(lease))
            .is_ok());
        assert!(state
            .resize_pane_authorized(
                session_id,
                pane_id,
                lease.target_cols,
                lease.target_rows,
                &remote_origin(lease),
            )
            .is_ok());

        let mut wrong = remote_origin(lease);
        if let PaneCommandOrigin::Remote { revision, .. } = &mut wrong {
            *revision = Some(lease.revision.saturating_sub(1));
        }
        assert!(state
            .pane_writer_authorized(session_id, pane_id, &wrong)
            .is_err());
    }

    #[test]
    fn remote_input_without_lease_is_shared_with_desktop() {
        let (mut state, session_id, pane_id, owner_connection_id, device_id) = lease_state();
        let shared_remote = PaneCommandOrigin::Remote {
            owner_connection_id,
            device_id,
            lease_id: None,
            revision: None,
        };

        assert!(state
            .pane_writer_authorized(session_id, pane_id, &shared_remote)
            .is_ok());
        assert!(state
            .pane_writer_authorized(session_id, pane_id, &PaneCommandOrigin::Desktop)
            .is_ok());
        assert!(state
            .resize_pane_authorized(session_id, pane_id, 90, 25, &shared_remote)
            .is_ok());
    }

    #[test]
    fn release_restores_original_geometry() {
        let (mut state, session_id, pane_id, owner_connection_id, device_id) = lease_state();
        let claimed = claim_lease(
            &mut state,
            session_id,
            pane_id,
            owner_connection_id,
            &device_id,
            100,
            30,
            1,
            None,
            1_000,
        );
        let lease = result_lease(&claimed.result).clone();

        let released = state
            .release_remote_pane_lease(release_request(&lease))
            .expect("release lease");

        assert_restored(&released, 80, 24);
        assert_eq!(pane_geometry(&state, session_id, pane_id), (80, 24));
    }

    #[test]
    fn claim_immediately_after_expiry_preserves_restoration_and_lost_event_order() {
        let (mut state, session_id, pane_id, owner_connection_id, device_id) = lease_state();
        let first = claim_lease(
            &mut state,
            session_id,
            pane_id,
            owner_connection_id,
            &device_id,
            100,
            30,
            1,
            None,
            1_000,
        );
        let first_lease = result_lease(&first.result).clone();
        let next_owner_connection_id = Uuid::new_v4();

        let claimed = claim_lease(
            &mut state,
            session_id,
            pane_id,
            next_owner_connection_id,
            "device-2",
            120,
            40,
            2,
            None,
            first_lease.expires_at,
        );

        let next_lease = result_lease(&claimed.result);
        assert_eq!(next_lease.owner_connection_id, next_owner_connection_id);
        assert_eq!(
            (next_lease.original_cols, next_lease.original_rows),
            (80, 24)
        );
        assert_eq!(claimed.effects.len(), 2);

        let expired = claimed.effects[0]
            .event
            .as_ref()
            .expect("expired lease lost event");
        assert_eq!(expired.kind, RemotePaneLeaseEventKind::Lost);
        assert_eq!(expired.reason, RemotePaneLeaseEventReason::Expired);
        assert_eq!(expired.lease_id, first_lease.lease_id);
        assert_eq!(expired.owner_connection_id, first_lease.owner_connection_id);
        let restoration = expired
            .restoration
            .as_ref()
            .expect("expired lease restoration outcome");
        assert_eq!(
            restoration.status,
            RemotePaneLeaseRestorationStatus::Restored
        );
        assert_eq!((restoration.cols, restoration.rows), (80, 24));

        let current = claimed.effects[1]
            .event
            .as_ref()
            .expect("new lease claimed event");
        assert_eq!(current.kind, RemotePaneLeaseEventKind::Claimed);
        assert_eq!(current.reason, RemotePaneLeaseEventReason::Claimed);
        assert_eq!(current.owner_connection_id, next_owner_connection_id);
        assert_eq!((current.target_cols, current.target_rows), (120, 40));
        assert_eq!(pane_geometry(&state, session_id, pane_id), (120, 40));
    }

    #[test]
    fn claim_after_expired_stale_generation_does_not_restore_replacement_pane() {
        let (mut state, session_id, pane_id, owner_connection_id, device_id) = lease_state();
        let first = claim_lease(
            &mut state,
            session_id,
            pane_id,
            owner_connection_id,
            &device_id,
            100,
            30,
            1,
            None,
            1_000,
        );
        let first_lease = result_lease(&first.result).clone();
        let removed = state
            .remove_pane(session_id, pane_id)
            .expect("remove leased pane");
        drop(removed);
        let mut replacement_config = test_config(pane_id);
        replacement_config.cols = 90;
        replacement_config.rows = 25;
        state
            .insert_pane(session_id, Pane::for_test(replacement_config, true))
            .expect("insert replacement");
        let replacement_generation = state
            .pane_in_session(session_id, pane_id)
            .expect("replacement pane")
            .output_cursor()
            .0;
        assert!(replacement_generation > first_lease.pane_generation);

        let claimed = claim_lease(
            &mut state,
            session_id,
            pane_id,
            Uuid::new_v4(),
            "device-2",
            120,
            40,
            2,
            None,
            first_lease.expires_at,
        );

        assert_eq!(claimed.effects.len(), 2);
        let expired = claimed.effects[0]
            .event
            .as_ref()
            .expect("expired lease lost event");
        assert_eq!(expired.kind, RemotePaneLeaseEventKind::Lost);
        assert_eq!(expired.reason, RemotePaneLeaseEventReason::Expired);
        let restoration = expired
            .restoration
            .as_ref()
            .expect("expired restoration outcome");
        assert_eq!(
            restoration.status,
            RemotePaneLeaseRestorationStatus::GenerationMismatch
        );
        let next_lease = result_lease(&claimed.result);
        assert_eq!(
            (next_lease.original_cols, next_lease.original_rows),
            (90, 25)
        );
        assert_eq!((next_lease.target_cols, next_lease.target_rows), (120, 40));
        let current = claimed.effects[1]
            .event
            .as_ref()
            .expect("new lease claimed event");
        assert_eq!(current.kind, RemotePaneLeaseEventKind::Claimed);
        assert_eq!(current.reason, RemotePaneLeaseEventReason::Claimed);
        assert_eq!((current.target_cols, current.target_rows), (120, 40));
        assert_eq!(pane_geometry(&state, session_id, pane_id), (120, 40));
    }

    #[test]
    fn reclaim_expiry_and_disconnect_restore_original_geometry() {
        let (mut reclaimed_state, session_id, pane_id, owner_connection_id, device_id) =
            lease_state();
        claim_lease(
            &mut reclaimed_state,
            session_id,
            pane_id,
            owner_connection_id,
            &device_id,
            100,
            30,
            1,
            None,
            1_000,
        );
        let reclaimed = reclaimed_state
            .admin_reclaim_remote_pane_lease(RemotePaneLeaseAdminReclaimRequest {
                session_id,
                pane_id,
            })
            .expect("admin reclaim");
        assert_restored(&reclaimed, 80, 24);

        let (mut expired_state, session_id, pane_id, owner_connection_id, device_id) =
            lease_state();
        claim_lease(
            &mut expired_state,
            session_id,
            pane_id,
            owner_connection_id,
            &device_id,
            100,
            30,
            1,
            None,
            1_000,
        );
        let expired = expired_state.expire_remote_pane_leases(16_000);
        assert_eq!(expired.len(), 1);
        assert_restored(&expired[0], 80, 24);

        let (mut disconnected_state, session_id, pane_id, owner_connection_id, device_id) =
            lease_state();
        claim_lease(
            &mut disconnected_state,
            session_id,
            pane_id,
            owner_connection_id,
            &device_id,
            100,
            30,
            1,
            None,
            1_000,
        );
        let disconnected =
            disconnected_state.cleanup_remote_connection_leases(RemoteConnectionCleanupRequest {
                owner_connection_id,
            });
        assert_eq!(disconnected.len(), 1);
        assert_restored(&disconnected[0], 80, 24);
    }

    #[test]
    fn pane_exit_loses_lease_without_resizing_exiting_pane() {
        let (mut state, session_id, pane_id, owner_connection_id, device_id) = lease_state();
        claim_lease(
            &mut state,
            session_id,
            pane_id,
            owner_connection_id,
            &device_id,
            100,
            30,
            1,
            None,
            1_000,
        );

        let effect = state.mark_exited(pane_id);
        let transition = effect.lease.expect("pane exit lease effect");

        assert_eq!(transition.effects.len(), 1);
        assert!(transition.effects[0].resize.is_none());
        assert!(matches!(
            transition.effects[0].event.as_ref(),
            Some(RemotePaneLeaseEvent {
                kind: RemotePaneLeaseEventKind::Lost,
                reason: RemotePaneLeaseEventReason::PaneExited,
                ..
            })
        ));
        assert!(state.pane_metas(session_id).expect("pane metas").is_empty());
    }

    #[test]
    fn stale_generation_never_resizes_replacement_pane() {
        let (mut state, session_id, pane_id, owner_connection_id, device_id) = lease_state();
        let claimed = claim_lease(
            &mut state,
            session_id,
            pane_id,
            owner_connection_id,
            &device_id,
            100,
            30,
            1,
            None,
            1_000,
        );
        let lease = result_lease(&claimed.result).clone();
        let removed = state
            .remove_pane(session_id, pane_id)
            .expect("remove leased pane");
        drop(removed);
        let mut replacement_config = test_config(pane_id);
        replacement_config.cols = 90;
        replacement_config.rows = 25;
        state
            .insert_pane(session_id, Pane::for_test(replacement_config, true))
            .expect("insert replacement");
        let replacement_generation = state
            .pane_in_session(session_id, pane_id)
            .expect("replacement pane")
            .output_cursor()
            .0;
        assert!(replacement_generation > lease.pane_generation);

        let released = state
            .release_remote_pane_lease(release_request(&lease))
            .expect("release stale lease");

        assert!(released.effects[0].resize.is_none());
        let restoration = match released.result {
            RemotePaneLeaseResult::Released { release } => release.restoration,
            other => panic!("unexpected release result: {other:?}"),
        };
        assert_eq!(
            restoration.status,
            RemotePaneLeaseRestorationStatus::GenerationMismatch
        );
        assert_eq!(pane_geometry(&state, session_id, pane_id), (90, 25));
    }

    #[test]
    fn remote_geometry_is_bounded() {
        let (mut state, session_id, pane_id, owner_connection_id, device_id) = lease_state();
        let request = RemotePaneLeaseClaimRequest {
            owner_connection_id,
            device_id,
            session_id,
            pane_id,
            cols: 19,
            rows: 24,
            viewport_revision: 1,
            lease_id: None,
            revision: None,
        };
        assert!(state
            .claim_or_update_remote_pane_lease(request, 1_000)
            .is_err());
    }

    fn lease_state() -> (DaemonState, Uuid, Uuid, Uuid, String) {
        let mut state = DaemonState::new();
        let session_id = state.create_session("Workspace".to_string(), None).id;
        let pane_id = Uuid::new_v4();
        state
            .insert_pane(session_id, Pane::for_test(test_config(pane_id), true))
            .expect("insert pane");
        (
            state,
            session_id,
            pane_id,
            Uuid::new_v4(),
            "device-1".to_string(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn claim_lease(
        state: &mut DaemonState,
        session_id: Uuid,
        pane_id: Uuid,
        owner_connection_id: Uuid,
        device_id: &str,
        cols: u16,
        rows: u16,
        viewport_revision: u64,
        current: Option<(&Uuid, u64)>,
        now_ms: u64,
    ) -> PaneLeaseTransition {
        state
            .claim_or_update_remote_pane_lease(
                RemotePaneLeaseClaimRequest {
                    owner_connection_id,
                    device_id: device_id.to_string(),
                    session_id,
                    pane_id,
                    cols,
                    rows,
                    viewport_revision,
                    lease_id: current.map(|(lease_id, _)| *lease_id),
                    revision: current.map(|(_, revision)| revision),
                },
                now_ms,
            )
            .expect("claim lease")
    }

    fn result_lease(result: &RemotePaneLeaseResult) -> &RemotePaneLease {
        match result {
            RemotePaneLeaseResult::Claimed { lease }
            | RemotePaneLeaseResult::Updated { lease }
            | RemotePaneLeaseResult::Renewed { lease } => lease,
            other => panic!("unexpected lease result: {other:?}"),
        }
    }

    fn release_request(lease: &RemotePaneLease) -> RemotePaneLeaseReleaseRequest {
        RemotePaneLeaseReleaseRequest {
            owner_connection_id: lease.owner_connection_id,
            device_id: lease.device_id.clone(),
            session_id: lease.session_id,
            pane_id: lease.pane_id,
            lease_id: lease.lease_id,
            revision: lease.revision,
        }
    }

    fn remote_origin(lease: &RemotePaneLease) -> PaneCommandOrigin {
        PaneCommandOrigin::Remote {
            owner_connection_id: lease.owner_connection_id,
            device_id: lease.device_id.clone(),
            lease_id: Some(lease.lease_id),
            revision: Some(lease.revision),
        }
    }

    fn assert_restored(transition: &PaneLeaseTransition, cols: u16, rows: u16) {
        let restoration = match &transition.result {
            RemotePaneLeaseResult::Released { release }
            | RemotePaneLeaseResult::Reclaimed { release } => &release.restoration,
            RemotePaneLeaseResult::Cleanup { releases } => &releases[0].restoration,
            other => panic!("unexpected restoration result: {other:?}"),
        };
        assert_eq!(
            restoration.status,
            RemotePaneLeaseRestorationStatus::Restored
        );
        assert_eq!((restoration.cols, restoration.rows), (cols, rows));
    }

    fn pane_geometry(state: &DaemonState, session_id: Uuid, pane_id: Uuid) -> (u16, u16) {
        let pane = state
            .pane_metas(session_id)
            .expect("pane metas")
            .into_iter()
            .find(|pane| pane.id == pane_id)
            .expect("pane");
        (pane.config.cols, pane.config.rows)
    }

    #[test]
    fn desktop_selection_validates_membership_and_clears_previous_selection() {
        let mut state = DaemonState::new();
        let first = state.create_session("First".to_string(), None);
        let second = state.create_session("Second".to_string(), None);
        let first_pane = Uuid::new_v4();
        let second_pane = Uuid::new_v4();
        state
            .insert_pane(first.id, Pane::for_test(test_config(first_pane), true))
            .unwrap();
        state
            .insert_pane(second.id, Pane::for_test(test_config(second_pane), true))
            .unwrap();

        assert_eq!(
            state
                .set_desktop_selection(DesktopSelection {
                    workspace_id: Some(first.id),
                    pane_id: Some(first_pane),
                })
                .unwrap(),
            vec![first.id]
        );
        assert!(state
            .set_desktop_selection(DesktopSelection {
                workspace_id: Some(first.id),
                pane_id: Some(second_pane),
            })
            .is_err());
        assert_eq!(
            state.desktop_selection(),
            DesktopSelection {
                workspace_id: Some(first.id),
                pane_id: Some(first_pane),
            }
        );
        assert_eq!(
            state
                .set_desktop_selection(DesktopSelection {
                    workspace_id: None,
                    pane_id: None,
                })
                .unwrap(),
            vec![first.id]
        );
        assert_eq!(
            state.desktop_selection(),
            DesktopSelection {
                workspace_id: None,
                pane_id: None,
            }
        );
    }

    #[test]
    fn remote_projection_uses_pty_generation_and_real_last_output_timestamp() {
        let mut state = DaemonState::new();
        let workspace = state.create_session("Workspace".to_string(), None);
        let pane_id = Uuid::new_v4();
        let mut config = test_config(pane_id);
        config.cols = 132;
        config.rows = 41;
        config.title = Some("Build".to_string());
        config.role = Some("implementation".to_string());
        state
            .insert_pane(workspace.id, Pane::for_test(config, true))
            .unwrap();
        state.record_output_and_push(pane_id, b"output");

        let projection = state
            .remote_workspace_projection(Some(workspace.id), &HashMap::new())
            .unwrap();
        let pane = &projection.panes[0];
        assert_eq!(pane.pane_generation, 1);
        assert!(pane.last_output_at > 0);
        assert_eq!((pane.cols, pane.rows), (132, 41));
        assert!(pane.alive);
        assert_eq!(pane.title, "Build");
        assert_eq!(pane.role, "implementation");
    }

    fn test_config(pane_id: Uuid) -> crate::protocol::PaneConfig {
        #[cfg(windows)]
        let (shell, args) = (
            "cmd.exe".to_string(),
            vec![
                "/D".to_string(),
                "/Q".to_string(),
                "/C".to_string(),
                "exit 0".to_string(),
            ],
        );
        #[cfg(not(windows))]
        let (shell, args) = (
            "/bin/sh".to_string(),
            vec!["-lc".to_string(), "exit 0".to_string()],
        );

        crate::protocol::PaneConfig {
            pane_id,
            shell: Some(shell),
            args,
            cwd: None,
            env: Vec::new(),
            title: Some("test".to_string()),
            icon: None,
            profile_id: None,
            role: None,
            restore_on_start: false,
            cols: 80,
            rows: 24,
        }
    }
}
