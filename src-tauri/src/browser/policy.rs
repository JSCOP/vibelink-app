use super::error::{BrowserError, BrowserErrorCode, BrowserResult};
use super::types::{ArtifactDescriptor, BrowserRiskCapability, ReservedDownload};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct BrowserPolicy {
    allow_local_files: bool,
    local_file_roots: Vec<PathBuf>,
    download_root: PathBuf,
    artifact_root: PathBuf,
    max_artifact_bytes: u64,
}

impl BrowserPolicy {
    pub fn new(
        allow_local_files: bool,
        local_file_roots: Vec<PathBuf>,
        download_root: PathBuf,
        artifact_root: PathBuf,
        max_artifact_bytes: u64,
    ) -> BrowserResult<Self> {
        if max_artifact_bytes == 0 {
            return Err(BrowserError::invalid(
                "max artifact bytes must be greater than zero",
            ));
        }
        Ok(Self {
            allow_local_files,
            local_file_roots,
            download_root,
            artifact_root,
            max_artifact_bytes,
        })
    }

    pub fn normalize_navigation(&self, raw: &str) -> BrowserResult<String> {
        let input = raw.trim();
        if input.is_empty() {
            return Err(BrowserError::invalid("navigation input is empty"));
        }
        if input.chars().any(char::is_control) {
            return Err(BrowserError::new(
                BrowserErrorCode::UnsafeUrl,
                "URL contains control characters",
            ));
        }
        if input.eq_ignore_ascii_case("about:blank") {
            return Ok("about:blank".to_string());
        }

        let lower = input.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            if input.chars().any(char::is_whitespace) {
                return Err(BrowserError::new(
                    BrowserErrorCode::UnsafeUrl,
                    "URL contains unescaped whitespace",
                ));
            }
            return Ok(input.to_string());
        }
        if lower.starts_with("file:") || is_absolute_local_path(input) {
            return self.normalize_local_file(input);
        }
        if has_explicit_scheme(input) {
            return Err(BrowserError::new(
                BrowserErrorCode::UnsafeUrl,
                format!("URL scheme is not allowed: {input}"),
            ));
        }
        if looks_like_host(input) {
            return Ok(format!("https://{input}"));
        }
        Ok(format!(
            "https://www.google.com/search?q={}",
            percent_encode(input)
        ))
    }

    pub fn reserve_download(&self, suggested_name: &str) -> BrowserResult<ReservedDownload> {
        let file_name = sanitize_file_name(suggested_name)?;
        fs::create_dir_all(&self.download_root).map_err(|error| {
            BrowserError::new(
                BrowserErrorCode::DownloadDenied,
                format!("create download directory: {error}"),
            )
        })?;
        let root = fs::canonicalize(&self.download_root).map_err(|error| {
            BrowserError::new(
                BrowserErrorCode::DownloadDenied,
                format!("resolve download directory: {error}"),
            )
        })?;
        let (stem, extension) = split_file_name(&file_name);
        for suffix in 0..10_000u32 {
            let candidate_name = if suffix == 0 {
                file_name.clone()
            } else if extension.is_empty() {
                format!("{stem} ({suffix})")
            } else {
                format!("{stem} ({suffix}).{extension}")
            };
            let candidate = root.join(&candidate_name);
            if !lexically_within(&root, &candidate) {
                return Err(BrowserError::new(
                    BrowserErrorCode::DownloadDenied,
                    "download escaped canonical root",
                ));
            }
            match OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&candidate)
            {
                Ok(_) => {
                    return Ok(ReservedDownload {
                        path: candidate,
                        file_name: candidate_name,
                    })
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(BrowserError::new(
                        BrowserErrorCode::DownloadDenied,
                        format!("reserve download destination: {error}"),
                    ))
                }
            }
        }
        Err(BrowserError::new(
            BrowserErrorCode::Conflict,
            "could not reserve a unique download name",
        ))
    }

    pub fn describe_artifact(
        &self,
        path: &Path,
        content_type: impl Into<String>,
        expires_at_ms: u64,
    ) -> BrowserResult<ArtifactDescriptor> {
        let root = fs::canonicalize(&self.artifact_root).map_err(|error| {
            BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                format!("resolve artifact root: {error}"),
            )
        })?;
        let canonical = fs::canonicalize(path).map_err(|error| {
            BrowserError::new(
                BrowserErrorCode::NotFound,
                format!("resolve browser artifact: {error}"),
            )
        })?;
        if !canonical.starts_with(&root) {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "browser artifact is outside the canonical artifact root",
            ));
        }
        let actual_bytes = fs::metadata(&canonical)
            .map_err(|error| {
                BrowserError::new(
                    BrowserErrorCode::NotFound,
                    format!("read browser artifact metadata: {error}"),
                )
            })?
            .len();
        Ok(ArtifactDescriptor {
            path: canonical,
            content_type: content_type.into(),
            bytes: actual_bytes.min(self.max_artifact_bytes),
            expires_at_ms,
            truncated: actual_bytes > self.max_artifact_bytes,
        })
    }

    pub fn require_capability(
        &self,
        grants: &HashSet<BrowserRiskCapability>,
        capability: BrowserRiskCapability,
    ) -> BrowserResult<()> {
        if grants.contains(&capability) {
            Ok(())
        } else {
            Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                format!(
                    "browser operation requires explicit {} grant",
                    capability.grant_name()
                ),
            ))
        }
    }

    pub fn workspace_file(
        &self,
        path: &Path,
        grants: &HashSet<BrowserRiskCapability>,
        capability: BrowserRiskCapability,
    ) -> BrowserResult<PathBuf> {
        self.require_capability(grants, capability)?;
        let canonical = fs::canonicalize(path).map_err(|error| {
            BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                format!("resolve workspace file: {error}"),
            )
        })?;
        if !canonical.is_file() {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "browser file operation requires an existing regular file",
            ));
        }
        let allowed = self.local_file_roots.iter().any(|root| {
            fs::canonicalize(root)
                .map(|canonical_root| canonical.starts_with(canonical_root))
                .unwrap_or(false)
        });
        if !allowed {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "browser file is outside the explicitly granted workspace roots",
            ));
        }
        Ok(canonical)
    }

    pub fn download_root(&self) -> &Path {
        &self.download_root
    }

    pub fn artifact_root(&self) -> &Path {
        &self.artifact_root
    }

    pub fn max_artifact_bytes(&self) -> u64 {
        self.max_artifact_bytes
    }

    fn normalize_local_file(&self, input: &str) -> BrowserResult<String> {
        if !self.allow_local_files {
            return Err(BrowserError::new(
                BrowserErrorCode::LocalFileDenied,
                "local-file navigation requires an explicit browser.file grant",
            ));
        }
        let path = local_path_from_input(input)?;
        let canonical = fs::canonicalize(&path).map_err(|error| {
            BrowserError::new(
                BrowserErrorCode::LocalFileDenied,
                format!("resolve local file: {error}"),
            )
        })?;
        let allowed = self.local_file_roots.iter().any(|root| {
            fs::canonicalize(root)
                .map(|canonical_root| canonical.starts_with(canonical_root))
                .unwrap_or(false)
        });
        if !allowed {
            return Err(BrowserError::new(
                BrowserErrorCode::LocalFileDenied,
                "local file is outside the granted workspace roots",
            ));
        }
        let normalized = canonical.to_string_lossy().replace('\\', "/");
        let prefix = if normalized.starts_with('/') {
            "file://"
        } else {
            "file:///"
        };
        Ok(format!("{prefix}{normalized}"))
    }
}

