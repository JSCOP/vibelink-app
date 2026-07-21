use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserErrorCode {
    InvalidArgument,
    RuntimeUnavailable,
    NotFound,
    StaleRef,
    DeniedCapability,
    Conflict,
    Timeout,
    UnsafeUrl,
    LocalFileDenied,
    DownloadDenied,
    PermissionNotFound,
    CertificateNotFound,
    Unsupported,
    Internal,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserError {
    pub code: BrowserErrorCode,
    pub message: String,
}

impl BrowserError {
    pub fn new(code: BrowserErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(BrowserErrorCode::InvalidArgument, message)
    }

    pub fn not_found(target: impl fmt::Display) -> Self {
        Self::new(
            BrowserErrorCode::NotFound,
            format!("browser target not found: {target}"),
        )
    }

    pub fn stale_ref(message: impl Into<String>) -> Self {
        Self::new(BrowserErrorCode::StaleRef, message)
    }

    pub fn unsupported(operation: impl fmt::Display) -> Self {
        Self::new(
            BrowserErrorCode::Unsupported,
            format!("native browser operation is not available: {operation}"),
        )
    }
}

impl fmt::Display for BrowserError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for BrowserError {}

pub type BrowserResult<T> = Result<T, BrowserError>;
