use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    env,
    fs::{self, File},
    io::Read,
    net::TcpListener,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const REGISTRY_VERSION: u32 = 1;
const MAX_LOCAL_STATE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_REGISTRY_BYTES: u64 = 1024 * 1024;
const MAX_COPY_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_COPY_FILES: u64 = 200_000;
const MAX_COPY_DEPTH: usize = 32;
const CHROME_CDP_READINESS_TIMEOUT: Duration = Duration::from_secs(20);
const CHROME_CDP_REQUEST_TIMEOUT: Duration = Duration::from_secs(1);
const CHROME_CDP_POLL_INTERVAL: Duration = Duration::from_millis(250);

const SKIPPED_DIRECTORY_NAMES: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "GrShaderCache",
    "ShaderCache",
    "component_crx_cache",
    "extensions_crx_cache",
    "optimization_guide_model_store",
    "optimization_guide_prediction_model_downloads",
    "Crashpad",
    "blob_storage",
];

const SKIPPED_FILE_NAMES: &[&str] = &[
    "LOCK",
    "SingletonLock",
    "SingletonCookie",
    "SingletonSocket",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeSource {
    pub directory: String,
    pub name: String,
    pub last_used: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeProfileRecord {
    pub profile_id: String,
    pub port: u16,
    pub user_data_dir: PathBuf,
    pub source_directory: String,
    pub source_name: String,
    pub copied_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeProfileStatus {
    pub profile: ChromeProfileRecord,
    pub copied: bool,
    pub launched: bool,
    pub copied_files: u64,
    pub copied_bytes: u64,
    pub available_sources: Vec<ChromeSource>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChromeRegistry {
    version: u32,
    profiles: Vec<ChromeProfileRecord>,
}

impl Default for ChromeRegistry {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            profiles: Vec::new(),
        }
    }
}

#[derive(Default)]
struct CopyStats {
    attempted_files: u64,
    copied_files: u64,
    copied_bytes: u64,
}

impl CopyStats {
    fn note_file(&mut self, expected_bytes: u64) -> Result<()> {
        self.attempted_files = self.attempted_files.saturating_add(1);
        if self.attempted_files > MAX_COPY_FILES {
            bail!("Chrome profile copy exceeds the 200000-file limit");
        }
        if self.copied_bytes.saturating_add(expected_bytes) > MAX_COPY_BYTES {
            bail!("Chrome profile copy exceeds the 4 GiB byte limit");
        }
        Ok(())
    }

    fn note_unreadable_file(&mut self) -> Result<()> {
        self.note_file(0)
    }

    fn note_copied(&mut self, copied_bytes: u64) -> Result<()> {
        let total = self
            .copied_bytes
            .checked_add(copied_bytes)
            .filter(|total| *total <= MAX_COPY_BYTES)
            .context("Chrome profile copy exceeds the 4 GiB byte limit")?;
        self.copied_files = self.copied_files.saturating_add(1);
        self.copied_bytes = total;
        Ok(())
    }
}

/// Ensures one VibeLink-owned Chrome profile copy exists and Chrome is
/// listening on its assigned CDP port. Idempotent: reuses an existing copy and
/// an already-listening Chrome unless `refresh` is true.
pub fn ensure(
    artifact_root: &Path,
    main_cdp_port: u16,
    reserved_ports: &[u16],
    source_directory: Option<&str>,
    refresh: bool,
) -> Result<ChromeProfileStatus> {
    let available_sources = list_sources()?;
    let chrome_root = chrome_user_data_root()?;
    let managed_root = artifact_root.join("chrome");
    let registry_path = managed_root.join("registry.json");
    let allowed_ports = crate::runtime_ports::browser_profile_port_candidates(main_cdp_port);
    let mut registry = read_registry_path(&registry_path, &managed_root).unwrap_or_default();

    if registry
        .profiles
        .iter()
        .any(|profile| profile.port == 9_222 || !allowed_ports.contains(&profile.port))
    {
        registry = ChromeRegistry::default();
    }

    let previous = registry.profiles.first().cloned();
    if !refresh {
        if let Some(profile) = previous.as_ref() {
            validate_user_data_dir(&managed_root, &profile.user_data_dir)?;
            if is_plain_directory(&profile.user_data_dir) {
                if chrome_cdp_responds(profile.port) {
                    return Ok(ChromeProfileStatus {
                        profile: profile.clone(),
                        copied: false,
                        launched: false,
                        copied_files: 0,
                        copied_bytes: 0,
                        available_sources,
                    });
                }

                let chrome = find_chrome()?;
                launch_chrome(&chrome, &profile.user_data_dir, profile.port)?;
                wait_for_chrome_cdp(profile.port)?;
                return Ok(ChromeProfileStatus {
                    profile: profile.clone(),
                    copied: false,
                    launched: true,
                    copied_files: 0,
                    copied_bytes: 0,
                    available_sources,
                });
            }
        }
    }

    let source = select_source(&available_sources, source_directory)?;
    if !valid_source_directory(&source.directory) {
        bail!("invalid Google Chrome source profile directory");
    }
    let chrome = find_chrome()?;
    let profiles_root = managed_root.join("profiles");
    fs::create_dir_all(&profiles_root)
        .context("failed to create the VibeLink Chrome profile root")?;
    require_plain_directory(
        &profiles_root,
        "VibeLink Chrome profile root is not a plain directory",
    )?;

    let profile_id = new_profile_id()?;
    let destination = profiles_root.join(&profile_id);
    validate_user_data_dir(&managed_root, &destination)?;
    let stats = copy_profile(&chrome_root, &source.directory, &managed_root, &destination)?;
    let port = select_port(main_cdp_port, &registry, reserved_ports)?;
    launch_chrome(&chrome, &destination, port)?;
    wait_for_chrome_cdp(port)?;

    let profile = ChromeProfileRecord {
        profile_id,
        port,
        user_data_dir: destination,
        source_directory: source.directory,
        source_name: source.name,
        copied_at_ms: copied_at_ms(),
    };
    let next_registry = ChromeRegistry {
        version: REGISTRY_VERSION,
        profiles: vec![profile.clone()],
    };
    write_registry(&registry_path, &managed_root, &next_registry)?;

    if refresh {
        if let Some(previous) = previous.as_ref() {
            if previous.user_data_dir != profile.user_data_dir {
                remove_managed_copy(&managed_root, &previous.user_data_dir)?;
            }
        }
    }

    Ok(ChromeProfileStatus {
        profile,
        copied: true,
        launched: true,
        copied_files: stats.copied_files,
        copied_bytes: stats.copied_bytes,
        available_sources,
    })
}

/// Registered external Chrome profiles. Returns an empty vector when the
/// registry is missing or unreadable; never fails the caller.
pub fn registered(artifact_root: &Path) -> Vec<ChromeProfileRecord> {
    let managed_root = artifact_root.join("chrome");
    read_registry_path(&managed_root.join("registry.json"), &managed_root)
        .map(|registry| registry.profiles)
        .unwrap_or_default()
}

fn list_sources() -> Result<Vec<ChromeSource>> {
    let root = chrome_user_data_root()?;
    let local_state = read_local_state(&root)?;
    let profile = local_state.get("profile").and_then(Value::as_object);
    let last_used = profile
        .and_then(|profile| profile.get("last_used"))
        .and_then(Value::as_str)
        .unwrap_or_default();

    let mut sources = if let Some(info_cache) = profile
        .and_then(|profile| profile.get("info_cache"))
        .and_then(Value::as_object)
    {
        info_cache
            .iter()
            .map(|(directory, info)| ChromeSource {
                directory: directory.clone(),
                name: info
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(directory)
                    .to_string(),
                last_used: directory == last_used,
            })
            .collect()
    } else {
        scan_profile_directories(&root, last_used)?
    };
    sources.sort_by(|left, right| left.directory.cmp(&right.directory));
    Ok(sources)
}

fn chrome_user_data_root() -> Result<PathBuf> {
    let local_app_data = env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .context("LOCALAPPDATA is not set; Google Chrome user data cannot be located")?;
    let root = PathBuf::from(local_app_data)
        .join("Google")
        .join("Chrome")
        .join("User Data");
    let metadata =
        fs::symlink_metadata(&root).context("Google Chrome user data directory was not found")?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        bail!("Google Chrome user data path is not a plain directory");
    }
    Ok(root)
}

fn read_local_state(root: &Path) -> Result<Value> {
    let path = root.join("Local State");
    let metadata =
        fs::symlink_metadata(&path).context("Google Chrome Local State was not found")?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        bail!("Google Chrome Local State is not a plain file");
    }
    if metadata.len() > MAX_LOCAL_STATE_BYTES {
        bail!("Google Chrome Local State exceeds the 32 MiB limit");
    }

    let file = File::open(&path).context("failed to read Google Chrome Local State")?;
    let mut bytes = Vec::new();
    file.take(MAX_LOCAL_STATE_BYTES + 1)
        .read_to_end(&mut bytes)
        .context("failed to read Google Chrome Local State")?;
    if bytes.len() as u64 > MAX_LOCAL_STATE_BYTES {
        bail!("Google Chrome Local State exceeds the 32 MiB limit");
    }
    serde_json::from_slice(&bytes).context("failed to parse Google Chrome Local State")
}

