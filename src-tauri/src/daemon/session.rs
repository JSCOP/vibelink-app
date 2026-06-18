use crate::daemon::persistence::PersistedSession;
use crate::daemon::pty::Pane;
use crate::protocol::{DaemonToClient, PaneMeta, SessionMeta};
use crossbeam_channel::Sender;
use indexmap::IndexMap;
use std::{
    collections::{HashMap, HashSet},
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
}

impl DaemonState {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            clients: HashMap::new(),
            pane_clients: HashMap::new(),
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

    pub fn rename_session(&mut self, session_id: Uuid, name: String) -> anyhow::Result<()> {
        let session = self.session_mut(session_id)?;
        session.meta.name = name;
        Ok(())
    }

    pub fn delete_session(&mut self, session_id: Uuid) -> anyhow::Result<Vec<Uuid>> {
        let mut session = self
            .sessions
            .remove(&session_id)
            .ok_or_else(|| anyhow::anyhow!("unknown session {session_id}"))?;
        let pane_ids: Vec<_> = session.panes.keys().copied().collect();
        for pane in session.panes.values_mut() {
            let _ = pane.kill();
        }
        for pane_id in &pane_ids {
            self.pane_clients.remove(pane_id);
        }
        Ok(pane_ids)
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
            return;
        };
        for pane_id in session.panes.keys() {
            if let Some(clients) = self.pane_clients.get_mut(pane_id) {
                clients.remove(&client_id);
            }
        }
    }

    pub fn save_layout(&mut self, session_id: Uuid, layout_json: String) -> anyhow::Result<()> {
        self.session_mut(session_id)?.layout_json = Some(layout_json);
        Ok(())
    }

    pub fn insert_pane(&mut self, session_id: Uuid, pane: Pane) -> anyhow::Result<PaneMeta> {
        let session = self.session_mut(session_id)?;
        let meta = pane.meta();
        session.panes.insert(meta.id, pane);
        session.meta.pane_count = session.panes.len();
        Ok(meta)
    }

    pub fn close_pane(&mut self, pane_id: Uuid) -> anyhow::Result<Option<Pane>> {
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

    pub fn write_pane(&self, pane_id: Uuid, data: &[u8]) -> anyhow::Result<()> {
        let pane = self.pane(pane_id)?;
        pane.write(data)
    }

    pub fn resize_pane(&self, pane_id: Uuid, cols: u16, rows: u16) -> anyhow::Result<()> {
        let pane = self.pane(pane_id)?;
        pane.resize(cols, rows)
    }

    pub fn set_pane_title(&mut self, pane_id: Uuid, title: String) -> anyhow::Result<()> {
        let pane = self.pane_mut(pane_id)?;
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

    pub fn clear_session_scrollback(&mut self, session_id: Uuid) -> anyhow::Result<()> {
        let session = self.session_mut(session_id)?;
        for pane in session.panes.values_mut() {
            let _ = pane.write(b"\x1b[2J\x1b[3J\x1b[H");
            pane.clear_scrollback();
        }
        Ok(())
    }

    pub fn attach_pane(&mut self, client_id: Uuid, pane_id: Uuid) -> anyhow::Result<()> {
        let (snapshot, alive) = {
            let pane = self.pane(pane_id)?;
            (pane.scrollback_snapshot(), pane.alive)
        };
        if let Some(tx) = self.clients.get(&client_id) {
            if !snapshot.is_empty() {
                let _ = tx.send(DaemonToClient::Output {
                    pane_id,
                    data: snapshot,
                });
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

    #[cfg(test)]
    pub fn attached_clients(&self, pane_id: Uuid) -> Vec<Uuid> {
        self.pane_clients
            .get(&pane_id)
            .map(|clients| clients.iter().copied().collect())
            .unwrap_or_default()
    }

    pub fn record_output(&mut self, pane_id: Uuid, data: &[u8]) -> Vec<Sender<DaemonToClient>> {
        if let Ok(pane) = self.pane_mut(pane_id) {
            pane.push_scrollback(data);
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

    fn senders_for_pane(&self, pane_id: Uuid) -> Vec<Sender<DaemonToClient>> {
        self.pane_clients
            .get(&pane_id)
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

    fn pane(&self, pane_id: Uuid) -> anyhow::Result<&Pane> {
        self.find_pane(pane_id)
            .and_then(|(session_id, pane_id)| self.sessions.get(&session_id)?.panes.get(&pane_id))
            .ok_or_else(|| anyhow::anyhow!("unknown pane {pane_id}"))
    }

    fn pane_mut(&mut self, pane_id: Uuid) -> anyhow::Result<&mut Pane> {
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

        let closed = state.close_pane(pane_id).expect("close pane");

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
    fn clear_session_scrollback_clears_only_target_workspace() {
        let mut state = DaemonState::new();
        let workspace_a = state.create_session("Workspace A".to_string(), None);
        let workspace_b = state.create_session("Workspace B".to_string(), None);
        let pane_a_id = Uuid::new_v4();
        let pane_b_id = Uuid::new_v4();
        let mut pane_a = Pane::for_test(test_config(pane_a_id), true);
        let mut pane_b = Pane::for_test(test_config(pane_b_id), true);
        pane_a.push_scrollback(b"workspace a");
        pane_b.push_scrollback(b"workspace b");
        state
            .insert_pane(workspace_a.id, pane_a)
            .expect("insert pane a");
        state
            .insert_pane(workspace_b.id, pane_b)
            .expect("insert pane b");

        state
            .clear_session_scrollback(workspace_a.id)
            .expect("clear workspace a");

        assert!(state
            .get_scrollback(workspace_a.id, pane_a_id)
            .expect("workspace a scrollback")
            .is_empty());
        assert_eq!(
            state
                .get_scrollback(workspace_b.id, pane_b_id)
                .expect("workspace b scrollback"),
            b"workspace b"
        );
    }

    #[test]
    fn set_pane_title_updates_live_pane_metadata() {
        let mut state = DaemonState::new();
        let meta = state.create_session("Workspace".to_string(), None);
        let pane_id = Uuid::new_v4();
        let pane = Pane::for_test(test_config(pane_id), true);
        state.insert_pane(meta.id, pane).expect("insert pane");

        state
            .set_pane_title(pane_id, "Codex: refactor terminal".to_string())
            .expect("set title");

        let panes = state.pane_metas(meta.id).expect("pane metas");
        assert_eq!(
            panes[0].config.title.as_deref(),
            Some("Codex: refactor terminal")
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
            .close_pane(pane_id)
            .expect("close exited pane")
            .is_none());
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
            cols: 80,
            rows: 24,
        }
    }
}
