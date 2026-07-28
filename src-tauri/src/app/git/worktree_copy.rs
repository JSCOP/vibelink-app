use super::worktree_operation::{WorktreeCancellation, WorktreeCommandFailure};
use anyhow::{bail, Context, Result};
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

const COPY_CHUNK_BYTES: usize = 64 * 1024;
pub(crate) const LINKED_FILE_BUDGET_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct WorktreeCopyJournal {
    pub copied_files: Vec<PathBuf>,
    pub created_directories: Vec<PathBuf>,
    pub copied_bytes: u64,
}

pub(crate) fn validate_linked_file_paths(paths: &[String]) -> Result<Vec<PathBuf>> {
    let mut seen = HashSet::new();
    let mut validated = Vec::with_capacity(paths.len());
    for path in paths {
        let relative = validate_relative_file_path(path)?;
        let mut key = relative.to_string_lossy().replace('\\', "/");
        #[cfg(windows)]
        key.make_ascii_lowercase();
        if !seen.insert(key) {
            bail!("linked file paths must not contain duplicates");
        }
        validated.push(relative);
    }
    Ok(validated)
}

pub(crate) fn validate_regular_file_sources(
    source_root: &Path,
    relative_paths: &[PathBuf],
) -> Result<u64> {
    let source_root = canonical_safe_directory(source_root, "source repository")?;
    let mut total = 0u64;
    for relative in relative_paths {
        let source = resolve_existing_regular_file(&source_root, relative)?;
        let length = std::fs::symlink_metadata(&source)?.len();
        total = total
            .checked_add(length)
            .context("linked-file source size overflowed")?;
        if total > LINKED_FILE_BUDGET_BYTES {
            bail!("linked-file sources exceed the 2 GiB operation budget");
        }
    }
    Ok(total)
}

pub(crate) fn copy_regular_files(
    source_root: &Path,
    destination_root: &Path,
    relative_paths: &[PathBuf],
    cancellation: &WorktreeCancellation,
) -> Result<WorktreeCopyJournal> {
    let source_root = canonical_safe_directory(source_root, "source repository")?;
    let destination_root = canonical_safe_directory(destination_root, "destination worktree")?;
    let mut journal = WorktreeCopyJournal::default();

    for relative in relative_paths {
        check_cancelled(cancellation)?;
        let source = resolve_existing_regular_file(&source_root, relative)?;
        let destination = prepare_destination_file(
            &destination_root,
            relative,
            &mut journal.created_directories,
        )?;
        let remaining = LINKED_FILE_BUDGET_BYTES
            .checked_sub(journal.copied_bytes)
            .context("linked-file copy budget was exceeded")?;
        let copied = match copy_one_bounded(&source, &destination, remaining, cancellation) {
            Ok(copied) => copied,
            Err(error) => {
                let _ = std::fs::remove_file(&destination);
                rollback_empty_directories(&journal.created_directories);
                return Err(error);
            }
        };
        journal.copied_bytes += copied;
        journal.copied_files.push(destination);
    }
    Ok(journal)
}

pub(crate) fn rollback_copy_journal(journal: &WorktreeCopyJournal) {
    for file in journal.copied_files.iter().rev() {
        let _ = std::fs::remove_file(file);
    }
    rollback_empty_directories(&journal.created_directories);
}

fn validate_relative_file_path(path: &str) -> Result<PathBuf> {
    let value = PathBuf::from(path);
    if value.as_os_str().is_empty() || value.is_absolute() {
        bail!("linked file path must be a non-empty relative path");
    }
    for component in value.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir => bail!("linked file path must not contain '.' components"),
            Component::ParentDir => bail!("linked file path must not contain '..' components"),
            Component::Prefix(_) | Component::RootDir => {
                bail!("linked file path must not contain a root or volume prefix")
            }
        }
    }
    Ok(value)
}

fn canonical_safe_directory(path: &Path, label: &str) -> Result<PathBuf> {
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("inspect {label} {}", path.display()))?;
    if !metadata.is_dir() || is_link_or_reparse(&metadata) {
        bail!("{label} must be a regular directory without symlink or reparse indirection");
    }
    path.canonicalize()
        .with_context(|| format!("canonicalize {label} {}", path.display()))
}

fn resolve_existing_regular_file(root: &Path, relative: &Path) -> Result<PathBuf> {
    let mut current = root.to_path_buf();
    let components = relative.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(component) = component else {
            bail!("linked file path contains an unsafe component");
        };
        current.push(component);
        let metadata = std::fs::symlink_metadata(&current)
            .with_context(|| format!("inspect linked file source {}", current.display()))?;
        if is_link_or_reparse(&metadata) {
            bail!(
                "linked file source crosses a symlink or reparse point: {}",
                current.display()
            );
        }
        let canonical = current
            .canonicalize()
            .with_context(|| format!("canonicalize linked file source {}", current.display()))?;
        ensure_contained(root, &canonical, "linked file source")?;
        if index + 1 == components.len() {
            if !metadata.is_file() {
                bail!(
                    "linked file source is not a regular file: {}",
                    current.display()
                );
            }
            return Ok(canonical);
        }
        if !metadata.is_dir() {
            bail!(
                "linked file source parent is not a directory: {}",
                current.display()
            );
        }
        current = canonical;
    }
    bail!("linked file path is empty")
}

