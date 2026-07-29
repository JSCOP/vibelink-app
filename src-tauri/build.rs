use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
};
use url::Url;

const CONPTY_RESOURCES: [&str; 2] = [
    "resources/conpty/x64/conpty.dll",
    "resources/conpty/x64/OpenConsole.exe",
];

const RELEASE_LICENSE_ORIGIN: &str = "https://vibelink.moobang.net";

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
    let configured = std::env::var("VIBELINK_LICENSE_API_URL").ok();
    let raw = configured.as_deref().unwrap_or_else(|| {
        if cfg!(debug_assertions) {
            "http://localhost:3000"
        } else {
            panic!("VIBELINK_LICENSE_API_URL is required for release builds")
        }
    });
    let url = Url::parse(raw).expect("VIBELINK_LICENSE_API_URL must be an absolute URL");
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || (url.path() != "/" && !url.path().is_empty())
    {
        panic!("VIBELINK_LICENSE_API_URL must be an origin without credentials, path, query, or fragment");
    }
    if !cfg!(debug_assertions) && url.scheme() != "https" {
        panic!("VIBELINK_LICENSE_API_URL must use HTTPS for release builds");
    }
    if !cfg!(debug_assertions) && url.origin().ascii_serialization() != RELEASE_LICENSE_ORIGIN {
        panic!("VIBELINK_LICENSE_API_URL must be https://vibelink.moobang.net for release builds");
    }
    if url.scheme() != "http" && url.scheme() != "https" {
        panic!("VIBELINK_LICENSE_API_URL must use HTTP(S)");
    }
    println!("cargo:rerun-if-env-changed=VIBELINK_LICENSE_API_URL");
    for resource in CONPTY_RESOURCES {
        println!("cargo:rerun-if-changed={resource}");
    }
    println!(
        "cargo:rustc-env=VIBELINK_LICENSE_API_URL={}",
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