fn scan_profile_directories(root: &Path, last_used: &str) -> Result<Vec<ChromeSource>> {
    let entries = fs::read_dir(root).context("failed to scan Google Chrome profile directories")?;
    let mut sources = Vec::new();
    for entry in entries.flatten() {
        let directory = entry.file_name().to_string_lossy().into_owned();
        if directory != "Default" && !directory.starts_with("Profile ") {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
            continue;
        }
        let Ok(preferences) = fs::symlink_metadata(entry.path().join("Preferences")) else {
            continue;
        };
        if preferences.file_type().is_symlink() || !preferences.file_type().is_file() {
            continue;
        }
        sources.push(ChromeSource {
            name: directory.clone(),
            last_used: directory == last_used,
            directory,
        });
    }
    Ok(sources)
}

fn select_source(sources: &[ChromeSource], requested: Option<&str>) -> Result<ChromeSource> {
    if let Some(requested) = requested {
        return sources
            .iter()
            .find(|source| {
                source.directory.eq_ignore_ascii_case(requested)
                    || source.name.eq_ignore_ascii_case(requested)
            })
            .cloned()
            .ok_or_else(|| anyhow!("Google Chrome source profile was not found: {requested}"));
    }

    Ok(sources
        .iter()
        .find(|source| source.last_used)
        .or_else(|| {
            sources
                .iter()
                .find(|source| source.directory.eq_ignore_ascii_case("Default"))
        })
        .cloned()
        .unwrap_or_else(|| ChromeSource {
            directory: "Default".to_string(),
            name: "Default".to_string(),
            last_used: false,
        }))
}

