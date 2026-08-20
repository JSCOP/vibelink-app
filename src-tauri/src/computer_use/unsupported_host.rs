use crate::computer_use::{
    frame::{BootToken, RequestEnvelope, ResponseEnvelope},
    host::{
        HostIoError, HostIoErrorKind, OwnedProviderProcess, ProviderProcessIdentity,
        ProviderProcessSpawner,
    },
};
use std::path::Path;

/// Spawner for targets that ship no computer-use host binary.
///
/// `ProviderHostSupervisor` starts the host lazily on the first request, so returning an error
/// from `spawn` turns every computer-use call into a typed `ProviderUnavailable` failure while
/// leaving daemon startup, the CLI, and the Remote v2 surface intact.
pub struct UnsupportedProcessSpawner;

/// Uninhabited: `UnsupportedProcessSpawner::spawn` never produces a process.
pub enum UnsupportedProcess {}

impl OwnedProviderProcess for UnsupportedProcess {
    fn identity(&self) -> &ProviderProcessIdentity {
        match *self {}
    }

    fn transact(&mut self, _request: &RequestEnvelope) -> Result<ResponseEnvelope, HostIoError> {
        match *self {}
    }

    fn terminate_owned(self) -> Result<(), HostIoError> {
        match self {}
    }
}

impl ProviderProcessSpawner for UnsupportedProcessSpawner {
    type Process = UnsupportedProcess;

    fn spawn(
        &mut self,
        _executable_path: &Path,
        _boot_token: BootToken,
        _generation: u64,
    ) -> Result<Self::Process, HostIoError> {
        Err(HostIoError::new(
            HostIoErrorKind::Other,
            "computer-use requires a platform host binary, which this build does not provide",
        ))
    }
}
