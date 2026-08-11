use anyhow::{anyhow, Context, Result};
use directories::BaseDirs;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    borrow::Cow,
    fs,
    path::{Path, PathBuf},
};

pub const VIBELINK_MEMORY_SKILL_NAME: &str = "vibelink-memory";
pub const VIBELINK_BROWSER_SKILL_NAME: &str = "vibelink-browser";
pub const VIBELINK_SKILLS_REPOSITORY: &str = "JSCOP/vibelink-skills";
// Which skills the public repository serves is discovered at runtime by
// `published_skills_at`, not hardcoded here: a hardcoded list drifted once and
// told users to install `vibelink-browser` before it existed.
// Bump whenever any bundled SKILL.md changes: an installed copy whose SHA-256
// differs reads as `Stale`, and refresh rewrites that installed skill only.
// 6: the browser skill gained `new-tab`, the not-on-PATH warning, and the
// no-`--help` discovery rule.
pub const VIBELINK_SKILLS_REVISION: u32 = 6;

/// A skill VibeLink writes into an agent's own skills directory. The capability
/// itself lives in the daemon behind the `vibelink` CLI; these files only teach
/// an agent the contract, which is why adding one is a documentation change.
#[derive(Clone, Copy, Debug)]
struct BundledSkill {
    name: &'static str,
    markdown: &'static str,
}

const BUNDLED_SKILLS: [BundledSkill; 2] = [
    BundledSkill {
        name: VIBELINK_MEMORY_SKILL_NAME,
        markdown: include_str!("../../resources/skills/vibelink-memory/SKILL.md"),
    },
    BundledSkill {
        name: VIBELINK_BROWSER_SKILL_NAME,
        markdown: include_str!("../../resources/skills/vibelink-browser/SKILL.md"),
    },
];

const SKILL_FILE: &str = "SKILL.md";
const REVISION_FILE: &str = ".vibelink-revision";

// Source: the list printed by `skills add --agent <invalid>` in skills v1.5.20.
// Keep every spelling exact: one typo makes the entire CLI installation fail.
const SKILLS_CLI_AGENT_KEYS: [&str; 75] = [
    "aider-desk",
    "amp",
    "antigravity",
    "antigravity-cli",
    "astrbot",
    "autohand-code",
    "augment",
    "bob",
    "claude-code",
    "openclaw",
    "cline",
    "codearts-agent",
    "codebuddy",
    "codemaker",
    "codestudio",
    "codex",
    "command-code",
    "continue",
    "cortex",
    "crush",
    "cursor",
    "deepagents",
    "devin",
    "dexto",
    "droid",
    "eve",
    "firebender",
    "forgecode",
    "gemini-cli",
    "github-copilot",
    "goose",
    "grok",
    "hermes-agent",
    "inference-sh",
    "jazz",
    "junie",
    "iflow-cli",
    "kilo",
    "kimchi",
    "kimi-code-cli",
    "kiro-cli",
    "kode",
    "lingma",
    "loaf",
    "mcpjam",
    "mistral-vibe",
    "moxby",
    "mux",
    "opencode",
    "openhands",
    "ona",
    "pi",
    "qoder",
    "qoder-cn",
    "qwen-code",
    "replit",
    "reasonix",
    "rovodev",
    "roo",
    "tabnine-cli",
    "terramind",
    "tinycloud",
    "trae",
    "trae-cn",
    "warp",
    "windsurf",
    "zed",
    "zcode",
    "zencoder",
    "zenflow",
    "neovate",
    "pochi",
    "promptscript",
    "adal",
    "universal",
];

#[derive(Clone, Copy, Debug)]
struct InstallTarget {
    id: &'static str,
    label: &'static str,
    skills_relative: &'static str,
    agent_home_relative: &'static str,
}

