use crate::{
    runtime_ports,
    storage::{
        load_with_recovery, parse_json, require_supported_schema, write_json, DocumentError,
        LoadSource,
    },
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const DEFAULT_REMOTE_PORT: u16 = runtime_ports::default_remote_port(cfg!(debug_assertions));
const CONFIG_SCHEMA_VERSION: u64 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfig {
    pub enabled: bool,
    pub port: u16,
    #[serde(default)]
    pub lan_enabled: bool,
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_REMOTE_PORT,
            lan_enabled: false,
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
    fn config_defaults_and_round_trips() {
        let path =
            std::env::temp_dir().join(format!("vibelink-remote-config-{}.json", Uuid::new_v4()));
        assert_eq!(RemoteConfig::load(&path).unwrap(), RemoteConfig::default());
        let config = RemoteConfig {
            enabled: true,
            port: 45_000,
            lan_enabled: true,
        };
        config.save(&path).unwrap();
        assert_eq!(RemoteConfig::load(&path).unwrap(), config);
        let _ = std::fs::remove_file(path);
    }
}
