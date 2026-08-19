//! Hermes-specific integration: binary discovery, HERMES_HOME model
//! configuration, runtime status, and the Hermes CLI helpers. The generic ACP
//! chat runtime that Hermes runs on lives in `acp.rs`.

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::acp::{
    agent_workspace_dir, apply_no_window, non_empty, resolve_workspace_cwd, to_string,
};

const HERMES_ACP_BIN: &str = if cfg!(windows) {
    "hermes-acp.exe"
} else {
    "hermes-acp"
};
const HERMES_BIN: &str = if cfg!(windows) {
    "hermes.exe"
} else {
    "hermes"
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesRuntimeStatus {
    pub detected: bool,
    pub command: Option<String>,
    pub cli_command: Option<String>,
    pub version: Option<String>,
    pub home: Option<String>,
    pub source: Option<String>,
    pub configured_model: Option<HermesConfiguredModel>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesConfiguredModel {
    pub provider: String,
    pub model: String,
    pub base_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesWorkspaceState {
    pub home: String,
    pub workspace_folder: String,
    pub model: Option<HermesConfiguredModel>,
}

#[tauri::command]
pub async fn hermes_cli_command(command_override: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_hermes_command(command_override))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_auth_list(
    session_id: String,
    command_override: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        hermes_auth_list_native(&session_id, command_override)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_runtime_status(
    command_override: Option<String>,
) -> Result<HermesRuntimeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || hermes_runtime_status_native(command_override))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_workspace_state(
    session_id: String,
    workspace_folder: Option<String>,
) -> Result<HermesWorkspaceState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_workspace_state_native(&session_id, workspace_folder.as_deref())
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

pub(crate) fn acp_model_id_from_configured_model(model: &HermesConfiguredModel) -> String {
    let provider = model.provider.trim();
    let raw = model.model.trim();
    if raw.is_empty() {
        return String::new();
    }
    // Reduce to the bare model id, dropping a leading "<provider>/" or
    // "<provider>:" that only repeats the configured provider.
    let bare = raw
        .split_once(['/', ':'])
        .filter(|(prefix, rest)| {
            prefix.trim().eq_ignore_ascii_case(provider) && !rest.trim().is_empty()
        })
        .map(|(_, rest)| rest.trim())
        .unwrap_or(raw);
    if provider.is_empty() {
        return bare.to_string();
    }
    // Qualify with the provider so Hermes pins it instead of re-detecting a
    // bare id to a different provider (e.g. gpt-5.5 -> openai-api).
    format!("{}:{}", provider.to_ascii_lowercase(), bare)
}

const HERMES_NOT_INSTALLED: &str = "Hermes Agent is not installed. Install it from https://hermes-agent.nousresearch.com/ and re-check.";

fn hermes_global_home() -> PathBuf {
    if let Some(home) = std::env::var("HERMES_HOME").ok().and_then(non_empty) {
        return PathBuf::from(home);
    }
    #[cfg(windows)]
    {
        if let Some(local_app_data) = std::env::var("LOCALAPPDATA").ok().and_then(non_empty) {
            return PathBuf::from(local_app_data).join("hermes");
        }
        if let Some(user_profile) = std::env::var("USERPROFILE").ok().and_then(non_empty) {
            return PathBuf::from(user_profile)
                .join("AppData")
                .join("Local")
                .join("hermes");
        }
    }
    #[cfg(not(windows))]
    if let Some(home) = std::env::var("HOME").ok().and_then(non_empty) {
        return PathBuf::from(home).join(".hermes");
    }
    PathBuf::from(".hermes")
}

fn read_workspace_model(doc: &serde_yaml::Mapping) -> Option<HermesConfiguredModel> {
    match doc.get(serde_yaml::Value::from("model"))? {
        serde_yaml::Value::Mapping(model) => {
            let provider = model
                .get(serde_yaml::Value::from("provider"))
                .and_then(serde_yaml::Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            let id = model
                .get(serde_yaml::Value::from("default"))
                .or_else(|| model.get(serde_yaml::Value::from("model")))
                .and_then(serde_yaml::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            let base_url = model
                .get(serde_yaml::Value::from("base_url"))
                .and_then(serde_yaml::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);

            Some(HermesConfiguredModel {
                provider: provider.to_string(),
                model: id.to_string(),
                base_url,
            })
        }
        serde_yaml::Value::String(model) => {
            non_empty(model.clone()).map(|model| HermesConfiguredModel {
                provider: String::new(),
                model,
                base_url: None,
            })
        }
        _ => None,
    }
}

pub(crate) fn read_global_configured_model() -> Result<Option<HermesConfiguredModel>> {
    let doc = read_workspace_config_doc(&hermes_global_home().join("config.yaml"))?;
    Ok(read_workspace_model(&doc))
}

fn read_workspace_state_native(
    session_id: &str,
    workspace_folder: Option<&str>,
) -> Result<HermesWorkspaceState> {
    let home = hermes_global_home();
    let anchor = agent_workspace_dir(session_id)?;
    let cwd = resolve_workspace_cwd(workspace_folder, &anchor)?;
    Ok(HermesWorkspaceState {
        home: home.to_string_lossy().to_string(),
        workspace_folder: cwd.to_string_lossy().to_string(),
        model: read_global_configured_model()?,
    })
}

fn read_workspace_config_doc(config_path: &Path) -> Result<serde_yaml::Mapping> {
    if !config_path.exists() {
        return Ok(serde_yaml::Mapping::new());
    }
    let text = std::fs::read_to_string(config_path).context("read config.yaml")?;
    let value: serde_yaml::Value =
        serde_yaml::from_str(&text).with_context(|| format!("parse {}", config_path.display()))?;
    value
        .as_mapping()
        .cloned()
        .ok_or_else(|| anyhow!("config.yaml top-level is not a mapping"))
}

fn installer_acp_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(windows)]
    {
        if let Some(local_app_data) = std::env::var("LOCALAPPDATA").ok().and_then(non_empty) {
            candidates.push(
                PathBuf::from(local_app_data)
                    .join("hermes/hermes-agent/venv/Scripts/hermes-acp.exe"),
            );
        }
        if let Some(user_profile) = std::env::var("USERPROFILE").ok().and_then(non_empty) {
            candidates.push(
                PathBuf::from(user_profile)
                    .join(".hermes/hermes-agent/venv/Scripts/hermes-acp.exe"),
            );
        }
    }
    candidates
}

fn resolve_command_with_source(command_override: Option<String>) -> Result<(String, &'static str)> {
    if let Some(command) = command_override.and_then(non_empty) {
        if let Some(resolved) = crate::daemon::pty::resolve_program(&command) {
            return Ok((resolved, "override"));
        }
        bail!(HERMES_NOT_INSTALLED);
    }
    if let Some(command) = crate::daemon::pty::resolve_program(HERMES_ACP_BIN) {
        return Ok((command, "path"));
    }
    if let Some(command) = installer_acp_candidates()
        .into_iter()
        .find(|path| path.is_file())
    {
        return Ok((command.to_string_lossy().to_string(), "installer"));
    }
    bail!(HERMES_NOT_INSTALLED)
}

pub fn resolve_command(command_override: Option<String>) -> Result<String> {
    resolve_command_with_source(command_override).map(|(command, _)| command)
}

fn resolve_hermes_command(command_override: Option<String>) -> Result<String> {
    if let Some(command) = command_override.clone().and_then(non_empty) {
        if !command.ends_with("hermes-acp") && !command.ends_with("hermes-acp.exe") {
            return crate::daemon::pty::resolve_program(&command)
                .ok_or_else(|| anyhow!(HERMES_NOT_INSTALLED));
        }
    }
    let acp = PathBuf::from(resolve_command(command_override)?);
    let sibling = acp.with_file_name(HERMES_BIN);
    if sibling.is_file() {
        return Ok(sibling.to_string_lossy().to_string());
    }
    crate::daemon::pty::resolve_program(HERMES_BIN).ok_or_else(|| anyhow!(HERMES_NOT_INSTALLED))
}

fn hermes_auth_list_native(_session_id: &str, command_override: Option<String>) -> Result<String> {
    let command_path = resolve_hermes_command(command_override)?;
    let mut command = Command::new(command_path);
    command.arg("auth").arg("list");
    apply_no_window(&mut command);
    let output = command.output().context("run hermes auth list")?;
    if !output.status.success() {
        return Err(anyhow!(stderr_or_status(&output, "hermes auth list")));
    }
    Ok(stdout_or_stderr(&output))
}

fn hermes_runtime_status_native(command_override: Option<String>) -> Result<HermesRuntimeStatus> {
    let home = hermes_global_home();
    let configured_model = read_global_configured_model().ok().flatten();
    let Ok((command, source)) = resolve_command_with_source(command_override) else {
        return Ok(HermesRuntimeStatus {
            detected: false,
            command: None,
            cli_command: None,
            version: None,
            home: Some(home.to_string_lossy().to_string()),
            source: None,
            configured_model,
        });
    };
    let cli_command = resolve_hermes_command(Some(command.clone())).ok();
    let mut probe = Command::new(&command);
    probe.arg("--version");
    apply_no_window(&mut probe);
    let version = probe
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| non_empty(stdout_or_stderr(&output)));
    Ok(HermesRuntimeStatus {
        detected: version.is_some(),
        command: Some(command),
        cli_command,
        version,
        home: Some(home.to_string_lossy().to_string()),
        source: Some(source.to_string()),
        configured_model,
    })
}

fn stdout_or_stderr(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        String::from_utf8_lossy(&output.stderr).trim().to_string()
    } else {
        stdout
    }
}

fn stderr_or_status(output: &std::process::Output, command: &str) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        format!("{command} exited with status {}", output.status)
    } else {
        stderr
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acp_model_id_qualifies_with_provider() {
        let anthropic = HermesConfiguredModel {
            provider: "anthropic".to_string(),
            model: "anthropic/claude-sonnet-4-6".to_string(),
            base_url: None,
        };
        let openrouter = HermesConfiguredModel {
            provider: "openrouter".to_string(),
            model: "anthropic/claude-sonnet-4.6".to_string(),
            base_url: None,
        };
        let codex = HermesConfiguredModel {
            provider: "openai-codex".to_string(),
            model: "gpt-5.5".to_string(),
            base_url: None,
        };
        let no_provider = HermesConfiguredModel {
            provider: String::new(),
            model: "gpt-5.5".to_string(),
            base_url: None,
        };

        assert_eq!(
            acp_model_id_from_configured_model(&anthropic),
            "anthropic:claude-sonnet-4-6"
        );
        assert_eq!(
            acp_model_id_from_configured_model(&openrouter),
            "openrouter:anthropic/claude-sonnet-4.6"
        );
        assert_eq!(
            acp_model_id_from_configured_model(&codex),
            "openai-codex:gpt-5.5"
        );
        assert_eq!(acp_model_id_from_configured_model(&no_provider), "gpt-5.5");
    }

    #[test]
    fn read_workspace_model_interprets_mapping_and_sentinel() {
        let doc = yaml_mapping(
            r#"
model:
  provider: anthropic
  default: claude-sonnet-4-6
  base_url: https://api.anthropic.com
"#,
        );

        let model = read_workspace_model(&doc).expect("configured model");

        assert_eq!(model.provider, "anthropic");
        assert_eq!(model.model, "claude-sonnet-4-6");
        assert_eq!(model.base_url.as_deref(), Some("https://api.anthropic.com"));
        assert!(read_workspace_model(&yaml_mapping("model: ''\n")).is_none());
    }

    #[test]
    fn read_workspace_config_doc_rejects_corrupted_yaml() {
        let path = std::env::temp_dir().join(format!(
            "hermes-corrupt-config-{}.yaml",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, "model: [").expect("write corrupt config");

        let err = read_workspace_config_doc(&path).expect_err("corrupt yaml should fail");

        assert!(err.to_string().contains("parse"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "model: [");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_workspace_config_doc_rejects_non_mapping() {
        let path =
            std::env::temp_dir().join(format!("hermes-list-config-{}.yaml", uuid::Uuid::new_v4()));
        std::fs::write(&path, "[]").expect("write list config");

        let err = read_workspace_config_doc(&path).expect_err("list yaml should fail");

        assert!(err.to_string().contains("top-level is not a mapping"));
        let _ = std::fs::remove_file(&path);
    }

    fn yaml_mapping(input: &str) -> serde_yaml::Mapping {
        serde_yaml::from_str::<serde_yaml::Value>(input)
            .expect("parse yaml")
            .as_mapping()
            .cloned()
            .expect("yaml mapping")
    }
}
