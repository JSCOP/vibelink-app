use super::git::{git_output, paths::contain_path, split_nul};
use anyhow::{bail, Context, Result};
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const TEXT_LIMIT: usize = 2 * 1024 * 1024;
const TEXT_DOCUMENT_LIMIT: usize = 8 * 1024 * 1024;
const IMAGE_LIMIT: u64 = 64 * 1024 * 1024;
const PATH_KIND_SNIFF_LIMIT: usize = 8 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub content: String,
    pub truncated: bool,
    pub binary: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FsPathKind {
    Directory,
    TextFile,
    Other,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TextDocumentEncoding {
    Utf8,
    Utf8Bom,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TextDocumentLineEnding {
    Lf,
    Crlf,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDocumentRevision {
    pub sha256: String,
    pub size: u64,
    /// A decimal string keeps the full filesystem timestamp precision across JavaScript's
    /// 53-bit integer boundary.
    pub modified_at_ns: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDocument {
    pub content: String,
    pub revision: TextDocumentRevision,
    pub encoding: TextDocumentEncoding,
    pub line_ending: TextDocumentLineEnding,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SaveTextDocumentResult {
    Saved {
        document: TextDocument,
    },
    Conflict {
        current_revision: Option<TextDocumentRevision>,
    },
}

enum ConditionalWriteOutcome {
    Saved(TextDocumentRevision),
    Conflict(Option<TextDocumentRevision>),
}

#[tauri::command]
pub async fn fs_list_dir(
    workspace_folder: String,
    rel_path: String,
) -> Result<Vec<DirEntryInfo>, String> {
    spawn_blocking(move || list_dir_native(&workspace_folder, &rel_path)).await
}

#[tauri::command]
pub async fn fs_list_workspace_files(workspace_folder: String) -> Result<Vec<String>, String> {
    spawn_blocking(move || list_workspace_files_native(&workspace_folder)).await
}

#[tauri::command]
pub async fn fs_read_text(workspace_folder: String, rel_path: String) -> Result<TextFile, String> {
    spawn_blocking(move || read_text_native(&workspace_folder, &rel_path)).await
}

#[tauri::command]
pub async fn fs_path_kind(
    workspace_folder: String,
    rel_path: String,
) -> Result<FsPathKind, String> {
    spawn_blocking(move || path_kind_native(&workspace_folder, &rel_path)).await
}

#[tauri::command]
pub async fn fs_read_image(workspace_folder: String, rel_path: String) -> Result<String, String> {
    spawn_blocking(move || read_base64_native(&workspace_folder, &rel_path)).await
}

#[tauri::command]
pub async fn fs_open_text_document(
    workspace_folder: String,
    rel_path: String,
) -> Result<TextDocument, String> {
    spawn_blocking(move || open_text_document_native(&workspace_folder, &rel_path)).await
}

#[tauri::command]
pub async fn fs_text_document_revision(
    workspace_folder: String,
    rel_path: String,
) -> Result<TextDocumentRevision, String> {
    spawn_blocking(move || text_document_revision_native(&workspace_folder, &rel_path)).await
}

#[tauri::command]
pub async fn fs_save_text_document(
    workspace_folder: String,
    rel_path: String,
    content: String,
    expected_revision: TextDocumentRevision,
    encoding: TextDocumentEncoding,
    line_ending: TextDocumentLineEnding,
) -> Result<SaveTextDocumentResult, String> {
    spawn_blocking(move || {
        save_text_document_native(
            &workspace_folder,
            &rel_path,
            &content,
            Some(&expected_revision),
            encoding,
            line_ending,
            false,
        )
    })
    .await
}

#[tauri::command]
pub async fn fs_save_text_document_as(
    workspace_folder: String,
    rel_path: String,
    content: String,
    expected_revision: Option<TextDocumentRevision>,
    encoding: TextDocumentEncoding,
    line_ending: TextDocumentLineEnding,
) -> Result<SaveTextDocumentResult, String> {
    spawn_blocking(move || {
        save_text_document_native(
            &workspace_folder,
            &rel_path,
            &content,
            expected_revision.as_ref(),
            encoding,
            line_ending,
            true,
        )
    })
    .await
}

#[tauri::command]
pub async fn fs_create_file(workspace_folder: String, rel_path: String) -> Result<(), String> {
    spawn_blocking(move || create_file_native(&workspace_folder, &rel_path)).await
}

#[tauri::command]
pub async fn fs_create_dir(workspace_folder: String, rel_path: String) -> Result<(), String> {
    spawn_blocking(move || create_dir_native(&workspace_folder, &rel_path)).await
}

#[tauri::command]
pub async fn fs_rename(
    workspace_folder: String,
    from_rel: String,
    to_rel: String,
) -> Result<(), String> {
    spawn_blocking(move || rename_native(&workspace_folder, &from_rel, &to_rel)).await
}

#[tauri::command]
pub async fn fs_delete(workspace_folder: String, rel_paths: Vec<String>) -> Result<(), String> {
    spawn_blocking(move || delete_native(&workspace_folder, &rel_paths)).await
}

#[tauri::command]
pub async fn open_in_editor(
    workspace_folder: String,
    rel_path: String,
    editor_command: String,
) -> Result<(), String> {
    spawn_blocking(move || open_in_editor_native(&workspace_folder, &rel_path, &editor_command))
        .await
}

fn list_workspace_files_native(workspace_folder: &str) -> Result<Vec<String>> {
    let output = match git_output(
        workspace_folder,
        [
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    ) {
        Ok(output) => output,
        Err(error)
            if error
                .to_string()
                .to_ascii_lowercase()
                .contains("not a git repository") =>
        {
            bail!("workspace is not a Git repository")
        }
        Err(error) => return Err(error).context("list workspace files with git"),
    };
    Ok(split_nul(&output))
}

fn list_dir_native(root: &str, rel_path: &str) -> Result<Vec<DirEntryInfo>> {
    let directory = contain_path(Path::new(root), rel_path)?;
    if !directory.is_dir() {
        bail!("directory does not exist");
    }
    let mut entries = Vec::new();
    for entry in
        std::fs::read_dir(&directory).with_context(|| format!("read {}", directory.display()))?
    {
        let entry = entry?;
        let metadata = std::fs::symlink_metadata(entry.path())?;
        let file_type = metadata.file_type();
        entries.push(DirEntryInfo {
            name: entry.file_name().to_string_lossy().to_string(),
            is_dir: file_type.is_dir(),
            is_symlink: file_type.is_symlink(),
            size: metadata.len(),
            modified_at: metadata
                .modified()
                .ok()
                .map(|time| DateTime::<Utc>::from(time).to_rfc3339()),
        });
    }
    Ok(entries)
}

fn read_text_native(root: &str, rel_path: &str) -> Result<TextFile> {
    let path = contain_path(Path::new(root), rel_path)?;
    let file = std::fs::File::open(&path).with_context(|| format!("open {}", path.display()))?;
    let mut bytes = Vec::with_capacity(TEXT_LIMIT.min(file.metadata()?.len() as usize));
    file.take((TEXT_LIMIT + 1) as u64).read_to_end(&mut bytes)?;
    let truncated = bytes.len() > TEXT_LIMIT;
    bytes.truncate(TEXT_LIMIT);
    let binary = bytes.iter().take(8 * 1024).any(|byte| *byte == 0);
    Ok(TextFile {
        content: if binary {
            String::new()
        } else {
            String::from_utf8_lossy(&bytes).to_string()
        },
        truncated,
        binary,
    })
}

fn path_kind_native(root: &str, rel_path: &str) -> Result<FsPathKind> {
    let path = contain_path(Path::new(root), rel_path)?;
    let metadata = std::fs::metadata(&path)?;
    if metadata.is_dir() {
        return Ok(FsPathKind::Directory);
    }
    if !metadata.is_file() || metadata.len() > TEXT_DOCUMENT_LIMIT as u64 {
        return Ok(FsPathKind::Other);
    }

    let mut file = std::fs::File::open(&path)?;
    let mut prefix = [0_u8; PATH_KIND_SNIFF_LIMIT];
    let length = metadata.len().min(PATH_KIND_SNIFF_LIMIT as u64) as usize;
    file.read_exact(&mut prefix[..length])?;
    let bytes = &prefix[..length];
    if bytes.contains(&0) {
        return Ok(FsPathKind::Other);
    }
    if let Err(error) = std::str::from_utf8(bytes) {
        let ended_at_buffer_boundary =
            error.error_len().is_none() && metadata.len() > length as u64;
        if !ended_at_buffer_boundary {
            return Ok(FsPathKind::Other);
        }
    }
    Ok(FsPathKind::TextFile)
}

fn open_text_document_native(root: &str, rel_path: &str) -> Result<TextDocument> {
    let path = contain_path(Path::new(root), rel_path)?;
    let (bytes, revision) = read_revision_bytes(&path)?;
    let (content, encoding, line_ending) = decode_text_document(&bytes)?;
    Ok(TextDocument {
        content,
        revision,
        encoding,
        line_ending,
    })
}

fn text_document_revision_native(root: &str, rel_path: &str) -> Result<TextDocumentRevision> {
    let path = contain_path(Path::new(root), rel_path)?;
    read_revision_bytes(&path).map(|(_, revision)| revision)
}

fn save_text_document_native(
    root: &str,
    rel_path: &str,
    content: &str,
    expected_revision: Option<&TextDocumentRevision>,
    encoding: TextDocumentEncoding,
    line_ending: TextDocumentLineEnding,
    allow_create: bool,
) -> Result<SaveTextDocumentResult> {
    let path = contain_writable_document_path(Path::new(root), rel_path)?;
    let normalized_content = normalize_editor_content(content)?;
    let bytes = encode_text_document(&normalized_content, encoding, line_ending)?;
    if bytes.len() > TEXT_DOCUMENT_LIMIT {
        bail!("text documents are limited to 8 MiB");
    }

    let outcome = conditional_write_text_document(
        Path::new(root),
        &path,
        &bytes,
        expected_revision,
        allow_create,
    )?;
    let revision = match outcome {
        ConditionalWriteOutcome::Saved(revision) => revision,
        ConditionalWriteOutcome::Conflict(current_revision) => {
            return Ok(SaveTextDocumentResult::Conflict { current_revision });
        }
    };
    Ok(SaveTextDocumentResult::Saved {
        document: TextDocument {
            content: normalized_content,
            revision,
            encoding,
            line_ending,
        },
    })
}

fn contain_writable_document_path(root: &Path, rel_path: &str) -> Result<PathBuf> {
    let contained = contain_path(root, rel_path)?;
    if contained.exists() {
        return Ok(contained);
    }
    let canonical_root = root
        .canonicalize()
        .with_context(|| format!("canonicalize workspace {}", root.display()))?;
    let file_name = contained
        .file_name()
        .with_context(|| format!("{} has no file name", contained.display()))?;
    let canonical_parent = contained
        .parent()
        .with_context(|| format!("{} has no parent directory", contained.display()))?
        .canonicalize()
        .with_context(|| format!("canonicalize parent of {}", contained.display()))?;
    if !canonical_parent.starts_with(&canonical_root) {
        bail!("file path escapes workspace through a symbolic link");
    }
    Ok(canonical_parent.join(file_name))
}

fn read_revision_bytes(path: &Path) -> Result<(Vec<u8>, TextDocumentRevision)> {
    let mut file = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    read_revision_bytes_from_file(&mut file)
        .with_context(|| format!("read revision for {}", path.display()))
}

fn read_revision_bytes_from_file(
    file: &mut std::fs::File,
) -> Result<(Vec<u8>, TextDocumentRevision)> {
    file.seek(SeekFrom::Start(0))?;
    let before = file.metadata()?;
    if !before.is_file() {
        bail!("text document is not a regular file");
    }
    if before.len() > TEXT_DOCUMENT_LIMIT as u64 {
        bail!("text documents are limited to 8 MiB");
    }
    let before_modified = modified_at_ns(before.modified()?)?;
    let mut bytes = Vec::with_capacity(before.len() as usize);
    file.read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    let after_modified = modified_at_ns(after.modified()?)?;
    if before.len() != after.len() || before_modified != after_modified {
        bail!("text document changed while it was being read");
    }
    if bytes.len() > TEXT_DOCUMENT_LIMIT {
        bail!("text documents are limited to 8 MiB");
    }
    let revision = revision_from_bytes(&bytes, after.len(), after_modified);
    Ok((bytes, revision))
}

#[cfg(not(windows))]
fn text_document_revision_for_path(path: &Path) -> Result<TextDocumentRevision> {
    read_revision_bytes(path).map(|(_, revision)| revision)
}

#[cfg(not(windows))]
fn revision_if_file(path: &Path) -> Result<Option<TextDocumentRevision>> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            // contain_path resolves existing symlinks and rejects escape targets before this
            // helper is reached. A surviving symlink here is a newly-created race.
            bail!("text document target changed to a symbolic link")
        }
        Ok(metadata) if !metadata.is_file() => bail!("text document is not a regular file"),
        Ok(_) => text_document_revision_for_path(path).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("inspect {}", path.display())),
    }
}

fn revision_from_bytes(bytes: &[u8], size: u64, modified_at_ns: String) -> TextDocumentRevision {
    TextDocumentRevision {
        sha256: format!("{:x}", Sha256::digest(bytes)),
        size,
        modified_at_ns,
    }
}

fn modified_at_ns(time: SystemTime) -> Result<String> {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => Ok(duration.as_nanos().to_string()),
        Err(error) => Ok(format!("-{}", error.duration().as_nanos())),
    }
}

fn decode_text_document(
    bytes: &[u8],
) -> Result<(String, TextDocumentEncoding, TextDocumentLineEnding)> {
    let (payload, encoding) = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        (&bytes[3..], TextDocumentEncoding::Utf8Bom)
    } else {
        (bytes, TextDocumentEncoding::Utf8)
    };
    if payload.contains(&0) {
        bail!("text document contains binary NUL bytes");
    }
    let decoded = std::str::from_utf8(payload).context("text document is not strict UTF-8")?;
    let (content, line_ending) = normalize_disk_line_endings(decoded)?;
    Ok((content, encoding, line_ending))
}

