use super::exec::git_write;
use super::paths::validate_repo_relative_path;
use super::to_string;
use anyhow::Result;

#[tauri::command]
pub async fn git_submodule_update(
    workspace_folder: String,
    path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || submodule_update_native(&workspace_folder, &path))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn git_submodule_sync(
    workspace_folder: String,
    path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || submodule_sync_native(&workspace_folder, &path))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

fn submodule_update_native(repo: &str, path: &str) -> Result<()> {
    validate_repo_relative_path(path)?;
    git_write(
        repo,
        ["submodule", "update", "--init", "--recursive", "--", path],
    )
    .map(|_| ())
}

fn submodule_sync_native(repo: &str, path: &str) -> Result<()> {
    validate_repo_relative_path(path)?;
    git_write(repo, ["submodule", "sync", "--recursive", "--", path]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::git::test_support::{file_url, run_git, test_repo};

    #[test]
    fn initializes_and_syncs_registered_submodule() {
        let child = test_repo();
        std::fs::write(child.join("child.txt"), "child\n").expect("write child");
        run_git(&child, &["add", "child.txt"]);
        run_git(&child, &["commit", "-m", "child"]);

        let parent = test_repo();
        run_git(&parent, &["config", "protocol.file.allow", "always"]);
        let child_url = file_url(&child);
        run_git(
            &parent,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                &child_url,
                "modules/child",
            ],
        );
        run_git(&parent, &["commit", "-am", "add submodule"]);
        run_git(
            &parent,
            &["submodule", "deinit", "-f", "--", "modules/child"],
        );

        let parent_str = parent.to_str().expect("utf8 parent");
        submodule_sync_native(parent_str, "modules/child").expect("sync submodule");
        submodule_update_native(parent_str, "modules/child").expect("update submodule");
        assert!(parent.join("modules/child/.git").is_file());
        assert!(parent.join("modules/child/child.txt").is_file());

        std::fs::remove_dir_all(parent).expect("cleanup parent");
        std::fs::remove_dir_all(child).expect("cleanup child");
    }
}
