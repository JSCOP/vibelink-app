use anyhow::{anyhow, Context, Result};
use directories::BaseDirs;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const VIBELINK_MEMORY_SKILL_NAME: &str = "vibelink-memory";
pub const VIBELINK_BROWSER_SKILL_NAME: &str = "vibelink-browser";
pub const VIBELINK_SKILLS_REPOSITORY: &str = "JSCOP/vibelink-skills";
// Bump whenever any bundled SKILL.md changes: an installed copy whose SHA-256
// differs from the built-in one reads as `Stale`, and refresh then rewrites it.
pub const VIBELINK_SKILLS_REVISION: u32 = 3;

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
pub struct AgentSkillTarget {
    pub id: String,
    pub label: String,
    pub path: String,
    pub state: AgentSkillState,
    pub installed_revision: Option<u32>,
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
    for target in targets {
        install_target_at(home, target)?;
    }
    skill_status_at(home)
}

pub fn install_skill(target_ids: &[String]) -> Result<AgentSkillStatus> {
    install_skill_at(&user_home()?, target_ids)
}

fn refresh_installed_skills_at(home: &Path) -> Result<AgentSkillStatus> {
    let status = skill_status_at(home)?;
    for (target, target_status) in INSTALL_TARGETS.iter().zip(&status.targets) {
        if target_status.state == AgentSkillState::Stale {
            if let Err(error) = install_target_at(home, target) {
                tracing::warn!(
                    ?error,
                    target_id = target.id,
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

pub fn skills_cli_install_command(agent_keys: &[String]) -> Result<String> {
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
    for skill in BUNDLED_SKILLS {
        command.push_str(" --skill ");
        command.push_str(skill.name);
    }
    command.push_str(" --global");
    for key in unique_keys {
        command.push_str(" --agent ");
        command.push_str(key);
    }
    Ok(command)
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
    // The bundle is one unit: a target that carries an older or partial set is
    // `Stale`, so refresh rewrites every skill instead of leaving a gap the user
    // cannot see.
    let mut present = 0usize;
    let mut current = 0usize;
    for skill in BUNDLED_SKILLS {
        let skill_path = skill_dir(home, target, skill.name).join(SKILL_FILE);
        if !skill_path.is_file() {
            continue;
        }
        present += 1;
        let content = fs::read(&skill_path)
            .with_context(|| format!("read installed agent skill {}", skill_path.display()))?;
        if Sha256::digest(&content) == Sha256::digest(skill.markdown.as_bytes()) {
            current += 1;
        }
    }
    let state = if present == 0 {
        if home.join(target.agent_home_relative).is_dir() {
            AgentSkillState::Missing
        } else {
            AgentSkillState::AgentAbsent
        }
    } else if current == BUNDLED_SKILLS.len() {
        AgentSkillState::Installed
    } else {
        AgentSkillState::Stale
    };
    // Deterministically the first bundled skill's marker: falling through to a
    // sibling would report a revision the corrupt copy does not have.
    let installed_revision = (present > 0)
        .then(|| {
            fs::read_to_string(skill_dir(home, target, BUNDLED_SKILLS[0].name).join(REVISION_FILE))
                .ok()
        })
        .flatten()
        .and_then(|revision| revision.trim().parse().ok());

    let skill_path = skill_dir(home, target, BUNDLED_SKILLS[0].name).join(SKILL_FILE);

    Ok(AgentSkillTarget {
        id: target.id.to_string(),
        label: target.label.to_string(),
        path: skill_path.to_string_lossy().into_owned(),
        state,
        installed_revision,
    })
}

fn install_target_at(home: &Path, target: &InstallTarget) -> Result<()> {
    for skill in BUNDLED_SKILLS {
        let skill_dir = skill_dir(home, target, skill.name);
        fs::create_dir_all(&skill_dir)
            .with_context(|| format!("create agent skill directory {}", skill_dir.display()))?;
        fs::write(skill_dir.join(SKILL_FILE), skill.markdown)
            .with_context(|| format!("write agent skill {} for {}", skill.name, target.id))?;
        fs::write(
            skill_dir.join(REVISION_FILE),
            format!("{VIBELINK_SKILLS_REVISION}\n"),
        )
        .with_context(|| format!("write agent skill revision for {}", target.id))?;
    }
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
        assert!(status
            .targets
            .iter()
            .all(|target| target.state == AgentSkillState::AgentAbsent));
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
        let mut permissions = fs::metadata(&claude_skill)
            .expect("read Claude permissions")
            .permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&claude_skill, permissions).expect("lock Claude skill");

        let status = refresh_installed_skills_at(&root).expect("refresh around failed target");

        assert_eq!(target(&status, "claude").state, AgentSkillState::Stale);
        assert_eq!(target(&status, "codex").state, AgentSkillState::Installed);
        // Unlock so `cleanup_root` can delete it on Windows, where a read-only
        // file blocks `remove_dir_all`. The world-writable concern the lint
        // raises does not apply to a temp file that is removed on the next line.
        #[allow(clippy::permissions_set_readonly_false)]
        {
            let mut permissions = fs::metadata(&claude_skill)
                .expect("reread Claude permissions")
                .permissions();
            permissions.set_readonly(false);
            fs::set_permissions(&claude_skill, permissions).expect("unlock Claude skill");
        }
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
        let command = skills_cli_install_command(&[
            "amp".to_string(),
            "claude-code".to_string(),
            "amp".to_string(),
        ])
        .expect("build skills CLI command");

        assert_eq!(
            command,
            "npx skills add JSCOP/vibelink-skills --skill vibelink-memory --skill vibelink-browser --global --agent amp --agent claude-code"
        );
    }

    #[test]
    fn installs_shared_skill_on_an_empty_home() {
        let root = temp_root("agent-skills-install");
        let status = install_skill_at(&root, &["agents".to_string()]).expect("install skill");
        let installed = target(&status, "agents");

        assert_eq!(installed.state, AgentSkillState::Installed);
        assert_eq!(installed.installed_revision, Some(VIBELINK_SKILLS_REVISION));
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
        assert_eq!(target(&invalid, "agents").installed_revision, None);

        fs::remove_file(revision_path).expect("remove revision");
        let missing = skill_status_at(&root).expect("read missing revision status");
        assert_eq!(target(&missing, "agents").installed_revision, None);
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

    fn target<'a>(status: &'a AgentSkillStatus, id: &str) -> &'a AgentSkillTarget {
        status
            .targets
            .iter()
            .find(|target| target.id == id)
            .expect("target exists")
    }

    fn installed_skill_path(root: &Path, target_id: &str, agent_home: &str) -> PathBuf {
        fs::create_dir_all(root.join(agent_home)).expect("create agent home");
        install_skill_at(root, &[target_id.to_string()]).expect("install skill");
        root.join(agent_home)
            .join("skills")
            .join(VIBELINK_MEMORY_SKILL_NAME)
            .join(SKILL_FILE)
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
    fn a_partial_bundle_reads_as_stale() {
        let root = temp_root("agent-skills-partial");
        fs::create_dir_all(root.join(".claude")).expect("create Claude home");
        install_skill_at(&root, &["claude".to_string()]).expect("install bundle");
        fs::remove_dir_all(
            root.join(".claude/skills")
                .join(VIBELINK_BROWSER_SKILL_NAME),
        )
        .expect("remove one bundled skill");

        let status = skill_status_at(&root).expect("read partial status");
        assert_eq!(target(&status, "claude").state, AgentSkillState::Stale);

        let refreshed = refresh_installed_skills_at(&root).expect("refresh partial bundle");
        assert_eq!(
            target(&refreshed, "claude").state,
            AgentSkillState::Installed
        );
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
            "VIBELINK_CLI_EXE",
        ] {
            assert!(markdown.contains(token), "browser skill lost `{token}`");
        }
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
