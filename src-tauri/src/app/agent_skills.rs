use anyhow::{anyhow, Context, Result};
use directories::BaseDirs;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const VIBELINK_MEMORY_SKILL_NAME: &str = "vibelink-memory";
pub const VIBELINK_MEMORY_SKILL_REVISION: u32 = 1;
pub const VIBELINK_MEMORY_SKILL_MARKDOWN: &str =
    include_str!("../../resources/skills/vibelink-memory/SKILL.md");

const SKILL_FILE: &str = "SKILL.md";
const REVISION_FILE: &str = ".vibelink-revision";

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
    pub skill: String,
    pub revision: u32,
    pub targets: Vec<AgentSkillTarget>,
}

pub fn skill_status_at(home: &Path) -> Result<AgentSkillStatus> {
    let targets = INSTALL_TARGETS
        .iter()
        .map(|target| target_status(home, target))
        .collect::<Result<Vec<_>>>()?;

    Ok(AgentSkillStatus {
        skill: VIBELINK_MEMORY_SKILL_NAME.to_string(),
        revision: VIBELINK_MEMORY_SKILL_REVISION,
        targets,
    })
}

pub fn skill_status() -> Result<AgentSkillStatus> {
    skill_status_at(&user_home()?)
}

pub fn install_skill_at(home: &Path, target_ids: &[String]) -> Result<AgentSkillStatus> {
    let targets = resolve_targets(target_ids)?;
    for target in targets {
        let skill_dir = skill_dir(home, target);
        fs::create_dir_all(&skill_dir)
            .with_context(|| format!("create agent skill directory {}", skill_dir.display()))?;
        fs::write(skill_dir.join(SKILL_FILE), VIBELINK_MEMORY_SKILL_MARKDOWN)
            .with_context(|| format!("write agent skill for {}", target.id))?;
        fs::write(
            skill_dir.join(REVISION_FILE),
            format!("{VIBELINK_MEMORY_SKILL_REVISION}\n"),
        )
        .with_context(|| format!("write agent skill revision for {}", target.id))?;
    }
    skill_status_at(home)
}

pub fn install_skill(target_ids: &[String]) -> Result<AgentSkillStatus> {
    install_skill_at(&user_home()?, target_ids)
}

pub fn uninstall_skill_at(home: &Path, target_ids: &[String]) -> Result<AgentSkillStatus> {
    let targets = resolve_targets(target_ids)?;
    for target in targets {
        let skill_dir = skill_dir(home, target);
        if skill_dir.exists() {
            fs::remove_dir_all(&skill_dir)
                .with_context(|| format!("remove agent skill directory {}", skill_dir.display()))?;
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
    let skill_dir = skill_dir(home, target);
    let skill_path = skill_dir.join(SKILL_FILE);
    let installed = skill_path.is_file();
    let state = if installed {
        let content = fs::read(&skill_path)
            .with_context(|| format!("read installed agent skill {}", skill_path.display()))?;
        if Sha256::digest(&content) == Sha256::digest(VIBELINK_MEMORY_SKILL_MARKDOWN.as_bytes()) {
            AgentSkillState::Installed
        } else {
            AgentSkillState::Stale
        }
    } else if home.join(target.agent_home_relative).is_dir() {
        AgentSkillState::Missing
    } else {
        AgentSkillState::AgentAbsent
    };
    let installed_revision = installed
        .then(|| fs::read_to_string(skill_dir.join(REVISION_FILE)).ok())
        .flatten()
        .and_then(|revision| revision.trim().parse().ok());

    Ok(AgentSkillTarget {
        id: target.id.to_string(),
        label: target.label.to_string(),
        path: skill_path.to_string_lossy().into_owned(),
        state,
        installed_revision,
    })
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

fn skill_dir(home: &Path, target: &InstallTarget) -> PathBuf {
    home.join(target.skills_relative)
        .join(VIBELINK_MEMORY_SKILL_NAME)
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

        assert_eq!(status.skill, VIBELINK_MEMORY_SKILL_NAME);
        assert_eq!(status.revision, VIBELINK_MEMORY_SKILL_REVISION);
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
    fn installs_shared_skill_on_an_empty_home() {
        let root = temp_root("agent-skills-install");
        let status = install_skill_at(&root, &["agents".to_string()]).expect("install skill");
        let installed = target(&status, "agents");

        assert_eq!(installed.state, AgentSkillState::Installed);
        assert_eq!(
            installed.installed_revision,
            Some(VIBELINK_MEMORY_SKILL_REVISION)
        );
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
            VIBELINK_MEMORY_SKILL_MARKDOWN
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

    fn temp_root(prefix: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("vibelink-{prefix}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    fn cleanup_root(root: PathBuf) {
        let _ = fs::remove_dir_all(root);
    }
}
