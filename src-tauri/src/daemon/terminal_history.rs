use crate::{
    daemon::{pty::DEFAULT_SCROLLBACK_CAP, scrollback::ScrollbackRing},
    persistence::write_bytes_atomic,
};
use anyhow::{Context, Result};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const HISTORY_DIR: &str = "terminal-history";
const MAX_HISTORY_FILE_BYTES: usize = DEFAULT_SCROLLBACK_CAP * 2;

pub struct TerminalHistoryWriter {
    path: PathBuf,
    file: Option<File>,
    file_len: usize,
}

impl TerminalHistoryWriter {
    pub fn open(
        sessions_path: &Path,
        session_id: Uuid,
        pane_id: Uuid,
        initial_snapshot: &[u8],
    ) -> Result<Self> {
        let path = pane_history_path(sessions_path, session_id, pane_id)?;
        write_bytes_atomic(&path, initial_snapshot)?;
        let file = open_append(&path)?;
        Ok(Self {
            path,
            file: Some(file),
            file_len: initial_snapshot.len(),
        })
    }

    pub fn should_compact(&self, incoming_len: usize) -> bool {
        self.file_len.saturating_add(incoming_len) > MAX_HISTORY_FILE_BYTES
    }

    pub fn record(&mut self, bytes: &[u8], snapshot: Option<&[u8]>) -> Result<()> {
        if let Some(snapshot) = snapshot {
            self.rewrite(snapshot)?;
            return Ok(());
        }
        let file = self
            .file
            .as_mut()
            .context("terminal history append handle is closed")?;
        file.write_all(bytes)
            .with_context(|| format!("append terminal history {}", self.path.display()))?;
        self.file_len = self.file_len.saturating_add(bytes.len());
        Ok(())
    }

    pub fn remove(mut self) -> Result<()> {
        self.file.take();
        remove_file_if_exists(&self.path)?;
        if let Some(parent) = self.path.parent() {
            let _ = fs::remove_dir(parent);
        }
        Ok(())
    }

    fn rewrite(&mut self, snapshot: &[u8]) -> Result<()> {
        self.file.take();
        write_bytes_atomic(&self.path, snapshot)?;
        self.file = Some(open_append(&self.path)?);
        self.file_len = snapshot.len();
        Ok(())
    }
}

fn restore_read_window(file_len: u64) -> u64 {
    file_len.min(u64::try_from(DEFAULT_SCROLLBACK_CAP).unwrap_or(u64::MAX))
}

pub fn load_pane_history(sessions_path: &Path, session_id: Uuid, pane_id: Uuid) -> Result<Vec<u8>> {
    let path = pane_history_path(sessions_path, session_id, pane_id)?;
    let mut file = match File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(error).with_context(|| format!("open terminal history {}", path.display()))
        }
    };
    let file_len = file.metadata()?.len();
    let retained = restore_read_window(file_len);
    if file_len > retained {
        file.seek(SeekFrom::Start(file_len - retained))?;
    }
    let mut bytes = Vec::with_capacity(usize::try_from(retained).unwrap_or(DEFAULT_SCROLLBACK_CAP));
    file.read_to_end(&mut bytes)?;
    let mut ring = ScrollbackRing::new(DEFAULT_SCROLLBACK_CAP);
    ring.push(&bytes);
    Ok(ring.snapshot())
}

pub fn remove_pane_history(sessions_path: &Path, session_id: Uuid, pane_id: Uuid) -> Result<()> {
    let path = pane_history_path(sessions_path, session_id, pane_id)?;
    remove_file_if_exists(&path)?;
    if let Some(parent) = path.parent() {
        let _ = fs::remove_dir(parent);
    }
    Ok(())
}

pub fn remove_session_history(sessions_path: &Path, session_id: Uuid) -> Result<()> {
    let dir = history_root(sessions_path)?.join(session_id.to_string());
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            Err(error).with_context(|| format!("remove terminal history {}", dir.display()))
        }
    }
}

/// Scrollback that no persisted workspace or pane claims any more.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PrunedHistory {
    pub sessions: usize,
    pub panes: usize,
}

impl PrunedHistory {
    pub fn is_empty(self) -> bool {
        self.sessions == 0 && self.panes == 0
    }
}

