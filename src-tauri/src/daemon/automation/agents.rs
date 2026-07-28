//! Headless agent catalog for scheduled automations.
//!
//! Every automation names one agent CLI. The catalog owns that agent's identity,
//! the binaries used to resolve it on PATH, and the exact non-interactive argv
//! used to run one unattended prompt. Nothing here launches a TUI: each spec is
//! the CLI's documented print/exec mode so a run terminates on its own.

use std::path::{Path, PathBuf};

/// How the prompt reaches the agent process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptDelivery {
    /// Prompt is one positional argv entry.
    Argv,
    /// Prompt is written to the child's stdin and the pipe is closed.
    Stdin,
}

/// Where the agent's per-run model override goes, when the automation pins one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelFlag {
    /// `--model <value>`; provider is folded into the value when present.
    Model,
    /// `--model <provider/value>`; opencode requires the provider prefix.
    ProviderQualifiedModel,
}

#[derive(Clone, Copy, Debug)]
pub struct AgentSpec {
    /// Stable identifier persisted on the automation record.
    pub id: &'static str,
    /// User-facing label.
    pub display_name: &'static str,
    /// PATH candidates, in preference order.
    pub binaries: &'static [&'static str],
    /// Argv placed before the prompt to select the CLI's headless mode.
    pub headless_args: &'static [&'static str],
    /// Argv placed after the prompt (sandbox/approval opt-outs).
    pub unattended_args: &'static [&'static str],
    pub prompt_delivery: PromptDelivery,
    pub model_flag: ModelFlag,
    /// Env var carrying the per-run iteration cap, when the CLI honours one.
    pub max_turns_env: Option<&'static str>,
    /// True when the CLI reads Hermes-specific toolset/skill/usage flags.
    pub supports_hermes_extensions: bool,
}

/// Ordered so the default (`hermes`) stays first and matches the panel listing.
pub const AGENT_SPECS: &[AgentSpec] = &[
    AgentSpec {
        id: "hermes",
        display_name: "Hermes",
        binaries: &["hermes"],
        headless_args: &["--oneshot"],
        unattended_args: &["--accept-hooks", "--yolo"],
        prompt_delivery: PromptDelivery::Argv,
        model_flag: ModelFlag::Model,
        max_turns_env: Some("HERMES_MAX_ITERATIONS"),
        supports_hermes_extensions: true,
    },
    AgentSpec {
        id: "omp",
        display_name: "Oh My Pi",
        binaries: &["omp"],
        headless_args: &["--print"],
        unattended_args: &["--auto-approve", "--no-session"],
        prompt_delivery: PromptDelivery::Argv,
        model_flag: ModelFlag::Model,
        max_turns_env: None,
        supports_hermes_extensions: false,
    },
    AgentSpec {
        id: "claude",
        display_name: "Claude Code",
        binaries: &["claude"],
        headless_args: &["--print"],
        unattended_args: &["--permission-mode", "bypassPermissions"],
        prompt_delivery: PromptDelivery::Argv,
        model_flag: ModelFlag::Model,
        max_turns_env: None,
        supports_hermes_extensions: false,
    },
    AgentSpec {
        id: "codex",
        display_name: "Codex",
        binaries: &["codex"],
        headless_args: &["exec", "--skip-git-repo-check", "--color", "never"],
        unattended_args: &["--dangerously-bypass-approvals-and-sandbox"],
        prompt_delivery: PromptDelivery::Argv,
        model_flag: ModelFlag::Model,
        max_turns_env: None,
        supports_hermes_extensions: false,
    },
    AgentSpec {
        id: "opencode",
        display_name: "OpenCode",
        binaries: &["opencode"],
        headless_args: &["run"],
        unattended_args: &["--auto"],
        // Why: opencode's positional message is split into an array, so a
        // multi-line prompt is safest over stdin.
        prompt_delivery: PromptDelivery::Stdin,
        model_flag: ModelFlag::ProviderQualifiedModel,
        max_turns_env: None,
        supports_hermes_extensions: false,
    },
];