fn prepare_destination_file(
    root: &Path,
    relative: &Path,
    created_directories: &mut Vec<PathBuf>,
) -> Result<PathBuf> {
    let mut current = root.to_path_buf();
    let components = relative.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(component) = component else {
            bail!("linked file destination contains an unsafe component");
        };
        current.push(component);
        let last = index + 1 == components.len();
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if is_link_or_reparse(&metadata) {
                    bail!(
                        "linked file destination crosses a symlink or reparse point: {}",
                        current.display()
                    );
                }
                if last {
                    bail!(
                        "linked-file destination already exists: {}",
                        current.display()
                    );
                }
                if !metadata.is_dir() {
                    bail!(
                        "linked file destination parent is not a directory: {}",
                        current.display()
                    );
                }
                let canonical = current.canonicalize().with_context(|| {
                    format!("canonicalize linked file destination {}", current.display())
                })?;
                ensure_contained(root, &canonical, "linked file destination")?;
                current = canonical;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if last {
                    let parent = current
                        .parent()
                        .context("linked file destination has no parent")?
                        .canonicalize()
                        .with_context(|| {
                            format!(
                                "canonicalize linked file destination parent {}",
                                current.display()
                            )
                        })?;
                    ensure_contained(root, &parent, "linked file destination")?;
                    return Ok(current);
                }
                std::fs::create_dir(&current).with_context(|| {
                    format!(
                        "create linked file destination directory {}",
                        current.display()
                    )
                })?;
                let canonical = current.canonicalize().with_context(|| {
                    format!("canonicalize linked file destination {}", current.display())
                })?;
                ensure_contained(root, &canonical, "linked file destination")?;
                created_directories.push(canonical.clone());
                current = canonical;
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("inspect linked file destination {}", current.display())
                })
            }
        }
    }
    bail!("linked file destination path is empty")
}

fn copy_one_bounded(
    source: &Path,
    destination: &Path,
    remaining_budget: u64,
    cancellation: &WorktreeCancellation,
) -> Result<u64> {
    let source_metadata = std::fs::symlink_metadata(source)
        .with_context(|| format!("inspect linked file source {}", source.display()))?;
    if !source_metadata.is_file() || is_link_or_reparse(&source_metadata) {
        bail!(
            "linked file source is not a regular file: {}",
            source.display()
        );
    }
    if source_metadata.len() > remaining_budget {
        bail!("linked-file copy exceeds the 2 GiB operation budget");
    }

    let mut source_file = File::open(source)
        .with_context(|| format!("open linked file source {}", source.display()))?;
    let mut destination_file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .with_context(|| format!("create linked file destination {}", destination.display()))?;
    let mut buffer = vec![0u8; COPY_CHUNK_BYTES];
    let mut copied = 0u64;
    loop {
        check_cancelled(cancellation)?;
        let read = source_file
            .read(&mut buffer)
            .with_context(|| format!("read linked file source {}", source.display()))?;
        if read == 0 {
            break;
        }
        let next = copied
            .checked_add(read as u64)
            .context("linked-file copy byte count overflowed")?;
        if next > remaining_budget {
            bail!("linked-file grew beyond the remaining 2 GiB operation budget while copying");
        }
        destination_file
            .write_all(&buffer[..read])
            .with_context(|| format!("write linked file destination {}", destination.display()))?;
        copied = next;
    }
    destination_file
        .flush()
        .with_context(|| format!("flush linked file destination {}", destination.display()))?;
    Ok(copied)
}

fn rollback_empty_directories(directories: &[PathBuf]) {
    for directory in directories.iter().rev() {
        let _ = std::fs::remove_dir(directory);
    }
}

fn ensure_contained(root: &Path, candidate: &Path, label: &str) -> Result<()> {
    if candidate == root || candidate.starts_with(root) {
        Ok(())
    } else {
        bail!(
            "{label} escapes its canonical root: {}",
            candidate.display()
        )
    }
}

fn check_cancelled(cancellation: &WorktreeCancellation) -> Result<()> {
    cancellation.check().map_err(|error| match error {
        WorktreeCommandFailure::Cancelled { .. } => anyhow::anyhow!(error),
        _ => anyhow::anyhow!(error),
    })
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_dir(label: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("vibelink-worktree-copy-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create temp directory");
        path
    }

    #[test]
    fn linked_paths_reject_absolute_and_traversal_components() {
        assert!(validate_linked_file_paths(&["../secret".into()]).is_err());
        assert!(validate_linked_file_paths(&["./file".into()]).is_err());
        let absolute = std::env::temp_dir().join("absolute-file");
        assert!(validate_linked_file_paths(&[absolute.to_string_lossy().to_string()]).is_err());
    }

    #[test]
    fn regular_file_copy_is_streamed_and_never_overwrites() {
        let source = temp_dir("source");
        let destination = temp_dir("destination");
        std::fs::create_dir(source.join("config")).expect("create source parent");
        std::fs::write(source.join("config/settings.json"), b"safe-copy").expect("write source");
        let relative = validate_linked_file_paths(&["config/settings.json".into()])
            .expect("validate relative path");
        let journal = copy_regular_files(
            &source,
            &destination,
            &relative,
            &WorktreeCancellation::default(),
        )
        .expect("copy regular file");
        assert_eq!(journal.copied_bytes, 9);
        assert_eq!(
            std::fs::read(destination.join("config/settings.json")).expect("read destination"),
            b"safe-copy"
        );
        assert!(copy_regular_files(
            &source,
            &destination,
            &relative,
            &WorktreeCancellation::default(),
        )
        .is_err());
    }

    #[test]
    fn remaining_budget_limits_source_size_before_copy() {
        let source = temp_dir("budget-source");
        let destination = temp_dir("budget-destination");
        let source_file = source.join("large.bin");
        let destination_file = destination.join("large.bin");
        std::fs::write(&source_file, b"123").expect("write source");
        assert!(copy_one_bounded(
            &source_file,
            &destination_file,
            2,
            &WorktreeCancellation::default(),
        )
        .is_err());
        assert!(!destination_file.exists());
    }
}
