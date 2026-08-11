use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fmt;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidArguments,
    UnavailableRuntime,
    NotFound,
    StaleTarget,
    /// A snapshot ref that no longer names the element it was issued for. Kept
    /// distinct from `StaleTarget` so an agent knows to re-snapshot the page
    /// rather than re-resolve the target.
    StaleRef,
    #[serde(rename = "denied_capability")]
    PermissionDenied,
    Conflict,
    AmbiguousSelector,
    Timeout,
    InternalFailure,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl CliError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArguments, message)
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::UnavailableRuntime, message)
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Timeout, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InternalFailure, message)
    }

    pub fn ambiguous(kind: &str, query: &str, mut matches: Vec<String>) -> Self {
        matches.sort();
        matches.dedup();
        Self::new(
            ErrorCode::AmbiguousSelector,
            format!("{kind} selector '{query}' matches more than one target"),
        )
        .with_details(json!({
            "selectorKind": kind,
            "query": query,
            "matches": matches,
        }))
    }

    pub fn not_found(kind: &str, query: &str) -> Self {
        Self::new(
            ErrorCode::NotFound,
            format!("{kind} selector '{query}' did not match a target"),
        )
        .with_details(json!({ "selectorKind": kind, "query": query }))
    }

    pub fn exit_code(&self) -> i32 {
        match self.code {
            ErrorCode::InvalidArguments => 2,
            ErrorCode::UnavailableRuntime => 3,
            ErrorCode::NotFound | ErrorCode::StaleTarget | ErrorCode::StaleRef => 4,
            ErrorCode::PermissionDenied => 5,
            ErrorCode::Conflict | ErrorCode::AmbiguousSelector => 6,
            ErrorCode::Timeout => 7,
            ErrorCode::InternalFailure => 1,
        }
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CliError {}
