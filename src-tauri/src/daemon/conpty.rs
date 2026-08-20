#[cfg(windows)]
use std::path::{Path, PathBuf};

#[cfg(windows)]
const CONPTY_DLL: &str = "conpty.dll";
#[cfg(windows)]
const OPEN_CONSOLE_EXE: &str = "OpenConsole.exe";

#[cfg(windows)]
fn resolve_bundle_dir<I>(candidates: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = PathBuf>,
{
    candidates.into_iter().find(|candidate| {
        candidate.join(CONPTY_DLL).is_file() && candidate.join(OPEN_CONSOLE_EXE).is_file()
    })
}

#[cfg(windows)]
struct LoadedConpty {
    dir: PathBuf,
    // LoadLibraryExW increments the module reference count. Retaining the handle
    // here documents that it is intentionally never passed to FreeLibrary.
    _module: isize,
}

#[cfg(windows)]
fn absolute_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(path))
                .unwrap_or_else(|_| path.to_path_buf())
        }
    })
}

#[cfg(windows)]
fn module_file_name(module: windows::Win32::Foundation::HMODULE) -> Option<PathBuf> {
    use windows::Win32::System::LibraryLoader::GetModuleFileNameW;

    let mut capacity = 260_usize;
    while capacity <= 32_768 {
        let mut buffer = vec![0_u16; capacity];
        let len = unsafe { GetModuleFileNameW(Some(module), &mut buffer) } as usize;
        if len == 0 {
            return None;
        }
        if len < buffer.len() {
            buffer.truncate(len);
            return Some(PathBuf::from(String::from_utf16_lossy(&buffer)));
        }
        capacity *= 2;
    }
    None
}

#[cfg(windows)]
fn windows_paths_equal(left: &Path, right: &Path) -> bool {
    let left = std::fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = std::fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

#[cfg(windows)]
fn load_bundled_conpty() -> Option<LoadedConpty> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::System::LibraryLoader::{LoadLibraryExW, LOAD_WITH_ALTERED_SEARCH_PATH},
    };

    let mut candidates = Vec::with_capacity(3);
    if let Some(configured) = std::env::var_os("VIBELINK_CONPTY_DIR") {
        candidates.push(PathBuf::from(configured));
    }
    match std::env::current_exe() {
        Ok(exe) => {
            if let Some(exe_dir) = exe.parent() {
                candidates.push(exe_dir.to_path_buf());
                candidates.push(exe_dir.join("resources").join("conpty").join("x64"));
            }
        }
        Err(err) => tracing::warn!(
            ?err,
            "failed to resolve current executable while locating bundled ConPTY"
        ),
    }

    let Some(dir) = resolve_bundle_dir(candidates.iter().cloned()) else {
        tracing::warn!(
            searched_directories = ?candidates,
            "bundled ConPTY runtime is missing; falling back to the system ConPTY"
        );
        return None;
    };

    let intended_dll = absolute_path(&dir.join(CONPTY_DLL));
    let intended_dir = intended_dll
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| absolute_path(&dir));
    let wide: Vec<u16> = intended_dll
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let module =
        match unsafe { LoadLibraryExW(PCWSTR(wide.as_ptr()), None, LOAD_WITH_ALTERED_SEARCH_PATH) }
        {
            Ok(module) => module,
            Err(err) => {
                tracing::warn!(
                    ?err,
                    path = %intended_dll.display(),
                    "failed to preload bundled ConPTY; falling back to the system ConPTY"
                );
                return None;
            }
        };

    let loaded_path = module_file_name(module);
    match &loaded_path {
        Some(loaded) if !windows_paths_equal(loaded, &intended_dll) => tracing::warn!(
            intended = %intended_dll.display(),
            loaded = %loaded.display(),
            "preloaded ConPTY module path does not match the intended bundled runtime"
        ),
        None => tracing::warn!(
            intended = %intended_dll.display(),
            "failed to verify the preloaded ConPTY module path"
        ),
        _ => {}
    }

    tracing::info!(
        path = %intended_dll.display(),
        "preloaded VibeLink bundled ConPTY runtime"
    );
    Some(LoadedConpty {
        dir: intended_dir,
        _module: module.0 as isize,
    })
}

/// Preloads VibeLink's bundled ConPTY so portable-pty's bare
/// `LoadLibrary("conpty.dll")` resolves to it instead of a PATH install.
/// Returns the directory the bundled runtime was loaded from.
#[cfg(windows)]
pub fn ensure_bundled_conpty() -> Option<PathBuf> {
    use std::sync::OnceLock;

    static LOADED: OnceLock<Option<LoadedConpty>> = OnceLock::new();
    LOADED
        .get_or_init(load_bundled_conpty)
        .as_ref()
        .map(|loaded| loaded.dir.clone())
}

/// Preloads VibeLink's bundled ConPTY so portable-pty's bare
/// `LoadLibrary("conpty.dll")` resolves to it instead of a PATH install.
/// Returns the directory the bundled runtime was loaded from.
#[cfg(not(windows))]
pub fn ensure_bundled_conpty() -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn tempdir() -> std::io::Result<TempDir> {
        let path = std::env::temp_dir().join(format!(
            "vibelink-conpty-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&path)?;
        Ok(TempDir { path })
    }

    fn write_file(path: &Path) {
        std::fs::write(path, b"test").expect("write test bundle file");
    }

    #[test]
    fn resolver_accepts_directory_with_both_runtime_files() {
        let temp = tempdir().expect("create temp dir");
        write_file(&temp.path().join(CONPTY_DLL));
        write_file(&temp.path().join(OPEN_CONSOLE_EXE));

        assert_eq!(
            resolve_bundle_dir([temp.path().to_path_buf()]),
            Some(temp.path().to_path_buf())
        );
    }

    #[test]
    fn resolver_rejects_directory_with_only_dll() {
        let temp = tempdir().expect("create temp dir");
        write_file(&temp.path().join(CONPTY_DLL));

        assert_eq!(resolve_bundle_dir([temp.path().to_path_buf()]), None);
    }

    #[test]
    fn resolver_rejects_empty_directory() {
        let temp = tempdir().expect("create temp dir");

        assert_eq!(resolve_bundle_dir([temp.path().to_path_buf()]), None);
    }

    #[test]
    fn resolver_uses_first_complete_candidate() {
        let first = tempdir().expect("create first temp dir");
        let second = tempdir().expect("create second temp dir");
        for dir in [first.path(), second.path()] {
            write_file(&dir.join(CONPTY_DLL));
            write_file(&dir.join(OPEN_CONSOLE_EXE));
        }

        assert_eq!(
            resolve_bundle_dir([first.path().to_path_buf(), second.path().to_path_buf(),]),
            Some(first.path().to_path_buf())
        );
    }
}
