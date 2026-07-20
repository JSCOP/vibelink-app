use super::git::paths::contain_path;
use super::license::LicenseService;
use anyhow::{bail, Context, Result};
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use tauri::State;

const TEXT_LIMIT: usize = 2 * 1024 * 1024;
const IMAGE_LIMIT: u64 = 64 * 1024 * 1024;

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

#[tauri::command]
pub async fn fs_list_dir(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    rel_path: String,
) -> Result<Vec<DirEntryInfo>, String> {
    entitled_spawn(license, move || list_dir_native(&workspace_folder, &rel_path)).await
}

#[tauri::command]
pub async fn fs_read_text(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    rel_path: String,
) -> Result<TextFile, String> {
    entitled_spawn(license, move || read_text_native(&workspace_folder, &rel_path)).await
}

#[tauri::command]
pub async fn fs_read_image(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    rel_path: String,
) -> Result<String, String> {
    entitled_spawn(license, move || read_base64_native(&workspace_folder, &rel_path)).await
}

#[tauri::command]
pub async fn fs_create_file(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    rel_path: String,
) -> Result<(), String> {
    entitled_spawn(license, move || create_file_native(&workspace_folder, &rel_path)).await
}

#[tauri::command]
pub async fn fs_create_dir(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    rel_path: String,
) -> Result<(), String> {
    entitled_spawn(license, move || create_dir_native(&workspace_folder, &rel_path)).await
}

#[tauri::command]
pub async fn fs_rename(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    from_rel: String,
    to_rel: String,
) -> Result<(), String> {
    entitled_spawn(license, move || rename_native(&workspace_folder, &from_rel, &to_rel)).await
}

#[tauri::command]
pub async fn fs_delete(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    rel_paths: Vec<String>,
) -> Result<(), String> {
    entitled_spawn(license, move || delete_native(&workspace_folder, &rel_paths)).await
}

#[tauri::command]
pub async fn open_in_editor(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    rel_path: String,
    editor_command: String,
) -> Result<(), String> {
    entitled_spawn(license, move || open_in_editor_native(&workspace_folder, &rel_path, &editor_command)).await
}

fn list_dir_native(root: &str, rel_path: &str) -> Result<Vec<DirEntryInfo>> {
    let directory = contain_path(Path::new(root), rel_path)?;
    if !directory.is_dir() {
        bail!("directory does not exist");
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&directory).with_context(|| format!("read {}", directory.display()))? {
        let entry = entry?;
        let metadata = std::fs::symlink_metadata(entry.path())?;
        let file_type = metadata.file_type();
        entries.push(DirEntryInfo {
            name: entry.file_name().to_string_lossy().to_string(),
            is_dir: file_type.is_dir(),
            is_symlink: file_type.is_symlink(),
            size: metadata.len(),
            modified_at: metadata.modified().ok().map(|time| DateTime::<Utc>::from(time).to_rfc3339()),
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
        content: if binary { String::new() } else { String::from_utf8_lossy(&bytes).to_string() },
        truncated,
        binary,
    })
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
    std::fs::rename(&from, &to).with_context(|| format!("rename {} to {}", from.display(), to.display()))
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
    Command::new(program)
        .args(parts)
        .arg(&path)
        .spawn()
        .with_context(|| format!("launch external editor {program}"))?;
    Ok(())
}

async fn entitled_spawn<T, F>(license: State<'_, Arc<LicenseService>>, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    license.require_entitled_cached().map_err(to_string)?;
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
    use uuid::Uuid;

    fn temp_root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("vibelink-fsops-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create root");
        root
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
        let absolute = if cfg!(windows) { r"C:\Windows\win.ini" } else { "/etc/passwd" };
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
        delete_native(root.to_str().expect("utf8 root"), &["delete.txt".to_string()]).expect("delete");
        assert!(!root.join("delete.txt").exists());
        std::fs::remove_dir_all(root).expect("cleanup");
    }
}
