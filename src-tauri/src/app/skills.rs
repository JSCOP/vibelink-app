use super::{authorization::Capability, entitlement::EntitlementSupervisor};
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;
const SKILL_ROOT: &str = "skills";
const GLOBAL_SCOPE_DIR: &str = "global";
const WORKSPACE_SCOPE_DIR: &str = "workspaces";
const SKILL_FILE: &str = "SKILL.md";
const METADATA_FILE: &str = "metadata.json";
const DEFAULT_CATEGORY: &str = "Custom";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum SkillScope {
    #[default]
    Global,
    Workspace,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    pub id: String,
    pub name: String,
    pub category: String,
    pub description: String,
    pub scope: SkillScope,
    pub enabled: bool,
    pub updated_at: u64,
    pub path: String,
    pub read_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required_capabilities: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillApplyInput {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, alias = "instructions")]
    pub content: String,
    #[serde(default)]
    pub scope: SkillScope,
    #[serde(default, alias = "session_id")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub required_capabilities: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillMetadata {
    id: String,
    name: String,
    category: String,
    description: String,
    scope: SkillScope,
    enabled: bool,
    #[serde(alias = "updated_at")]
    updated_at: u64,
    #[serde(default)]
    required_capabilities: Vec<String>,
}

#[derive(Clone, Copy)]
struct LegacyBuiltinSkill {
    id: &'static str,
    category: &'static str,
    description: &'static str,
}

const LEGACY_BUILTIN_SKILLS: &[LegacyBuiltinSkill] = &[
    LegacyBuiltinSkill {
        id: "vibelink-terminal",
        category: "Workspace",
        description: "List, read, write, launch panes, and configure agent pane titles/roles through the VibeLink MCP bridge.",
    },
    LegacyBuiltinSkill {
        id: "kanban-board",
        category: "Planning",
        description: "Create, assign, update, and complete tasks on AI agent panes only.",
    },
    LegacyBuiltinSkill {
        id: "diff-review",
        category: "Review",
        description: "Inspect task baselines and changed files from the Diff window.",
    },
    LegacyBuiltinSkill {
        id: "native-hermes",
        category: "Agent",
        description: "Uses native Hermes provider, auth, model, and session storage.",
    },
];

#[tauri::command]
pub async fn vibelink_skill_list(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    session_id: Option<String>,
) -> Result<Vec<SkillEntry>, String> {
    supervisor
        .authorize(Capability::WorkspaceRead)
        .map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || list_skills(session_id.as_deref()))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn vibelink_skill_get(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    id: String,
    session_id: Option<String>,
    scope: Option<SkillScope>,
) -> Result<SkillEntry, String> {
    supervisor
        .authorize(Capability::WorkspaceRead)
        .map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || get_skill(&id, session_id.as_deref(), scope))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn vibelink_skill_apply(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    input: SkillApplyInput,
) -> Result<SkillEntry, String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || apply_skill(input))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn vibelink_skill_delete(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    id: String,
    session_id: Option<String>,
    scope: Option<SkillScope>,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || delete_skill(&id, session_id.as_deref(), scope))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

pub fn list_skills(session_id: Option<&str>) -> Result<Vec<SkillEntry>> {
    let data_dir = crate::daemon::paths::daemon_paths()?.data_dir;
    list_skills_at(&data_dir, session_id)
}

pub fn get_skill(
    id: &str,
    session_id: Option<&str>,
    scope: Option<SkillScope>,
) -> Result<SkillEntry> {
    let data_dir = crate::daemon::paths::daemon_paths()?.data_dir;
    get_skill_at(&data_dir, id, session_id, scope)
}

pub fn apply_skill(input: SkillApplyInput) -> Result<SkillEntry> {
    let data_dir = crate::daemon::paths::daemon_paths()?.data_dir;
    apply_skill_at(&data_dir, input)
}

pub fn delete_skill(id: &str, session_id: Option<&str>, scope: Option<SkillScope>) -> Result<()> {
    let data_dir = crate::daemon::paths::daemon_paths()?.data_dir;
    delete_skill_at(&data_dir, id, session_id, scope)
}

