pub use super::payload::{apply_patch, parse_create};
#[cfg(test)]
pub use super::types::AutomationPrecheck;
pub use super::types::{
    is_active_status, is_final_status, read_automation, read_run, AutomationOutputSnapshot,
    AutomationPrecheckResult, AutomationRecord, AutomationRunRecord, AutomationRuntimeIdentity,
};
