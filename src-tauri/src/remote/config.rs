use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}};

pub const DEFAULT_REMOTE_PORT: u16 = 42_811;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfig {
    pub enabled: bool,
    pub port: u16,
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self { enabled: false, port: DEFAULT_REMOTE_PORT }
    }
}

impl RemoteConfig {
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
        let config: Self = serde_json::from_slice(&bytes)
            .with_context(|| format!("parse {}", path.display()))?;
        Ok(config)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary = temporary_path(path);
        fs::write(&temporary, serde_json::to_vec_pretty(self)?)?;
        fs::rename(&temporary, path)?;
        Ok(())
    }
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(".tmp");
    PathBuf::from(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn config_defaults_and_round_trips() {
        let path = std::env::temp_dir().join(format!("vibelink-remote-config-{}.json", Uuid::new_v4()));
        assert_eq!(RemoteConfig::load(&path).unwrap(), RemoteConfig::default());
        let config = RemoteConfig { enabled: true, port: 45_000 };
        config.save(&path).unwrap();
        assert_eq!(RemoteConfig::load(&path).unwrap(), config);
        let _ = fs::remove_file(path);
    }
}
