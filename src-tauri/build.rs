// Only the ConPTY staging path copies files, and that path is Windows-only.
#[cfg(windows)]
use std::io::Read;
use std::{
    fs, io,
    path::{Path, PathBuf},
};
use url::Url;

const CONPTY_RESOURCES: [&str; 2] = [
    "resources/conpty/x64/conpty.dll",
    "resources/conpty/x64/OpenConsole.exe",
];

const DEFAULT_API_ORIGIN: &str = "https://vibelink.moobang.net";

/// Trees whose contents decide what the DAEMON does.
///
/// The daemon and the GUI ship as one executable, so identifying the daemon by
/// the executable's bytes made every rebuild a new daemon: reinstalling a build
/// that only changed the frontend still replaced the running daemon and killed
/// every terminal pane with it. `VIBELINK_DAEMON_CONTRACT` fingerprints the
/// daemon-side sources instead, so a release that leaves daemon behaviour alone
/// leaves the running daemon alone.
const DAEMON_CONTRACT_ROOTS: [&str; 3] = ["src", "resources/browser-extension", "../contracts"];

/// Include by default, exclude explicitly. A new module the daemon starts
/// depending on is fingerprinted automatically; the worst a stale entry here
/// can do is replace a daemon that did not have to be replaced. Everything
/// listed below is GUI-only: no daemon, CLI-host, orchestration, remote, or
/// computer-use path reaches it.
const DAEMON_CONTRACT_EXCLUDED: [&str; 27] = [
    "src/app/account.rs",
    "src/app/acp.rs",
    "src/app/agent_history.rs",
    "src/app/agent_hooks.rs",
    "src/app/agent_skills.rs",
    "src/app/agent_skills_remote.rs",
    "src/app/android_device_lab.rs",
    "src/app/app_update.rs",
    "src/app/browser.rs",
    "src/app/capture.rs",
    "src/app/cli.rs",
    "src/app/commands.rs",
    "src/app/computer_use.rs",
    "src/app/config_sync.rs",
    "src/app/daemon_client.rs",
    "src/app/diagnostics.rs",
    "src/app/fsops.rs",
    "src/app/hermes.rs",
    "src/app/mcp_check.rs",
    "src/app/mod.rs",
    "src/app/orchestration.rs",
    "src/app/provider_integrations.rs",
    "src/app/system_wake.rs",
    "src/app/tray.rs",
    "src/app/webview_renderer.rs",
    "src/app/window_chrome.rs",
    // Client-side bridges into the daemon, never executed by it.
    "src/cli",
];

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x100_0000_01b3;

fn fnv1a(mut hash: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

fn is_contract_source(relative: &str) -> bool {
    if DAEMON_CONTRACT_EXCLUDED
        .iter()
        .any(|excluded| relative == *excluded || relative.starts_with(&format!("{excluded}/")))
    {
        return false;
    }
    // Test modules change without changing what a running daemon does.
    if relative.ends_with("tests.rs") {
        return false;
    }
    relative.ends_with(".rs")
        || relative.ends_with(".ps1")
        || relative.ends_with(".json")
        || relative.ends_with(".js")
        || relative.ends_with(".md")
        || relative.ends_with(".png")
}

fn collect_contract_sources(root: &Path, prefix: &str, found: &mut Vec<String>) -> io::Result<()> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        // A fork may drop an optional resource tree; a missing root is not a
        // build failure, it just contributes nothing to the fingerprint.
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    for entry in entries {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let relative = format!("{prefix}/{name}");
        if entry.file_type()?.is_dir() {
            if DAEMON_CONTRACT_EXCLUDED.contains(&relative.as_str()) {
                continue;
            }
            collect_contract_sources(&entry.path(), &relative, found)?;
        } else if is_contract_source(&relative) {
            found.push(relative);
        }
    }
    Ok(())
}

fn daemon_contract(manifest_dir: &Path) -> io::Result<String> {
    let mut sources = Vec::new();
    for root in DAEMON_CONTRACT_ROOTS {
        collect_contract_sources(&manifest_dir.join(root), root, &mut sources)?;
    }
    // Directory order is filesystem order; the fingerprint must not be.
    sources.sort();

    let mut hash = FNV_OFFSET;
    let mut total = 0_u64;
    for relative in &sources {
        let bytes = fs::read(manifest_dir.join(relative))?;
        total += bytes.len() as u64;
        hash = fnv1a(hash, relative.as_bytes());
        hash = fnv1a(hash, &bytes);
    }
    Ok(format!("{total:012x}-{hash:016x}"))
}