pub fn augment_prompt_with_enabled_skills(session_id: &str, text: &str) -> Result<String> {
    augment_prompt_with_enabled_skills_for_capabilities(
        session_id,
        text,
        std::iter::empty::<&str>(),
    )
}

pub fn augment_prompt_with_enabled_skills_for_capabilities<'a>(
    session_id: &str,
    text: &str,
    granted_capabilities: impl IntoIterator<Item = &'a str>,
) -> Result<String> {
    let Some(context) =
        enabled_skill_context_for_capabilities(Some(session_id), granted_capabilities)?
    else {
        return Ok(text.to_string());
    };
    Ok(format!(
        "{context}\n\n[VIBELINK_USER_REQUEST bytes={}]\n{text}\n[END_VIBELINK_USER_REQUEST]",
        text.len()
    ))
}

pub fn enabled_skill_context(session_id: Option<&str>) -> Result<Option<String>> {
    enabled_skill_context_for_capabilities(session_id, std::iter::empty::<&str>())
}

pub fn enabled_skill_context_for_capabilities<'a>(
    session_id: Option<&str>,
    granted_capabilities: impl IntoIterator<Item = &'a str>,
) -> Result<Option<String>> {
    let data_dir = crate::daemon::paths::daemon_paths()?.data_dir;
    enabled_skill_context_with_capabilities_at(&data_dir, session_id, granted_capabilities)
}

#[cfg(test)]
fn enabled_skill_context_at(data_dir: &Path, session_id: Option<&str>) -> Result<Option<String>> {
    enabled_skill_context_with_capabilities_at(data_dir, session_id, std::iter::empty::<&str>())
}

fn enabled_skill_context_with_capabilities_at<'a>(
    data_dir: &Path,
    session_id: Option<&str>,
    granted_capabilities: impl IntoIterator<Item = &'a str>,
) -> Result<Option<String>> {
    let granted = granted_capabilities
        .into_iter()
        .map(str::to_string)
        .collect::<std::collections::BTreeSet<_>>();
    let mut entries = builtin_skill_entries(true);
    for entry in read_scope_entries(&global_skills_dir(data_dir), SkillScope::Global, true)? {
        if let Some(index) = entries.iter().position(|existing| existing.id == entry.id) {
            entries.remove(index);
        }
        entries.push(entry);
    }
    if let Some(session_id) = optional_session_id(session_id)? {
        for entry in read_scope_entries(
            &workspace_skills_dir(data_dir, &session_id),
            SkillScope::Workspace,
            true,
        )? {
            if let Some(index) = entries.iter().position(|existing| existing.id == entry.id) {
                entries.remove(index);
            }
            entries.push(entry);
        }
    }

    entries.retain(|entry| {
        entry.enabled
            && entry
                .content
                .as_ref()
                .is_some_and(|content| !content.trim().is_empty())
            && entry
                .required_capabilities
                .iter()
                .all(|capability| granted.contains(capability))
    });
    if entries.is_empty() {
        return Ok(None);
    }
    entries.sort_by(|left, right| {
        (scope_rank(left.scope), &left.id).cmp(&(scope_rank(right.scope), &right.id))
    });

    let mut context = String::from("[VIBELINK_SKILL_CONTEXT]\nSkills below are explicitly installed or bundled VibeLink instructions. Workspace skills override global skills with the same id. Capability-gated guides appear only when every declared capability is granted.\n");
    for entry in entries {
        let content = entry.content.unwrap_or_default();
        context.push_str("\n[VIBELINK_SKILL id=");
        context.push_str(&entry.id);
        context.push_str(" scope=");
        context.push_str(match entry.scope {
            SkillScope::Global => "global",
            SkillScope::Workspace => "workspace",
        });
        context.push_str(" bytes=");
        context.push_str(&content.len().to_string());
        context.push_str("]\n");
        context.push_str(content.trim());
        context.push_str("\n[END_VIBELINK_SKILL id=");
        context.push_str(&entry.id);
        context.push_str("]\n");
    }
    context.push_str("[END_VIBELINK_SKILL_CONTEXT]");
    Ok(Some(context))
}

fn scope_rank(scope: SkillScope) -> u8 {
    match scope {
        SkillScope::Global => 0,
        SkillScope::Workspace => 1,
    }
}