fn normalize_disk_line_endings(content: &str) -> Result<(String, TextDocumentLineEnding)> {
    let bytes = content.as_bytes();
    let mut lf = 0usize;
    let mut crlf = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\r' => {
                if bytes.get(index + 1) != Some(&b'\n') {
                    bail!("text document contains unsupported lone CR line endings");
                }
                crlf += 1;
                index += 2;
            }
            b'\n' => {
                lf += 1;
                index += 1;
            }
            _ => index += 1,
        }
    }
    if lf > 0 && crlf > 0 {
        bail!("text document contains mixed LF and CRLF line endings");
    }
    if crlf > 0 {
        Ok((content.replace("\r\n", "\n"), TextDocumentLineEnding::Crlf))
    } else {
        Ok((content.to_string(), TextDocumentLineEnding::Lf))
    }
}

fn normalize_editor_content(content: &str) -> Result<String> {
    if content.contains('\0') {
        bail!("editor content contains binary NUL bytes");
    }
    normalize_disk_line_endings(content).map(|(normalized, _)| normalized)
}

fn encode_text_document(
    normalized_content: &str,
    encoding: TextDocumentEncoding,
    line_ending: TextDocumentLineEnding,
) -> Result<Vec<u8>> {
    if normalized_content.contains('\r') {
        bail!("editor content must use LF internally");
    }
    let encoded_content = match line_ending {
        TextDocumentLineEnding::Lf => normalized_content.to_string(),
        TextDocumentLineEnding::Crlf => normalized_content.replace('\n', "\r\n"),
    };
    let mut bytes = Vec::with_capacity(encoded_content.len() + 3);
    if encoding == TextDocumentEncoding::Utf8Bom {
        bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    }
    bytes.extend_from_slice(encoded_content.as_bytes());
    Ok(bytes)
}