fn valid_source_directory(value: &str) -> bool {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
    {
        return false;
    }
    let mut components = Path::new(value).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

fn copy_profile(
    chrome_root: &Path,
    source_directory: &str,
    managed_root: &Path,
    destination: &Path,
) -> Result<CopyStats> {
    validate_user_data_dir(managed_root, destination)?;
    ensure_destination_absent(destination)?;

    let source = chrome_root.join(source_directory);
    require_plain_directory(
        &source,
        "Google Chrome source profile is not a plain directory",
    )?;
    require_idle_source_profile(&source)?;

    let destination_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .context("invalid VibeLink Chrome profile destination")?;
    let partial = destination.with_file_name(format!(
        "{destination_name}.partial-{}",
        Uuid::new_v4().simple()
    ));
    validate_user_data_dir(managed_root, &partial)?;
    remove_stale_partial(&partial)?;

    let result = (|| -> Result<CopyStats> {
        fs::create_dir_all(&partial)
            .context("failed to create the partial VibeLink Chrome profile")?;
        require_plain_directory(
            &partial,
            "partial VibeLink Chrome profile is not a plain directory",
        )?;

        let mut stats = CopyStats::default();
        copy_local_state(chrome_root, &partial, &mut stats)?;
        let default_destination = partial.join("Default");
        fs::create_dir_all(&default_destination)
            .context("failed to create the Default Chrome profile directory")?;
        copy_profile_tree(&source, &default_destination, Path::new(""), 0, &mut stats)?;
        fs::rename(&partial, destination)
            .context("failed to install the completed VibeLink Chrome profile copy")?;
        Ok(stats)
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&partial);
    }
    result
}

fn copy_local_state(chrome_root: &Path, destination: &Path, stats: &mut CopyStats) -> Result<()> {
    let source = chrome_root.join("Local State");
    let metadata = fs::symlink_metadata(&source)
        .map_err(|error| anyhow!("failed to read required Chrome file Local State: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        bail!("required Chrome file Local State is not a plain file");
    }
    if metadata.len() > MAX_LOCAL_STATE_BYTES {
        bail!("Google Chrome Local State exceeds the 32 MiB limit");
    }
    stats.note_file(metadata.len())?;
    let copied = fs::copy(&source, destination.join("Local State"))
        .map_err(|error| anyhow!("failed to copy required Chrome file Local State: {error}"))?;
    if copied > MAX_LOCAL_STATE_BYTES {
        bail!("Google Chrome Local State exceeds the 32 MiB limit");
    }
    stats.note_copied(copied)
}

fn copy_profile_tree(
    source: &Path,
    destination: &Path,
    relative: &Path,
    depth: usize,
    stats: &mut CopyStats,
) -> Result<()> {
    let label = if relative.as_os_str().is_empty() {
        ".".to_string()
    } else {
        relative.to_string_lossy().into_owned()
    };
    let entries = fs::read_dir(source)
        .with_context(|| format!("failed to read Google Chrome profile directory {label}"))?;

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                stats.note_unreadable_file()?;
                continue;
            }
        };
        let name = entry.file_name();
        let relative_path = relative.join(&name);
        let source_path = entry.path();
        let destination_path = destination.join(&name);
        let required_name = required_profile_file(&relative_path);
        let metadata = match fs::symlink_metadata(&source_path) {
            Ok(metadata) => metadata,
            Err(error) => {
                if let Some(required_name) = required_name {
                    return Err(anyhow!(
                        "failed to read required Chrome profile file {required_name}: {error}"
                    ));
                }
                stats.note_unreadable_file()?;
                continue;
            }
        };
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            if let Some(required_name) = required_name {
                bail!("required Chrome profile file {required_name} is not a plain file");
            }
            continue;
        }

        if file_type.is_dir() {
            if let Some(required_name) = required_name {
                bail!("required Chrome profile file {required_name} is not a plain file");
            }
            if should_skip_directory(&relative_path) {
                continue;
            }
            if depth >= MAX_COPY_DEPTH {
                bail!("Google Chrome profile copy exceeds the 32-level recursion limit");
            }
            fs::create_dir_all(&destination_path).with_context(|| {
                format!(
                    "failed to create VibeLink Chrome profile directory {}",
                    relative_path.to_string_lossy()
                )
            })?;
            copy_profile_tree(
                &source_path,
                &destination_path,
                &relative_path,
                depth + 1,
                stats,
            )?;
            continue;
        }

        if !file_type.is_file() {
            if let Some(required_name) = required_name {
                bail!("required Chrome profile file {required_name} is not a plain file");
            }
            continue;
        }
        if should_skip_file(&name.to_string_lossy()) {
            continue;
        }

        stats.note_file(metadata.len())?;
        match fs::copy(&source_path, &destination_path) {
            Ok(copied) => stats.note_copied(copied)?,
            Err(error) => {
                let _ = fs::remove_file(&destination_path);
                if let Some(required_name) = required_name {
                    return Err(anyhow!(
                        "failed to copy required Chrome profile file {required_name}: {error}"
                    ));
                }
            }
        }
    }
    Ok(())
}