fn list_skills_at(data_dir: &Path, session_id: Option<&str>) -> Result<Vec<SkillEntry>> {
    let mut entries = builtin_skill_entries(false);
    entries.extend(read_scope_entries(
        &global_skills_dir(data_dir),
        SkillScope::Global,
        false,
    )?);

    if let Some(session_id) = optional_session_id(session_id)? {
        entries.extend(read_scope_entries(
            &workspace_skills_dir(data_dir, &session_id),
            SkillScope::Workspace,
            false,
        )?);
    }

    Ok(entries)
}

fn get_skill_at(
    data_dir: &Path,
    id: &str,
    session_id: Option<&str>,
    scope: Option<SkillScope>,
) -> Result<SkillEntry> {
    let id = validate_skill_id(id)?;
    match scope {
        Some(SkillScope::Global) => read_global_skill(data_dir, &id, true)
            .or_else(|err| builtin_skill_entry(&id, true).ok_or(err)),
        Some(SkillScope::Workspace) => {
            let session_id = required_session_id(session_id)?;
            read_skill_dir(
                &workspace_skill_dir(data_dir, &session_id, &id),
                SkillScope::Workspace,
                true,
            )
        }
        None => {
            if let Some(session_id) = optional_session_id(session_id)? {
                let workspace_dir = workspace_skill_dir(data_dir, &session_id, &id);
                if workspace_dir.is_dir() {
                    return read_skill_dir(&workspace_dir, SkillScope::Workspace, true);
                }
            }

            read_global_skill(data_dir, &id, true)
                .or_else(|err| builtin_skill_entry(&id, true).ok_or(err))
        }
    }
}

fn apply_skill_at(data_dir: &Path, input: SkillApplyInput) -> Result<SkillEntry> {
    let id = validate_skill_id(&input.id)?;
    ensure_not_builtin(&id)?;
    ensure_skill_content(&input.content)?;

    let dir = match input.scope {
        SkillScope::Global => global_skill_dir(data_dir, &id),
        SkillScope::Workspace => {
            let session_id = required_session_id(input.session_id.as_deref())?;
            workspace_skill_dir(data_dir, &session_id, &id)
        }
    };

    let required_capabilities = normalize_capabilities(input.required_capabilities)?;
    let metadata = SkillMetadata {
        name: clean_text(input.name.as_deref()).unwrap_or_else(|| id.clone()),
        category: clean_text(input.category.as_deref())
            .unwrap_or_else(|| DEFAULT_CATEGORY.to_string()),
        description: clean_text(input.description.as_deref()).unwrap_or_default(),
        scope: input.scope,
        enabled: input.enabled.unwrap_or(true),
        updated_at: current_time_millis()?,
        id,
        required_capabilities,
    };

    write_skill_dir(&dir, &metadata, &input.content)?;
    metadata_to_entry(metadata, &dir, false, Some(input.content))
}

fn delete_skill_at(
    data_dir: &Path,
    id: &str,
    session_id: Option<&str>,
    scope: Option<SkillScope>,
) -> Result<()> {
    let id = validate_skill_id(id)?;
    ensure_not_builtin(&id)?;

    let dir = match scope {
        Some(SkillScope::Global) => global_skill_dir(data_dir, &id),
        Some(SkillScope::Workspace) => {
            let session_id = required_session_id(session_id)?;
            workspace_skill_dir(data_dir, &session_id, &id)
        }
        None => {
            if let Some(session_id) = optional_session_id(session_id)? {
                let workspace_dir = workspace_skill_dir(data_dir, &session_id, &id);
                if workspace_dir.is_dir() {
                    workspace_dir
                } else {
                    global_skill_dir(data_dir, &id)
                }
            } else {
                global_skill_dir(data_dir, &id)
            }
        }
    };

    if !dir.is_dir() {
        bail!("skill '{id}' not found");
    }
    fs::remove_dir_all(&dir).with_context(|| format!("delete skill directory {}", dir.display()))
}

fn read_global_skill(data_dir: &Path, id: &str, include_content: bool) -> Result<SkillEntry> {
    read_skill_dir(
        &global_skill_dir(data_dir, id),
        SkillScope::Global,
        include_content,
    )
}

