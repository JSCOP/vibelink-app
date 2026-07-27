use super::exec::{git_read, git_read_allow_fail, git_write};
use super::paths::validate_base_ref;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf, Prefix};
use uuid::Uuid;

/// Folder created inside the app data root when worktrees are stored there.
const APP_DATA_WORKTREE_DIR: &str = "worktrees";
/// Root folder name used when the user has not chosen one.
pub(crate) const DEFAULT_WORKTREE_FOLDER: &str = "VibeLinkWorktrees";

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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStorageOptions {
    pub drives: Vec<String>,
    pub app_data_root: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStorageResolution {
    pub root: String,
    pub example: String,
    pub writable: bool,
    pub fallback_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub worktree_path: String,
    pub branch: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub worktree_path: String,
    pub branch: String,
    pub head: String,
    pub is_main: bool,
    pub locked: bool,
    pub prunable: bool,
    pub dirty: bool,
    pub exists: bool,
}

pub(crate) fn app_data_worktree_root() -> Result<PathBuf> {
    Ok(crate::daemon::paths::daemon_paths()?
        .data_dir
        .join(APP_DATA_WORKTREE_DIR))
}

pub fn storage_options() -> Result<WorktreeStorageOptions> {
    Ok(WorktreeStorageOptions {
        drives: available_drives(),
        app_data_root: app_data_worktree_root()?.to_string_lossy().to_string(),
    })
}

/// Resolve the effective root for `storage`, falling back to app data when the
/// requested location cannot hold a checkout.
pub fn resolve_root(
    repo: &str,
    storage: &WorktreeStorage,
    name: Option<&str>,
) -> Result<WorktreeStorageResolution> {
    let app_data_root = app_data_worktree_root()?;
    let (requested, requested_error) = match requested_root(repo, storage) {
        Ok(root) => (Some(root), None),
        Err(error) => (None, Some(error.to_string())),
    };

    let (base, fallback_reason) = match requested {
        Some(root) => match probe_writable(&root) {
            Ok(()) => (root, None),
            Err(error) => (app_data_root.clone(), Some(error.to_string())),
        },
        None => (app_data_root.clone(), requested_error),
    };

    let root = if storage.group_by_repository {
        base.join(repository_folder(repo))
    } else {
        base
    };
    let slug = name.map(slug_worktree_name).unwrap_or_default();
    let leaf = if slug.is_empty() {
        "<name>-<id>".to_string()
    } else {
        format!("{slug}-<id>")
    };

    Ok(WorktreeStorageResolution {
        example: root.join(leaf).to_string_lossy().to_string(),
        root: root.to_string_lossy().to_string(),
        writable: fallback_reason.is_none(),
        fallback_reason,
    })
}

pub fn create_named(
    repo: &str,
    name: &str,
    start_ref: &str,
    branch: &str,
    storage: &WorktreeStorage,
) -> Result<WorktreeInfo> {
    let root = PathBuf::from(resolve_root(repo, storage, None)?.root);
    create_named_at(repo, name, start_ref, branch, &root)
}

pub(crate) fn create_named_at(
    repo: &str,
    name: &str,
    start_ref: &str,
    branch: &str,
    worktree_root: &Path,
) -> Result<WorktreeInfo> {
    let slug = slug_worktree_name(name);
    if slug.is_empty() {
        bail!("worktree name must contain a letter or number");
    }
    validate_base_ref(start_ref)?;
    validate_base_ref(branch)?;
    let commit_ref = format!("{start_ref}^{{commit}}");
    git_write(repo, ["rev-parse", "--verify", "--quiet", &commit_ref])
        .with_context(|| format!("resolve worktree start ref {start_ref}"))?;
    git_write(repo, ["check-ref-format", "--branch", branch])
        .with_context(|| format!("validate worktree branch {branch}"))?;

    let unique = Uuid::new_v4().simple().to_string();
    let worktree_path = worktree_root.join(format!("{slug}-{}", &unique[..8]));
    std::fs::create_dir_all(worktree_root).with_context(|| {
        format!(
            "create worktree storage root {}",
            worktree_root.to_string_lossy()
        )
    })?;
    let path_string = worktree_path.to_string_lossy().to_string();
    git_write(
        repo,
        ["worktree", "add", "-b", branch, &path_string, start_ref],
    )?;
    Ok(WorktreeInfo {
        worktree_path: path_string,
        branch: branch.to_string(),
    })
}

pub fn create_for_task(repo: &str, task_id: &str) -> Result<WorktreeInfo> {
    let short = short_task_id(task_id);
    let branch = format!("vibelink/task-{short}");
    let worktree_path = app_data_worktree_root()?.join("tasks").join(&short);
    std::fs::create_dir_all(
        worktree_path
            .parent()
            .ok_or_else(|| anyhow!("task worktree path has no parent"))?,
    )?;
    let path_string = worktree_path.to_string_lossy().to_string();
    git_write(
        repo,
        ["worktree", "add", "-b", &branch, &path_string, "HEAD"],
    )?;
    Ok(WorktreeInfo {
        worktree_path: path_string,
        branch,
    })
}

pub fn list(repo: &str) -> Result<Vec<WorktreeEntry>> {
    let output = git_read(repo, ["worktree", "list", "--porcelain"])?;
    let mut entries = parse_worktree_list(&String::from_utf8_lossy(&output));
    for entry in entries.iter_mut() {
        entry.exists = Path::new(&entry.worktree_path).is_dir();
        entry.dirty = entry.exists && is_dirty(&entry.worktree_path);
    }
    Ok(entries)
}

pub fn remove(
    repo: &str,
    worktree_path: &str,
    branch: &str,
    force: bool,
    delete_branch: bool,
) -> Result<()> {
    let mut remove_args = vec!["worktree", "remove"];
    if force {
        remove_args.push("--force");
    }
    remove_args.push(worktree_path);
    if let Err(error) = git_write(repo, remove_args) {
        // A directory removed outside VibeLink leaves only a stale registration.
        if !is_missing_worktree_error(&error.to_string()) {
            return Err(error);
        }
        git_write(repo, ["worktree", "prune"])?;
    }
    if delete_branch && !branch.is_empty() {
        validate_base_ref(branch)?;
        git_write(repo, ["branch", "-D", branch])?;
    }
    Ok(())
}

pub fn move_to(repo: &str, worktree_path: &str, destination: &str) -> Result<WorktreeInfo> {
    let destination_path = validate_destination(destination)?;
    if let Some(parent) = destination_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create destination parent {}", parent.to_string_lossy()))?;
    }
    let destination_string = destination_path.to_string_lossy().to_string();
    git_write(
        repo,
        ["worktree", "move", worktree_path, &destination_string],
    )?;
    let branch = git_read_allow_fail(
        &destination_string,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "HEAD"],
    )?
    .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
    .filter(|branch| !branch.is_empty() && branch != "HEAD")
    .unwrap_or_default();
    Ok(WorktreeInfo {
        worktree_path: destination_string,
        branch,
    })
}