/// Drops history files whose workspace or pane no longer exists in the
/// persisted session set.
///
/// Pane history is only removed on an explicit close or a clean exit, so a
/// crash, a force kill, or a lost `sessions.json` entry used to leave its
/// scrollback on disk forever. `live` must be built from the persisted
/// sessions (workspace id -> pane ids), never from live panes: a workspace that
/// simply is not restored still owns its history.
pub fn prune_orphan_history(
    sessions_path: &Path,
    live: &HashMap<Uuid, HashSet<Uuid>>,
) -> Result<PrunedHistory> {
    let root = history_root(sessions_path)?;
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(PrunedHistory::default())
        }
        Err(error) => {
            return Err(error).with_context(|| format!("read terminal history {}", root.display()))
        }
    };

    let mut pruned = PrunedHistory::default();
    for entry in entries {
        let entry = entry.with_context(|| format!("read terminal history {}", root.display()))?;
        let path = entry.path();
        let session_id = entry
            .file_name()
            .to_str()
            .and_then(|name| Uuid::parse_str(name).ok());
        let panes = match session_id.and_then(|id| live.get(&id)) {
            Some(panes) => panes,
            None => {
                // Unknown workspace id, or a stray file where a directory belongs.
                if path.is_dir() {
                    fs::remove_dir_all(&path)
                        .with_context(|| format!("remove terminal history {}", path.display()))?;
                } else {
                    remove_file_if_exists(&path)?;
                }
                pruned.sessions += 1;
                continue;
            }
        };
        pruned.panes += prune_session_panes(&path, panes)?;
    }
    Ok(pruned)
}

fn prune_session_panes(session_dir: &Path, panes: &HashSet<Uuid>) -> Result<usize> {
    let entries = match fs::read_dir(session_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("read terminal history {}", session_dir.display()))
        }
    };

    let mut removed = 0;
    for entry in entries {
        let entry =
            entry.with_context(|| format!("read terminal history {}", session_dir.display()))?;
        let path = entry.path();
        let claimed = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .and_then(|stem| Uuid::parse_str(stem).ok())
            .is_some_and(|pane_id| panes.contains(&pane_id));
        if claimed {
            continue;
        }
        remove_file_if_exists(&path)?;
        removed += 1;
    }
    let _ = fs::remove_dir(session_dir);
    Ok(removed)
}

fn open_append(path: &Path) -> Result<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("open terminal history {}", path.display()))
}

fn pane_history_path(sessions_path: &Path, session_id: Uuid, pane_id: Uuid) -> Result<PathBuf> {
    Ok(history_root(sessions_path)?
        .join(session_id.to_string())
        .join(format!("{pane_id}.bin")))
}