const INSTALL_TARGETS: [InstallTarget; 10] = [
    InstallTarget {
        id: "agents",
        label: "shared (many agents)",
        skills_relative: ".agents/skills",
        agent_home_relative: ".agents",
    },
    InstallTarget {
        id: "claude",
        label: "Claude Code",
        skills_relative: ".claude/skills",
        agent_home_relative: ".claude",
    },
    InstallTarget {
        id: "codex",
        label: "Codex",
        skills_relative: ".codex/skills",
        agent_home_relative: ".codex",
    },
    InstallTarget {
        id: "omp",
        label: "Oh My Pi",
        skills_relative: ".omp/agent/skills",
        agent_home_relative: ".omp/agent",
    },
    InstallTarget {
        id: "pi",
        label: "Pi",
        skills_relative: ".pi/agent/skills",
        agent_home_relative: ".pi/agent",
    },
    InstallTarget {
        id: "cursor",
        label: "Cursor",
        skills_relative: ".cursor/skills",
        agent_home_relative: ".cursor",
    },
    InstallTarget {
        id: "gemini",
        label: "Gemini",
        skills_relative: ".gemini/skills",
        agent_home_relative: ".gemini",
    },
    InstallTarget {
        id: "antigravity",
        label: "Antigravity",
        skills_relative: ".gemini/antigravity/skills",
        agent_home_relative: ".gemini/antigravity",
    },
    InstallTarget {
        id: "opencode",
        label: "OpenCode",
        skills_relative: ".config/opencode/skills",
        agent_home_relative: ".config/opencode",
    },
    InstallTarget {
        id: "grok",
        label: "Grok",
        skills_relative: ".grok/skills",
        agent_home_relative: ".grok",
    },
];

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentSkillState {
    Installed,
    Stale,
    Missing,
    AgentAbsent,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillTargetSkill {
    pub name: String,
    pub state: AgentSkillState,
    pub installed_revision: Option<u32>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillTarget {
    pub id: String,
    pub label: String,
    pub path: String,
    pub state: AgentSkillState,
    pub skills: Vec<AgentSkillTargetSkill>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillStatus {
    pub skills: Vec<String>,
    pub revision: u32,
    pub targets: Vec<AgentSkillTarget>,
}

pub fn skill_status_at(home: &Path) -> Result<AgentSkillStatus> {
    let targets = INSTALL_TARGETS
        .iter()
        .map(|target| target_status(home, target))
        .collect::<Result<Vec<_>>>()?;

    Ok(AgentSkillStatus {
        skills: BUNDLED_SKILLS
            .iter()
            .map(|skill| skill.name.to_string())
            .collect(),
        revision: VIBELINK_SKILLS_REVISION,
        targets,
    })
}

pub fn skill_status() -> Result<AgentSkillStatus> {
    skill_status_at(&user_home()?)
}

pub fn install_skill_at(home: &Path, target_ids: &[String]) -> Result<AgentSkillStatus> {
    let targets = resolve_targets(target_ids)?;
    let mut failures = Vec::new();
    for target in targets {
        if let Err(error) = install_target_at(home, target) {
            failures.push(format!("{}: {error:#}", target.id));
        }
    }
    if !failures.is_empty() {
        return Err(anyhow!(
            "failed to install agent skills: {}",
            failures.join("; ")
        ));
    }
    skill_status_at(home)
}

pub fn install_skill(target_ids: &[String]) -> Result<AgentSkillStatus> {
    install_skill_at(&user_home()?, target_ids)
}

fn refresh_installed_skills_at(home: &Path) -> Result<AgentSkillStatus> {
    // Pull the published text FIRST, so the staleness comparison below is made
    // against what the skill should now say rather than what this build was
    // compiled with. A skill nobody has installed is never fetched: that keeps
    // the network work proportional to what the user actually uses, and it
    // keeps the per-skill consent rule intact.
    let status = skill_status_at(home)?;
    for skill in &BUNDLED_SKILLS {
        let installed_somewhere = status.targets.iter().any(|target| {
            target.skills.iter().any(|entry| {
                entry.name == skill.name
                    && entry.state != AgentSkillState::AgentAbsent
                    && entry.state != AgentSkillState::Missing
            })
        });
        if !installed_somewhere {
            continue;
        }
        if let Err(error) = super::agent_skills_remote::refresh(home, skill.name) {
            // Offline, unpublished, or rejected by validation: the bundled copy
            // stays authoritative and the user sees nothing break.
            tracing::debug!(
                ?error,
                skill_name = skill.name,
                "published agent skill unavailable"
            );
        }
    }
    let status = skill_status_at(home)?;
    for (target, target_status) in INSTALL_TARGETS.iter().zip(&status.targets) {
        for (skill, skill_status) in BUNDLED_SKILLS.iter().zip(&target_status.skills) {
            if skill_status.state != AgentSkillState::Stale {
                continue;
            }
            if let Err(error) = install_bundled_skill_at(home, target, skill) {
                tracing::warn!(
                    ?error,
                    target_id = target.id,
                    skill_name = skill.name,
                    "failed to refresh agent skill; continuing"
                );
            }
        }
    }
    skill_status_at(home)
}

pub fn refresh_installed_skills() -> Result<AgentSkillStatus> {
    refresh_installed_skills_at(&user_home()?)
}

/// A skill belongs in the emitted command only once the repository is PROVEN to
/// serve it, because `npx skills add --skill <name>` fails outright on a name
/// the repository does not have. A successful remote fetch is that proof, so
/// publishing `skills/<name>/SKILL.md` is the only step needed to add one — no
/// code change, and no way for this list to claim something that is not there.
fn published_skills_at(home: &Path) -> Vec<&'static str> {
    let confirmed: Vec<&'static str> = BUNDLED_SKILLS
        .iter()
        .map(|skill| skill.name)
        .filter(|name| super::agent_skills_remote::cached(home, name).is_some())
        .collect();
    if confirmed.is_empty() {
        // Nothing fetched yet (first run, or offline): fall back to the one
        // skill whose publication is known, rather than emitting a command with
        // no skills or a guessed one that would fail.
        return vec![VIBELINK_MEMORY_SKILL_NAME];
    }
    confirmed
}

pub fn skills_cli_install_command_at(home: &Path, agent_keys: &[String]) -> Result<String> {
    if agent_keys.is_empty() {
        return Err(anyhow!("at least one agent key is required"));
    }

    let mut unique_keys = Vec::new();
    for key in agent_keys {
        if !SKILLS_CLI_AGENT_KEYS.contains(&key.as_str()) {
            return Err(anyhow!("unknown skills CLI agent key: {key}"));
        }
        if !unique_keys.contains(&key.as_str()) {
            unique_keys.push(key.as_str());
        }
    }

    let mut command = format!("npx skills add {VIBELINK_SKILLS_REPOSITORY}");
    for skill in published_skills_at(home) {
        command.push_str(" --skill ");
        command.push_str(skill);
    }
    command.push_str(" --global");
    for key in unique_keys {
        command.push_str(" --agent ");
        command.push_str(key);
    }
    Ok(command)
}

pub fn skills_cli_install_command(agent_keys: &[String]) -> Result<String> {
    skills_cli_install_command_at(&user_home()?, agent_keys)
}

pub fn uninstall_skill_at(home: &Path, target_ids: &[String]) -> Result<AgentSkillStatus> {
    let targets = resolve_targets(target_ids)?;
    for target in targets {
        for skill in BUNDLED_SKILLS {
            let skill_dir = skill_dir(home, target, skill.name);
            if skill_dir.exists() {
                fs::remove_dir_all(&skill_dir).with_context(|| {
                    format!("remove agent skill directory {}", skill_dir.display())
                })?;
            }
        }
    }
    skill_status_at(home)
}

pub fn uninstall_skill(target_ids: &[String]) -> Result<AgentSkillStatus> {
    uninstall_skill_at(&user_home()?, target_ids)
}

#[tauri::command]
pub async fn agent_skill_status() -> Result<AgentSkillStatus, String> {
    tauri::async_runtime::spawn_blocking(skill_status)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn agent_skill_refresh() -> Result<AgentSkillStatus, String> {
    tauri::async_runtime::spawn_blocking(refresh_installed_skills)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn agent_skill_cli_command(agent_keys: Vec<String>) -> Result<String, String> {
    skills_cli_install_command(&agent_keys).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn agent_skill_install(target_ids: Vec<String>) -> Result<AgentSkillStatus, String> {
    tauri::async_runtime::spawn_blocking(move || install_skill(&target_ids))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn agent_skill_uninstall(target_ids: Vec<String>) -> Result<AgentSkillStatus, String> {
    tauri::async_runtime::spawn_blocking(move || uninstall_skill(&target_ids))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

fn target_status(home: &Path, target: &InstallTarget) -> Result<AgentSkillTarget> {
    let agent_present = home.join(target.agent_home_relative).is_dir();
    let skills = BUNDLED_SKILLS
        .iter()
        .map(|skill| target_skill_status(home, target, skill, agent_present))
        .collect::<Result<Vec<_>>>()?;
    let state = if skills
        .iter()
        .all(|skill| skill.state == AgentSkillState::AgentAbsent)
    {
        AgentSkillState::AgentAbsent
    } else if skills
        .iter()
        .all(|skill| skill.state == AgentSkillState::Installed)
    {
        AgentSkillState::Installed
    } else if skills
        .iter()
        .all(|skill| skill.state == AgentSkillState::Missing)
    {
        AgentSkillState::Missing
    } else {
        AgentSkillState::Stale
    };

    // The bundle writes several folders, so the honest location to show the user
    // is the skills root they own, not one skill's file.
    Ok(AgentSkillTarget {
        id: target.id.to_string(),
        label: target.label.to_string(),
        path: home
            .join(target.skills_relative)
            .to_string_lossy()
            .into_owned(),
        state,
        skills,
    })
}

fn target_skill_status(
    home: &Path,
    target: &InstallTarget,
    skill: &BundledSkill,
    agent_present: bool,
) -> Result<AgentSkillTargetSkill> {
    let skill_dir = skill_dir(home, target, skill.name);
    let skill_path = skill_dir.join(SKILL_FILE);
    let present = skill_path.is_file();
    let state = if !present {
        if agent_present {
            AgentSkillState::Missing
        } else {
            AgentSkillState::AgentAbsent
        }
    } else {
        let content = fs::read(&skill_path)
            .with_context(|| format!("read installed agent skill {}", skill_path.display()))?;
        if Sha256::digest(&content) == Sha256::digest(effective_markdown(home, skill).as_bytes()) {
            AgentSkillState::Installed
        } else {
            AgentSkillState::Stale
        }
    };
    let installed_revision = present
        .then(|| fs::read_to_string(skill_dir.join(REVISION_FILE)).ok())
        .flatten()
        .and_then(|revision| revision.trim().parse().ok());

    Ok(AgentSkillTargetSkill {
        name: skill.name.to_string(),
        state,
        installed_revision,
    })
}

fn install_target_at(home: &Path, target: &InstallTarget) -> Result<()> {
    let mut failures = Vec::new();
    for skill in &BUNDLED_SKILLS {
        if let Err(error) = install_bundled_skill_at(home, target, skill) {
            failures.push(format!("{}: {error:#}", skill.name));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(anyhow!("{}", failures.join("; ")))
    }
}

/// The text an installed copy should hold: the published document when one has
/// been cached, otherwise the copy baked into this build. Resolving it here is
/// what lets a wording fix reach agents without a new desktop release, and it
/// must be the SAME resolution `target_skill_status` compares against or a
/// remote update would read as permanently `Stale`.
fn effective_markdown(home: &Path, skill: &BundledSkill) -> Cow<'static, str> {
    match super::agent_skills_remote::cached(home, skill.name) {
        Some(published) => Cow::Owned(published),
        None => Cow::Borrowed(skill.markdown),
    }
}

fn install_bundled_skill_at(
    home: &Path,
    target: &InstallTarget,
    skill: &BundledSkill,
) -> Result<()> {
    let skill_dir = skill_dir(home, target, skill.name);
    crate::persistence::write_bytes_atomic(
        &skill_dir.join(SKILL_FILE),
        effective_markdown(home, skill).as_bytes(),
    )
    .with_context(|| format!("write agent skill {} for {}", skill.name, target.id))?;
    crate::persistence::write_bytes_atomic(
        &skill_dir.join(REVISION_FILE),
        format!("{VIBELINK_SKILLS_REVISION}\n").as_bytes(),
    )
    .with_context(|| format!("write agent skill revision for {}", target.id))?;
    Ok(())
}

fn resolve_targets(target_ids: &[String]) -> Result<Vec<&'static InstallTarget>> {
    target_ids
        .iter()
        .map(|id| {
            INSTALL_TARGETS
                .iter()
                .find(|target| target.id == id)
                .ok_or_else(|| anyhow!("unknown agent skill target id: {id}"))
        })
        .collect()
}

fn skill_dir(home: &Path, target: &InstallTarget, skill: &str) -> PathBuf {
    home.join(target.skills_relative).join(skill)
}

fn user_home() -> Result<PathBuf> {
    BaseDirs::new()
        .map(|dirs| dirs.home_dir().to_path_buf())
        .ok_or_else(|| anyhow!("unable to resolve user home directory"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_home_reports_every_agent_absent() {
        let root = temp_root("agent-skills-empty");
        let status = skill_status_at(&root).expect("read empty status");

        assert_eq!(
            status.skills,
            vec![
                VIBELINK_MEMORY_SKILL_NAME.to_string(),
                VIBELINK_BROWSER_SKILL_NAME.to_string()
            ]
        );
        assert_eq!(status.revision, VIBELINK_SKILLS_REVISION);
        assert_eq!(status.targets.len(), INSTALL_TARGETS.len());
        assert!(status.targets.iter().all(|target| {
            target.state == AgentSkillState::AgentAbsent
                && target
                    .skills
                    .iter()
                    .all(|skill| skill.state == AgentSkillState::AgentAbsent)
        }));
        cleanup_root(root);
    }

    #[test]
    fn existing_agent_home_reports_missing() {
        let root = temp_root("agent-skills-missing");
        fs::create_dir_all(root.join(".claude")).expect("create Claude home");

        let status = skill_status_at(&root).expect("read missing status");
        assert_eq!(target(&status, "claude").state, AgentSkillState::Missing);
        cleanup_root(root);
    }

    #[test]
    fn refresh_on_empty_home_does_not_create_agent_directories() {
        let root = temp_root("agent-skills-refresh-empty");
        let status = refresh_installed_skills_at(&root).expect("refresh empty home");

        assert!(status
            .targets
            .iter()
            .all(|target| target.state == AgentSkillState::AgentAbsent));
        assert_eq!(fs::read_dir(&root).expect("read root").count(), 0);
        cleanup_root(root);
    }

    #[test]
    fn refresh_does_not_install_missing_skill() {
        let root = temp_root("agent-skills-refresh-missing");
        fs::create_dir_all(root.join(".claude")).expect("create Claude home");

        let status = refresh_installed_skills_at(&root).expect("refresh missing skill");

        assert_eq!(target(&status, "claude").state, AgentSkillState::Missing);
        assert!(!root
            .join(".claude/skills")
            .join(VIBELINK_MEMORY_SKILL_NAME)
            .exists());
        cleanup_root(root);
    }

    #[test]
    fn refresh_replaces_stale_content() {
        let root = temp_root("agent-skills-refresh-stale");
        fs::create_dir_all(root.join(".claude")).expect("create Claude home");
        install_skill_at(&root, &["claude".to_string()]).expect("install skill");
        let skill_path = root
            .join(".claude/skills")
            .join(VIBELINK_MEMORY_SKILL_NAME)
            .join(SKILL_FILE);
        fs::write(&skill_path, "old bundled skill\n").expect("write stale skill");

        let status = refresh_installed_skills_at(&root).expect("refresh stale skill");

        assert_eq!(target(&status, "claude").state, AgentSkillState::Installed);
        assert_eq!(
            fs::read_to_string(skill_path).expect("read refreshed skill"),
            BUNDLED_SKILLS[0].markdown
        );
        cleanup_root(root);
    }

    /// The whole point of the remote path: a published wording fix must reach
    /// an agent home without rebuilding and reinstalling the desktop app.
    #[test]
    fn a_published_skill_overrides_the_bundled_copy() {
        let root = temp_root("agent-skills-published");
        fs::create_dir_all(root.join(".claude")).expect("create Claude home");
        install_skill_at(&root, &["claude".to_string()]).expect("install skill");

        let published = format!(
            "---\nname: {VIBELINK_MEMORY_SKILL_NAME}\ndescription: published\n---\n\n# Newer\n"
        );
        let cache = root
            .join(".vibelink/agent-skills-remote")
            .join(format!("{VIBELINK_MEMORY_SKILL_NAME}.md"));
        fs::create_dir_all(cache.parent().expect("cache parent")).expect("create cache dir");
        fs::write(&cache, &published).expect("cache published skill");

        // With a published document cached, the installed bundled copy is the
        // one that now reads as stale.
        let status = skill_status_at(&root).expect("status against published text");
        let memory = &target(&status, "claude").skills[0];
        assert_eq!(memory.name, VIBELINK_MEMORY_SKILL_NAME);
        assert_eq!(memory.state, AgentSkillState::Stale);

        let refreshed = refresh_installed_skills_at(&root).expect("refresh onto published text");
        assert_eq!(
            target(&refreshed, "claude").skills[0].state,
            AgentSkillState::Installed
        );
        let skill_path = root
            .join(".claude/skills")
            .join(VIBELINK_MEMORY_SKILL_NAME)
            .join(SKILL_FILE);
        assert_eq!(
            fs::read_to_string(&skill_path).expect("read refreshed skill"),
            published
        );

        // A corrupt cache must fall back to the bundled copy, never blank it.
        fs::write(&cache, "not a skill").expect("corrupt cache");
        refresh_installed_skills_at(&root).expect("refresh after cache corruption");
        assert_eq!(
            fs::read_to_string(&skill_path).expect("read fallback skill"),
            BUNDLED_SKILLS[0].markdown
        );
        cleanup_root(root);
    }

    #[test]
    fn refresh_leaves_current_install_untouched() {
        let root = temp_root("agent-skills-refresh-current");
        fs::create_dir_all(root.join(".claude")).expect("create Claude home");
        install_skill_at(&root, &["claude".to_string()]).expect("install skill");
        let skill_path = root
            .join(".claude/skills")
            .join(VIBELINK_MEMORY_SKILL_NAME)
            .join(SKILL_FILE);
        let before_content = fs::read(&skill_path).expect("read installed skill");
        let before_modified = fs::metadata(&skill_path)
            .expect("read installed metadata")
            .modified()
            .expect("read installed mtime");
        std::thread::sleep(std::time::Duration::from_millis(20));

        let status = refresh_installed_skills_at(&root).expect("refresh current skill");

        assert_eq!(target(&status, "claude").state, AgentSkillState::Installed);
        assert_eq!(
            fs::read(&skill_path).expect("reread installed skill"),
            before_content
        );
        assert_eq!(
            fs::metadata(&skill_path)
                .expect("reread installed metadata")
                .modified()
                .expect("reread installed mtime"),
            before_modified
        );
        cleanup_root(root);
    }

    #[test]
    fn refresh_continues_after_one_stale_target_fails() {
        let root = temp_root("agent-skills-refresh-partial");
        let claude_skill = installed_skill_path(&root, "claude", ".claude");
        let codex_skill = installed_skill_path(&root, "codex", ".codex");
        fs::write(&claude_skill, "old bundled skill\n").expect("stale Claude skill");
        fs::write(&codex_skill, "old bundled skill\n").expect("stale Codex skill");
        let blocked_temp = atomic_temp_path(&claude_skill);
        fs::create_dir(&blocked_temp).expect("block Claude atomic write");

        let status = refresh_installed_skills_at(&root).expect("refresh around failed target");

        assert_eq!(target(&status, "claude").state, AgentSkillState::Stale);
        assert_eq!(target(&status, "codex").state, AgentSkillState::Installed);
        fs::remove_dir(blocked_temp).expect("remove atomic-write blocker");
        cleanup_root(root);
    }

    #[test]
    fn skills_cli_agent_key_count_is_stable() {
        assert_eq!(SKILLS_CLI_AGENT_KEYS.len(), 75);
    }

    #[test]
    fn skills_cli_command_requires_known_agent_keys() {
        let empty = skills_cli_install_command(&[]).expect_err("empty keys should fail");
        assert!(empty.to_string().contains("at least one agent key"));

        let unknown = skills_cli_install_command(&["unknown-agent".to_string()])
            .expect_err("unknown key should fail");
        assert!(unknown.to_string().contains("unknown-agent"));
    }

    #[test]
    fn skills_cli_command_preserves_order_and_removes_duplicates() {
        // `_at` with a temp home, so the emitted skill list cannot depend on
        // whatever this machine happens to have cached.
        let root = temp_root("agent-skills-cli-order");
        let command = skills_cli_install_command_at(
            &root,
            &[
                "amp".to_string(),
                "claude-code".to_string(),
                "amp".to_string(),
            ],
        )
        .expect("build skills CLI command");

        assert_eq!(
            command,
            "npx skills add JSCOP/vibelink-skills --skill vibelink-memory --global --agent amp --agent claude-code"
        );
        cleanup_root(root);
    }

    /// Publishing `skills/<name>/SKILL.md` must be the ONLY step needed to add a
    /// skill to the install command. The previous hardcoded list named
    /// `vibelink-browser` before it existed upstream, which made the command it
    /// printed fail for every user who ran it.
    #[test]
    fn the_install_command_picks_up_a_skill_once_the_repository_serves_it() {
        let root = temp_root("agent-skills-cli-published");
        let cache = root.join(".vibelink/agent-skills-remote");
        fs::create_dir_all(&cache).expect("create cache dir");

        let before = skills_cli_install_command_at(&root, &["amp".to_string()])
            .expect("command before publication");
        assert!(!before.contains(VIBELINK_BROWSER_SKILL_NAME));

        for skill in &BUNDLED_SKILLS {
            fs::write(
                cache.join(format!("{}.md", skill.name)),
                format!(
                    "---\nname: {}\ndescription: published\n---\n\n# Body\n",
                    skill.name
                ),
            )
            .expect("cache published skill");
        }

        let after = skills_cli_install_command_at(&root, &["amp".to_string()])
            .expect("command after publication");
        assert_eq!(
            after,
            "npx skills add JSCOP/vibelink-skills --skill vibelink-memory --skill vibelink-browser --global --agent amp"
        );
        cleanup_root(root);
    }

    #[test]
    fn installs_shared_skill_on_an_empty_home() {
        let root = temp_root("agent-skills-install");
        let status = install_skill_at(&root, &["agents".to_string()]).expect("install skill");
        let installed = target(&status, "agents");

        assert_eq!(installed.state, AgentSkillState::Installed);
        assert!(installed.skills.iter().all(|skill| {
            skill.state == AgentSkillState::Installed
                && skill.installed_revision == Some(VIBELINK_SKILLS_REVISION)
        }));
        assert!(status
            .targets
            .iter()
            .filter(|target| target.id != "agents")
            .all(|target| target.state == AgentSkillState::AgentAbsent));
        cleanup_root(root);
    }

    #[test]
    fn invalid_or_missing_revision_reports_none() {
        let root = temp_root("agent-skills-revision");
        let ids = ["agents".to_string()];
        install_skill_at(&root, &ids).expect("install skill");
        let revision_path = root
            .join(".agents/skills")
            .join(VIBELINK_MEMORY_SKILL_NAME)
            .join(REVISION_FILE);

        fs::write(&revision_path, "not-a-number\n").expect("write invalid revision");
        let invalid = skill_status_at(&root).expect("read invalid revision status");
        assert_eq!(
            target_skill(&invalid, "agents", VIBELINK_MEMORY_SKILL_NAME).installed_revision,
            None
        );

        fs::remove_file(revision_path).expect("remove revision");
        let missing = skill_status_at(&root).expect("read missing revision status");
        assert_eq!(
            target_skill(&missing, "agents", VIBELINK_MEMORY_SKILL_NAME).installed_revision,
            None
        );
        cleanup_root(root);
    }

    #[test]
    fn reinstall_replaces_stale_content() {
        let root = temp_root("agent-skills-reinstall");
        let ids = ["agents".to_string()];
        install_skill_at(&root, &ids).expect("install skill");
        let skill_path = root
            .join(".agents/skills")
            .join(VIBELINK_MEMORY_SKILL_NAME)
            .join(SKILL_FILE);
        fs::write(&skill_path, "changed by hand\n").expect("change installed skill");

        let stale = skill_status_at(&root).expect("read stale status");
        assert_eq!(target(&stale, "agents").state, AgentSkillState::Stale);

        let reinstalled = install_skill_at(&root, &ids).expect("reinstall skill");
        assert_eq!(
            target(&reinstalled, "agents").state,
            AgentSkillState::Installed
        );
        assert_eq!(
            fs::read_to_string(skill_path).expect("read reinstalled skill"),
            BUNDLED_SKILLS[0].markdown
        );
        cleanup_root(root);
    }

    #[test]
    fn uninstall_keeps_sibling_skills() {
        let root = temp_root("agent-skills-uninstall");
        let sibling = root.join(".agents/skills/other-skill/SKILL.md");
        fs::create_dir_all(sibling.parent().expect("sibling parent"))
            .expect("create sibling skill");
        fs::write(&sibling, "# Other skill\n").expect("write sibling skill");
        let ids = ["agents".to_string()];
        install_skill_at(&root, &ids).expect("install skill");

        let status = uninstall_skill_at(&root, &ids).expect("uninstall skill");
        assert_eq!(target(&status, "agents").state, AgentSkillState::Missing);
        assert!(!root
            .join(".agents/skills")
            .join(VIBELINK_MEMORY_SKILL_NAME)
            .exists());
        assert!(sibling.is_file());
        cleanup_root(root);
    }

    #[test]
    fn unknown_target_error_names_the_id_without_writing() {
        let root = temp_root("agent-skills-unknown");
        let error = install_skill_at(&root, &["unknown-agent".to_string()])
            .expect_err("unknown target should fail");

        assert!(error.to_string().contains("unknown-agent"));
        assert_eq!(fs::read_dir(&root).expect("read root").count(), 0);
        cleanup_root(root);
    }

    #[test]
    fn install_collects_target_errors_and_continues_with_later_targets() {
        let root = temp_root("agent-skills-install-errors");
        for skills_root in [".claude/skills", ".agents/skills"] {
            let skills_root = root.join(skills_root);
            fs::create_dir_all(&skills_root).expect("create blocked skills root");
            fs::write(
                skills_root.join(VIBELINK_MEMORY_SKILL_NAME),
                "not a directory\n",
            )
            .expect("block bundled skill directory");
        }

        let error = install_skill_at(
            &root,
            &[
                "claude".to_string(),
                "agents".to_string(),
                "codex".to_string(),
            ],
        )
        .expect_err("blocked targets should be reported");

        let message = error.to_string();
        assert!(message.contains("claude"));
        assert!(message.contains("agents"));
        for skill in BUNDLED_SKILLS {
            assert!(root
                .join(".codex/skills")
                .join(skill.name)
                .join(SKILL_FILE)
                .is_file());
        }
        cleanup_root(root);
    }

    #[test]
    fn failed_atomic_write_keeps_the_installed_skill_intact() {
        let root = temp_root("agent-skills-atomic-write");
        let ids = ["agents".to_string()];
        install_skill_at(&root, &ids).expect("install skill");
        let skill_path = root
            .join(".agents/skills")
            .join(VIBELINK_MEMORY_SKILL_NAME)
            .join(SKILL_FILE);
        let before = fs::read(&skill_path).expect("read installed skill");
        let blocked_temp = atomic_temp_path(&skill_path);
        fs::create_dir(&blocked_temp).expect("block atomic temp file");

        install_skill_at(&root, &ids).expect_err("blocked atomic write should fail");

        assert_eq!(
            fs::read(&skill_path).expect("reread installed skill"),
            before
        );
        fs::remove_dir(blocked_temp).expect("remove atomic-write blocker");
        cleanup_root(root);
    }

    fn target<'a>(status: &'a AgentSkillStatus, id: &str) -> &'a AgentSkillTarget {
        status
            .targets
            .iter()
            .find(|target| target.id == id)
            .expect("target exists")
    }

    fn target_skill<'a>(
        status: &'a AgentSkillStatus,
        target_id: &str,
        skill_name: &str,
    ) -> &'a AgentSkillTargetSkill {
        target(status, target_id)
            .skills
            .iter()
            .find(|skill| skill.name == skill_name)
            .expect("target skill exists")
    }

    fn installed_skill_path(root: &Path, target_id: &str, agent_home: &str) -> PathBuf {
        fs::create_dir_all(root.join(agent_home)).expect("create agent home");
        install_skill_at(root, &[target_id.to_string()]).expect("install skill");
        root.join(agent_home)
            .join("skills")
            .join(VIBELINK_MEMORY_SKILL_NAME)
            .join(SKILL_FILE)
    }

    fn atomic_temp_path(path: &Path) -> PathBuf {
        let mut value = path.as_os_str().to_os_string();
        value.push(".tmp");
        PathBuf::from(value)
    }

    #[test]
    fn install_writes_every_bundled_skill() {
        let root = temp_root("agent-skills-bundle");
        fs::create_dir_all(root.join(".claude")).expect("create Claude home");
        install_skill_at(&root, &["claude".to_string()]).expect("install bundle");

        for skill in BUNDLED_SKILLS {
            let path = root
                .join(".claude/skills")
                .join(skill.name)
                .join(SKILL_FILE);
            assert_eq!(
                fs::read_to_string(&path).unwrap_or_else(|_| panic!("read {}", path.display())),
                skill.markdown
            );
        }
        cleanup_root(root);
    }

    #[test]
    fn partial_bundle_refreshes_present_skills_without_installing_missing_ones() {
        let root = temp_root("agent-skills-partial");
        fs::create_dir_all(root.join(".claude")).expect("create Claude home");
        install_skill_at(&root, &["claude".to_string()]).expect("install bundle");
        fs::remove_dir_all(
            root.join(".claude/skills")
                .join(VIBELINK_BROWSER_SKILL_NAME),
        )
        .expect("remove one bundled skill");
        let memory_path = root
            .join(".claude/skills")
            .join(VIBELINK_MEMORY_SKILL_NAME)
            .join(SKILL_FILE);
        fs::write(&memory_path, "old bundled skill\n").expect("stale installed skill");

        let status = skill_status_at(&root).expect("read partial status");
        assert_eq!(target(&status, "claude").state, AgentSkillState::Stale);
        assert_eq!(
            target_skill(&status, "claude", VIBELINK_MEMORY_SKILL_NAME).state,
            AgentSkillState::Stale
        );
        assert_eq!(
            target_skill(&status, "claude", VIBELINK_BROWSER_SKILL_NAME).state,
            AgentSkillState::Missing
        );

        let refreshed = refresh_installed_skills_at(&root).expect("refresh partial bundle");
        assert_eq!(target(&refreshed, "claude").state, AgentSkillState::Stale);
        assert_eq!(
            target_skill(&refreshed, "claude", VIBELINK_MEMORY_SKILL_NAME).state,
            AgentSkillState::Installed
        );
        assert_eq!(
            target_skill(&refreshed, "claude", VIBELINK_BROWSER_SKILL_NAME).state,
            AgentSkillState::Missing
        );
        assert!(!root
            .join(".claude/skills")
            .join(VIBELINK_BROWSER_SKILL_NAME)
            .exists());
        cleanup_root(root);
    }

    /// The installed skill is the only thing an agent reads before acting, so a
    /// contract it no longer describes is worse than no skill at all.
    #[test]
    fn the_browser_skill_describes_the_shipped_contract() {
        let markdown = BUNDLED_SKILLS
            .iter()
            .find(|skill| skill.name == VIBELINK_BROWSER_SKILL_NAME)
            .expect("browser skill is bundled")
            .markdown;
        for token in [
            "--ref eN",
            "stale_ref",
            "browser wait --for load|selector|no-selector|url|idle",
            "browser chrome --install --grant browser.cookies",
            "browser chrome --unpair --grant browser.cookies",
            "browser chrome --copy-profile --confirm --grant browser.cookies",
            "VIBELINK_CLI_EXE",
            // The three dead ends that cost a real agent three minutes: a bare
            // `vibelink` is not on PATH, there is no `--help`, and without
            // `new-tab` it shelled out to chrome.exe and lost the tab.
            "`vibelink` is not on PATH",
            "browser new-tab --url",
            "no action to get its action list",
        ] {
            assert!(markdown.contains(token), "browser skill lost `{token}`");
        }
        // Status is a plain report; only the profile-touching switches are gated.
        assert!(
            !markdown.contains("browser chrome --grant browser.cookies"),
            "browser skill still tells agents to pay a cookies grant for a status read"
        );
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
