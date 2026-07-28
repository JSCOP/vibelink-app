use anyhow::{anyhow, Context, Result};
use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};
use uuid::Uuid;

const STALE_TEMP_AGE: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoadSource {
    Primary,
    RestoredBackup,
    Default,
}

#[derive(Debug)]
pub struct LoadReport<T> {
    pub value: T,
    pub source: LoadSource,
    pub quarantined: Vec<PathBuf>,
}

#[derive(Debug)]
pub enum DocumentError {
    Invalid(anyhow::Error),
    UnsupportedSchema { found: u64, supported: u64 },
}

impl From<serde_json::Error> for DocumentError {
    fn from(error: serde_json::Error) -> Self {
        Self::Invalid(error.into())
    }
}

pub fn parse_json<T: DeserializeOwned>(bytes: &[u8]) -> std::result::Result<T, DocumentError> {
    serde_json::from_slice(bytes).map_err(Into::into)
}

pub fn require_supported_schema(
    found: u64,
    supported: u64,
) -> std::result::Result<(), DocumentError> {
    if found > supported {
        Err(DocumentError::UnsupportedSchema { found, supported })
    } else {
        Ok(())
    }
}

pub fn load_with_recovery<T, P>(path: &Path, default: T, parse: P) -> Result<LoadReport<T>>
where
    P: Fn(&[u8]) -> std::result::Result<T, DocumentError>,
{
    cleanup_stale_temp_at(path, SystemTime::now())?;
    let backup = backup_path(path);
    let mut quarantined = Vec::new();

    match read_and_parse(path, &parse)? {
        Parsed::Valid(value) => Ok(LoadReport {
            value,
            source: LoadSource::Primary,
            quarantined,
        }),
        Parsed::Unsupported { found, supported } => {
            let quarantine = quarantine(path)?;
            Err(anyhow!(
                "unsupported storage schema {found}; supported through {supported}; quarantined {}",
                quarantine.display()
            ))
        }
        Parsed::Invalid => match read_and_parse(&backup, &parse)? {
            Parsed::Valid(value) => {
                if path.exists() {
                    quarantined.push(quarantine(path)?);
                }
                restore_backup(path, &backup)?;
                Ok(LoadReport {
                    value,
                    source: LoadSource::RestoredBackup,
                    quarantined,
                })
            }
            Parsed::Unsupported { found, supported } => {
                if path.exists() {
                    quarantined.push(quarantine(path)?);
                }
                let backup_quarantine = quarantine(&backup)?;
                Err(anyhow!(
                    "unsupported storage backup schema {found}; supported through {supported}; quarantined {}",
                    backup_quarantine.display()
                ))
            }
            Parsed::Invalid => {
                if path.exists() {
                    quarantined.push(quarantine(path)?);
                }
                if backup.exists() {
                    quarantined.push(quarantine(&backup)?);
                }
                Ok(LoadReport {
                    value: default,
                    source: LoadSource::Default,
                    quarantined,
                })
            }
            Parsed::Missing => {
                if path.exists() {
                    quarantined.push(quarantine(path)?);
                }
                Ok(LoadReport {
                    value: default,
                    source: LoadSource::Default,
                    quarantined,
                })
            }
        },
        Parsed::Missing => match read_and_parse(&backup, &parse)? {
            Parsed::Valid(value) => {
                restore_backup(path, &backup)?;
                Ok(LoadReport {
                    value,
                    source: LoadSource::RestoredBackup,
                    quarantined,
                })
            }
            Parsed::Unsupported { found, supported } => {
                let backup_quarantine = quarantine(&backup)?;
                Err(anyhow!(
                    "unsupported storage backup schema {found}; supported through {supported}; quarantined {}",
                    backup_quarantine.display()
                ))
            }
            Parsed::Invalid => {
                quarantined.push(quarantine(&backup)?);
                Ok(LoadReport {
                    value: default,
                    source: LoadSource::Default,
                    quarantined,
                })
            }
            Parsed::Missing => Ok(LoadReport {
                value: default,
                source: LoadSource::Default,
                quarantined,
            }),
        },
    }
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value).context("serialize storage document")?;
    write_bytes(path, &bytes)
}

pub fn write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("storage path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .with_context(|| format!("create storage directory {}", parent.display()))?;
    cleanup_stale_temp_at(path, SystemTime::now())?;
    let temporary = temporary_path(path);
    if temporary.exists() {
        return Err(anyhow!(
            "storage temp file may have an active writer: {}",
            temporary.display()
        ));
    }
    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .with_context(|| format!("create storage temp file {}", temporary.display()))?;
        file.write_all(bytes)
            .with_context(|| format!("write storage temp file {}", temporary.display()))?;
        file.flush()
            .with_context(|| format!("flush storage temp file {}", temporary.display()))?;
        file.sync_all()
            .with_context(|| format!("sync storage temp file {}", temporary.display()))?;
    }
    if let Err(error) = replace_file(path, &temporary, Some(&backup_path(path))) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