fn should_skip_directory(relative: &Path) -> bool {
    let Some(name) = relative.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if SKIPPED_DIRECTORY_NAMES
        .iter()
        .any(|skipped| name.eq_ignore_ascii_case(skipped))
    {
        return true;
    }
    name.eq_ignore_ascii_case("ext")
        && relative
            .parent()
            .and_then(Path::file_name)
            .and_then(|parent| parent.to_str())
            .is_some_and(|parent| parent.eq_ignore_ascii_case("Storage"))
}

fn should_skip_file(name: &str) -> bool {
    SKIPPED_FILE_NAMES
        .iter()
        .any(|skipped| name.eq_ignore_ascii_case(skipped))
        || name.to_ascii_lowercase().ends_with(".lock")
}

/// The signed-in state lives in the cookie database. Modern Chrome keeps it at
/// `Network/Cookies`; older profiles keep it at the profile root. Either one
/// failing to copy must be loud, because the silent outcome is a browser that
/// looks correct and is signed out of everything.
fn required_profile_file(relative: &Path) -> Option<&'static str> {
    let mut components = relative.components();
    let normalized = relative.to_string_lossy().replace('\\', "/").to_lowercase();
    match normalized.as_str() {
        "cookies" if matches!((components.next(), components.next()), (Some(_), None)) => {
            Some("Cookies")
        }
        "network/cookies" => Some("Network/Cookies"),
        _ => None,
    }
}