fn read_scope_entries(
    root: &Path,
    scope: SkillScope,
    include_content: bool,
) -> Result<Vec<SkillEntry>> {
    if !root.is_dir() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    for entry in
        fs::read_dir(root).with_context(|| format!("read skills directory {}", root.display()))?
    {
        let entry =
            entry.with_context(|| format!("read skill directory entry in {}", root.display()))?;
        let path = entry.path();
        if !entry
            .file_type()
            .with_context(|| format!("read file type for {}", path.display()))?
            .is_dir()
        {
            continue;
        }
        let Some(dir_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if dir_name.starts_with('.') || validate_skill_id(dir_name).is_err() {
            continue;
        }
        entries.push(read_skill_dir(&path, scope, include_content)?);
    }
    entries.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(entries)
}

fn read_skill_dir(
    dir: &Path,
    expected_scope: SkillScope,
    include_content: bool,
) -> Result<SkillEntry> {
    if !dir.is_dir() {
        bail!("skill not found at {}", dir.display());
    }

    let metadata_path = dir.join(METADATA_FILE);
    let metadata_text = fs::read_to_string(&metadata_path)
        .with_context(|| format!("read skill metadata {}", metadata_path.display()))?;
    let metadata: SkillMetadata = serde_json::from_str(&metadata_text)
        .with_context(|| format!("parse skill metadata {}", metadata_path.display()))?;
    let id = validate_skill_id(&metadata.id)?;
    let dir_name = dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("skill directory has no UTF-8 name: {}", dir.display()))?;
    if id != dir_name {
        bail!(
            "skill metadata id '{}' does not match directory '{}'",
            id,
            dir.display()
        );
    }
    if metadata.scope != expected_scope {
        bail!(
            "skill '{}' stored in {:?} directory but metadata scope is {:?}",
            id,
            expected_scope,
            metadata.scope
        );
    }

    let content = if include_content {
        let skill_path = dir.join(SKILL_FILE);
        Some(
            fs::read_to_string(&skill_path)
                .with_context(|| format!("read skill content {}", skill_path.display()))?,
        )
    } else {
        None
    };

    metadata_to_entry(metadata, dir, false, content)
}

fn metadata_to_entry(
    metadata: SkillMetadata,
    dir: &Path,
    read_only: bool,
    content: Option<String>,
) -> Result<SkillEntry> {
    Ok(SkillEntry {
        id: metadata.id,
        name: metadata.name,
        category: metadata.category,
        description: metadata.description,
        scope: metadata.scope,
        enabled: metadata.enabled,
        updated_at: metadata.updated_at,
        path: dir.join(SKILL_FILE).to_string_lossy().to_string(),
        read_only,
        content,
        version: None,
        required_capabilities: metadata.required_capabilities,
    })
}