fn restore_backup(path: &Path, backup: &Path) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("storage path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)?;
    cleanup_stale_temp_at(path, SystemTime::now())?;
    let temporary = temporary_path(path);
    if temporary.exists() {
        return Err(anyhow!(
            "storage temp file may have an active writer: {}",
            temporary.display()
        ));
    }
    {
        let mut source = fs::File::open(backup)
            .with_context(|| format!("open storage backup {}", backup.display()))?;
        let mut destination = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .with_context(|| format!("create restore temp file {}", temporary.display()))?;
        io::copy(&mut source, &mut destination)
            .with_context(|| format!("copy storage backup {}", backup.display()))?;
        destination.flush()?;
        destination.sync_all()?;
    }
    if let Err(error) = replace_file(path, &temporary, None) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

fn cleanup_stale_temp_at(path: &Path, now: SystemTime) -> Result<()> {
    let temporary = temporary_path(path);
    let metadata = match fs::metadata(&temporary) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).context("read storage temp metadata"),
    };
    let modified = metadata
        .modified()
        .context("read storage temp modified time")?;
    if now.duration_since(modified).unwrap_or_default() >= STALE_TEMP_AGE {
        fs::remove_file(&temporary)
            .with_context(|| format!("remove stale storage temp {}", temporary.display()))?;
    }
    Ok(())
}

fn quarantine(path: &Path) -> Result<PathBuf> {
    let file_name = path
        .file_name()
        .ok_or_else(|| anyhow!("storage path has no file name: {}", path.display()))?
        .to_string_lossy();
    let quarantine = path.with_file_name(format!(
        "{file_name}.corrupt-{}-{}",
        chrono::Utc::now().timestamp_millis(),
        Uuid::new_v4()
    ));
    fs::rename(path, &quarantine).with_context(|| {
        format!(
            "quarantine invalid storage file {} as {}",
            path.display(),
            quarantine.display()
        )
    })?;
    Ok(quarantine)
}

fn backup_path(path: &Path) -> PathBuf {
    append_suffix(path, ".bak")
}

fn temporary_path(path: &Path) -> PathBuf {
    append_suffix(path, ".tmp")
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

enum Parsed<T> {
    Valid(T),
    Invalid,
    Unsupported { found: u64, supported: u64 },
    Missing,
}

fn read_and_parse<T, P>(path: &Path, parse: &P) -> Result<Parsed<T>>
where
    P: Fn(&[u8]) -> std::result::Result<T, DocumentError>,
{
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Parsed::Missing),
        Err(error) => {
            return Err(error).with_context(|| format!("read storage file {}", path.display()));
        }
    };
    Ok(match parse(&bytes) {
        Ok(value) => Parsed::Valid(value),
        Err(DocumentError::Invalid(error)) => {
            tracing::warn!(path = %path.display(), ?error, "invalid storage document");
            Parsed::Invalid
        }
        Err(DocumentError::UnsupportedSchema { found, supported }) => {
            Parsed::Unsupported { found, supported }
        }
    })
}

