use super::chrome_profile_windows;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    env,
    fs::{self, File},
    io::{Read, Seek},
    net::TcpListener,
    path::{Component, Path, PathBuf},
    process::Command,
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
    #[serde(default)]
    pending_cleanup: Vec<PathBuf>,
}

impl Default for ChromeRegistry {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            profiles: Vec::new(),
            pending_cleanup: Vec::new(),
        }
    }
}

struct PortReservation {
    port: u16,
    listener: Option<TcpListener>,
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
/// listening on its assigned CDP port. Creation is serialized and committed
/// only after the exact spawned process owns the responder.
pub fn ensure(
    artifact_root: &Path,
    main_cdp_port: u16,
    reserved_ports: &[u16],
    source_directory: Option<&str>,
    refresh: bool,
) -> Result<ChromeProfileStatus> {
    validate_main_cdp_port(main_cdp_port)?;
    let _creation_lock = chrome_profile_windows::lock_creation(main_cdp_port)?;
    let managed_root = artifact_root.join("chrome");
    let profiles_root = managed_root.join("profiles");
    fs::create_dir_all(&profiles_root).context("create the VibeLink Chrome profile root")?;
    require_plain_directory(
        &profiles_root,
        "VibeLink Chrome profile root is not a plain directory",
    )?;
    let registry_path = managed_root.join("registry.json");
    let allowed_ports = crate::runtime_ports::browser_profile_port_candidates(main_cdp_port);
    let mut registry = read_registry_path(&registry_path, &managed_root).unwrap_or_default();
    if registry
        .profiles
        .iter()
        .any(|profile| !allowed_ports.contains(&profile.port))
    {
        for profile in &registry.profiles {
            chrome_profile_windows::terminate(&profile.profile_id)?;
        }
        registry = ChromeRegistry::default();
    }
    chrome_profile_windows::sweep(
        registry
            .profiles
            .iter()
            .map(|profile| profile.profile_id.as_str()),
    )?;
    if sweep_managed_root(&managed_root, &mut registry)? {
        write_registry(&registry_path, &managed_root, &registry)?;
    }

    let available_sources = list_sources()?;
    let chrome_root = chrome_user_data_root()?;
    let previous = registry.profiles.first().cloned();
    if !refresh {
        if let Some(profile) = previous.as_ref() {
            validate_user_data_dir(&managed_root, &profile.user_data_dir)?;
            if is_plain_directory(&profile.user_data_dir) {
                if managed_profile_ready(profile)? {
                    return Ok(profile_status(
                        profile.clone(),
                        false,
                        false,
                        available_sources,
                    ));
                }
                if chrome_profile_windows::managed_process_pid(&profile.profile_id)?.is_some() {
                    bail!("managed Chrome is running but its CDP identity could not be verified");
                }
                require_managed_copy_stopped(Some(&profile.profile_id), &profile.user_data_dir)?;
                let chrome = find_chrome()?;
                let mut reservation = reserve_port(profile.port)?;
                let listener = reservation
                    .listener
                    .take()
                    .context("Chrome profile CDP port reservation is missing")?;
                let mut launched = chrome_profile_windows::launch(
                    artifact_root,
                    &chrome,
                    &profile.profile_id,
                    &profile.user_data_dir,
                    profile.port,
                    listener,
                )?;
                wait_for_chrome_cdp(&launched, &profile.user_data_dir, profile.port)?;
                launched.commit_to_daemon(|| {
                    write_registry(&registry_path, &managed_root, &registry)
                })?;
                return Ok(profile_status(
                    profile.clone(),
                    false,
                    true,
                    available_sources,
                ));
            }
        }
    }

    let source = select_source(&available_sources, source_directory)?;
    if !valid_source_directory(&source.directory) {
        bail!("invalid Google Chrome source profile directory");
    }
    let chrome = find_chrome()?;
    let profile_id = new_profile_id()?;
    let destination = profiles_root.join(&profile_id);
    validate_user_data_dir(&managed_root, &destination)?;
    let result = (|| -> Result<ChromeProfileStatus> {
        let stats = copy_profile(&chrome_root, &source.directory, &managed_root, &destination)?;
        let mut reservation = select_port(main_cdp_port, &registry, reserved_ports)?;
        let listener = reservation
            .listener
            .take()
            .context("Chrome profile CDP port reservation is missing")?;
        let mut launched = chrome_profile_windows::launch(
            artifact_root,
            &chrome,
            &profile_id,
            &destination,
            reservation.port,
            listener,
        )?;
        wait_for_chrome_cdp(&launched, &destination, reservation.port)?;
        let profile = ChromeProfileRecord {
            profile_id,
            port: reservation.port,
            user_data_dir: destination.clone(),
            source_directory: source.directory,
            source_name: source.name,
            copied_at_ms: copied_at_ms(),
        };
        let mut next_registry = ChromeRegistry {
            version: REGISTRY_VERSION,
            profiles: vec![profile.clone()],
            pending_cleanup: registry.pending_cleanup.clone(),
        };
        if refresh {
            if let Some(previous) = previous.as_ref() {
                if previous.user_data_dir != profile.user_data_dir {
                    require_managed_copy_stopped(
                        Some(&previous.profile_id),
                        &previous.user_data_dir,
                    )?;
                    chrome_profile_windows::terminate(&previous.profile_id)?;
                    next_registry
                        .pending_cleanup
                        .push(previous.user_data_dir.clone());
                }
            }
        }
        next_registry.pending_cleanup.sort();
        next_registry.pending_cleanup.dedup();
        launched
            .commit_to_daemon(|| write_registry(&registry_path, &managed_root, &next_registry))?;
        if sweep_pending_cleanup(&managed_root, &mut next_registry)? {
            if let Err(error) = write_registry(&registry_path, &managed_root, &next_registry) {
                tracing::warn!(%error, "deferred Chrome profile cleanup registry update failed");
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
    })();
    if result.is_err() {
        let _ = remove_stopped_copy(&managed_root, &destination);
    }
    result
}

fn profile_status(
    profile: ChromeProfileRecord,
    copied: bool,
    launched: bool,
    available_sources: Vec<ChromeSource>,
) -> ChromeProfileStatus {
    ChromeProfileStatus {
        profile,
        copied,
        launched,
        copied_files: 0,
        copied_bytes: 0,
        available_sources,
    }
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
        if let Some(source) = sources
            .iter()
            .find(|source| source.directory.eq_ignore_ascii_case(requested))
        {
            return Ok(source.clone());
        }
        let matches = sources
            .iter()
            .filter(|source| source.name.eq_ignore_ascii_case(requested))
            .collect::<Vec<_>>();
        return match matches.as_slice() {
            [source] => Ok((*source).clone()),
            [] => Err(anyhow!(
                "Google Chrome source profile was not found: {requested}"
            )),
            _ => bail!(
                "Google Chrome source profile name is ambiguous: {requested}; candidates: {}",
                matches
                    .iter()
                    .map(|source| source.directory.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        };
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
    let mut source_locks = lock_source_profile(chrome_root, &source)?;

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
        copy_local_state(chrome_root, &partial, &mut stats, &mut source_locks)?;
        let default_destination = partial.join("Default");
        fs::create_dir_all(&default_destination)
            .context("failed to create the Default Chrome profile directory")?;
        copy_profile_tree(
            &source,
            &default_destination,
            Path::new(""),
            0,
            &mut stats,
            &mut source_locks,
        )?;
        fs::rename(&partial, destination)
            .context("failed to install the completed VibeLink Chrome profile copy")?;
        Ok(stats)
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&partial);
    }
    result
}

fn copy_local_state(
    chrome_root: &Path,
    destination: &Path,
    stats: &mut CopyStats,
    locks: &mut HashMap<PathBuf, File>,
) -> Result<()> {
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
    let copied = copy_source_file(&source, &destination.join("Local State"), locks)
        .map_err(|error| anyhow!("failed to copy required Chrome file Local State: {error}"))?;
    if copied != metadata.len() {
        bail!("Google Chrome Local State changed while copying");
    }
    stats.note_copied(copied)
}

fn copy_profile_tree(
    source: &Path,
    destination: &Path,
    relative: &Path,
    depth: usize,
    stats: &mut CopyStats,
    locks: &mut HashMap<PathBuf, File>,
) -> Result<()> {
    let label = if relative.as_os_str().is_empty() {
        ".".to_string()
    } else {
        relative.to_string_lossy().into_owned()
    };
    for entry in fs::read_dir(source)
        .with_context(|| format!("failed to read Google Chrome profile directory {label}"))?
    {
        let entry = entry.with_context(|| {
            format!("failed to read an entry in Chrome profile directory {label}")
        })?;
        let name = entry.file_name();
        let relative_path = relative.join(&name);
        let source_path = entry.path();
        let destination_path = destination.join(&name);
        let metadata = fs::symlink_metadata(&source_path).with_context(|| {
            format!(
                "failed to inspect Chrome profile path {}",
                relative_path.display()
            )
        })?;
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            bail!(
                "Chrome profile path {} is a symbolic link",
                relative_path.display()
            );
        }
        if file_type.is_dir() {
            if should_skip_directory(&relative_path) {
                continue;
            }
            if depth >= MAX_COPY_DEPTH {
                bail!("Google Chrome profile copy exceeds the 32-level recursion limit");
            }
            fs::create_dir_all(&destination_path).with_context(|| {
                format!(
                    "failed to create VibeLink Chrome profile directory {}",
                    relative_path.display()
                )
            })?;
            copy_profile_tree(
                &source_path,
                &destination_path,
                &relative_path,
                depth + 1,
                stats,
                locks,
            )?;
            continue;
        }
        if !file_type.is_file() {
            bail!(
                "Chrome profile path {} is not a plain file",
                relative_path.display()
            );
        }
        if should_skip_file(&name.to_string_lossy()) {
            continue;
        }
        stats.note_file(metadata.len())?;
        let copied =
            copy_source_file(&source_path, &destination_path, locks).with_context(|| {
                format!(
                    "failed to copy Chrome profile file {}",
                    relative_path.display()
                )
            })?;
        if copied != metadata.len() {
            bail!(
                "Chrome profile file changed while copying: {}",
                relative_path.display()
            );
        }
        stats.note_copied(copied)?;
    }
    Ok(())
}

fn should_skip_directory(relative: &Path) -> bool {
    relative
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            SKIPPED_DIRECTORY_NAMES
                .iter()
                .any(|skipped| name.eq_ignore_ascii_case(skipped))
        })
}