#[cfg(not(windows))]
fn write_flushed_sibling_temp(path: &Path, bytes: &[u8]) -> Result<PathBuf> {
    let parent = path
        .parent()
        .with_context(|| format!("{} has no parent directory", path.display()))?;
    if !parent.is_dir() {
        bail!("text document parent directory does not exist");
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document");
    for _ in 0..8 {
        let temporary = parent.join(format!(".{file_name}.vibelink-{}.tmp", Uuid::new_v4()));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(mut file) => {
                let result = (|| -> Result<()> {
                    file.write_all(bytes)?;
                    file.flush()?;
                    file.sync_all()?;
                    Ok(())
                })();
                if let Err(error) = result {
                    drop(file);
                    let _ = std::fs::remove_file(&temporary);
                    return Err(error).with_context(|| format!("write {}", temporary.display()));
                }
                return Ok(temporary);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error).with_context(|| format!("create {}", temporary.display()))
            }
        }
    }
    bail!("could not allocate a sibling temporary file")
}

#[cfg(windows)]
fn conditional_write_text_document(
    workspace_root: &Path,
    target: &Path,
    bytes: &[u8],
    expected_revision: Option<&TextDocumentRevision>,
    allow_create: bool,
) -> Result<ConditionalWriteOutcome> {
    let mut guard = match WindowsConditionalSave::acquire(
        workspace_root,
        target,
        expected_revision,
        allow_create,
    )? {
        WindowsSavePreparation::Ready(guard) => guard,
        WindowsSavePreparation::Conflict(current_revision) => {
            return Ok(ConditionalWriteOutcome::Conflict(current_revision));
        }
    };
    let mut temporary = write_locked_flushed_sibling_temp(target, bytes)?;
    let outcome = guard.commit(&mut temporary, bytes);
    let should_clean = !matches!(&outcome, Ok(ConditionalWriteOutcome::Saved(_)));
    let temporary_path = temporary.path.clone();
    drop(temporary);
    if should_clean {
        let _ = std::fs::remove_file(&temporary_path);
    }
    outcome
}