pub const DEFAULT_AGENT_ID: &str = "hermes";

pub fn spec(agent_id: &str) -> Option<&'static AgentSpec> {
    AGENT_SPECS.iter().find(|spec| spec.id == agent_id)
}

pub fn is_supported(agent_id: &str) -> bool {
    spec(agent_id).is_some()
}

pub fn supported_ids() -> Vec<&'static str> {
    AGENT_SPECS.iter().map(|spec| spec.id).collect()
}

impl AgentSpec {
    /// The model argument value for this agent, or `None` when the automation
    /// pins no model. `provider` is only meaningful for opencode's
    /// `provider/model` form; other CLIs resolve the provider from their own
    /// configuration.
    pub fn model_argument(&self, provider: Option<&str>, model: Option<&str>) -> Option<String> {
        let model = model.map(str::trim).filter(|value| !value.is_empty())?;
        match self.model_flag {
            ModelFlag::Model => Some(model.to_string()),
            ModelFlag::ProviderQualifiedModel => {
                let provider = provider.map(str::trim).filter(|value| !value.is_empty());
                match provider {
                    Some(provider) if !model.contains('/') => Some(format!("{provider}/{model}")),
                    _ => Some(model.to_string()),
                }
            }
        }
    }

    /// Resolve this agent's executable using the supplied PATH resolver.
    pub fn resolve(&self, resolve: impl Fn(&Path) -> Option<PathBuf>) -> Option<PathBuf> {
        self.binaries
            .iter()
            .find_map(|binary| resolve(Path::new(binary)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_spec_runs_headless_and_has_unique_identity() {
        let mut seen = Vec::new();
        for spec in AGENT_SPECS {
            assert!(
                !seen.contains(&spec.id),
                "duplicate automation agent id {}",
                spec.id
            );
            seen.push(spec.id);
            assert!(
                !spec.binaries.is_empty(),
                "agent {} has no PATH candidates",
                spec.id
            );
            // Why: a spec with no headless argv would launch the CLI's
            // interactive TUI and hang the unattended run until its timeout.
            assert!(
                !spec.headless_args.is_empty(),
                "agent {} has no headless argv",
                spec.id
            );
        }
        assert_eq!(seen.first().copied(), Some(DEFAULT_AGENT_ID));
    }

    #[test]
    fn only_hermes_receives_hermes_specific_flags() {
        for spec in AGENT_SPECS {
            assert_eq!(
                spec.supports_hermes_extensions,
                spec.id == "hermes",
                "agent {} has an unexpected Hermes extension setting",
                spec.id
            );
        }
    }

    #[test]
    fn opencode_qualifies_the_model_with_its_provider() {
        let opencode = spec("opencode").expect("opencode spec");
        assert_eq!(
            opencode.model_argument(Some("anthropic"), Some("claude-sonnet-4")),
            Some("anthropic/claude-sonnet-4".to_string())
        );
        assert_eq!(
            opencode.model_argument(Some("anthropic"), Some("openai/gpt-5")),
            Some("openai/gpt-5".to_string())
        );
        assert_eq!(opencode.model_argument(Some("anthropic"), None), None);
    }

    #[test]
    fn other_agents_forward_the_bare_model() {
        let claude = spec("claude").expect("claude spec");
        assert_eq!(
            claude.model_argument(Some("anthropic"), Some(" sonnet ")),
            Some("sonnet".to_string())
        );
        assert_eq!(claude.model_argument(None, Some("   ")), None);
    }

    #[test]
    fn unsupported_agents_are_rejected() {
        assert!(is_supported("hermes"));
        assert!(is_supported("opencode"));
        assert!(!is_supported("openclaw"));
        assert_eq!(
            supported_ids(),
            vec!["hermes", "omp", "claude", "codex", "opencode"]
        );
    }
}