fn should_skip_file(name: &str) -> bool {
    SKIPPED_FILE_NAMES
        .iter()
        .any(|skipped| name.eq_ignore_ascii_case(skipped))
}

fn lock_source_profile(chrome_root: &Path, source: &Path) -> Result<HashMap<PathBuf, File>> {
    let files = [
        (chrome_root.join("Local State"), true),
        (source.join("Preferences"), true),
        (source.join("Secure Preferences"), false),
        (source.join("Network/Cookies"), false),
        (source.join("Cookies"), false),
        (source.join("Login Data"), false),
        (source.join("Web Data"), false),
        (source.join("History"), false),
        (source.join("Favicons"), false),
        (source.join("Local Storage/leveldb/LOCK"), false),
        (source.join("Extension State/LOCK"), false),
        (source.join("Extension Rules/LOCK"), false),
        (source.join("Extension Scripts/LOCK"), false),
    ];
    let mut locks = HashMap::new();
    for (path, required) in files {
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if !required && error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error).with_context(|| format!("inspect {}", path.display())),
        };
        if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
            bail!(
                "critical Chrome profile path is not a plain file: {}",
                path.display()
            );
        }
        locks.insert(
            path.clone(),
            open_source_lock(&path).with_context(|| {
                "Chrome profile conflict: close every Chrome window before copying the signed-in profile"
            })?,
        );
    }
    Ok(locks)
}

