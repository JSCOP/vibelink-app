use crate::storage::{
    load_with_recovery, parse_json, require_supported_schema, write_json, DocumentError, LoadSource,
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const DEFAULT_REMOTE_PORT: u16 = 42_811;
const CONFIG_SCHEMA_VERSION: u64 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfig {
    pub enabled: bool,
    pub port: u16,
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_REMOTE_PORT,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteConfigDocument {
    schema_version: u64,
    config: RemoteConfig,
}

struct LoadedConfig {
    config: RemoteConfig,
    legacy: bool,
}

impl Default for LoadedConfig {
    fn default() -> Self {
        Self {
            config: RemoteConfig::default(),
            legacy: false,
        }
    }
}

impl RemoteConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let report = load_with_recovery(path, LoadedConfig::default(), parse_config)?;
        let rewrite = report.value.legacy || report.source == LoadSource::Default;
        let config = report.value.config;
        if rewrite {
            config.save(path)?;
        }
        Ok(config)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        write_json(
            path,
            &RemoteConfigDocument {
                schema_version: CONFIG_SCHEMA_VERSION,
                config: self.clone(),
            },
        )
    }
}

fn parse_config(bytes: &[u8]) -> std::result::Result<LoadedConfig, DocumentError> {
    let value: serde_json::Value = parse_json(bytes)?;
    if value.get("schemaVersion").is_some() {
        let document: RemoteConfigDocument = serde_json::from_value(value)?;
        require_supported_schema(document.schema_version, CONFIG_SCHEMA_VERSION)?;
        Ok(LoadedConfig {
            config: document.config,
            legacy: false,
        })
    } else {
        Ok(LoadedConfig {
            config: serde_json::from_value(value)?,
            legacy: true,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn directory(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("vibelink-remote-config-{label}-{}", Uuid::new_v4()))
    }

    #[test]
    fn config_defaults_migrates_legacy_and_round_trips_versioned_document() {
        let directory = directory("round-trip");
        let path = directory.join("config.json");
        assert_eq!(RemoteConfig::load(&path).unwrap(), RemoteConfig::default());
        let first_document: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(first_document["schemaVersion"], 1);

        fs::write(&path, br#"{"enabled":true,"port":45000}"#).unwrap();
        let config = RemoteConfig::load(&path).unwrap();
        assert_eq!(
            config,
            RemoteConfig {
                enabled: true,
                port: 45_000,
            }
        );
        let migrated: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(migrated["schemaVersion"], 1);
        assert_eq!(migrated["config"]["port"], 45_000);

        let saved = RemoteConfig {
            enabled: false,
            port: 46_000,
        };
        saved.save(&path).unwrap();
        assert_eq!(RemoteConfig::load(&path).unwrap(), saved);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn corrupt_config_primary_recovers_from_valid_backup() {
        let directory = directory("recovery");
        let path = directory.join("config.json");
        let first = RemoteConfig {
            enabled: true,
            port: 45_001,
        };
        let second = RemoteConfig {
            enabled: false,
            port: 45_002,
        };
        first.save(&path).unwrap();
        second.save(&path).unwrap();
        fs::write(&path, b"{").unwrap();

        assert_eq!(RemoteConfig::load(&path).unwrap(), first);
        assert!(fs::read_dir(&directory)
            .unwrap()
            .flatten()
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .contains("config.json.corrupt-")));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn newer_config_schema_errors_without_rewriting_default() {
        let directory = directory("newer");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("config.json");
        fs::write(
            &path,
            br#"{"schemaVersion":2,"config":{"enabled":true,"port":45000}}"#,
        )
        .unwrap();

        let error = RemoteConfig::load(&path).unwrap_err().to_string();
        assert!(error.contains("unsupported storage schema 2"));
        assert!(!path.exists());
        assert!(fs::read_dir(&directory)
            .unwrap()
            .flatten()
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .contains("config.json.corrupt-")));
        let _ = fs::remove_dir_all(directory);
    }
}
