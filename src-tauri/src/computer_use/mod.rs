pub mod frame;
pub mod host;
pub mod policy;
pub mod provider;
pub mod types;
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
#[cfg(windows)]
pub use windows_backend::WindowsComputerBackend;
#[cfg(windows)]
pub use windows_host::WindowsProcessSpawner;