#[cfg(windows)]
fn open_source_lock(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::{FILE_SHARE_DELETE, FILE_SHARE_READ};
    fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_DELETE.0)
        .open(path)
}

#[cfg(not(windows))]
fn open_source_lock(path: &Path) -> std::io::Result<File> {
    File::open(path)
}

fn copy_source_file(
    source: &Path,
    destination: &Path,
    locks: &mut HashMap<PathBuf, File>,
) -> std::io::Result<u64> {
    if let Some(source) = locks.get_mut(source) {
        source.rewind()?;
        let mut destination = File::create(destination)?;
        return std::io::copy(source, &mut destination);
    }
    fs::copy(source, destination)
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
    let profiles_valid = registry.profiles.iter().all(|profile| {
        valid_registry_id(&profile.profile_id)
            && valid_source_directory(&profile.source_directory)
            && profile.port != 0
            && profile.port != 9_222
            && profile_ids.insert(profile.profile_id.as_str())
            && ports.insert(profile.port)
            && profile.user_data_dir == profiles_root.join(&profile.profile_id)
            && validate_user_data_dir(managed_root, &profile.user_data_dir).is_ok()
    });
    let active = registry
        .profiles
        .iter()
        .map(|profile| profile.user_data_dir.as_path())
        .collect::<HashSet<_>>();
    let mut cleanup = HashSet::new();
    profiles_valid
        && registry.pending_cleanup.iter().all(|path| {
            path.parent() == Some(profiles_root.as_path())
                && !active.contains(path.as_path())
                && cleanup.insert(path.as_path())
                && validate_user_data_dir(managed_root, path).is_ok()
        })
}

