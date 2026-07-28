use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf, Prefix};

/// Root folder name used when the user has not chosen one.
pub const DEFAULT_WORKTREE_FOLDER: &str = "VibeLinkWorktrees";

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeStorageMode {
    /// Store on a drive: the source repository's drive by default, or an explicit one.
    #[default]
    Drive,
    /// Store under the flavor's app data directory.
    AppData,
    /// Store under an explicit absolute folder.
    Custom,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStorage {
    #[serde(default)]
    pub mode: WorktreeStorageMode,
    /// `""` means "same drive as the source repository"; otherwise a `C:`-style prefix.
    #[serde(default)]
    pub drive: String,
    #[serde(default)]
    pub folder_name: String,
    #[serde(default)]
    pub custom_root: String,
    #[serde(default = "default_group_by_repository")]
    pub group_by_repository: bool,
}

fn default_group_by_repository() -> bool {
    true
}

impl Default for WorktreeStorage {
    fn default() -> Self {
        Self {
            mode: WorktreeStorageMode::Drive,
            drive: String::new(),
            folder_name: DEFAULT_WORKTREE_FOLDER.to_string(),
            custom_root: String::new(),
            group_by_repository: true,
        }
    }
}

/// Resolve the requested storage root without probing the filesystem or applying
/// repository grouping. Callers remain responsible for writability fallback and
/// any per-repository subfolder.
pub fn requested_root(
    repo: &Path,
    storage: &WorktreeStorage,
    app_data_root: &Path,
) -> Result<PathBuf> {
    match storage.mode {
        WorktreeStorageMode::AppData => Ok(app_data_root.to_path_buf()),
        WorktreeStorageMode::Custom => custom_root(storage),
        WorktreeStorageMode::Drive => {
            let folder = folder_name(storage)?;
            let drive = storage.drive.trim();
            let base = if drive.is_empty() {
                drive_root(repo).ok_or_else(|| {
                    anyhow!(
                        "could not resolve the source repository drive for {}",
                        repo.to_string_lossy()
                    )
                })?
            } else {
                normalized_drive_root(drive)?
            };
            Ok(base.join(folder))
        }
    }
}

fn custom_root(storage: &WorktreeStorage) -> Result<PathBuf> {
    let custom = storage.custom_root.trim();
    if custom.is_empty() {
        bail!("custom worktree folder is not set");
    }
    let path = PathBuf::from(custom);
    if !path.is_absolute() {
        bail!("custom worktree folder must be an absolute path");
    }
    if path
        .components()
        .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        bail!("custom worktree folder must not contain relative path components");
    }
    Ok(path)
}

fn folder_name(storage: &WorktreeStorage) -> Result<String> {
    let folder = storage.folder_name.trim();
    if folder.is_empty() {
        return Ok(DEFAULT_WORKTREE_FOLDER.to_string());
    }
    if folder.contains(['/', '\\']) || folder.contains("..") {
        bail!("worktree folder name must be a single folder");
    }
    let mut components = Path::new(folder).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        bail!("worktree folder name must be a single folder");
    }
    Ok(folder.to_string())
}

fn normalized_drive_root(drive: &str) -> Result<PathBuf> {
    let trimmed = drive.trim().trim_end_matches(['\\', '/']);
    let letter = trimmed.trim_end_matches(':');
    if letter.len() != 1 || !letter.chars().all(|ch| ch.is_ascii_alphabetic()) {
        bail!("worktree drive must be a single drive letter");
    }
    Ok(PathBuf::from(format!("{}:\\", letter.to_ascii_uppercase())))
}

/// The volume root that owns `path`: the Windows drive prefix, else the filesystem
/// root. Verbatim Windows drive prefixes are re-emitted as plain `E:\\` roots
/// because `git worktree add` rejects the verbatim form.
pub(crate) fn drive_root(path: &Path) -> Option<PathBuf> {
    let mut components = path.components();
    match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => Some(PathBuf::from(format!(
                "{}:\\",
                (letter as char).to_ascii_uppercase()
            ))),
            _ => {
                let mut root = PathBuf::from(prefix.as_os_str());
                root.push(std::path::MAIN_SEPARATOR_STR);
                Some(root)
            }
        },
        Some(Component::RootDir) => Some(PathBuf::from(std::path::MAIN_SEPARATOR_STR)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn storage(mode: WorktreeStorageMode) -> WorktreeStorage {
        WorktreeStorage {
            mode,
            ..WorktreeStorage::default()
        }
    }

    #[test]
    fn app_data_mode_returns_the_supplied_root() {
        let app_data = std::env::temp_dir().join("vibelink-app-data-worktrees");
        let root = requested_root(
            Path::new("ignored-repository"),
            &storage(WorktreeStorageMode::AppData),
            &app_data,
        )
        .expect("resolve app-data root");

        assert_eq!(root, app_data);
    }

    #[test]
    fn custom_mode_requires_an_absolute_root_without_relative_components() {
        let app_data = std::env::temp_dir().join("vibelink-app-data-worktrees");
        let mut custom = storage(WorktreeStorageMode::Custom);
        custom.custom_root = "relative/worktrees".to_string();
        assert!(requested_root(Path::new("repo"), &custom, &app_data).is_err());

        custom.custom_root = std::env::temp_dir()
            .join("safe")
            .join("..")
            .join("escape")
            .to_string_lossy()
            .to_string();
        assert!(requested_root(Path::new("repo"), &custom, &app_data).is_err());

        let expected = std::env::temp_dir().join("vibelink-custom-worktrees");
        custom.custom_root = expected.to_string_lossy().to_string();
        assert_eq!(
            requested_root(Path::new("repo"), &custom, &app_data).expect("resolve custom root"),
            expected
        );
    }

    #[test]
    fn drive_mode_uses_the_source_volume_and_default_folder() {
        let repo = std::env::temp_dir().join("vibelink-repository");
        let expected = drive_root(&repo)
            .expect("resolve source volume")
            .join(DEFAULT_WORKTREE_FOLDER);

        assert_eq!(
            requested_root(
                &repo,
                &storage(WorktreeStorageMode::Drive),
                Path::new("unused-app-data"),
            )
            .expect("resolve drive root"),
            expected
        );
    }

    #[test]
    fn drive_mode_rejects_nested_or_escaping_folder_names() {
        let repo = std::env::temp_dir().join("vibelink-repository");
        for folder in ["a/b", "a\\b", ".", "..", "safe..escape"] {
            let mut drive = storage(WorktreeStorageMode::Drive);
            drive.folder_name = folder.to_string();
            assert!(
                requested_root(&repo, &drive, Path::new("unused-app-data")).is_err(),
                "accepted unsafe folder {folder:?}"
            );
        }
    }

    #[test]
    fn drive_mode_normalizes_an_explicit_drive_and_folder() {
        let mut drive = storage(WorktreeStorageMode::Drive);
        drive.drive = " e://// ".to_string();
        drive.folder_name = "TeamWorktrees".to_string();

        assert_eq!(
            requested_root(
                Path::new("unused-repository"),
                &drive,
                Path::new("unused-app-data"),
            )
            .expect("resolve explicit drive"),
            PathBuf::from("E:\\").join("TeamWorktrees")
        );
    }
}