/// Copying a profile while Chrome owns it yields a torn SQLite cookie database.
/// Chrome razes a corrupt database on first launch, so the copy succeeds, the
/// browser opens, and every session is gone. Refuse instead of shipping that.
fn require_idle_source_profile(source: &Path) -> Result<()> {
    for relative in ["Network/Cookies", "Cookies", "Login Data"] {
        let candidate = source.join(relative);
        if candidate.is_file() && !can_open_exclusively(&candidate) {
            bail!(
                "Chrome profile conflict: Google Chrome is running and holds this profile. Close every Chrome window, then run `vibelink browser chrome` again"
            );
        }
    }
    Ok(())
}

#[cfg(windows)]
fn can_open_exclusively(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(path)
        .is_ok()
}

#[cfg(not(windows))]
fn can_open_exclusively(_path: &Path) -> bool {
    true
}

fn validate_user_data_dir(managed_root: &Path, user_data_dir: &Path) -> Result<()> {
    let contains_parent = user_data_dir
        .components()
        .any(|component| component == Component::ParentDir);
    let normalized = user_data_dir
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    if contains_parent
        || user_data_dir == managed_root
        || !user_data_dir.starts_with(managed_root)
        || normalized.contains("/google/chrome/user data")
        || normalized.contains("/microsoft/edge/user data")
        || normalized.contains("/chromium/user data")
    {
        bail!("Chrome user-data directories must be isolated under the VibeLink-managed root");
    }
    Ok(())
}

fn new_profile_id() -> Result<String> {
    let random = Uuid::new_v4().simple().to_string();
    let profile_id = format!("chrome-{}", &random[..12]);
    if !valid_registry_id(&profile_id) {
        bail!("generated an invalid Chrome profile id");
    }
    Ok(profile_id)
}

fn valid_registry_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn read_registry_path(path: &Path, managed_root: &Path) -> Option<ChromeRegistry> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_file()
        || metadata.len() > MAX_REGISTRY_BYTES
    {
        return None;
    }

    let file = File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_REGISTRY_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_REGISTRY_BYTES {
        return None;
    }
    let registry: ChromeRegistry = serde_json::from_slice(&bytes).ok()?;
    validate_registry(&registry, managed_root).then_some(registry)
}

fn validate_registry(registry: &ChromeRegistry, managed_root: &Path) -> bool {
    if registry.version != REGISTRY_VERSION {
        return false;
    }
    let profiles_root = managed_root.join("profiles");
    let mut profile_ids = HashSet::new();
    let mut ports = HashSet::new();
    registry.profiles.iter().all(|profile| {
        valid_registry_id(&profile.profile_id)
            && valid_source_directory(&profile.source_directory)
            && profile.port != 0
            && profile.port != 9_222
            && profile_ids.insert(profile.profile_id.as_str())
            && ports.insert(profile.port)
            && validate_user_data_dir(managed_root, &profile.user_data_dir).is_ok()
            && profile.user_data_dir == profiles_root.join(&profile.profile_id)
    })
}

fn write_registry(path: &Path, managed_root: &Path, registry: &ChromeRegistry) -> Result<()> {
    if !validate_registry(registry, managed_root) {
        bail!("refusing to write an invalid VibeLink Chrome registry");
    }
    let parent = path
        .parent()
        .context("invalid VibeLink Chrome registry path")?;
    fs::create_dir_all(parent)
        .context("failed to create the VibeLink Chrome registry directory")?;
    require_plain_directory(
        parent,
        "VibeLink Chrome registry directory is not a plain directory",
    )?;
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).context("failed to inspect the VibeLink Chrome registry path")
        }
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.file_type().is_file() => {
            bail!("VibeLink Chrome registry path is not a plain file");
        }
        Ok(_) => {}
    }
    let bytes = serde_json::to_vec_pretty(registry)
        .context("failed to serialize the VibeLink Chrome registry")?;
    if bytes.len() as u64 > MAX_REGISTRY_BYTES {
        bail!("VibeLink Chrome registry exceeds the 1 MiB limit");
    }
    fs::write(path, bytes).context("failed to write the VibeLink Chrome registry")
}