fn write_registry(path: &Path, managed_root: &Path, registry: &ChromeRegistry) -> Result<()> {
    if !validate_registry(registry, managed_root) {
        bail!("refusing to write an invalid VibeLink Chrome registry");
    }
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
            bail!("VibeLink Chrome registry path is not a plain file");
        }
    }
    let bytes = serde_json::to_vec_pretty(registry)
        .context("failed to serialize the VibeLink Chrome registry")?;
    if bytes.len() as u64 > MAX_REGISTRY_BYTES {
        bail!("VibeLink Chrome registry exceeds the 1 MiB limit");
    }
    crate::storage::write_bytes(path, &bytes)
        .context("failed to atomically write the VibeLink Chrome registry")
}

fn validate_main_cdp_port(port: u16) -> Result<()> {
    use crate::runtime_ports::{
        DEV_MAIN_WEBVIEW_CDP_PORT, DEV_MAIN_WEBVIEW_CDP_PORT_END, PROD_MAIN_WEBVIEW_CDP_PORT,
    };
    if port == PROD_MAIN_WEBVIEW_CDP_PORT
        || (DEV_MAIN_WEBVIEW_CDP_PORT..=DEV_MAIN_WEBVIEW_CDP_PORT_END).contains(&port)
    {
        return Ok(());
    }
    bail!("main browser CDP port must be production 9333 or development 19333-19363")
}

fn select_port(
    main_cdp_port: u16,
    registry: &ChromeRegistry,
    reserved: &[u16],
) -> Result<PortReservation> {
    let claimed: HashSet<u16> = registry
        .profiles
        .iter()
        .map(|profile| profile.port)
        .chain(reserved.iter().copied())
        .collect();
    for port in crate::runtime_ports::browser_profile_port_candidates(main_cdp_port) {
        if !claimed.contains(&port) {
            if let Ok(reservation) = reserve_port(port) {
                return Ok(reservation);
            }
        }
    }
    bail!("no available Chrome profile CDP port remains in the VibeLink flavor range")
}

fn reserve_port(port: u16) -> Result<PortReservation> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .with_context(|| format!("Chrome profile CDP port {port} is already occupied"))?;
    Ok(PortReservation {
        port,
        listener: Some(listener),
    })
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

fn chrome_cdp_responds(port: u16) -> bool {
    ureq::get(&format!("http://127.0.0.1:{port}/json/version"))
        .timeout(CHROME_CDP_REQUEST_TIMEOUT)
        .call()
        .is_ok()
}

fn wait_for_chrome_cdp(
    process: &chrome_profile_windows::LaunchedChrome,
    user_data_dir: &Path,
    port: u16,
) -> Result<()> {
    let deadline = Instant::now() + CHROME_CDP_READINESS_TIMEOUT;
    loop {
        if !process.is_alive()? {
            bail!("Google Chrome exited before CDP was ready");
        }
        if chrome_cdp_responds(port) {
            if responder_belongs_to_process(user_data_dir, port, process.pid())? {
                return Ok(());
            }
            bail!(
                "CDP responder on port {port} does not belong to the exact spawned Chrome PID {}",
                process.pid()
            );
        }
        let now = Instant::now();
        if now >= deadline {
            bail!("Google Chrome CDP readiness timed out on port {port}");
        }
        thread::sleep(CHROME_CDP_POLL_INTERVAL.min(deadline.saturating_duration_since(now)));
    }
}

fn require_managed_copy_stopped(profile_id: Option<&str>, path: &Path) -> Result<()> {
    if let Some(profile_id) = profile_id {
        if chrome_profile_windows::managed_process_pid(profile_id)?.is_some() {
            bail!("managed Chrome process is still running; the old profile was not deleted");
        }
    }
    if !managed_copy_is_idle(path) {
        bail!("managed Chrome process is still running; the old profile was not deleted");
    }
    Ok(())
}

fn responder_belongs_to_process(user_data_dir: &Path, port: u16, pid: u32) -> Result<bool> {
    if let Ok(value) = fs::read_to_string(user_data_dir.join("DevToolsActivePort")) {
        if value
            .lines()
            .next()
            .and_then(|line| line.parse::<u16>().ok())
            != Some(port)
        {
            return Ok(false);
        }
    }
    Ok(listener_pid(port)? == Some(pid))
}

