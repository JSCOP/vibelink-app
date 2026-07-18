use anyhow::{anyhow, bail, Context, Result};
use std::path::{Component, Path, PathBuf};

pub(crate) fn validate_base_ref(base_ref: &str) -> Result<()> {
    if base_ref.is_empty() {
        bail!("git base ref must not be empty");
    }
    if base_ref.starts_with('-') {
        bail!("git base ref must not start with '-'");
    }
    if !base_ref.chars().all(is_allowed_base_ref_char) {
        bail!("git base ref contains unsupported characters");
    }
    Ok(())
}

pub(crate) fn is_allowed_base_ref_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '/' | '_' | '-' | '.' | '@' | '~' | '^')
}

pub(crate) fn resolve_repo_file_path(repo: &str, path: &str) -> Result<PathBuf> {
    contain_path(Path::new(repo), path)
}

pub(crate) fn contain_path(root: &Path, rel_path: &str) -> Result<PathBuf> {
    let relative = validate_repo_relative_path(rel_path)?;
    let root = root
        .canonicalize()
        .with_context(|| format!("canonicalize workspace {}", root.display()))?;
    let joined = root.join(relative);
    if !joined.starts_with(&root) {
        bail!("file path escapes workspace");
    }
    if let Ok(canonical) = joined.canonicalize() {
        if !canonical.starts_with(&root) {
            bail!("file path escapes workspace");
        }
        return Ok(canonical);
    }
    if let Some(parent) = joined.parent() {
        if let Ok(canonical_parent) = parent.canonicalize() {
            if !canonical_parent.starts_with(&root) {
                bail!("file path escapes workspace");
            }
        }
    }
    Ok(joined)
}

pub(crate) fn validate_repo_relative_path(path: &str) -> Result<&Path> {
    let relative = Path::new(path);
    if relative.is_absolute() {
        bail!("git file path must be relative");
    }
    if relative.components().any(|component| {
        matches!(
            component,
            Component::Prefix(_) | Component::RootDir | Component::ParentDir
        )
    }) {
        bail!("git file path must stay within the workspace");
    }
    Ok(relative)
}

pub(crate) fn parent_dir(path: &Path) -> Result<PathBuf> {
    path.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow!("{} has no parent directory", path.display()))
}
