use anyhow::{Context, Result};
use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub fn load_json_or_default<T>(path: &Path, label: &str) -> Result<T>
where
    T: DeserializeOwned + Default,
{
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(T::default()),
        Err(error) => {
            return Err(error).with_context(|| format!("read {label} {}", path.display()))
        }
    };
    match serde_json::from_slice(&bytes) {
        Ok(value) => Ok(value),
        Err(error) => {
            let quarantined = quarantine_file(path, "corrupt")?;
            tracing::warn!(
                ?error,
                path = %path.display(),
                quarantine = %quarantined.display(),
                "quarantined invalid persisted JSON"
            );
            Ok(T::default())
        }
    }
}

pub fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value).context("serialize persisted JSON")?;
    write_bytes_atomic(path, &bytes)
}

pub fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create persistence directory {}", parent.display()))?;
    }
    let temporary = temporary_path(path);
    {
        let mut file = fs::File::create(&temporary)
            .with_context(|| format!("create persistence temp file {}", temporary.display()))?;
        file.write_all(bytes)
            .with_context(|| format!("write persistence temp file {}", temporary.display()))?;
        file.flush()
            .with_context(|| format!("flush persistence temp file {}", temporary.display()))?;
        file.sync_all()
            .with_context(|| format!("fsync persistence temp file {}", temporary.display()))?;
    }
    fs::rename(&temporary, path)
        .with_context(|| format!("replace persisted file {}", path.display()))?;
    Ok(())
}

pub fn quarantine_file(path: &Path, reason: &str) -> Result<PathBuf> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("persisted-state");
    let quarantine = path.with_file_name(format!("{file_name}.{reason}-{timestamp}"));
    fs::rename(path, &quarantine).with_context(|| {
        format!(
            "quarantine persisted file {} as {}",
            path.display(),
            quarantine.display()
        )
    })?;
    Ok(quarantine)
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(".tmp");
    PathBuf::from(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use uuid::Uuid;

    #[derive(Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
    struct Fixture {
        value: String,
    }

    #[test]
    fn invalid_json_is_quarantined_and_defaults() {
        let directory =
            std::env::temp_dir().join(format!("vibelink-persistence-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("create temp directory");
        let path = directory.join("state.json");
        fs::write(&path, b"{broken").expect("seed invalid JSON");

        let loaded: Fixture = load_json_or_default(&path, "fixture").expect("recover fixture");

        assert_eq!(loaded, Fixture::default());
        assert!(!path.exists());
        assert_eq!(fs::read_dir(&directory).expect("list directory").count(), 1);
        fs::remove_dir_all(directory).expect("cleanup temp directory");
    }

    #[test]
    fn atomic_write_round_trips() {
        let directory =
            std::env::temp_dir().join(format!("vibelink-persistence-{}", Uuid::new_v4()));
        let path = directory.join("state.json");
        let fixture = Fixture { value: "ok".into() };

        write_json_atomic(&path, &fixture).expect("write fixture");
        let loaded: Fixture = load_json_or_default(&path, "fixture").expect("load fixture");

        assert_eq!(loaded, fixture);
        assert!(!temporary_path(&path).exists());
        fs::remove_dir_all(directory).expect("cleanup temp directory");
    }
}
