use crate::persistence::{load_json_or_default, write_json_atomic};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const DEFAULT_REMOTE_PORT: u16 = 42_811;

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

impl RemoteConfig {
    pub fn load(path: &Path) -> Result<Self> {
        load_json_or_default(path, "remote config")
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        write_json_atomic(path, self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

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
