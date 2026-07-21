pub mod browser_cdp;
pub mod builtin_skills;
pub mod client;
pub mod command;
pub mod contract;
pub mod error;
pub mod output;
pub mod runner;
pub mod selector;

pub use builtin_skills::{
    builtin_skill, builtin_skills, resolve_skill_precedence, BuiltinSkillDefinition, SkillContent,
    SkillSource, BUILTIN_SKILL_VERSION,
};
pub use client::{socket_name_for_user, ControlSocketClient, ControlSocketConfig, Flavor};
pub use command::{
    parse_args, ActionCommand, AutomationAction, BrowserAction, Command, ComputerAction,
    Invocation, McpAction, OperationArguments, OrchestrationAction, RemoteAction, SelectorSet,
    SkillAction, TerminalAction, WorkspaceAction, COMMAND_SCHEMA_VERSION,
};
pub use contract::{
    command_contracts, contract_for_command, find_contract, CommandContract, OptionSpec, RiskLevel,
    ValueKind,
};
pub use error::{CliError, ErrorCode};
pub use output::{
    ErrorEnvelope, OutputStreams, StderrKeepalive, SuccessEnvelope, ENVELOPE_VERSION,
};
pub use runner::{run_with_io, CliControlRequest, ControlExecutor, McpRunner, SocketExecutor};
pub use selector::{resolve_selector, SelectorCandidate};