#[cfg(not(windows))]
fn conditional_write_text_document(
    _workspace_root: &Path,
    target: &Path,
    bytes: &[u8],
    expected_revision: Option<&TextDocumentRevision>,
    allow_create: bool,
) -> Result<ConditionalWriteOutcome> {
    let initial_revision = revision_if_file(target)?;
    if (!allow_create && initial_revision.is_none())
        || initial_revision.as_ref() != expected_revision
    {
        return Ok(ConditionalWriteOutcome::Conflict(initial_revision));
    }

    let temporary = write_flushed_sibling_temp(target, bytes)?;
    let latest_revision = revision_if_file(target)?;
    if latest_revision.as_ref() != expected_revision {
        let _ = std::fs::remove_file(&temporary);
        return Ok(ConditionalWriteOutcome::Conflict(latest_revision));
    }
    let install_result = if expected_revision.is_none() {
        install_new_without_replace(&temporary, target)
    } else {
        // This application ships on Windows. Other platforms retain the existing double
        // revision check, but never weaken Save As into an overwriting rename.
        std::fs::rename(&temporary, target)
            .with_context(|| format!("rename {} to {}", temporary.display(), target.display()))
    };
    if let Err(error) = install_result {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(ConditionalWriteOutcome::Saved(
        text_document_revision_for_path(target)?,
    ))
}

#[cfg(windows)]
enum WindowsSavePreparation {
    Ready(WindowsConditionalSave),
    Conflict(Option<TextDocumentRevision>),
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct WindowsFileIdentity {
    volume_serial: u64,
    file_id: [u8; 16],
}

#[cfg(windows)]
#[derive(Debug)]
struct WindowsIdentityConflict(String);

#[cfg(windows)]
impl std::fmt::Display for WindowsIdentityConflict {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[cfg(windows)]
impl std::error::Error for WindowsIdentityConflict {}

#[cfg(windows)]
struct WindowsHeldDirectory {
    path: PathBuf,
    file: std::fs::File,
    identity: WindowsFileIdentity,
}

#[cfg(windows)]
struct WindowsConditionalSave {
    workspace_root: PathBuf,
    canonical_workspace_root: PathBuf,
    target: PathBuf,
    parent: PathBuf,
    directories: Vec<WindowsHeldDirectory>,
    target_file: Option<std::fs::File>,
    target_identity: Option<WindowsFileIdentity>,
    expected_revision: Option<TextDocumentRevision>,
}

#[cfg(windows)]
impl WindowsConditionalSave {
    fn acquire(
        workspace_root: &Path,
        target: &Path,
        expected_revision: Option<&TextDocumentRevision>,
        allow_create: bool,
    ) -> Result<WindowsSavePreparation> {
        let parent = target
            .parent()
            .with_context(|| format!("{} has no parent directory", target.display()))?
            .to_path_buf();
        // A handle on only the leaf parent is insufficient: renaming an earlier physical
        // ancestor could make later path opens resolve into a replacement tree. Denying
        // delete sharing on the complete canonical chain keeps every pathname used before
        // the handle-relative commit bound to the tree that passed containment.
        let directories = match lock_windows_directory_chain(&parent) {
            Ok(directories) => directories,
            Err(error) if windows_error_is_conflict(&error) => {
                return Ok(WindowsSavePreparation::Conflict(None));
            }
            Err(error) => return Err(error),
        };
        let canonical_workspace_root = workspace_root
            .canonicalize()
            .with_context(|| format!("canonicalize workspace {}", workspace_root.display()))?;
        let current_parent = parent
            .canonicalize()
            .with_context(|| format!("canonicalize editor parent {}", parent.display()))?;
        if !windows_paths_equal(&current_parent, &parent)
            || !current_parent.starts_with(&canonical_workspace_root)
        {
            return Ok(WindowsSavePreparation::Conflict(None));
        }

        let mut target_file = match open_windows_target_exclusive(target) {
            Ok(file) => Some(file),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) if windows_io_error_is_conflict(&error) => {
                return Ok(WindowsSavePreparation::Conflict(None));
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("lock editor target {}", target.display()));
            }
        };
        if expected_revision.is_none() {
            if !allow_create {
                return Ok(WindowsSavePreparation::Conflict(None));
            }
            if let Some(file) = target_file.as_mut() {
                let current_revision = read_revision_bytes_from_file(file)
                    .ok()
                    .map(|(_, revision)| revision);
                return Ok(WindowsSavePreparation::Conflict(current_revision));
            }
        } else if target_file.is_none() {
            return Ok(WindowsSavePreparation::Conflict(None));
        }

        let target_identity = if let Some(file) = target_file.as_mut() {
            if !windows_handle_is_regular_non_reparse(file)?
                || !windows_handle_path_matches(file, target)?
            {
                return Ok(WindowsSavePreparation::Conflict(None));
            }
            if let Err(error) = lock_windows_file_exclusive(file) {
                if windows_error_is_conflict(&error) {
                    return Ok(WindowsSavePreparation::Conflict(None));
                }
                return Err(error);
            }
            let identity = windows_file_identity(file)?;
            let current_revision = read_revision_bytes_from_file(file)?.1;
            if Some(&current_revision) != expected_revision {
                return Ok(WindowsSavePreparation::Conflict(Some(current_revision)));
            }
            Some(identity)
        } else {
            None
        };

        Ok(WindowsSavePreparation::Ready(Self {
            workspace_root: workspace_root.to_path_buf(),
            canonical_workspace_root,
            target: target.to_path_buf(),
            parent,
            directories,
            target_file,
            target_identity,
            expected_revision: expected_revision.cloned(),
        }))
    }

    fn commit(
        &mut self,
        temporary: &mut WindowsSiblingTemp,
        intended_bytes: &[u8],
    ) -> Result<ConditionalWriteOutcome> {
        let directories_stable = match self.revalidate_directories() {
            Ok(stable) => stable,
            Err(error) if windows_error_is_conflict(&error) => false,
            Err(error) => return Err(error),
        };
        let containment_stable = match self.revalidate_workspace_containment() {
            Ok(stable) => stable,
            Err(error) if windows_error_is_conflict(&error) => false,
            Err(error) => return Err(error),
        };
        if !directories_stable || !containment_stable {
            return Ok(ConditionalWriteOutcome::Conflict(None));
        }
        if !windows_handle_path_matches(&temporary.file, &temporary.path)?
            || !windows_handle_is_regular_non_reparse(&temporary.file)?
        {
            return Ok(ConditionalWriteOutcome::Conflict(None));
        }
        let (temporary_bytes, saved_revision) = read_revision_bytes_from_file(&mut temporary.file)?;
        if temporary_bytes != intended_bytes {
            bail!("editor sibling temporary file changed before replacement");
        }

        match (
            self.expected_revision.as_ref(),
            self.target_file.as_mut(),
            self.target_identity,
        ) {
            (Some(expected), Some(target_file), Some(target_identity)) => {
                if !windows_handle_path_matches(target_file, &self.target)?
                    || windows_file_identity(target_file)? != target_identity
                    || !windows_path_still_has_identity(
                        &self.target,
                        target_identity,
                        WindowsPathKind::File,
                    )?
                {
                    return Ok(ConditionalWriteOutcome::Conflict(None));
                }
                let current_revision = read_revision_bytes_from_file(target_file)?.1;
                if &current_revision != expected {
                    return Ok(ConditionalWriteOutcome::Conflict(Some(current_revision)));
                }
                rename_windows_temp_by_path(&temporary.file, &self.target, true)?;
            }
            (None, None, None) => {
                match open_windows_target_exclusive(&self.target) {
                    Ok(mut file) => {
                        let current_revision = read_revision_bytes_from_file(&mut file)
                            .ok()
                            .map(|(_, revision)| revision);
                        return Ok(ConditionalWriteOutcome::Conflict(current_revision));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) if windows_io_error_is_conflict(&error) => {
                        return Ok(ConditionalWriteOutcome::Conflict(None));
                    }
                    Err(error) => return Err(error).context("recheck Save As destination"),
                }
                if let Err(error) =
                    rename_windows_temp_by_path(&temporary.file, &self.target, false)
                {
                    if windows_error_is_conflict(&error) {
                        return Ok(ConditionalWriteOutcome::Conflict(None));
                    }
                    return Err(error);
                }
            }
            _ => return Ok(ConditionalWriteOutcome::Conflict(None)),
        }
        Ok(ConditionalWriteOutcome::Saved(saved_revision))
    }

    fn revalidate_directories(&self) -> Result<bool> {
        for directory in &self.directories {
            if !windows_handle_path_matches(&directory.file, &directory.path)?
                || windows_file_identity(&directory.file)? != directory.identity
                || !windows_path_still_has_identity(
                    &directory.path,
                    directory.identity,
                    WindowsPathKind::Directory,
                )?
            {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn revalidate_workspace_containment(&self) -> Result<bool> {
        let current_root = self.workspace_root.canonicalize()?;
        let current_parent = self.parent.canonicalize()?;
        Ok(
            windows_paths_equal(&current_root, &self.canonical_workspace_root)
                && windows_paths_equal(&current_parent, &self.parent)
                && current_parent.starts_with(&current_root),
        )
    }
}

#[cfg(windows)]
struct WindowsSiblingTemp {
    path: PathBuf,
    file: std::fs::File,
}

#[cfg(windows)]
fn write_locked_flushed_sibling_temp(path: &Path, bytes: &[u8]) -> Result<WindowsSiblingTemp> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
    use windows::Win32::Storage::FileSystem::{DELETE, FILE_FLAG_OPEN_REPARSE_POINT};

    let parent = path
        .parent()
        .with_context(|| format!("{} has no parent directory", path.display()))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document");
    for _ in 0..8 {
        let temporary = parent.join(format!(".{file_name}.vibelink-{}.tmp", Uuid::new_v4()));
        let opened = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .access_mode(GENERIC_READ.0 | GENERIC_WRITE.0 | DELETE.0)
            .share_mode(0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
            .create_new(true)
            .open(&temporary);
        match opened {
            Ok(mut file) => {
                let write_result = (|| -> Result<()> {
                    file.write_all(bytes)?;
                    file.flush()?;
                    file.sync_all()?;
                    if !windows_handle_path_matches(&file, &temporary)?
                        || !windows_handle_is_regular_non_reparse(&file)?
                    {
                        bail!("editor sibling temporary path changed while it was written");
                    }
                    Ok(())
                })();
                if let Err(error) = write_result {
                    drop(file);
                    let _ = std::fs::remove_file(&temporary);
                    return Err(error).with_context(|| format!("write {}", temporary.display()));
                }
                return Ok(WindowsSiblingTemp {
                    path: temporary,
                    file,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error).with_context(|| format!("create {}", temporary.display()));
            }
        }
    }
    bail!("could not allocate a sibling temporary file")
}

#[cfg(windows)]
fn lock_windows_directory_chain(parent: &Path) -> Result<Vec<WindowsHeldDirectory>> {
    let mut paths: Vec<PathBuf> = parent
        .ancestors()
        .filter(|path| !path.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .collect();
    paths.reverse();
    let mut directories = Vec::with_capacity(paths.len());
    for path in paths {
        let file = open_windows_directory(&path, false)
            .with_context(|| format!("lock editor ancestor {}", path.display()))?;
        if !windows_handle_is_directory_non_reparse(&file)?
            || !windows_handle_path_matches(&file, &path)?
        {
            return Err(WindowsIdentityConflict(format!(
                "editor ancestor identity changed: {}",
                path.display()
            ))
            .into());
        }
        let identity = windows_file_identity(&file)?;
        directories.push(WindowsHeldDirectory {
            path,
            file,
            identity,
        });
    }
    Ok(directories)
}

#[cfg(windows)]
fn open_windows_directory(path: &Path, allow_delete_share: bool) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let mut share = FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0;
    if allow_delete_share {
        share |= FILE_SHARE_DELETE.0;
    }
    std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES.0)
        .share_mode(share)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)
}

#[cfg(windows)]
fn open_windows_target_exclusive(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Foundation::GENERIC_READ;
    use windows::Win32::Storage::FileSystem::{
        DELETE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ,
    };

    std::fs::OpenOptions::new()
        // Deny writers while the byte-range lock, revision, and identity are held.
        // Delete sharing is required for FileRenameInfoEx to atomically replace this
        // name while the verified destination handle remains open.
        .access_mode(GENERIC_READ.0 | DELETE.0)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_DELETE.0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)
}

#[cfg(windows)]
fn open_windows_file_identity_probe(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::{
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
    };

    std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES.0)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_DELETE.0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)
}