#[cfg(windows)]
fn replace_file(path: &Path, temporary: &Path, backup: Option<&Path>) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        REPLACEFILE_WRITE_THROUGH,
    };

    let wide = |value: &Path| {
        value
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>()
    };
    let path_wide = wide(path);
    let temporary_wide = wide(temporary);
    let result = if path.exists() {
        let backup_wide = backup.map(wide);
        unsafe {
            ReplaceFileW(
                path_wide.as_ptr(),
                temporary_wide.as_ptr(),
                backup_wide
                    .as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
                REPLACEFILE_WRITE_THROUGH,
                std::ptr::null(),
                std::ptr::null(),
            )
        }
    } else {
        unsafe {
            MoveFileExW(
                temporary_wide.as_ptr(),
                path_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if result == 0 {
        Err(io::Error::last_os_error()).with_context(|| {
            format!(
                "atomically replace storage file {} with {}",
                path.display(),
                temporary.display()
            )
        })
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(path: &Path, temporary: &Path, backup: Option<&Path>) -> Result<()> {
    if path.exists() {
        if let Some(backup) = backup {
            fs::copy(path, backup)
                .with_context(|| format!("preserve storage backup {}", backup.display()))?;
        }
    }
    fs::rename(temporary, path).with_context(|| {
        format!(
            "atomically replace storage file {} with {}",
            path.display(),
            temporary.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TestDocument {
        #[serde(default = "schema_one")]
        schema_version: u64,
        value: String,
    }

    fn schema_one() -> u64 {
        1
    }

    fn parse_test(bytes: &[u8]) -> std::result::Result<TestDocument, DocumentError> {
        let document: TestDocument = parse_json(bytes)?;
        require_supported_schema(document.schema_version, 1)?;
        Ok(document)
    }

    fn temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("vibelink-storage-{label}-{}.json", Uuid::new_v4()))
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(backup_path(path));
        let _ = fs::remove_file(temporary_path(path));
        if let Some(parent) = path.parent() {
            if let Ok(entries) = fs::read_dir(parent) {
                let prefix = format!(
                    "{}{}.corrupt-",
                    path.file_name().unwrap().to_string_lossy(),
                    ""
                );
                for entry in entries.flatten() {
                    if entry.file_name().to_string_lossy().starts_with(&prefix) {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
        }
    }

    #[test]
    fn truncated_primary_restores_valid_backup() {
        let path = temp_path("restore");
        write_json(
            &path,
            &TestDocument {
                schema_version: 1,
                value: "first".into(),
            },
        )
        .unwrap();
        write_json(
            &path,
            &TestDocument {
                schema_version: 1,
                value: "second".into(),
            },
        )
        .unwrap();
        fs::write(&path, b"{").unwrap();

        let report = load_with_recovery(&path, TestDocument::default(), parse_test).unwrap();
        assert_eq!(report.source, LoadSource::RestoredBackup);
        assert_eq!(report.value.value, "first");
        assert_eq!(
            parse_test(&fs::read(&path).unwrap()).unwrap().value,
            "first"
        );
        assert_eq!(report.quarantined.len(), 1);
        cleanup(&path);
    }

    #[test]
    fn invalid_primary_and_backup_are_quarantined_before_default() {
        let path = temp_path("default");
        fs::write(&path, b"{").unwrap();
        fs::write(backup_path(&path), b"[").unwrap();

        let report = load_with_recovery(
            &path,
            TestDocument {
                schema_version: 1,
                value: "safe".into(),
            },
            parse_test,
        )
        .unwrap();
        assert_eq!(report.source, LoadSource::Default);
        assert_eq!(report.value.value, "safe");
        assert_eq!(report.quarantined.len(), 2);
        assert!(!path.exists());
        assert!(!backup_path(&path).exists());
        cleanup(&path);
    }

    #[test]
    fn unknown_newer_schema_is_quarantined_and_returns_error() {
        let path = temp_path("newer");
        fs::write(&path, br#"{"schemaVersion":2,"value":"future"}"#).unwrap();

        let error = load_with_recovery(&path, TestDocument::default(), parse_test).unwrap_err();
        assert!(error.to_string().contains("unsupported storage schema 2"));
        assert!(!path.exists());
        cleanup(&path);
    }

    #[test]
    fn stale_temp_is_removed_but_recent_temp_blocks_a_writer() {
        let path = temp_path("temp");
        let temporary = temporary_path(&path);
        fs::write(&temporary, b"stale").unwrap();
        cleanup_stale_temp_at(
            &path,
            SystemTime::now() + STALE_TEMP_AGE + Duration::from_secs(1),
        )
        .unwrap();
        assert!(!temporary.exists());

        fs::write(&temporary, b"recent").unwrap();
        let error = write_json(&path, &TestDocument::default()).unwrap_err();
        assert!(error.to_string().contains("active writer"));
        cleanup(&path);
    }

    #[test]
    fn replacement_keeps_previous_valid_backup() {
        let path = temp_path("backup");
        let first = TestDocument {
            schema_version: 1,
            value: "first".into(),
        };
        let second = TestDocument {
            schema_version: 1,
            value: "second".into(),
        };
        let third = TestDocument {
            schema_version: 1,
            value: "third".into(),
        };
        write_json(&path, &first).unwrap();
        write_json(&path, &second).unwrap();
        write_json(&path, &third).unwrap();

        assert_eq!(parse_test(&fs::read(&path).unwrap()).unwrap(), third);
        assert_eq!(
            parse_test(&fs::read(backup_path(&path)).unwrap()).unwrap(),
            second
        );
        cleanup(&path);
    }

    #[test]
    fn parent_creation_failure_does_not_create_partial_primary() {
        let root = temp_path("permission-root");
        fs::write(&root, b"not a directory").unwrap();
        let path = root.join("state.json");
        assert!(write_json(&path, &TestDocument::default()).is_err());
        assert!(!path.exists());
        let _ = fs::remove_file(root);
    }
}