fn requested_root(repo: &str, storage: &WorktreeStorage) -> Result<PathBuf> {
    match storage.mode {
        WorktreeStorageMode::AppData => app_data_worktree_root(),
        WorktreeStorageMode::Custom => {
            let custom = storage.custom_root.trim();
            if custom.is_empty() {
                bail!("custom worktree folder is not set");
            }
            let path = PathBuf::from(custom);
            if !path.is_absolute() {
                bail!("custom worktree folder must be an absolute path");
            }
            Ok(path)
        }
        WorktreeStorageMode::Drive => {
            let folder = folder_name(storage)?;
            let drive = storage.drive.trim();
            let base = if drive.is_empty() {
                drive_root(Path::new(repo)).ok_or_else(|| {
                    anyhow!("could not resolve the source repository drive for {repo}")
                })?
            } else {
                normalized_drive_root(drive)?
            };
            Ok(base.join(folder))
        }
    }
}

fn folder_name(storage: &WorktreeStorage) -> Result<String> {
    let folder = storage.folder_name.trim();
    if folder.is_empty() {
        return Ok(DEFAULT_WORKTREE_FOLDER.to_string());
    }
    if folder.contains(['/', '\\']) || folder.contains("..") {
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
/// root. `canonicalize` returns a `\\?\` verbatim prefix that `git worktree add`
/// rejects ("could not create leading directories"), so the drive letter is
/// re-emitted as a plain `E:\` root.
fn drive_root(path: &Path) -> Option<PathBuf> {
    let absolute = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut components = absolute.components();
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

fn available_drives() -> Vec<String> {
    #[cfg(windows)]
    {
        ('A'..='Z')
            .filter(|letter| Path::new(&format!("{letter}:\\")).is_dir())
            .map(|letter| format!("{letter}:"))
            .collect()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Confirm a checkout can be created under `root` without leaving a probe behind.
fn probe_writable(root: &Path) -> Result<()> {
    let existing = nearest_existing_ancestor(root)
        .ok_or_else(|| anyhow!("{} is not available", root.to_string_lossy()))?;
    let probe = existing.join(format!(".vibelink-probe-{}", Uuid::new_v4().simple()));
    std::fs::create_dir(&probe)
        .with_context(|| format!("{} is not writable", existing.to_string_lossy()))?;
    let _ = std::fs::remove_dir(&probe);
    Ok(())
}

fn nearest_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        if candidate.is_dir() {
            return Some(candidate.to_path_buf());
        }
        current = candidate.parent();
    }
    None
}

/// Stable per-repository folder so several repositories can share one root.
fn repository_folder(repo: &str) -> String {
    let normalized = repo.replace('\\', "/");
    let normalized = normalized.trim_end_matches('/');
    let name = normalized
        .rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or("repository");
    let slug = slug_worktree_name(name);
    let slug = if slug.is_empty() {
        "repository".to_string()
    } else {
        slug
    };
    format!("{slug}-{}", path_hash(&normalized.to_ascii_lowercase()))
}

fn path_hash(value: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")[..8].to_string()
}

pub(crate) fn slug_worktree_name(name: &str) -> String {
    let mut slug = String::with_capacity(name.len());
    let mut separator_pending = false;
    for ch in name.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            if separator_pending && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(ch.to_ascii_lowercase());
            separator_pending = false;
        } else if !slug.is_empty() {
            separator_pending = true;
        }
    }
    slug
}

/// Full production-path smoke over a real repository: default drive resolution,
/// create, list, move, and remove-with-branch. Opt in with
/// `VIBELINK_SMOKE_WORKTREE_REPO=<path> cargo test --bin app storage_smoke -- --ignored --nocapture`.
#[cfg(test)]
#[test]
#[ignore = "requires VIBELINK_SMOKE_WORKTREE_REPO pointing at a real repository"]
fn storage_smoke_over_a_real_repository() {
    let Ok(repo) = std::env::var("VIBELINK_SMOKE_WORKTREE_REPO") else {
        panic!("set VIBELINK_SMOKE_WORKTREE_REPO to a real repository path");
    };
    let unique = Uuid::new_v4().simple().to_string();
    let branch = format!("vibelink/storage-smoke-{}", &unique[..8]);
    let storage = WorktreeStorage::default();
    let resolved = resolve_root(&repo, &storage, Some("Storage Smoke")).expect("resolve root");
    println!("root={} example={}", resolved.root, resolved.example);
    assert!(resolved.writable, "{:?}", resolved.fallback_reason);
    assert_eq!(
        drive_root(Path::new(&resolved.root)),
        drive_root(Path::new(&repo)),
        "default storage must stay on the repository's drive"
    );
    assert!(
        !resolved.root.contains(r"\\?\"),
        "git rejects verbatim \\\\?\\ roots: {}",
        resolved.root
    );

    let created =
        create_named(&repo, "Storage Smoke", "HEAD", &branch, &storage).expect("create worktree");
    assert!(Path::new(&created.worktree_path).is_dir());
    assert!(list(&repo)
        .expect("list")
        .iter()
        .any(|entry| entry.branch == created.branch && !entry.is_main && entry.exists));

    let destination =
        Path::new(&resolved.root).join(format!("storage-smoke-moved-{}", &unique[..8]));
    let moved = move_to(
        &repo,
        &created.worktree_path,
        destination.to_str().expect("utf8 destination"),
    )
    .expect("move worktree");
    assert!(destination.is_dir() && !Path::new(&created.worktree_path).exists());

    remove(&repo, &moved.worktree_path, &moved.branch, false, true).expect("remove worktree");
    assert!(!destination.exists());
    let remaining = list(&repo).expect("list after removal");
    assert!(remaining.iter().all(|entry| entry.branch != created.branch));
    assert!(remaining.iter().any(|entry| entry.is_main));
    println!(
        "smoke complete: created, listed, moved, and removed {}",
        moved.branch
    );
}

fn validate_destination(destination: &str) -> Result<PathBuf> {
    let trimmed = destination.trim();
    if trimmed.is_empty() {
        bail!("destination path is required");
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        bail!("destination path must be absolute");
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        bail!("destination path must not contain '..'");
    }
    if path.exists() {
        bail!("destination path already exists");
    }
    Ok(path)
}

fn is_dirty(worktree_path: &str) -> bool {
    git_read(
        worktree_path,
        ["status", "--porcelain", "--untracked-files=all"],
    )
    .map(|bytes| !String::from_utf8_lossy(&bytes).trim().is_empty())
    .unwrap_or(false)
}

fn is_missing_worktree_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("is not a working tree") || message.contains("no such file or directory")
}

pub(crate) fn parse_worktree_list(output: &str) -> Vec<WorktreeEntry> {
    let mut entries: Vec<WorktreeEntry> = Vec::new();
    for line in output.lines() {
        let line = line.trim_end();
        if let Some(path) = line.strip_prefix("worktree ") {
            entries.push(WorktreeEntry {
                worktree_path: path.to_string(),
                branch: String::new(),
                head: String::new(),
                is_main: entries.is_empty(),
                locked: false,
                prunable: false,
                dirty: false,
                exists: false,
            });
            continue;
        }
        let Some(entry) = entries.last_mut() else {
            continue;
        };
        if let Some(head) = line.strip_prefix("HEAD ") {
            entry.head = head.to_string();
        } else if let Some(branch) = line.strip_prefix("branch ") {
            entry.branch = branch.trim_start_matches("refs/heads/").to_string();
        } else if line == "locked" || line.starts_with("locked ") {
            entry.locked = true;
        } else if line == "prunable" || line.starts_with("prunable ") {
            entry.prunable = true;
        }
    }
    entries
}

fn short_task_id(task_id: &str) -> String {
    let short: String = task_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .take(12)
        .collect();
    if short.is_empty() {
        "task".to_string()
    } else {
        short
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
    fn drive_mode_defaults_to_the_repository_drive() {
        let repo = std::env::temp_dir().join(format!("vibelink-storage-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&repo).expect("create repo");
        let resolved = resolve_root(
            repo.to_str().expect("utf8 repo"),
            &storage(WorktreeStorageMode::Drive),
            Some("Fix Login"),
        )
        .expect("resolve root");

        let expected_drive = drive_root(&repo).expect("repo drive");
        assert!(resolved.writable, "{:?}", resolved.fallback_reason);
        assert!(Path::new(&resolved.root).starts_with(expected_drive.join(DEFAULT_WORKTREE_FOLDER)));
        assert!(resolved.example.ends_with("fix-login-<id>"));
        std::fs::remove_dir_all(repo).expect("cleanup repo");
    }

    #[test]
    fn grouping_toggle_controls_the_repository_folder() {
        let repo = std::env::temp_dir().join(format!("vibelink-storage-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&repo).expect("create repo");
        let repo_str = repo.to_str().expect("utf8 repo");
        let mut flat = storage(WorktreeStorageMode::Drive);
        flat.group_by_repository = false;

        let grouped = resolve_root(repo_str, &storage(WorktreeStorageMode::Drive), None)
            .expect("grouped root");
        let ungrouped = resolve_root(repo_str, &flat, None).expect("ungrouped root");

        assert_eq!(
            Path::new(&grouped.root).parent().expect("grouped parent"),
            Path::new(&ungrouped.root)
        );
        assert!(Path::new(&grouped.root)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(&format!(
                "{}-",
                slug_worktree_name(repo.file_name().unwrap().to_str().unwrap())
            ))));
        std::fs::remove_dir_all(repo).expect("cleanup repo");
    }

    #[test]
    fn unusable_custom_root_falls_back_to_app_data() {
        let repo = std::env::temp_dir().join(format!("vibelink-storage-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&repo).expect("create repo");
        let mut custom = storage(WorktreeStorageMode::Custom);
        custom.custom_root = "relative/path".to_string();

        let resolved =
            resolve_root(repo.to_str().expect("utf8 repo"), &custom, None).expect("resolve root");

        assert!(!resolved.writable);
        assert!(resolved
            .fallback_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("absolute")));
        assert!(
            Path::new(&resolved.root).starts_with(app_data_worktree_root().expect("app data root"))
        );
        std::fs::remove_dir_all(repo).expect("cleanup repo");
    }

    #[test]
    fn folder_name_rejects_nested_or_escaping_values() {
        let mut nested = storage(WorktreeStorageMode::Drive);
        nested.folder_name = "a/b".to_string();
        assert!(folder_name(&nested).is_err());
        nested.folder_name = "..".to_string();
        assert!(folder_name(&nested).is_err());
        nested.folder_name = "  ".to_string();
        assert_eq!(
            folder_name(&nested).expect("blank falls back"),
            DEFAULT_WORKTREE_FOLDER
        );
    }

    #[test]
    fn porcelain_list_marks_main_branch_lock_and_prunable() {
        let entries = parse_worktree_list(concat!(
            "worktree C:/repo\nHEAD aaaa\nbranch refs/heads/main\n\n",
            "worktree C:/wt/one\nHEAD bbbb\nbranch refs/heads/vibelink/one\nlocked portable\n\n",
            "worktree C:/wt/two\nHEAD cccc\ndetached\nprunable gitdir file points to non-existent location\n\n",
        ));

        assert_eq!(entries.len(), 3);
        assert!(entries[0].is_main && entries[0].branch == "main");
        assert!(!entries[1].is_main && entries[1].locked && entries[1].branch == "vibelink/one");
        assert!(entries[2].prunable && entries[2].branch.is_empty());
    }

    #[test]
    fn move_destination_must_be_absolute_new_and_contained() {
        assert!(validate_destination("  ").is_err());
        assert!(validate_destination("relative/dir").is_err());
        let existing = std::env::temp_dir();
        assert!(validate_destination(existing.to_str().expect("utf8 temp")).is_err());
        let fresh = existing.join(format!("vibelink-move-{}", Uuid::new_v4()));
        assert!(validate_destination(fresh.to_str().expect("utf8 fresh")).is_ok());
    }
}