#[cfg(windows)]
fn files_identical(source: &Path, destination: &Path) -> io::Result<bool> {
    let source_meta = fs::metadata(source)?;
    let destination_meta = match fs::metadata(destination) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err),
    };
    if source_meta.len() != destination_meta.len() {
        return Ok(false);
    }

    let mut source_file = fs::File::open(source)?;
    let mut destination_file = fs::File::open(destination)?;
    let mut source_buf = [0_u8; 64 * 1024];
    let mut destination_buf = [0_u8; 64 * 1024];
    loop {
        let source_len = source_file.read(&mut source_buf)?;
        let destination_len = destination_file.read(&mut destination_buf)?;
        if source_len != destination_len
            || source_buf[..source_len] != destination_buf[..destination_len]
        {
            return Ok(false);
        }
        if source_len == 0 {
            return Ok(true);
        }
    }
}

#[cfg(windows)]
fn cargo_profile_output_dir() -> io::Result<PathBuf> {
    let out_dir =
        PathBuf::from(std::env::var_os("OUT_DIR").ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "Cargo did not provide OUT_DIR")
        })?);
    out_dir
        .ancestors()
        .nth(3)
        .map(Path::to_path_buf)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "unexpected OUT_DIR layout"))
}

#[cfg(windows)]
fn stage_conpty_runtime() -> io::Result<()> {
    let manifest_dir = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "Cargo did not provide CARGO_MANIFEST_DIR",
        )
    })?);
    let output_dir = cargo_profile_output_dir()?;

    for relative in CONPTY_RESOURCES {
        let source = manifest_dir.join(relative);
        let destination =
            output_dir.join(source.file_name().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "resource has no name")
            })?);
        if files_identical(&source, &destination)? {
            continue;
        }
        fs::copy(&source, &destination)?;
    }
    Ok(())
}

fn main() {
    // Forks build against their own backend, so the origin is configurable in
    // every profile and only has to be a credential-free HTTP(S) origin.
    let configured = std::env::var("VIBELINK_API_URL").ok();
    let raw = configured.as_deref().unwrap_or(DEFAULT_API_ORIGIN);
    let url = Url::parse(raw).expect("VIBELINK_API_URL must be an absolute URL");
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || (url.path() != "/" && !url.path().is_empty())
    {
        panic!("VIBELINK_API_URL must be an origin without credentials, path, query, or fragment");
    }
    if url.scheme() != "http" && url.scheme() != "https" {
        panic!("VIBELINK_API_URL must use HTTP(S)");
    }
    if !cfg!(debug_assertions) && url.scheme() != "https" {
        panic!("VIBELINK_API_URL must use HTTPS for release builds");
    }
    println!("cargo:rerun-if-env-changed=VIBELINK_API_URL");
    for resource in CONPTY_RESOURCES {
        println!("cargo:rerun-if-changed={resource}");
    }
    // Emitting any `rerun-if-changed` disables Cargo's default "rerun on any
    // package change", so every fingerprint input has to be declared or the
    // contract goes stale and a changed daemon keeps its old identity.
    for root in DAEMON_CONTRACT_ROOTS {
        println!("cargo:rerun-if-changed={root}");
    }
    let manifest_dir = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("Cargo did not provide CARGO_MANIFEST_DIR"),
    );
    let contract = daemon_contract(&manifest_dir).expect("fingerprint daemon contract sources");
    println!("cargo:rustc-env=VIBELINK_DAEMON_CONTRACT={contract}");
    println!(
        "cargo:rustc-env=VIBELINK_API_URL={}",
        url.origin().ascii_serialization()
    );
    // Library test harnesses do not receive Tauri's resource manifest. Declaring the dependency
    // lets LINK activate Common Controls v6 instead of failing to resolve TaskDialogIndirect.
    // Binary manifests are merged into Tauri's resource; test harnesses receive a sidecar manifest.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }
    #[cfg(windows)]
    if let Err(err) = stage_conpty_runtime() {
        println!("cargo:warning=failed to stage bundled ConPTY beside the executable: {err}");
    }
    tauri_build::build()
}