#[cfg(windows)]
fn lock_windows_file_exclusive(file: &std::fs::File) -> Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    use windows::Win32::System::IO::OVERLAPPED;

    let mut overlapped = OVERLAPPED::default();
    unsafe {
        LockFileEx(
            HANDLE(file.as_raw_handle()),
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            None,
            u32::MAX,
            u32::MAX,
            &mut overlapped,
        )
    }
    .context("exclusively lock editor target")
}

#[cfg(windows)]
fn windows_file_identity(file: &std::fs::File) -> Result<WindowsFileIdentity> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO,
    };

    let mut info = FILE_ID_INFO::default();
    unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            FileIdInfo,
            &mut info as *mut _ as *mut std::ffi::c_void,
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    }
    .context("read Windows file identity")?;
    Ok(WindowsFileIdentity {
        volume_serial: info.VolumeSerialNumber,
        file_id: info.FileId.Identifier,
    })
}

#[cfg(windows)]
fn windows_handle_final_path(file: &std::fs::File) -> Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED};

    let mut buffer = vec![0_u16; 512];
    loop {
        let length = unsafe {
            GetFinalPathNameByHandleW(
                HANDLE(file.as_raw_handle()),
                &mut buffer,
                FILE_NAME_NORMALIZED,
            )
        } as usize;
        if length == 0 {
            return Err(std::io::Error::last_os_error()).context("read final path by handle");
        }
        if length < buffer.len() {
            buffer.truncate(length);
            return Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer)));
        }
        buffer.resize(length + 1, 0);
    }
}

