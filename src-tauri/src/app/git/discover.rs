use super::to_string;
use crate::app::license::LicenseService;
use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::ffi::OsStr;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tauri::State;

const DEFAULT_MAX_DEPTH: u32 = 2;
const MIN_MAX_DEPTH: u32 = 1;
const MAX_MAX_DEPTH: u32 = 4;
const DISCOVERED_REPO_LIMIT: usize = 200;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredRepo {
    pub name: String,
    pub path: String,
    pub is_submodule: bool,
}

#[tauri::command]
pub async fn git_discover_repos(
    license: State<'_, Arc<LicenseService>>,
    root: String,
    max_depth: Option<u32>,
) -> Result<Vec<DiscoveredRepo>, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || discover_repos_native(&root, max_depth))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

fn discover_repos_native(root: &str, max_depth: Option<u32>) -> Result<Vec<DiscoveredRepo>> {
    let max_depth = max_depth
        .unwrap_or(DEFAULT_MAX_DEPTH)
        .clamp(MIN_MAX_DEPTH, MAX_MAX_DEPTH);
    let requested_root = Path::new(root);
    let root = requested_root.canonicalize().with_context(|| {
        format!(
            "resolve repository discovery root {}",
            requested_root.display()
        )
    })?;
    if !root.is_dir() {
        bail!("repository discovery root is not a directory");
    }

    let mut repositories = Vec::new();
    walk_repositories(&root, 0, max_depth, false, &mut repositories)?;
    repositories.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(repositories)
}

#[derive(Clone, Copy)]
enum GitMarker {
    Directory,
    File,
}

fn walk_repositories(
    directory: &Path,
    depth: u32,
    max_depth: u32,
    inside_repo: bool,
    repositories: &mut Vec<DiscoveredRepo>,
) -> Result<()> {
    if repositories.len() >= DISCOVERED_REPO_LIMIT {
        return Ok(());
    }

    let discovered_here = match git_marker(directory)? {
        Some(GitMarker::File) => {
            push_repository(directory, true, repositories);
            true
        }
        Some(GitMarker::Directory) => {
            push_repository(directory, false, repositories);
            true
        }
        None => false,
    };

    if depth >= max_depth || repositories.len() >= DISCOVERED_REPO_LIMIT {
        return Ok(());
    }

    let inside_repo = inside_repo || discovered_here;
    let mut entries = fs::read_dir(directory)
        .with_context(|| {
            format!(
                "read repository discovery directory {}",
                directory.display()
            )
        })?
        .collect::<std::io::Result<Vec<_>>>()
        .with_context(|| {
            format!(
                "read repository discovery entries in {}",
                directory.display()
            )
        })?;
    entries.sort_unstable_by(|left, right| left.file_name().cmp(&right.file_name()));
    for entry in entries {
        if repositories.len() >= DISCOVERED_REPO_LIMIT {
            break;
        }
        let file_type = entry.file_type().with_context(|| {
            format!(
                "inspect repository discovery entry {}",
                entry.path().display()
            )
        })?;
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        if is_ignored_directory(&entry.file_name()) {
            continue;
        }
        walk_repositories(
            &entry.path(),
            depth + 1,
            max_depth,
            inside_repo,
            repositories,
        )?;
    }
    Ok(())
}

fn git_marker(directory: &Path) -> Result<Option<GitMarker>> {
    let marker = directory.join(".git");
    let metadata = match fs::symlink_metadata(&marker) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("inspect Git marker {}", marker.display()))
        }
    };
    let file_type = metadata.file_type();
    if file_type.is_file() {
        Ok(Some(GitMarker::File))
    } else if file_type.is_dir() {
        Ok(Some(GitMarker::Directory))
    } else {
        Ok(None)
    }
}

fn is_ignored_directory(name: &OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_lowercase();
    name.starts_with('.')
        || matches!(
            name.as_str(),
            "node_modules" | "target" | "dist" | "build" | "out" | "vendor"
        )
}

fn push_repository(directory: &Path, is_submodule: bool, repositories: &mut Vec<DiscoveredRepo>) {
    if repositories.len() >= DISCOVERED_REPO_LIMIT {
        return;
    }
    let path = path_for_output(directory);
    let name = directory
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    repositories.push(DiscoveredRepo {
        name,
        path,
        is_submodule,
    });
}

#[cfg(windows)]
fn path_for_output(path: &Path) -> String {
    let rendered = path.to_string_lossy().replace('\\', "/");
    if let Some(tail) = rendered.strip_prefix("//?/UNC/") {
        format!("//{tail}")
    } else if let Some(tail) = rendered.strip_prefix("//?/") {
        tail.to_owned()
    } else {
        rendered
    }
}

