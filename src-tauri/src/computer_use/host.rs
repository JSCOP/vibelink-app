use super::{
    frame::{
        read_authenticated_request, write_frame, BootToken, RequestEnvelope, ResponseEnvelope,
    },
    policy::SensitiveAppPolicy,
    provider::{ComputerBackend, ComputerUseProvider},
    types::{HostRequest, HostResponseBody, ProviderError, ProviderErrorCode},
};
use std::{
    fmt,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderProcessIdentity {
    pub instance_id: Uuid,
    pub pid: u32,
    pub generation: u64,
    pub executable_path: PathBuf,
    pub boot_token: BootToken,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostIoErrorKind {
    BrokenPipe,
    ProcessExited,
    Protocol,
    Timeout,
    Other,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostIoError {
    pub kind: HostIoErrorKind,
    pub message: String,
}

impl HostIoError {
    pub fn new(kind: HostIoErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl fmt::Display for HostIoError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for HostIoError {}

pub trait OwnedProviderProcess {
    fn identity(&self) -> &ProviderProcessIdentity;
    fn transact(&mut self, request: &RequestEnvelope) -> Result<ResponseEnvelope, HostIoError>;
    fn terminate_owned(self) -> Result<(), HostIoError>;
}

pub trait ProviderProcessSpawner {
    type Process: OwnedProviderProcess;

    fn spawn(
        &mut self,
        executable_path: &Path,
        boot_token: BootToken,
        generation: u64,
    ) -> Result<Self::Process, HostIoError>;
}

pub struct ProviderHostSupervisor<S>
where
    S: ProviderProcessSpawner,
{
    spawner: S,
    executable_path: PathBuf,
    process: Option<S::Process>,
    generation: u64,
    emergency_stopped: bool,
}
impl<S> ProviderHostSupervisor<S>
where
    S: ProviderProcessSpawner,
{
    pub fn new(spawner: S, executable_path: PathBuf) -> Self {
        Self {
            spawner,
            executable_path,
            process: None,
            generation: 0,
            emergency_stopped: false,
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn process_identity(&self) -> Option<&ProviderProcessIdentity> {
        self.process.as_ref().map(OwnedProviderProcess::identity)
    }

    pub fn request(
        &mut self,
        operation_id: Uuid,
        request: HostRequest,
    ) -> Result<HostResponseBody, ProviderError> {
        match &request {
            HostRequest::ProviderStatus => {
                return Ok(HostResponseBody::ProviderStatus(self.status()));
            }
            HostRequest::RestartProvider => {
                self.restart_provider()?;
                return Ok(HostResponseBody::ProviderStatus(self.status()));
            }
            _ if self.emergency_stopped => {
                return Err(ProviderError::new(
                    ProviderErrorCode::EmergencyStopped,
                    "computer-use emergency stop is active; restart the provider explicitly",
                ));
            }
            _ => {}
        }

        self.ensure_started()?;
        let process = self.process.as_mut().ok_or_else(|| {
            ProviderError::new(
                ProviderErrorCode::ProviderUnavailable,
                "computer-use provider did not start",
            )
        })?;
        let is_emergency_stop = matches!(request, HostRequest::EmergencyStop);
        let envelope = RequestEnvelope::new(process.identity().boot_token, operation_id, request);
        let response = match process.transact(&envelope) {
            Ok(response) => response,
            Err(error) => return Err(self.restart_after_failure(error)),
        };
        if response.request_id != envelope.request_id
            || response.operation_id != envelope.operation_id
        {
            return Err(self.restart_after_failure(HostIoError::new(
                HostIoErrorKind::Protocol,
                "sidecar response identity did not match its request",
            )));
        }
        let result = response.result;
        if is_emergency_stop {
            self.emergency_stopped = true;
            if let Some(process) = self.process.take() {
                self.validate_owned(process.identity())?;
                process.terminate_owned().map_err(host_io_error)?;
            }
        }
        result
    }

    pub fn status(&self) -> super::types::ProviderStatus {
        super::types::ProviderStatus {
            running: self.process.is_some() && !self.emergency_stopped,
            emergency_stopped: self.emergency_stopped,
            host_generation: self.generation,
            host_process_id: self.process.as_ref().map(|process| process.identity().pid),
        }
    }

    pub fn restart_provider(&mut self) -> Result<(), ProviderError> {
        if let Some(process) = self.process.take() {
            self.validate_owned(process.identity())?;
            process.terminate_owned().map_err(host_io_error)?;
        }
        self.emergency_stopped = false;
        self.ensure_started()
    }

    pub fn stop(&mut self) -> Result<(), ProviderError> {
        if let Some(process) = self.process.take() {
            self.validate_owned(process.identity())?;
            process.terminate_owned().map_err(host_io_error)?;
        }
        Ok(())
    }

    pub fn into_spawner(self) -> S {
        self.spawner
    }

    fn ensure_started(&mut self) -> Result<(), ProviderError> {
        if self.process.is_some() {
            return Ok(());
        }
        self.generation = self.generation.saturating_add(1);
        let token = BootToken::generate();
        let process = self
            .spawner
            .spawn(&self.executable_path, token, self.generation)
            .map_err(host_io_error)?;
        self.validate_spawned(process.identity(), token, self.generation)?;
        self.process = Some(process);
        Ok(())
    }

    fn restart_after_failure(&mut self, error: HostIoError) -> ProviderError {
        if let Some(process) = self.process.take() {
            if self.validate_owned(process.identity()).is_ok() {
                let _ = process.terminate_owned();
            }
        }

        // A failed request is never replayed. A replacement is prepared only for the next
        // explicit operation, and the caller receives a typed failure for this operation.
        let previous_generation = self.generation;
        let restart_result = self.ensure_started();
        match restart_result {
            Ok(()) => ProviderError::new(
                ProviderErrorCode::HostRestarted,
                "computer-use host failed and was restarted; the action was not replayed",
            )
            .retryable()
            .with_detail("failedGeneration", previous_generation.to_string())
            .with_detail("replacementGeneration", self.generation.to_string())
            .with_detail("cause", error.to_string()),
            Err(restart_error) => ProviderError::new(
                ProviderErrorCode::HostFailed,
                "computer-use host failed and could not be restarted",
            )
            .retryable()
            .with_detail("failedGeneration", previous_generation.to_string())
            .with_detail("cause", error.to_string())
            .with_detail("restartError", restart_error.to_string()),
        }
    }

    fn validate_spawned(
        &self,
        identity: &ProviderProcessIdentity,
        expected_token: BootToken,
        expected_generation: u64,
    ) -> Result<(), ProviderError> {
        self.validate_owned(identity)?;
        if identity.pid == 0
            || identity.generation != expected_generation
            || !identity.boot_token.constant_time_eq(&expected_token)
        {
            return Err(ProviderError::new(
                ProviderErrorCode::OwnershipMismatch,
                "spawned computer-use provider identity did not match the launch contract",
            ));
        }
        Ok(())
    }

    fn validate_owned(&self, identity: &ProviderProcessIdentity) -> Result<(), ProviderError> {
        if !same_executable_path(&identity.executable_path, &self.executable_path) {
            return Err(ProviderError::new(
                ProviderErrorCode::OwnershipMismatch,
                "refusing to control a provider process outside the exact configured executable",
            )
            .with_detail(
                "expectedExecutable",
                self.executable_path.to_string_lossy().into_owned(),
            )
            .with_detail(
                "actualExecutable",
                identity.executable_path.to_string_lossy().into_owned(),
            ));
        }
        Ok(())
    }
}

pub fn serve_connection<B, R, W>(
    provider: &mut ComputerUseProvider<B>,
    expected_token: BootToken,
    reader: &mut R,
    writer: &mut W,
) -> Result<(), HostIoError>
where
    B: ComputerBackend,
    R: Read,
    W: Write,
{
    loop {
        let request = match read_authenticated_request(reader, &expected_token) {
            Ok(request) => request,
            Err(super::frame::FrameError::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::BrokenPipe
                ) =>
            {
                return Ok(())
            }
            Err(error) => {
                return Err(HostIoError::new(
                    HostIoErrorKind::Protocol,
                    error.to_string(),
                ))
            }
        };
        let stop = matches!(request.request, HostRequest::EmergencyStop);
        let result = dispatch(provider, &request.request);
        let response = match result {
            Ok(body) => ResponseEnvelope::success(&request, body),
            Err(error) => ResponseEnvelope::failure(&request, error),
        };
        write_frame(writer, &response)
            .map_err(|error| HostIoError::new(HostIoErrorKind::BrokenPipe, error.to_string()))?;
        if stop {
            return Ok(());
        }
    }
}

fn dispatch<B>(
    provider: &mut ComputerUseProvider<B>,
    request: &HostRequest,
) -> Result<HostResponseBody, ProviderError>
where
    B: ComputerBackend,
{
    match request {
        HostRequest::Capabilities => Ok(HostResponseBody::Capabilities(provider.capabilities())),
        HostRequest::ProviderStatus => Ok(HostResponseBody::ProviderStatus(
            super::types::ProviderStatus {
                running: true,
                emergency_stopped: false,
                host_generation: 0,
                host_process_id: Some(std::process::id()),
            },
        )),
        HostRequest::RestartProvider => Err(ProviderError::new(
            ProviderErrorCode::InvalidArgument,
            "provider restart is owned by the parent supervisor",
        )),
        HostRequest::ListApps => provider.list_apps().map(HostResponseBody::Apps),
        HostRequest::ListWindows { process_id } => provider
            .list_windows(*process_id)
            .map(HostResponseBody::Windows),
        HostRequest::Snapshot { request } => provider
            .snapshot(request.clone())
            .map(HostResponseBody::Snapshot),
        HostRequest::ApprovalCreate { request } => provider
            .create_approval(request.clone())
            .map(HostResponseBody::Approval),
        HostRequest::ApprovalResolve {
            approval_id,
            approved,
        } => provider
            .resolve_approval(*approval_id, *approved)
            .map(HostResponseBody::Approval),
        HostRequest::ApprovalList { limit } => {
            Ok(HostResponseBody::Approvals(provider.approvals(*limit)))
        }
        HostRequest::Action { request } => provider
            .action(request.clone())
            .map(HostResponseBody::Action),
        HostRequest::ActionHistory { limit } => Ok(HostResponseBody::ActionHistory(
            provider.action_history(*limit),
        )),
        HostRequest::EmergencyStop => {
            provider.emergency_stop();
            Ok(HostResponseBody::Stopped)
        }
    }
}

fn host_io_error(error: HostIoError) -> ProviderError {
    ProviderError::new(ProviderErrorCode::ProviderUnavailable, error.to_string()).retryable()
}

fn same_executable_path(left: &Path, right: &Path) -> bool {
    let normalize = |path: &Path| {
        path.to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    };
    normalize(left) == normalize(right)
}

pub fn default_provider<B>(backend: B) -> ComputerUseProvider<B>
where
    B: ComputerBackend,
{
    ComputerUseProvider::new(backend, SensitiveAppPolicy::default())
}