fn has_explicit_scheme(input: &str) -> bool {
    let Some(index) = input.find(':') else {
        return false;
    };
    if index == 1 && input.as_bytes().get(1) == Some(&b':') {
        return false;
    }
    let scheme = &input[..index];
    !scheme.is_empty()
        && scheme.as_bytes()[0].is_ascii_alphabetic()
        && scheme
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
}

fn is_absolute_local_path(input: &str) -> bool {
    Path::new(input).is_absolute()
        || (input.len() >= 3
            && input.as_bytes()[0].is_ascii_alphabetic()
            && input.as_bytes()[1] == b':'
            && matches!(input.as_bytes()[2], b'\\' | b'/'))
        || input.starts_with("\\\\")
}

fn local_path_from_input(input: &str) -> BrowserResult<PathBuf> {
    if input.to_ascii_lowercase().starts_with("file:") {
        let mut value = input[5..].trim_start_matches('/').replace('/', "\\");
        value = percent_decode(&value)?;
        if value.is_empty() {
            return Err(BrowserError::invalid("file URL has no path"));
        }
        Ok(PathBuf::from(value))
    } else {
        Ok(PathBuf::from(input))
    }
}

fn looks_like_host(input: &str) -> bool {
    !input.chars().any(char::is_whitespace)
        && (input.contains('.') || input.starts_with("localhost") || input.starts_with('['))
}

fn percent_encode(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn percent_decode(value: &str) -> BrowserResult<String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(BrowserError::invalid(
                    "invalid percent-encoding in file URL",
                ));
            }
            let encoded = std::str::from_utf8(&bytes[index + 1..index + 3])
                .map_err(|_| BrowserError::invalid("invalid percent-encoding in file URL"))?;
            let decoded = u8::from_str_radix(encoded, 16)
                .map_err(|_| BrowserError::invalid("invalid percent-encoding in file URL"))?;
            output.push(decoded);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).map_err(|_| BrowserError::invalid("file URL path is not UTF-8"))
}

fn sanitize_file_name(input: &str) -> BrowserResult<String> {
    let name = input.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        || name.chars().any(char::is_control)
    {
        return Err(BrowserError::new(
            BrowserErrorCode::DownloadDenied,
            "unsafe download file name",
        ));
    }
    let sanitized = name.trim_end_matches(['.', ' ']);
    let device_stem = sanitized
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved_device = matches!(device_stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (device_stem.len() == 4
            && (device_stem.starts_with("COM") || device_stem.starts_with("LPT"))
            && matches!(device_stem.as_bytes()[3], b'1'..=b'9'));
    if sanitized.is_empty() || reserved_device {
        return Err(BrowserError::new(
            BrowserErrorCode::DownloadDenied,
            "reserved download file name",
        ));
    }
    Ok(sanitized.to_string())
}

fn split_file_name(name: &str) -> (String, String) {
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && !extension.is_empty() => {
            (stem.to_string(), extension.to_string())
        }
        _ => (name.to_string(), String::new()),
    }
}

fn lexically_within(root: &Path, candidate: &Path) -> bool {
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized.starts_with(root)
}