#[cfg(not(windows))]
fn path_for_output(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use uuid::Uuid;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("vibelink-git-discovery-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).expect("create discovery fixture");
            Self(root)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn create_plain_repo(path: &Path) {
        fs::create_dir_all(path.join(".git")).expect("create plain repository");
    }

    fn create_submodule(path: &Path) {
        fs::create_dir_all(path).expect("create submodule directory");
        fs::write(path.join(".git"), b"gitdir: ../.git/modules/fixture\n")
            .expect("create submodule Git marker");
    }

    fn expected_path(path: &Path) -> String {
        path_for_output(&path.canonicalize().expect("canonical fixture path"))
    }

    fn discovered_paths(repositories: Vec<DiscoveredRepo>) -> Vec<String> {
        repositories
            .into_iter()
            .map(|repository| repository.path)
            .collect()
    }

    fn sorted_paths(mut paths: Vec<String>) -> Vec<String> {
        paths.sort();
        paths
    }

    #[test]
    fn discovers_plain_nested_and_submodule_repositories_but_skips_ignored_paths() {
        let root = TestDir::new();
        create_plain_repo(root.path());
        let submodule = root.path().join("crates").join("submodule");
        create_submodule(&submodule);
        let nested_repo = root.path().join("nested-repo");
        create_plain_repo(&nested_repo);
        let ignored_repo = root.path().join("node_modules").join("ignored");
        create_plain_repo(&ignored_repo);
        let hidden_repo = root.path().join(".hidden").join("ignored");
        create_submodule(&hidden_repo);

        let root_arg = root.path().to_string_lossy().into_owned();
        let repositories =
            discover_repos_native(&root_arg, Some(4)).expect("discover repositories");
        let root_path = expected_path(root.path());
        let submodule_path = expected_path(&submodule);
        let nested_repo_path = expected_path(&nested_repo);

        assert_eq!(repositories.len(), 3);
        let root_repo = repositories
            .iter()
            .find(|repository| repository.path == root_path)
            .expect("root repository");
        assert!(!root_repo.is_submodule);
        let discovered_submodule = repositories
            .iter()
            .find(|repository| repository.path == submodule_path)
            .expect("submodule repository");
        assert_eq!(discovered_submodule.name, "submodule");
        assert!(discovered_submodule.is_submodule);
        let discovered_nested = repositories
            .iter()
            .find(|repository| repository.path == nested_repo_path)
            .expect("nested repository");
        assert!(!discovered_nested.is_submodule);
        assert!(!repositories
            .iter()
            .any(|repository| repository.path == expected_path(&ignored_repo)));
        assert!(!repositories
            .iter()
            .any(|repository| repository.path == expected_path(&hidden_repo)));
        assert!(repositories
            .windows(2)
            .all(|pair| pair[0].path <= pair[1].path));
        assert!(repositories.iter().all(|repository| {
            Path::new(&repository.path).is_absolute() && !repository.path.contains('\\')
        }));
    }

    #[test]
    fn defaults_and_clamps_discovery_depth() {
        let root = TestDir::new();
        let depth_one = root.path().join("depth-one");
        create_plain_repo(&depth_one);
        let depth_two = root.path().join("depth-two").join("repo");
        create_plain_repo(&depth_two);
        let depth_four = root
            .path()
            .join("depth-four")
            .join("level-two")
            .join("level-three")
            .join("repo");
        create_plain_repo(&depth_four);
        let depth_five = root
            .path()
            .join("depth-five")
            .join("level-two")
            .join("level-three")
            .join("level-four")
            .join("repo");
        create_plain_repo(&depth_five);

        let root_arg = root.path().to_string_lossy().into_owned();
        assert_eq!(
            discovered_paths(discover_repos_native(&root_arg, Some(0)).expect("minimum depth")),
            vec![expected_path(&depth_one)]
        );
        assert_eq!(
            discovered_paths(discover_repos_native(&root_arg, None).expect("default depth")),
            sorted_paths(vec![expected_path(&depth_one), expected_path(&depth_two)])
        );
        assert_eq!(
            discovered_paths(
                discover_repos_native(&root_arg, Some(u32::MAX)).expect("maximum depth")
            ),
            sorted_paths(vec![
                expected_path(&depth_one),
                expected_path(&depth_two),
                expected_path(&depth_four),
            ])
        );
    }

    #[test]
    fn caps_and_sorts_discovered_repositories() {
        let root = TestDir::new();
        for index in 0..205 {
            create_plain_repo(&root.path().join(format!("repo-{index:03}")));
        }

        let root_arg = root.path().to_string_lossy().into_owned();
        let repositories = discover_repos_native(&root_arg, Some(1)).expect("capped discovery");

        assert_eq!(repositories.len(), DISCOVERED_REPO_LIMIT);
        assert!(repositories
            .windows(2)
            .all(|pair| pair[0].path <= pair[1].path));
    }

    #[cfg(windows)]
    #[test]
    fn strips_windows_verbatim_path_prefixes() {
        assert_eq!(
            path_for_output(Path::new(r"\\?\C:\workspace\repo")),
            "C:/workspace/repo"
        );
        assert_eq!(
            path_for_output(Path::new(r"\\?\UNC\server\share\repo")),
            "//server/share/repo"
        );
    }
}