#[cfg(windows)]
fn windows_handle_path_matches(file: &std::fs::File, expected: &Path) -> Result<bool> {
    Ok(windows_paths_equal(
        &windows_handle_final_path(file)?,
        expected,
    ))
}

#[cfg(windows)]
fn windows_paths_equal(left: &Path, right: &Path) -> bool {
    fn key(path: &Path) -> String {
        let rendered = path.to_string_lossy().replace('/', "\\");
        let rendered = if let Some(tail) = rendered.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{tail}")
        } else if let Some(tail) = rendered.strip_prefix(r"\\?\") {
            tail.to_owned()
        } else {
            rendered
        };
        rendered.trim_end_matches('\\').to_lowercase()
    }
    key(left) == key(right)
}

#[cfg(windows)]
fn windows_handle_is_directory_non_reparse(file: &std::fs::File) -> Result<bool> {
    use std::os::windows::fs::MetadataExt;
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    let metadata = file.metadata()?;
    Ok(metadata.is_dir() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0)
}

#[cfg(windows)]
fn windows_handle_is_regular_non_reparse(file: &std::fs::File) -> Result<bool> {
    use std::os::windows::fs::MetadataExt;
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    let metadata = file.metadata()?;
    Ok(metadata.is_file() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0)
}

#[cfg(windows)]
#[derive(Clone, Copy)]
enum WindowsPathKind {
    File,
    Directory,
}

#[cfg(windows)]
fn windows_path_still_has_identity(
    path: &Path,
    expected: WindowsFileIdentity,
    kind: WindowsPathKind,
) -> Result<bool> {
    let probe = match kind {
        WindowsPathKind::File => open_windows_file_identity_probe(path),
        WindowsPathKind::Directory => open_windows_directory(path, true),
    };
    let probe = match probe {
        Ok(file) => file,
        Err(error) if windows_io_error_is_conflict(&error) => return Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error).with_context(|| format!("reopen {}", path.display())),
    };
    let expected_kind = match kind {
        WindowsPathKind::File => windows_handle_is_regular_non_reparse(&probe)?,
        WindowsPathKind::Directory => windows_handle_is_directory_non_reparse(&probe)?,
    };
    Ok(expected_kind && windows_file_identity(&probe)? == expected)
}

#[cfg(windows)]
fn windows_rename_info_buffer_size(file_name_length: usize) -> Option<usize> {
    use windows::Win32::Storage::FileSystem::FILE_RENAME_INFO;

    std::mem::offset_of!(FILE_RENAME_INFO, FileName)
        .checked_add(file_name_length)
        .and_then(|size| size.checked_add(std::mem::size_of::<u16>()))
}

#[cfg(windows)]
fn rename_windows_temp_by_path(
    temporary: &std::fs::File,
    target: &Path,
    replace_existing: bool,
) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        FileRenameInfoEx, SetFileInformationByHandle, FILE_RENAME_INFO,
    };

    const FILE_RENAME_FLAG_REPLACE_IF_EXISTS: u32 = 0x0000_0001;
    const FILE_RENAME_FLAG_POSIX_SEMANTICS: u32 = 0x0000_0002;

    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let name_units = target_wide
        .len()
        .checked_sub(1)
        .context("editor replacement target has no path")?;
    let name_bytes = name_units
        .checked_mul(std::mem::size_of::<u16>())
        .context("editor target path is too long")?;
    let file_name_length = u32::try_from(name_bytes).context("editor target path is too long")?;
    // Match Rust's standard-library FileRenameInfoEx layout: the full path is
    // NUL-terminated in the buffer while FileNameLength excludes the terminator.
    let buffer_size =
        windows_rename_info_buffer_size(name_bytes).context("editor rename buffer is too large")?;
    let buffer_size_u32 =
        u32::try_from(buffer_size).context("editor rename buffer is too large")?;
    let word_size = std::mem::size_of::<usize>();
    let mut storage = vec![0_usize; buffer_size.div_ceil(word_size)];
    let info = storage.as_mut_ptr() as *mut FILE_RENAME_INFO;
    unsafe {
        (*info).Anonymous.Flags = FILE_RENAME_FLAG_POSIX_SEMANTICS
            | if replace_existing {
                FILE_RENAME_FLAG_REPLACE_IF_EXISTS
            } else {
                0
            };
        (*info).RootDirectory = HANDLE::default();
        (*info).FileNameLength = file_name_length;
        std::ptr::copy_nonoverlapping(
            target_wide.as_ptr(),
            (*info).FileName.as_mut_ptr(),
            target_wide.len(),
        );
        SetFileInformationByHandle(
            HANDLE(temporary.as_raw_handle()),
            FileRenameInfoEx,
            info as *const std::ffi::c_void,
            buffer_size_u32,
        )
    }
    // Ancestor handles remain locked and identity-fenced across this absolute-path
    // rename, so resolving the verified target cannot cross a replaced directory.
    // Never fall back to ReplaceFileW, which would require closing the target first.
    .context("conditionally replace editor document by handle")
}

