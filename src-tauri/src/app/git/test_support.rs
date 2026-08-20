#[cfg(windows)]
use super::exec::CREATE_NO_WINDOW;
use std::path::{Path, PathBuf};
use std::process::Command;
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub(crate) fn test_repo() -> PathBuf {
    let repo = unique_path("repo");
    std::fs::create_dir_all(&repo).expect("create repo");
    run_git_at(&repo, &["init"]);
    run_git(&repo, &["config", "user.email", "vibelink@example.invalid"]);
    run_git(&repo, &["config", "user.name", "VibeLink Test"]);
    repo
}

pub(crate) fn unique_path(kind: &str) -> PathBuf {
    std::env::temp_dir().join(format!("vibelink-git-{kind}-{}", Uuid::new_v4()))
}

pub(crate) fn run_git(repo: &Path, args: &[&str]) -> Vec<u8> {
    let repo_str = repo.to_str().expect("utf8 path");
    let mut scoped_args = vec!["-C", repo_str];
    scoped_args.extend_from_slice(args);
    run_git_at(repo, &scoped_args)
}

pub(crate) fn run_git_at(cwd: &Path, args: &[&str]) -> Vec<u8> {
    let mut command = Command::new("git");
    command.current_dir(cwd).args(args);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().expect("run git");
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

pub(crate) fn file_url(path: &Path) -> String {
    format!("file:///{}", path.to_string_lossy().replace('\\', "/"))
}
