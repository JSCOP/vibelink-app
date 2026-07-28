#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use app_lib::computer_use;

#[cfg(windows)]
fn main() {
    if let Err(error) = run() {
        eprintln!("VibeLink computer-use host error: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("VibeLink computer-use host is available only on Windows");
    std::process::exit(2);
}

#[cfg(windows)]
fn run() -> Result<(), String> {
    use computer_use::{frame::BootToken, host::serve_connection, SensitiveAppPolicy};
    use std::{fs::OpenOptions, path::PathBuf};

    let options = HostOptions::parse(std::env::args().skip(1))?;
    let boot_token = BootToken::from_hex(&options.boot_token).map_err(|error| error.to_string())?;
    let pipe = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&options.pipe)
        .map_err(|error| format!("open parent-owned named pipe: {error}"))?;
    let mut reader = pipe
        .try_clone()
        .map_err(|error| format!("clone named pipe handle: {error}"))?;
    let mut writer = pipe;
    let backend = computer_use::WindowsComputerBackend::new(PathBuf::from(options.artifact_root))
        .map_err(|error| {
        format!(
            "initialize Windows computer-use provider: {}",
            error.message
        )
    })?;
    let mut provider =
        computer_use::ComputerUseProvider::new(backend, SensitiveAppPolicy::default());
    serve_connection(&mut provider, boot_token, &mut reader, &mut writer)
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
struct HostOptions {
    pipe: String,
    boot_token: String,
    artifact_root: String,
}

#[cfg(windows)]
impl HostOptions {
    fn parse<I>(arguments: I) -> Result<Self, String>
    where
        I: IntoIterator<Item = String>,
    {
        let mut arguments = arguments.into_iter();
        let mut pipe = None;
        let mut boot_token = None;
        let mut artifact_root = None;
        while let Some(argument) = arguments.next() {
            let value = arguments
                .next()
                .ok_or_else(|| format!("missing value for {argument}"))?;
            match argument.as_str() {
                "--pipe" => pipe = Some(value),
                "--boot-token" => boot_token = Some(value),
                "--artifact-root" => artifact_root = Some(value),
                _ => return Err(format!("unknown argument: {argument}")),
            }
        }
        Ok(Self {
            pipe: pipe.ok_or_else(|| "missing --pipe".to_string())?,
            boot_token: boot_token.ok_or_else(|| "missing --boot-token".to_string())?,
            artifact_root: artifact_root.ok_or_else(|| "missing --artifact-root".to_string())?,
        })
    }
}