fn select_port(main_cdp_port: u16, registry: &ChromeRegistry, reserved: &[u16]) -> Result<u16> {
    // A desktop WebView2 profile can own a port in this range without listening
    // right now, so the bind probe alone is not enough to avoid a collision.
    let claimed: HashSet<u16> = registry
        .profiles
        .iter()
        .map(|profile| profile.port)
        .chain(reserved.iter().copied())
        .collect();
    for port in crate::runtime_ports::browser_profile_port_candidates(main_cdp_port) {
        if port == 9_222 || claimed.contains(&port) {
            continue;
        }
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            drop(listener);
            return Ok(port);
        }
    }
    bail!("no available Chrome profile CDP port remains in the VibeLink flavor range")
}

fn find_chrome() -> Result<PathBuf> {
    if let Some(path) = env::var_os("CHROME_PATH")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Ok(path);
    }

    for variable in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        let Some(root) = env::var_os(variable).filter(|value| !value.is_empty()) else {
            continue;
        };
        let candidate = PathBuf::from(root)
            .join("Google")
            .join("Chrome")
            .join("Application")
            .join("chrome.exe");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    bail!("Google Chrome was not found; set CHROME_PATH or install Google Chrome")
}

fn launch_chrome(chrome: &Path, user_data_dir: &Path, port: u16) -> Result<()> {
    Command::new(chrome)
        .arg(format!("--user-data-dir={}", user_data_dir.display()))
        .arg("--profile-directory=Default")
        .arg("--remote-debugging-address=127.0.0.1")
        .arg(format!("--remote-debugging-port={port}"))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--restore-last-session=false")
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("failed to launch Google Chrome")?;
    Ok(())
}

fn chrome_cdp_responds(port: u16) -> bool {
    ureq::get(&format!("http://127.0.0.1:{port}/json/version"))
        .timeout(CHROME_CDP_REQUEST_TIMEOUT)
        .call()
        .is_ok()
}

fn wait_for_chrome_cdp(port: u16) -> Result<()> {
    let deadline = Instant::now() + CHROME_CDP_READINESS_TIMEOUT;
    loop {
        if chrome_cdp_responds(port) {
            return Ok(());
        }
        let now = Instant::now();
        if now >= deadline {
            bail!("Google Chrome CDP readiness timed out on port {port}");
        }
        thread::sleep(CHROME_CDP_POLL_INTERVAL.min(deadline.saturating_duration_since(now)));
    }
}

fn copied_at_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn ensure_destination_absent(destination: &Path) -> Result<()> {
    match fs::symlink_metadata(destination) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            Err(error).context("failed to inspect the VibeLink Chrome profile destination")
        }
        Ok(_) => bail!("VibeLink Chrome profile destination already exists"),
    }
}

fn remove_stale_partial(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            Err(error).context("failed to inspect a stale Chrome profile partial directory")
        }
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
                bail!("stale Chrome profile partial path is not a plain directory");
            }
            fs::remove_dir_all(path)
                .context("failed to remove a stale Chrome profile partial directory")
        }
    }
}

fn remove_managed_copy(managed_root: &Path, path: &Path) -> Result<()> {
    validate_user_data_dir(managed_root, path)?;
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            Err(error).context("failed to inspect the previous VibeLink Chrome profile copy")
        }
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
                bail!("previous VibeLink Chrome profile copy is not a plain directory");
            }
            fs::remove_dir_all(path)
                .context("failed to remove the previous VibeLink Chrome profile copy")
        }
    }
}

fn is_plain_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| !metadata.file_type().is_symlink() && metadata.file_type().is_dir())
}