#[cfg(windows)]
fn windows_io_error_is_conflict(error: &std::io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(2 | 3 | 5 | 32 | 33 | 80 | 183 | 303)
    )
}

#[cfg(windows)]
fn windows_error_is_conflict(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause.downcast_ref::<WindowsIdentityConflict>().is_some()
            || cause
                .downcast_ref::<std::io::Error>()
                .is_some_and(windows_io_error_is_conflict)
            || cause
                .downcast_ref::<windows::core::Error>()
                .is_some_and(|error| {
                    matches!(
                        (error.code().0 as u32) & 0xffff,
                        2 | 3 | 5 | 32 | 33 | 80 | 183 | 303
                    )
                })
    })
}

#[cfg(not(windows))]
fn install_new_without_replace(temporary: &Path, target: &Path) -> Result<()> {
    std::fs::hard_link(temporary, target).with_context(|| {
        format!(
            "atomically create {} from {} without replacing an existing file",
            target.display(),
            temporary.display()
        )
    })?;
    std::fs::remove_file(temporary)
        .with_context(|| format!("remove sibling temporary file {}", temporary.display()))
}

fn read_base64_native(root: &str, rel_path: &str) -> Result<String> {
    let path = contain_path(Path::new(root), rel_path)?;
    if std::fs::metadata(&path)?.len() > IMAGE_LIMIT {
        bail!("image preview is limited to 64 MiB");
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(std::fs::read(&path)?))
}

fn create_file_native(root: &str, rel_path: &str) -> Result<()> {
    let path = contain_path(Path::new(root), rel_path)?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .with_context(|| format!("create {}", path.display()))?;
    Ok(())
}

fn create_dir_native(root: &str, rel_path: &str) -> Result<()> {
    let path = contain_path(Path::new(root), rel_path)?;
    if path.exists() {
        bail!("target already exists");
    }
    std::fs::create_dir(&path).with_context(|| format!("create {}", path.display()))
}

fn rename_native(root: &str, from_rel: &str, to_rel: &str) -> Result<()> {
    let from = contain_path(Path::new(root), from_rel)?;
    let to = contain_path(Path::new(root), to_rel)?;
    if to.exists() {
        bail!("target already exists");
    }
    std::fs::rename(&from, &to)
        .with_context(|| format!("rename {} to {}", from.display(), to.display()))
}

fn delete_native(root: &str, rel_paths: &[String]) -> Result<()> {
    let mut paths = Vec::with_capacity(rel_paths.len());
    for rel_path in rel_paths {
        let path = contain_path(Path::new(root), rel_path)?;
        if path == Path::new(root).canonicalize()? {
            bail!("cannot delete workspace root");
        }
        paths.push(path);
    }
    trash::delete_all(paths)?;
    Ok(())
}

fn open_in_editor_native(root: &str, rel_path: &str, editor_command: &str) -> Result<()> {
    let path = contain_path(Path::new(root), rel_path)?;
    let mut parts = editor_command.split_whitespace();
    let Some(program) = parts.next() else {
        bail!("no external editor configured");
    };
    #[cfg(windows)]
    let program = resolve_windows_launcher(program);
    // `program` is read again below, and on Windows it is an owned launcher path, so the borrow is
    // required there and merely redundant elsewhere.
    #[cfg_attr(not(windows), allow(clippy::needless_borrows_for_generic_args))]
    Command::new(&program)
        .args(parts)
        .arg(&path)
        .spawn()
        .with_context(|| format!("launch external editor {}", Path::new(&program).display()))?;
    Ok(())
}

/// Editors ship shell launchers, not executables: VS Code's `code` is
/// `code.cmd`. `CreateProcessW` only appends `.exe`, so an unqualified command
/// never launches until it is resolved against `PATH` × `PATHEXT` first.
#[cfg(windows)]
fn resolve_windows_launcher(program: &str) -> std::ffi::OsString {
    let candidate = Path::new(program);
    if candidate.is_file() {
        return candidate.into();
    }
    let extensions = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let directories: Vec<PathBuf> = if candidate
        .parent()
        .is_some_and(|parent| !parent.as_os_str().is_empty())
    {
        vec![PathBuf::new()]
    } else {
        std::env::var_os("PATH")
            .map(|paths| std::env::split_paths(&paths).collect())
            .unwrap_or_default()
    };
    for directory in directories {
        let base = directory.join(candidate);
        for extension in extensions
            .split(';')
            .filter(|extension| !extension.is_empty())
        {
            let mut name = base.clone().into_os_string();
            name.push(extension);
            if Path::new(&name).is_file() {
                return name;
            }
        }
    }
    program.into()
}

