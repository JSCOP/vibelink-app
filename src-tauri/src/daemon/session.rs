use crate::daemon::persistence::PersistedSession;
use crate::daemon::pty::Pane;
use crate::daemon::scrollback::ScrollbackRing;
use crate::protocol::{DaemonToClient, PaneMeta, SessionMeta};
use crossbeam_channel::Sender;
use indexmap::IndexMap;
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub struct Session {
    pub meta: SessionMeta,
    pub layout_json: Option<String>,
    pub panes: IndexMap<Uuid, Pane>,
}

pub struct DaemonState {
    sessions: HashMap<Uuid, Session>,
    clients: HashMap<Uuid, Sender<DaemonToClient>>,
    pane_clients: HashMap<Uuid, HashSet<Uuid>>,
    session_clients: HashMap<Uuid, HashSet<Uuid>>,
}

fn lock_scrollback(scrollback: &Mutex<ScrollbackRing>) -> MutexGuard<'_, ScrollbackRing> {
    scrollback
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl DaemonState {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            clients: HashMap::new(),
            pane_clients: HashMap::new(),
            session_clients: HashMap::new(),
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
            },
        );
        meta
    }

    pub fn insert_session(&mut self, meta: SessionMeta, layout_json: Option<String>) {
        self.sessions.insert(
            meta.id,
            Session {
                meta,
                layout_json,
                panes: IndexMap::new(),
            },
        );
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
        Ok(session.panes.drain(..).map(|(_, pane)| pane).collect())
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
        pane: Pane,
    ) -> std::result::Result<PaneMeta, (anyhow::Error, Pane)> {
        let Some(session) = self.sessions.get_mut(&session_id) else {
            return Err((anyhow::anyhow!("unknown session {session_id}"), pane));
        };
        let meta = pane.meta();
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
        pane
    }

    pub fn pane_writer(
        &self,
        session_id: Uuid,
        pane_id: Uuid,
    ) -> anyhow::Result<Arc<Mutex<Box<dyn Write + Send>>>> {
        let pane = self.pane_in_session(session_id, pane_id)?;
        Ok(Arc::clone(&pane.writer))
    }

    pub fn resize_pane(
        &mut self,
        session_id: Uuid,
        pane_id: Uuid,
        cols: u16,
        rows: u16,
    ) -> anyhow::Result<()> {
        let pane = self.pane_in_session_mut(session_id, pane_id)?;
        pane.resize(cols, rows)
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

    pub fn get_scrollback(&self, session_id: Uuid, pane_id: Uuid) -> anyhow::Result<Vec<u8>> {
        let session = self.session(session_id)?;
        let pane = session.panes.get(&pane_id).ok_or_else(|| {
            anyhow::anyhow!("pane {pane_id} does not belong to session {session_id}")
        })?;
        Ok(pane.scrollback_snapshot())
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
            lock_scrollback(&pane.scrollback).push(bytes);
        }
        self.senders_for_pane(pane_id)
    }

    pub fn mark_exited(&mut self, pane_id: Uuid) -> Vec<Sender<DaemonToClient>> {
        let senders = self.senders_for_pane(pane_id);
        if let Some((session_id, _)) = self.find_pane(pane_id) {
            self.remove_pane(session_id, pane_id);
        } else {
            self.pane_clients.remove(&pane_id);
        }
        senders
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
                panes: Vec::new(),
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
    fn persisted_sessions_exclude_live_panes() {
        let mut state = DaemonState::new();
        let meta = state.create_session("Workspace".to_string(), None);
        let pane_id = Uuid::new_v4();
        let config = test_config(pane_id);
        let pane = Pane::for_test(config, true);
        state.insert_pane(meta.id, pane).expect("insert pane");

        let persisted = state.persisted_sessions();

        assert!(persisted[0].panes.is_empty());
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
                .pane_writer(workspace_id.0, workspace_id.1)
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
            cols: 80,
            rows: 24,
        }
    }
}