fn write_skill_dir(dir: &Path, metadata: &SkillMetadata, content: &str) -> Result<()> {
    let parent = dir
        .parent()
        .ok_or_else(|| anyhow!("skill directory has no parent: {}", dir.display()))?;
    let dir_name = dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("skill directory has no UTF-8 name: {}", dir.display()))?;
    fs::create_dir_all(parent)
        .with_context(|| format!("create skill parent {}", parent.display()))?;

    let stage = parent.join(format!(".{dir_name}.{}.tmp", uuid::Uuid::new_v4()));
    fs::create_dir(&stage)
        .with_context(|| format!("create staged skill directory {}", stage.display()))?;
    let result = (|| {
        let metadata_json =
            serde_json::to_string_pretty(metadata).context("serialize skill metadata")?;
        fs::write(stage.join(SKILL_FILE), content)
            .with_context(|| format!("write staged skill content {}", stage.display()))?;
        fs::write(stage.join(METADATA_FILE), metadata_json)
            .with_context(|| format!("write staged skill metadata {}", stage.display()))?;
        replace_skill_dir(&stage, dir)
            .with_context(|| format!("replace skill directory {}", dir.display()))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

fn replace_skill_dir(stage: &Path, target: &Path) -> Result<()> {
    if !target.exists() {
        return fs::rename(stage, target)
            .with_context(|| format!("rename staged skill directory {}", target.display()));
    }
    if !target.is_dir() {
        bail!(
            "skill target exists but is not a directory: {}",
            target.display()
        );
    }

    let parent = target
        .parent()
        .ok_or_else(|| anyhow!("skill directory has no parent: {}", target.display()))?;
    let dir_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("skill directory has no UTF-8 name: {}", target.display()))?;
    let backup = parent.join(format!(".{dir_name}.{}.backup", uuid::Uuid::new_v4()));
    fs::rename(target, &backup)
        .with_context(|| format!("move existing skill directory to {}", backup.display()))?;

    match fs::rename(stage, target) {
        Ok(()) => {
            let _ = fs::remove_dir_all(&backup);
            Ok(())
        }
        Err(err) => {
            let restore = fs::rename(&backup, target);
            let _ = fs::remove_dir_all(stage);
            restore.with_context(|| format!("restore skill directory {}", target.display()))?;
            Err(err).with_context(|| format!("rename staged skill directory {}", target.display()))
        }
    }
}

fn builtin_skill_entries(include_content: bool) -> Vec<SkillEntry> {
    let mut entries = LEGACY_BUILTIN_SKILLS
        .iter()
        .map(|skill| legacy_builtin_to_entry(*skill, include_content))
        .collect::<Vec<_>>();
    entries.extend(
        crate::dedicated_cli::builtin_skills()
            .iter()
            .map(|skill| dedicated_builtin_to_entry(skill, include_content)),
    );
    entries
}

fn builtin_skill_entry(id: &str, include_content: bool) -> Option<SkillEntry> {
    LEGACY_BUILTIN_SKILLS
        .iter()
        .copied()
        .find(|skill| skill.id == id)
        .map(|skill| legacy_builtin_to_entry(skill, include_content))
        .or_else(|| {
            crate::dedicated_cli::builtin_skill(id)
                .map(|skill| dedicated_builtin_to_entry(skill, include_content))
        })
}

fn legacy_builtin_to_entry(skill: LegacyBuiltinSkill, include_content: bool) -> SkillEntry {
    SkillEntry {
        id: skill.id.to_string(),
        name: skill.id.to_string(),
        category: skill.category.to_string(),
        description: skill.description.to_string(),
        scope: SkillScope::Global,
        enabled: true,
        updated_at: 0,
        path: format!("builtin://{}", skill.id),
        read_only: true,
        content: include_content.then(|| format!("# {}\n\n{}\n", skill.id, skill.description)),
        version: None,
        required_capabilities: vec!["legacy.skills".to_string()],
    }
}

fn dedicated_builtin_to_entry(
    skill: &crate::dedicated_cli::BuiltinSkillDefinition,
    include_content: bool,
) -> SkillEntry {
    SkillEntry {
        id: skill.id.to_string(),
        name: skill.name.to_string(),
        category: skill.category.to_string(),
        description: skill.description.to_string(),
        scope: SkillScope::Global,
        enabled: true,
        updated_at: 0,
        path: format!("builtin://{}@{}", skill.id, skill.version),
        read_only: true,
        content: include_content.then(|| skill.content.to_string()),
        version: Some(skill.version.to_string()),
        required_capabilities: skill
            .required_capabilities
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
    }
}

fn ensure_not_builtin(id: &str) -> Result<()> {
    if LEGACY_BUILTIN_SKILLS.iter().any(|skill| skill.id == id)
        || crate::dedicated_cli::builtin_skill(id).is_some()
    {
        bail!("built-in skill '{id}' is read-only");
    }
    Ok(())
}

fn validate_skill_id(id: &str) -> Result<String> {
    let id = id.trim();
    let bytes = id.as_bytes();
    if !(2..=63).contains(&bytes.len()) {
        bail!("skill id must be 2 to 63 characters");
    }
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        bail!("skill id must start with a lowercase ASCII letter or digit");
    }
    if !bytes[1..]
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
    {
        bail!("skill id must match [a-z0-9][a-z0-9-]{{1,62}}");
    }
    Ok(id.to_string())
}

fn optional_session_id(session_id: Option<&str>) -> Result<Option<String>> {
    session_id
        .and_then(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then_some(trimmed)
        })
        .map(sanitize_session_id)
        .transpose()
}

fn required_session_id(session_id: Option<&str>) -> Result<String> {
    optional_session_id(session_id)?
        .ok_or_else(|| anyhow!("sessionId is required for workspace skills"))
}

