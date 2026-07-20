use super::exec::{git_read, git_read_allow_fail};
use super::paths::{resolve_repo_file_path, validate_base_ref, validate_repo_relative_path};
use super::{merge_numstat, parse_name_status, to_string, ChangedFile, FileContents};
use crate::app::license::LicenseService;
use anyhow::{bail, Context, Result};
use std::sync::Arc;
use tauri::State;

const MAX_DIFF_BYTES: usize = 1024 * 1024;

#[tauri::command]
pub async fn git_commit_file_contents(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    sha: String,
    path: String,
) -> Result<FileContents, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || {
        commit_file_contents_native(&workspace_folder, &sha, &path)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn git_diff_refs(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    base_ref: String,
    head_ref: String,
) -> Result<Vec<ChangedFile>, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || {
        diff_refs_native(&workspace_folder, &base_ref, &head_ref)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn git_diff_refs_file(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    base_ref: String,
    head_ref: String,
    path: String,
) -> Result<FileContents, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || {
        diff_refs_file_native(&workspace_folder, &base_ref, &head_ref, &path)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn git_compare_refs(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    base_ref: String,
    head_ref: String,
) -> Result<Vec<ChangedFile>, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || {
        compare_refs_native(&workspace_folder, &base_ref, &head_ref)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn git_compare_refs_file(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    base_ref: String,
    head_ref: String,
    path: String,
) -> Result<FileContents, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || {
        compare_refs_file_native(&workspace_folder, &base_ref, &head_ref, &path)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn git_working_file_contents(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    path: String,
    area: String,
) -> Result<FileContents, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || {
        working_file_contents_native(&workspace_folder, &path, &area)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

pub(crate) fn commit_file_contents_native(repo: &str, sha: &str, path: &str) -> Result<FileContents> {
    validate_base_ref(sha)?;
    validate_repo_relative_path(path)?;
    let parent = format!("{sha}^");
    let old = git_read_allow_fail(repo, ["show", &format!("{parent}:{path}")])?.unwrap_or_default();
    let new = git_read_allow_fail(repo, ["show", &format!("{sha}:{path}")])?.unwrap_or_default();
    file_contents_from_bytes(old, new)
}

pub(crate) fn diff_refs_native(repo: &str, base_ref: &str, head_ref: &str) -> Result<Vec<ChangedFile>> {
    validate_base_ref(base_ref)?;
    validate_base_ref(head_ref)?;
    let range = format!("{base_ref}...{head_ref}");
    let mut files = parse_name_status(&git_read(
        repo,
        ["diff", "-M", "-C", "-z", "--name-status", &range, "--"],
    )?);
    let numstat = git_read(repo, ["diff", "-M", "--numstat", "-z", &range, "--"])?;
    merge_numstat(&mut files, &numstat);
    Ok(files)
}

pub(crate) fn diff_refs_file_native(
    repo: &str,
    base_ref: &str,
    head_ref: &str,
    path: &str,
) -> Result<FileContents> {
    validate_base_ref(base_ref)?;
    validate_base_ref(head_ref)?;
    validate_repo_relative_path(path)?;
    let merge_base = git_read(repo, ["merge-base", base_ref, head_ref])?;
    let merge_base = String::from_utf8_lossy(&merge_base).trim().to_string();
    let old = git_read_allow_fail(repo, ["show", &format!("{merge_base}:{path}")])?.unwrap_or_default();
    let new = git_read_allow_fail(repo, ["show", &format!("{head_ref}:{path}")])?.unwrap_or_default();
    file_contents_from_bytes(old, new)
}

pub(crate) fn compare_refs_native(repo: &str, base_ref: &str, head_ref: &str) -> Result<Vec<ChangedFile>> {
    validate_base_ref(base_ref)?;
    validate_base_ref(head_ref)?;
    let mut files = parse_name_status(&git_read(
        repo,
        ["diff", "-M", "-C", "-z", "--name-status", base_ref, head_ref, "--"],
    )?);
    let numstat = git_read(repo, ["diff", "-M", "--numstat", "-z", base_ref, head_ref, "--"])?;
    merge_numstat(&mut files, &numstat);
    Ok(files)
}

pub(crate) fn compare_refs_file_native(
    repo: &str,
    base_ref: &str,
    head_ref: &str,
    path: &str,
) -> Result<FileContents> {
    validate_base_ref(base_ref)?;
    validate_base_ref(head_ref)?;
    validate_repo_relative_path(path)?;
    let old = git_read_allow_fail(repo, ["show", &format!("{base_ref}:{path}")])?.unwrap_or_default();
    let new = git_read_allow_fail(repo, ["show", &format!("{head_ref}:{path}")])?.unwrap_or_default();
    file_contents_from_bytes(old, new)
}

pub(crate) fn working_file_contents_native(repo: &str, path: &str, area: &str) -> Result<FileContents> {
    validate_repo_relative_path(path)?;
    match area {
        "staged" => {
            let old = git_read_allow_fail(repo, ["show", &format!("HEAD:{path}")])?.unwrap_or_default();
            let new = git_read_allow_fail(repo, ["show", &format!(":0:{path}")])?.unwrap_or_default();
            file_contents_from_bytes(old, new)
        }
        "unstaged" => {
            let old = git_read_allow_fail(repo, ["show", &format!(":0:{path}")])?.unwrap_or_default();
            let file_path = resolve_repo_file_path(repo, path)?;
            let new = match std::fs::metadata(&file_path) {
                Ok(metadata) if metadata.len() > MAX_DIFF_BYTES as u64 => bail!("file too large for diff"),
                Ok(_) => std::fs::read(&file_path)
                    .with_context(|| format!("read {}", file_path.display()))?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
                Err(error) => return Err(error).with_context(|| format!("read {}", file_path.display())),
            };
            file_contents_from_bytes(old, new)
        }
        _ => bail!("git diff area must be 'staged' or 'unstaged'"),
    }
}

pub(crate) fn file_contents_from_bytes(old: Vec<u8>, new: Vec<u8>) -> Result<FileContents> {
    if old.len() > MAX_DIFF_BYTES || new.len() > MAX_DIFF_BYTES {
        bail!("file too large for diff");
    }
    match (String::from_utf8(old), String::from_utf8(new)) {
        (Ok(old), Ok(new)) => Ok(FileContents { old, new, binary: false }),
        _ => Ok(FileContents { old: String::new(), new: String::new(), binary: true }),
    }
}
