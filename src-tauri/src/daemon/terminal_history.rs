use crate::{
    daemon::{pty::DEFAULT_SCROLLBACK_CAP, scrollback::ScrollbackRing},
    persistence::write_bytes_atomic,
};
use anyhow::{Context, Result};
use std::{
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
    let retained = u64::try_from(DEFAULT_SCROLLBACK_CAP).unwrap_or(u64::MAX);
    if file_len > retained {
        file.seek(SeekFrom::Start(file_len - retained))?;
    }
    let mut bytes = Vec::with_capacity(
        usize::try_from(file_len.min(retained)).unwrap_or(DEFAULT_SCROLLBACK_CAP),
    );
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
    fn history_load_is_bounded_to_scrollback_capacity() {
        let root = std::env::temp_dir().join(format!("vibelink-history-cap-{}", Uuid::new_v4()));
        let sessions_path = root.join("sessions.json");
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let bytes = vec![b'x'; DEFAULT_SCROLLBACK_CAP + 128];
        let path = pane_history_path(&sessions_path, session_id, pane_id).expect("history path");
        write_bytes_atomic(&path, &bytes).expect("seed oversized history");

        let loaded =
            load_pane_history(&sessions_path, session_id, pane_id).expect("load bounded history");
        assert_eq!(loaded.len(), DEFAULT_SCROLLBACK_CAP);
        assert!(loaded.iter().all(|byte| *byte == b'x'));
        let _ = fs::remove_dir_all(root);
    }
}