async fn spawn_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("vibelink-fsops-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create root");
        root
    }
    #[cfg(windows)]
    #[test]
    fn file_rename_info_buffer_includes_terminating_wchar() {
        use windows::Win32::Storage::FileSystem::FILE_RENAME_INFO;

        let name_size = 17 * std::mem::size_of::<u16>();
        assert_eq!(
            windows_rename_info_buffer_size(name_size),
            Some(
                std::mem::offset_of!(FILE_RENAME_INFO, FileName)
                    + name_size
                    + std::mem::size_of::<u16>()
            )
        );
        assert_eq!(windows_rename_info_buffer_size(usize::MAX), None);
    }

    #[test]
    fn create_list_rename_and_read_round_trip() {
        let root = temp_root();
        let root_str = root.to_str().expect("utf8 root");
        create_dir_native(root_str, "folder").expect("create dir");
        create_file_native(root_str, "folder/file.txt").expect("create file");
        std::fs::write(root.join("folder/file.txt"), "hello").expect("write");
        let entries = list_dir_native(root_str, "folder").expect("list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "file.txt");
        rename_native(root_str, "folder/file.txt", "folder/renamed.txt").expect("rename");
        let text = read_text_native(root_str, "folder/renamed.txt").expect("read");
        assert_eq!(text.content, "hello");
        assert!(!text.binary);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn rejects_escaping_and_absolute_paths() {
        let root = temp_root();
        let root_str = root.to_str().expect("utf8 root");
        assert!(read_text_native(root_str, "../secret.txt").is_err());
        let absolute = if cfg!(windows) {
            r"C:\Windows\win.ini"
        } else {
            "/etc/passwd"
        };
        assert!(read_text_native(root_str, absolute).is_err());
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn sniffs_binary_content() {
        let root = temp_root();
        std::fs::write(root.join("binary.bin"), b"abc\0def").expect("write binary");
        let text = read_text_native(root.to_str().expect("utf8 root"), "binary.bin").expect("read");
        assert!(text.binary);
        assert!(text.content.is_empty());
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn classifies_internal_open_targets_without_loading_whole_files() {
        let root = temp_root();
        let root_str = root.to_str().expect("utf8 root");
        std::fs::create_dir(root.join("folder")).expect("create folder");
        std::fs::write(root.join("notes.txt"), "hello").expect("write text");
        std::fs::write(root.join("binary.bin"), b"abc\0def").expect("write binary");
        std::fs::write(root.join("invalid.bin"), [0xff, 0xfe, 0xfd]).expect("write invalid utf8");
        std::fs::File::create(root.join("large.txt"))
            .expect("create large file")
            .set_len((TEXT_DOCUMENT_LIMIT + 1) as u64)
            .expect("size large file");

        assert_eq!(
            path_kind_native(root_str, "folder").unwrap(),
            FsPathKind::Directory
        );
        assert_eq!(
            path_kind_native(root_str, "notes.txt").unwrap(),
            FsPathKind::TextFile
        );
        assert_eq!(
            path_kind_native(root_str, "binary.bin").unwrap(),
            FsPathKind::Other
        );
        assert_eq!(
            path_kind_native(root_str, "invalid.bin").unwrap(),
            FsPathKind::Other
        );
        assert_eq!(
            path_kind_native(root_str, "large.txt").unwrap(),
            FsPathKind::Other
        );
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn previews_images_larger_than_twenty_mebibytes() {
        let root = temp_root();
        let image = vec![0_u8; 21 * 1024 * 1024];
        std::fs::write(root.join("large.png"), &image).expect("write image");
        let encoded = read_base64_native(root.to_str().expect("utf8 root"), "large.png")
            .expect("preview image");
        assert!(encoded.len() > image.len());
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn delete_removes_file_from_workspace() {
        let root = temp_root();
        std::fs::write(root.join("delete.txt"), "delete").expect("write");
        delete_native(
            root.to_str().expect("utf8 root"),
            &["delete.txt".to_string()],
        )
        .expect("delete");
        assert!(!root.join("delete.txt").exists());
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn text_document_round_trips_utf8_bom_and_crlf() {
        let root = temp_root();
        let path = root.join("document.txt");
        std::fs::write(&path, b"\xef\xbb\xbffirst\r\nsecond\r\n").expect("write document");
        let root_str = root.to_str().expect("utf8 root");
        let opened = open_text_document_native(root_str, "document.txt").expect("open document");
        assert_eq!(opened.content, "first\nsecond\n");
        assert_eq!(opened.encoding, TextDocumentEncoding::Utf8Bom);
        assert_eq!(opened.line_ending, TextDocumentLineEnding::Crlf);

        let saved = save_text_document_native(
            root_str,
            "document.txt",
            "changed\ncontent\n",
            Some(&opened.revision),
            opened.encoding,
            opened.line_ending,
            false,
        )
        .expect("save document");
        assert!(matches!(saved, SaveTextDocumentResult::Saved { .. }));
        assert_eq!(
            std::fs::read(&path).expect("read bytes"),
            b"\xef\xbb\xbfchanged\r\ncontent\r\n"
        );
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn text_document_conflict_never_overwrites_external_bytes() {
        let root = temp_root();
        let path = root.join("conflict.txt");
        std::fs::write(&path, "original\n").expect("write original");
        let root_str = root.to_str().expect("utf8 root");
        let opened = open_text_document_native(root_str, "conflict.txt").expect("open document");
        std::fs::write(&path, "external\n").expect("write external");

        let result = save_text_document_native(
            root_str,
            "conflict.txt",
            "local\n",
            Some(&opened.revision),
            opened.encoding,
            opened.line_ending,
            false,
        )
        .expect("conflict result");
        assert!(matches!(result, SaveTextDocumentResult::Conflict { .. }));
        assert_eq!(
            std::fs::read_to_string(&path).expect("read file"),
            "external\n"
        );
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn text_document_rejects_invalid_utf8_binary_and_oversize_content() {
        let root = temp_root();
        let root_str = root.to_str().expect("utf8 root");
        std::fs::write(root.join("invalid.bin"), [0xff, 0xfe, 0xfd]).expect("write invalid");
        std::fs::write(root.join("nul.bin"), b"valid\0utf8").expect("write nul");
        std::fs::write(root.join("large.txt"), vec![b'a'; TEXT_DOCUMENT_LIMIT + 1])
            .expect("write large");

        assert!(open_text_document_native(root_str, "invalid.bin").is_err());
        assert!(open_text_document_native(root_str, "nul.bin").is_err());
        assert!(open_text_document_native(root_str, "large.txt").is_err());
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn save_as_refuses_to_replace_an_unversioned_existing_target() {
        let root = temp_root();
        let root_str = root.to_str().expect("utf8 root");
        std::fs::write(root.join("existing.txt"), "keep\n").expect("write existing");
        let result = save_text_document_native(
            root_str,
            "existing.txt",
            "replace\n",
            None,
            TextDocumentEncoding::Utf8,
            TextDocumentLineEnding::Lf,
            true,
        )
        .expect("save as result");
        assert!(matches!(result, SaveTextDocumentResult::Conflict { .. }));
        assert_eq!(
            std::fs::read_to_string(root.join("existing.txt")).expect("read existing"),
            "keep\n"
        );
        std::fs::remove_dir_all(root).expect("cleanup");
    }
}