fn require_plain_directory(path: &Path, message: &'static str) -> Result<()> {
    if !is_plain_directory(path) {
        bail!(message);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        env::temp_dir().join(format!("vibelink-chrome-profile-{}", Uuid::new_v4()))
    }

    #[test]
    fn managed_destination_validation_enforces_isolation() {
        let artifact_root = temp_root();
        let managed_root = artifact_root.join("chrome");
        let valid = managed_root.join("profiles").join("chrome-0123456789ab");
        let real_chrome_path = managed_root
            .join("profiles")
            .join("Google")
            .join("Chrome")
            .join("User Data")
            .join("copy");
        let parent_path = managed_root
            .join("profiles")
            .join("..")
            .join("chrome-0123456789ab");
        let outside = artifact_root.join("outside").join("chrome-0123456789ab");

        assert!(validate_user_data_dir(&managed_root, &valid).is_ok());
        assert!(validate_user_data_dir(&managed_root, &real_chrome_path).is_err());
        assert!(validate_user_data_dir(&managed_root, &parent_path).is_err());
        assert!(validate_user_data_dir(&managed_root, &outside).is_err());

        let _ = fs::remove_dir_all(artifact_root);
    }

    #[test]
    fn cache_exclusion_is_case_insensitive_and_keeps_profile_data() {
        for skipped in [
            "Cache",
            "Code Cache",
            "GPUCache",
            "DawnCache",
            "DawnGraphiteCache",
            "DawnWebGPUCache",
            "GrShaderCache",
            "ShaderCache",
            "component_crx_cache",
            "extensions_crx_cache",
            "optimization_guide_model_store",
            "optimization_guide_prediction_model_downloads",
            "Crashpad",
            "blob_storage",
            "Storage/ext",
        ] {
            assert!(should_skip_directory(Path::new(skipped)), "{skipped}");
            assert!(
                should_skip_directory(Path::new(&skipped.to_ascii_uppercase())),
                "{}",
                skipped.to_ascii_uppercase()
            );
        }
        for kept in ["Cookies", "Login Data", "Local Storage", "Network"] {
            assert!(!should_skip_directory(Path::new(kept)), "{kept}");
        }
    }

    #[test]
    fn registry_round_trip_and_invalid_files_are_absent() {
        let artifact_root = temp_root();
        let managed_root = artifact_root.join("chrome");
        let registry_path = managed_root.join("registry.json");
        let record = ChromeProfileRecord {
            profile_id: "chrome-0123456789ab".to_string(),
            port: 19_400,
            user_data_dir: managed_root.join("profiles").join("chrome-0123456789ab"),
            source_directory: "Profile 20".to_string(),
            source_name: "Work".to_string(),
            copied_at_ms: 123,
        };
        let registry = ChromeRegistry {
            version: REGISTRY_VERSION,
            profiles: vec![record],
        };

        write_registry(&registry_path, &managed_root, &registry).unwrap();
        let parsed = read_registry_path(&registry_path, &managed_root).unwrap();
        assert_eq!(parsed.version, REGISTRY_VERSION);
        assert_eq!(parsed.profiles.len(), 1);
        assert_eq!(parsed.profiles[0].profile_id, "chrome-0123456789ab");
        assert_eq!(parsed.profiles[0].source_directory, "Profile 20");
        assert_eq!(parsed.profiles[0].source_name, "Work");
        assert_eq!(parsed.profiles[0].port, 19_400);
        assert_eq!(parsed.profiles[0].copied_at_ms, 123);

        fs::write(
            &registry_path,
            serde_json::to_vec(&ChromeRegistry {
                version: REGISTRY_VERSION + 1,
                profiles: Vec::new(),
            })
            .unwrap(),
        )
        .unwrap();
        assert!(read_registry_path(&registry_path, &managed_root).is_none());

        File::create(&registry_path)
            .unwrap()
            .set_len(MAX_REGISTRY_BYTES + 1)
            .unwrap();
        assert!(read_registry_path(&registry_path, &managed_root).is_none());

        let _ = fs::remove_dir_all(artifact_root);
    }

    #[test]
    fn source_selection_uses_last_used_and_matches_directory_or_name() {
        let sources = vec![
            ChromeSource {
                directory: "Default".to_string(),
                name: "Personal".to_string(),
                last_used: false,
            },
            ChromeSource {
                directory: "Profile 20".to_string(),
                name: "Work".to_string(),
                last_used: true,
            },
        ];

        assert_eq!(
            select_source(&sources, None).unwrap().directory,
            "Profile 20"
        );
        assert_eq!(
            select_source(&sources, Some("profile 20"))
                .unwrap()
                .directory,
            "Profile 20"
        );
        assert_eq!(
            select_source(&sources, Some("work")).unwrap().directory,
            "Profile 20"
        );
    }
}