#[cfg(windows)]
fn listener_pid(port: u16) -> Result<Option<u32>> {
    let output = Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .output()
        .context("inspect the Chrome CDP listening PID")?;
    if !output.status.success() {
        bail!("netstat failed while confirming Chrome CDP process identity");
    }
    let suffix = format!(":{port}");
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            (fields.len() >= 5
                && fields[0].eq_ignore_ascii_case("TCP")
                && fields[1].ends_with(&suffix))
            .then(|| fields[4].parse().ok())
            .flatten()
        }))
}

#[cfg(not(windows))]
fn listener_pid(_port: u16) -> Result<Option<u32>> {
    Ok(None)
}

fn managed_profile_ready(profile: &ChromeProfileRecord) -> Result<bool> {
    if !chrome_cdp_responds(profile.port) {
        return Ok(false);
    }
    let Some(pid) = chrome_profile_windows::managed_process_pid(&profile.profile_id)? else {
        return Ok(false);
    };
    responder_belongs_to_process(&profile.user_data_dir, profile.port, pid)
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
        Err(error) => Err(error).context("inspect the VibeLink Chrome profile destination"),
        Ok(_) => bail!("VibeLink Chrome profile destination already exists"),
    }
}

fn remove_plain_directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("inspect {}", path.display())),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() => {
            bail!("managed Chrome profile path is not a plain directory")
        }
        Ok(_) => fs::remove_dir_all(path)
            .with_context(|| format!("remove managed Chrome profile {}", path.display())),
    }
}

fn remove_stale_partial(path: &Path) -> Result<()> {
    remove_plain_directory(path)
}

fn remove_stopped_copy(managed_root: &Path, path: &Path) -> Result<()> {
    remove_managed_copy(managed_root, path)
}

fn remove_managed_copy(managed_root: &Path, path: &Path) -> Result<()> {
    remove_managed_copy_with(managed_root, path, |path| {
        lock_source_profile(path, &path.join("Default"))
            .context("managed Chrome process is still running; the profile was not deleted")
    })
}

fn remove_managed_copy_with<T>(
    managed_root: &Path,
    path: &Path,
    lock: impl FnOnce(&Path) -> Result<T>,
) -> Result<()> {
    validate_user_data_dir(managed_root, path)?;
    let _lock = lock(path)?;
    remove_plain_directory(path)
}

fn sweep_pending_cleanup(managed_root: &Path, registry: &mut ChromeRegistry) -> Result<bool> {
    let old = std::mem::take(&mut registry.pending_cleanup);
    let old_len = old.len();
    for path in old {
        if let Err(error) = remove_managed_copy(managed_root, &path) {
            tracing::warn!(%error, path = %path.display(), "deferred managed Chrome profile cleanup");
            registry.pending_cleanup.push(path);
        }
    }
    Ok(registry.pending_cleanup.len() != old_len)
}

fn sweep_managed_root(managed_root: &Path, registry: &mut ChromeRegistry) -> Result<bool> {
    let profiles_root = managed_root.join("profiles");
    fs::create_dir_all(&profiles_root).context("create the managed Chrome profile root")?;
    let registered = registry
        .profiles
        .iter()
        .map(|profile| profile.user_data_dir.as_path())
        .collect::<HashSet<_>>();
    let pending = registry
        .pending_cleanup
        .iter()
        .map(PathBuf::as_path)
        .collect::<HashSet<_>>();
    for entry in fs::read_dir(&profiles_root).context("scan managed Chrome profiles")? {
        let entry = entry.context("read a managed Chrome profile entry")?;
        let path = entry.path();
        let metadata =
            fs::symlink_metadata(&path).context("inspect a managed Chrome profile entry")?;
        if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
            bail!("managed Chrome profile root contains a non-directory entry");
        }
        if registered.contains(path.as_path()) || pending.contains(path.as_path()) {
            continue;
        }
        if entry.file_name().to_string_lossy().contains(".partial-") {
            remove_stale_partial(&path)?;
        } else if managed_copy_is_idle(&path) {
            remove_stopped_copy(managed_root, &path)?;
        }
    }
    sweep_pending_cleanup(managed_root, registry)
}

fn managed_copy_is_idle(path: &Path) -> bool {
    lock_source_profile(path, &path.join("Default")).is_ok()
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
#[path = "chrome_profile_tests.rs"]
mod tests;
