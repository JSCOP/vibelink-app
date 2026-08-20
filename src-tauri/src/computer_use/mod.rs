pub mod frame;
pub mod host;
pub mod policy;
pub mod provider;
pub mod types;
pub mod unsupported_host;
#[cfg(windows)]
pub mod windows_backend;
#[cfg(windows)]
pub mod windows_host;

pub use frame::{BootToken, RequestEnvelope, ResponseEnvelope, MAX_COMPUTER_FRAME_LEN};
pub use host::{
    OwnedProviderProcess, ProviderHostSupervisor, ProviderProcessIdentity, ProviderProcessSpawner,
};
pub use policy::SensitiveAppPolicy;
pub use provider::{ComputerBackend, ComputerUseProvider};
pub use types::*;
pub use unsupported_host::{UnsupportedProcess, UnsupportedProcessSpawner};
#[cfg(windows)]
pub use windows_backend::WindowsComputerBackend;
#[cfg(windows)]
pub use windows_host::WindowsProcessSpawner;

/// The computer-use host spawner this target drives the sidecar with.
///
/// Windows owns the only host implementation; it talks to `vibelink-computer-host.exe` over a
/// named pipe and drives Win32 UI Automation and `SendInput`. Other targets resolve to
/// `UnsupportedProcessSpawner`, which fails every spawn with a typed error instead of blocking
/// daemon startup.
#[cfg(windows)]
pub type PlatformProcessSpawner = WindowsProcessSpawner;
#[cfg(not(windows))]
pub type PlatformProcessSpawner = UnsupportedProcessSpawner;

/// Builds the spawner for this target.
#[cfg(windows)]
pub fn platform_process_spawner(
    artifact_root: std::path::PathBuf,
    flavor: &str,
) -> PlatformProcessSpawner {
    WindowsProcessSpawner::new(artifact_root, flavor)
}

#[cfg(not(windows))]
pub fn platform_process_spawner(
    _artifact_root: std::path::PathBuf,
    _flavor: &str,
) -> PlatformProcessSpawner {
    UnsupportedProcessSpawner
}