pub(crate) fn sanitize_session_id(session_id: &str) -> Result<String> {
    let mut sanitized = String::with_capacity(session_id.len().min(63));
    let mut last_was_hyphen = false;

    for byte in session_id.trim().bytes() {
        let byte = byte.to_ascii_lowercase();
        let next = if byte.is_ascii_lowercase() || byte.is_ascii_digit() {
            byte as char
        } else {
            '-'
        };

        if next == '-' {
            if sanitized.is_empty() || last_was_hyphen {
                continue;
            }
            last_was_hyphen = true;
        } else {
            last_was_hyphen = false;
        }
        sanitized.push(next);
        if sanitized.len() == 63 {
            break;
        }
    }

    while sanitized.ends_with('-') {
        sanitized.pop();
    }

    if !(2..=63).contains(&sanitized.len()) {
        bail!("sessionId must contain at least two safe characters");
    }
    validate_skill_id(&sanitized).map(|_| sanitized)
}

fn ensure_skill_content(content: &str) -> Result<()> {
    if content.trim().is_empty() {
        bail!("skill content is required");
    }
    Ok(())
}

fn clean_text(value: Option<&str>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}
fn normalize_capabilities(capabilities: Vec<String>) -> Result<Vec<String>> {
    if capabilities.len() > 64 {
        bail!("a skill may declare at most 64 capabilities");
    }
    let mut normalized = std::collections::BTreeSet::new();
    for capability in capabilities {
        let capability = capability.trim().to_ascii_lowercase();
        let valid = !capability.is_empty()
            && capability.len() <= 128
            && capability.bytes().enumerate().all(|(index, byte)| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
            });
        if !valid {
            bail!("invalid skill capability '{capability}'");
        }
        normalized.insert(capability);
    }
    Ok(normalized.into_iter().collect())
}

fn global_skills_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(SKILL_ROOT).join(GLOBAL_SCOPE_DIR)
}

fn global_skill_dir(data_dir: &Path, id: &str) -> PathBuf {
    global_skills_dir(data_dir).join(id)
}

fn workspace_skills_dir(data_dir: &Path, session_id: &str) -> PathBuf {
    data_dir
        .join(SKILL_ROOT)
        .join(WORKSPACE_SCOPE_DIR)
        .join(session_id)
}

fn workspace_skill_dir(data_dir: &Path, session_id: &str, id: &str) -> PathBuf {
    workspace_skills_dir(data_dir, session_id).join(id)
}

fn current_time_millis() -> Result<u64> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before Unix epoch")?;
    Ok(duration.as_millis() as u64)
}