fn history_root(sessions_path: &Path) -> Result<PathBuf> {
    Ok(sessions_path
        .parent()
        .context("sessions path has no data directory")?
        .join(HISTORY_DIR))
}

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            Err(error).with_context(|| format!("remove terminal history {}", path.display()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_caps_match_daemon_contract() {
        assert_eq!(DEFAULT_SCROLLBACK_CAP, 8 * 1024 * 1024);
        assert_eq!(MAX_HISTORY_FILE_BYTES, 16 * 1024 * 1024);
    }

    #[test]
    fn restore_read_window_matches_scrollback_ring_cap() {
        let oversized = u64::try_from(DEFAULT_SCROLLBACK_CAP + 128).expect("scrollback cap fits");

        assert_eq!(
            restore_read_window(oversized),
            u64::try_from(DEFAULT_SCROLLBACK_CAP).expect("scrollback cap fits")
        );
    }

    #[test]
    fn history_appends_compacts_and_removes() {
        let root = std::env::temp_dir().join(format!("vibelink-history-{}", Uuid::new_v4()));
        let sessions_path = root.join("sessions.json");
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let mut writer = TerminalHistoryWriter::open(&sessions_path, session_id, pane_id, b"old")
            .expect("open history");

        writer.record(b"-new", None).expect("append history");
        assert_eq!(
            load_pane_history(&sessions_path, session_id, pane_id).expect("load history"),
            b"old-new"
        );

        writer
            .record(b"ignored", Some(b"compacted"))
            .expect("compact history");
        assert_eq!(
            load_pane_history(&sessions_path, session_id, pane_id).expect("load compacted history"),
            b"compacted"
        );

        writer.remove().expect("remove history");
        assert!(load_pane_history(&sessions_path, session_id, pane_id)
            .expect("load missing history")
            .is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn history_restore_reads_exactly_one_scrollback_ring() {
        let root = std::env::temp_dir().join(format!("vibelink-history-cap-{}", Uuid::new_v4()));
        let sessions_path = root.join("sessions.json");
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let mut bytes = vec![b'o'; 128];
        bytes.resize(DEFAULT_SCROLLBACK_CAP + 128, b'n');
        let path = pane_history_path(&sessions_path, session_id, pane_id).expect("history path");
        write_bytes_atomic(&path, &bytes).expect("seed oversized history");

        let loaded =
            load_pane_history(&sessions_path, session_id, pane_id).expect("load bounded history");
        assert_eq!(loaded.len(), DEFAULT_SCROLLBACK_CAP);
        assert!(loaded.iter().all(|byte| *byte == b'n'));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn prune_drops_unknown_workspaces_and_panes_but_keeps_persisted_ones() {
        let root = std::env::temp_dir().join(format!("vibelink-history-prune-{}", Uuid::new_v4()));
        let sessions_path = root.join("sessions.json");
        let kept_session = Uuid::new_v4();
        let kept_pane = Uuid::new_v4();
        let dropped_pane = Uuid::new_v4();
        let dropped_session = Uuid::new_v4();
        for (session_id, pane_id) in [
            (kept_session, kept_pane),
            (kept_session, dropped_pane),
            (dropped_session, Uuid::new_v4()),
        ] {
            let path =
                pane_history_path(&sessions_path, session_id, pane_id).expect("history path");
            write_bytes_atomic(&path, b"scrollback").expect("seed history");
        }

        let live: HashMap<Uuid, HashSet<Uuid>> =
            [(kept_session, [kept_pane].into_iter().collect())]
                .into_iter()
                .collect();
        let pruned = prune_orphan_history(&sessions_path, &live).expect("prune history");

        assert_eq!(
            pruned,
            PrunedHistory {
                sessions: 1,
                panes: 1
            }
        );
        assert_eq!(
            load_pane_history(&sessions_path, kept_session, kept_pane).expect("load kept history"),
            b"scrollback"
        );
        assert!(
            load_pane_history(&sessions_path, kept_session, dropped_pane)
                .expect("load dropped pane history")
                .is_empty()
        );
        assert!(!history_root(&sessions_path)
            .expect("history root")
            .join(dropped_session.to_string())
            .exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn prune_is_a_no_op_without_a_history_directory() {
        let root = std::env::temp_dir().join(format!("vibelink-history-empty-{}", Uuid::new_v4()));
        let sessions_path = root.join("sessions.json");

        let pruned = prune_orphan_history(&sessions_path, &HashMap::new()).expect("prune history");

        assert!(pruned.is_empty());
    }

    #[test]
    fn prune_keeps_every_pane_of_a_workspace_that_is_not_restored() {
        let root = std::env::temp_dir().join(format!("vibelink-history-keep-{}", Uuid::new_v4()));
        let sessions_path = root.join("sessions.json");
        let session_id = Uuid::new_v4();
        let panes: Vec<Uuid> = (0..3).map(|_| Uuid::new_v4()).collect();
        for pane_id in &panes {
            let path =
                pane_history_path(&sessions_path, session_id, *pane_id).expect("history path");
            write_bytes_atomic(&path, b"kept").expect("seed history");
        }

        let live: HashMap<Uuid, HashSet<Uuid>> = [(session_id, panes.iter().copied().collect())]
            .into_iter()
            .collect();
        let pruned = prune_orphan_history(&sessions_path, &live).expect("prune history");

        assert!(pruned.is_empty());
        for pane_id in &panes {
            assert_eq!(
                load_pane_history(&sessions_path, session_id, *pane_id).expect("load history"),
                b"kept"
            );
        }
        let _ = fs::remove_dir_all(root);
    }
}