fn to_string(err: impl std::fmt::Display) -> String {
    err.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_skill_ids() {
        assert_eq!(
            validate_skill_id("agent-skill").expect("valid id"),
            "agent-skill"
        );
        assert!(validate_skill_id("A-bad").is_err());
        assert!(validate_skill_id("a").is_err());
        assert!(validate_skill_id("bad_skill").is_err());
        assert!(validate_skill_id("../bad").is_err());
    }

    #[test]
    fn sanitizes_workspace_session_ids() {
        assert_eq!(
            sanitize_session_id(" Workspace::{1234} ").expect("sanitize session"),
            "workspace-1234"
        );
        assert!(sanitize_session_id("!").is_err());
    }

    #[test]
    fn lists_builtin_fallback_skills() {
        let root = temp_root("skill-builtins");
        let skills = list_skills_at(&root, None).expect("list skills");
        assert_eq!(
            skills.len(),
            LEGACY_BUILTIN_SKILLS.len() + crate::dedicated_cli::builtin_skills().len()
        );
        assert!(skills.iter().all(|skill| skill.read_only));
        assert!(skills.iter().any(|skill| skill.id == "vibelink-terminal"));
        cleanup_root(root);
    }

    #[test]
    fn applies_gets_lists_and_deletes_global_skill() {
        let root = temp_root("skill-global");
        let applied = apply_skill_at(
            &root,
            SkillApplyInput {
                id: "custom-skill".to_string(),
                name: Some("Custom Skill".to_string()),
                category: Some("Testing".to_string()),
                description: Some("Test skill".to_string()),
                content: "# Custom Skill\n\nDo the thing.\n".to_string(),
                scope: SkillScope::Global,
                session_id: None,
                enabled: Some(false),
                required_capabilities: Vec::new(),
            },
        )
        .expect("apply skill");

        assert_eq!(applied.id, "custom-skill");
        assert_eq!(applied.scope, SkillScope::Global);
        assert!(!applied.enabled);
        assert!(root
            .join(SKILL_ROOT)
            .join(GLOBAL_SCOPE_DIR)
            .join("custom-skill")
            .join(SKILL_FILE)
            .is_file());

        let fetched = get_skill_at(&root, "custom-skill", None, None).expect("get skill");
        assert_eq!(
            fetched.content.as_deref(),
            Some("# Custom Skill\n\nDo the thing.\n")
        );

        let listed = list_skills_at(&root, None).expect("list skills");
        assert!(listed
            .iter()
            .any(|skill| skill.id == "custom-skill" && !skill.read_only));

        delete_skill_at(&root, "custom-skill", None, None).expect("delete skill");
        assert!(get_skill_at(&root, "custom-skill", None, None).is_err());
        cleanup_root(root);
    }

    #[test]
    fn applies_workspace_skill_under_sanitized_session() {
        let root = temp_root("skill-workspace");
        apply_skill_at(
            &root,
            SkillApplyInput {
                id: "workspace-skill".to_string(),
                name: None,
                category: None,
                description: None,
                content: "# Workspace Skill\n".to_string(),
                scope: SkillScope::Workspace,
                session_id: Some("Session::{ABC}".to_string()),
                enabled: None,
                required_capabilities: Vec::new(),
            },
        )
        .expect("apply workspace skill");

        assert!(root
            .join(SKILL_ROOT)
            .join(WORKSPACE_SCOPE_DIR)
            .join("session-abc")
            .join("workspace-skill")
            .join(METADATA_FILE)
            .is_file());
        let listed = list_skills_at(&root, Some("Session::{ABC}")).expect("list workspace skills");
        assert!(listed.iter().any(|skill| skill.id == "workspace-skill"));
        cleanup_root(root);
    }

    #[test]
    fn rejects_builtin_skill_mutation() {
        let root = temp_root("skill-readonly");
        let err = apply_skill_at(
            &root,
            SkillApplyInput {
                id: "vibelink-terminal".to_string(),
                name: None,
                category: None,
                description: None,
                content: "# Override\n".to_string(),
                scope: SkillScope::Global,
                session_id: None,
                enabled: None,
                required_capabilities: Vec::new(),
            },
        )
        .expect_err("built-in apply should fail");
        assert!(err.to_string().contains("read-only"));
        assert!(delete_skill_at(&root, "vibelink-terminal", None, None).is_err());
        cleanup_root(root);
    }

    #[test]
    fn deserializes_camel_case_apply_input() {
        let input: SkillApplyInput = serde_json::from_value(serde_json::json!({
            "id": "json-skill",
            "name": "JSON Skill",
            "category": "Automation",
            "description": "Created from IPC-shaped JSON",
            "content": "# JSON Skill\n",
            "scope": "workspace",
            "sessionId": "Session::{XYZ}",
            "enabled": false
        }))
        .expect("deserialize apply input");

        assert_eq!(input.id, "json-skill");
        assert_eq!(input.scope, SkillScope::Workspace);
        assert_eq!(input.session_id.as_deref(), Some("Session::{XYZ}"));
        assert_eq!(input.enabled, Some(false));
    }

    #[test]
    fn serializes_skill_entry_for_ipc() {
        let json = serde_json::to_value(SkillEntry {
            id: "entry-skill".to_string(),
            name: "Entry Skill".to_string(),
            category: "Testing".to_string(),
            description: "Serialized entry".to_string(),
            scope: SkillScope::Global,
            enabled: true,
            updated_at: 42,
            path: "builtin://entry-skill".to_string(),
            read_only: true,
            content: None,
            version: None,
            required_capabilities: Vec::new(),
        })
        .expect("serialize entry");

        assert_eq!(json["updatedAt"], 42);
        assert_eq!(json["readOnly"], true);
        assert!(json.get("updated_at").is_none());
        assert!(json.get("read_only").is_none());
        assert!(json.get("content").is_none());
    }

    #[test]
    fn replaces_existing_skill_metadata_and_content() {
        let root = temp_root("skill-replace");
        apply_skill_at(
            &root,
            SkillApplyInput {
                id: "replace-skill".to_string(),
                name: Some("Replace Skill".to_string()),
                category: Some("Old".to_string()),
                description: Some("old description".to_string()),
                content: "# Old\n".to_string(),
                scope: SkillScope::Global,
                session_id: None,
                enabled: Some(false),
                required_capabilities: Vec::new(),
            },
        )
        .expect("apply first skill");

        apply_skill_at(
            &root,
            SkillApplyInput {
                id: "replace-skill".to_string(),
                name: Some("Replace Skill".to_string()),
                category: Some("New".to_string()),
                description: Some("new description".to_string()),
                content: "# New\n".to_string(),
                scope: SkillScope::Global,
                session_id: None,
                enabled: Some(true),
                required_capabilities: Vec::new(),
            },
        )
        .expect("replace skill");

        let fetched = get_skill_at(&root, "replace-skill", None, None).expect("get replacement");
        assert_eq!(fetched.category, "New");
        assert_eq!(fetched.description, "new description");
        assert!(fetched.enabled);
        assert_eq!(fetched.content.as_deref(), Some("# New\n"));
        assert!(fetched.path.ends_with(SKILL_FILE));
        cleanup_root(root);
    }

    #[test]
    fn enabled_skill_context_includes_active_custom_skills() {
        let root = temp_root("skill-context");
        apply_skill_at(
            &root,
            SkillApplyInput {
                id: "context-skill".to_string(),
                name: Some("Context Skill".to_string()),
                category: None,
                description: None,
                content: "# Context Skill\n\nAlways mention context.".to_string(),
                scope: SkillScope::Workspace,
                session_id: Some("Session::{CTX}".to_string()),
                enabled: Some(true),
                required_capabilities: vec!["orchestration.view".to_string()],
            },
        )
        .expect("apply context skill");
        apply_skill_at(
            &root,
            SkillApplyInput {
                id: "disabled-skill".to_string(),
                name: None,
                category: None,
                description: None,
                content: "# Disabled".to_string(),
                scope: SkillScope::Workspace,
                session_id: Some("Session::{CTX}".to_string()),
                enabled: Some(false),
                required_capabilities: Vec::new(),
            },
        )
        .expect("apply disabled skill");

        let context = enabled_skill_context_at(&root, Some("Session::{CTX}"))
            .expect("build context")
            .expect("context exists");
        assert!(!context.contains("disabled-skill"));
        assert!(
            !context.contains("context-skill"),
            "capability-gated skill must not be injected without a grant"
        );
        let granted = enabled_skill_context_with_capabilities_at(
            &root,
            Some("Session::{CTX}"),
            ["orchestration.view"],
        )
        .expect("build granted context")
        .expect("granted context exists");
        assert!(granted.contains("context-skill"));
        assert!(granted.contains("Always mention context."));
        cleanup_root(root);
    }

    #[test]
    fn augment_prompt_wraps_user_request_after_skills() {
        let root = temp_root("skill-augment");
        apply_skill_at(
            &root,
            SkillApplyInput {
                id: "global-context".to_string(),
                name: None,
                category: None,
                description: None,
                content: "# Global Context".to_string(),
                scope: SkillScope::Global,
                session_id: None,
                enabled: Some(true),
                required_capabilities: Vec::new(),
            },
        )
        .expect("apply global skill");
        let context = enabled_skill_context_at(&root, Some("Session::{CTX}"))
            .expect("build context")
            .expect("context exists");
        let prompt = format!(
            "{context}\n\n[VIBELINK_USER_REQUEST bytes=7]\nDo work\n[END_VIBELINK_USER_REQUEST]"
        );
        assert!(prompt.contains("# Global Context"));
        assert!(prompt.ends_with("[END_VIBELINK_USER_REQUEST]"));
        cleanup_root(root);
    }

    fn temp_root(prefix: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("vibelink-{prefix}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    fn cleanup_root(root: PathBuf) {
        let _ = fs::remove_dir_all(root);
    }
}
