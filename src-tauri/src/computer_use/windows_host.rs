#![cfg(windows)]

use crate::computer_use::{
    frame::{read_frame, write_frame, BootToken, RequestEnvelope, ResponseEnvelope},
    host::{
        HostIoError, HostIoErrorKind, OwnedProviderProcess, ProviderProcessIdentity,
        ProviderProcessSpawner,
    },
};
use std::{
    ffi::{c_void, OsStr},
    fs::File,
    mem::{size_of, zeroed},
    os::windows::{ffi::OsStrExt, io::FromRawHandle},
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;
use windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, GetLastError, LocalFree, HANDLE, HLOCAL, WAIT_OBJECT_0},
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
            },
            PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
        },
        Storage::FileSystem::{
            FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
        },
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Pipes::{
                ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId,
                SetNamedPipeHandleState, NAMED_PIPE_MODE, PIPE_NOWAIT, PIPE_READMODE_BYTE,
                PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
            },
            Threading::{
                CreateProcessW, QueryFullProcessImageNameW, ResumeThread, WaitForSingleObject,
                CREATE_NO_WINDOW, CREATE_SUSPENDED, PROCESS_INFORMATION, PROCESS_NAME_WIN32,
                STARTUPINFOW,
            },
        },
    },
};

const ERROR_NO_DATA_CODE: u32 = 232;
const ERROR_PIPE_CONNECTED_CODE: u32 = 535;
const ERROR_PIPE_LISTENING_CODE: u32 = 536;
const PIPE_BUFFER_LEN: u32 = 4 * 1024 * 1024;
const PIPE_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TRANSACTION_TIMEOUT: Duration = Duration::from_secs(20);
const TERMINATE_WAIT_MS: u32 = 5_000;

pub struct WindowsProcessSpawner {
    artifact_root: PathBuf,
    pipe_prefix: String,
}

impl WindowsProcessSpawner {
    pub fn new(artifact_root: PathBuf, flavor: &str) -> Self {
        let flavor = flavor
            .chars()
            .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
            .collect::<String>();
        Self {
            artifact_root,
            pipe_prefix: format!("vibelink-{flavor}-computer"),
        }
    }
}

impl ProviderProcessSpawner for WindowsProcessSpawner {
    type Process = WindowsOwnedProviderProcess;

    fn spawn(
        &mut self,
        executable_path: &Path,
        boot_token: BootToken,
        generation: u64,
    ) -> Result<Self::Process, HostIoError> {
        let pipe_name = format!(
            r"\\.\pipe\{}-{}-{}",
            self.pipe_prefix,
            std::process::id(),
            Uuid::new_v4()
        );
        let server_pipe = SecureNamedPipe::create(&pipe_name)?;
        let job = create_kill_on_close_job()?;
        let spawned =
            spawn_suspended(executable_path, &pipe_name, boot_token, &self.artifact_root)?;

        if let Err(error) = unsafe { AssignProcessToJobObject(job.0, spawned.process.0) } {
            let _ = unsafe {
                windows::Win32::System::Threading::TerminateProcess(spawned.process.0, 1)
            };
            return Err(host_error(HostIoErrorKind::Other, error.to_string()));
        }
        let resumed = unsafe { ResumeThread(spawned.thread.0) };
        if resumed == u32::MAX {
            return Err(last_host_error(
                HostIoErrorKind::Other,
                "resume computer-use sidecar",
            ));
        }
        let actual_path = process_executable_path(spawned.process.0)?;
        if !same_path(&actual_path, executable_path) {
            return Err(host_error(
                HostIoErrorKind::Protocol,
                format!(
                    "spawned executable mismatch: expected {}, got {}",
                    executable_path.display(),
                    actual_path.display()
                ),
            ));
        }
        let pipe = server_pipe.connect(spawned.pid, spawned.process.0)?;
        drop(spawned.thread);
        Ok(WindowsOwnedProviderProcess {
            identity: ProviderProcessIdentity {
                instance_id: Uuid::new_v4(),
                pid: spawned.pid,
                generation,
                executable_path: actual_path,
                boot_token,
            },
            pipe,
            process: spawned.process,
            job,
        })
    }
}

pub struct WindowsOwnedProviderProcess {
    identity: ProviderProcessIdentity,
    pipe: File,
    process: OwnedHandle,
    job: OwnedHandle,
}

impl OwnedProviderProcess for WindowsOwnedProviderProcess {
    fn identity(&self) -> &ProviderProcessIdentity {
        &self.identity
    }

    fn transact(&mut self, request: &RequestEnvelope) -> Result<ResponseEnvelope, HostIoError> {
        let mut pipe = self.pipe.try_clone().map_err(|error| {
            host_error(
                HostIoErrorKind::BrokenPipe,
                format!("clone sidecar pipe: {error}"),
            )
        })?;
        let request = request.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("vibelink-computer-transaction".to_string())
            .spawn(move || {
                let result = write_frame(&mut pipe, &request)
                    .map_err(|error| {
                        host_error(
                            HostIoErrorKind::BrokenPipe,
                            format!("write sidecar request: {error}"),
                        )
                    })
                    .and_then(|()| {
                        read_frame(&mut pipe).map_err(|error| {
                            host_error(
                                HostIoErrorKind::BrokenPipe,
                                format!("read sidecar response: {error}"),
                            )
                        })
                    });
                let _ = sender.send(result);
            })
            .map_err(|error| host_error(HostIoErrorKind::Other, error.to_string()))?;
        receiver
            .recv_timeout(TRANSACTION_TIMEOUT)
            .map_err(|error| {
                host_error(
                    HostIoErrorKind::Timeout,
                    format!("computer-use sidecar request exceeded 20 seconds: {error}"),
                )
            })?
    }

    fn terminate_owned(self) -> Result<(), HostIoError> {
        unsafe { TerminateJobObject(self.job.0, 1) }
            .map_err(|error| host_error(HostIoErrorKind::Other, error.to_string()))?;
        let wait = unsafe { WaitForSingleObject(self.process.0, TERMINATE_WAIT_MS) };
        if wait != WAIT_OBJECT_0 {
            return Err(host_error(
                HostIoErrorKind::Timeout,
                "timed out waiting for the exact computer-use provider job to exit",
            ));
        }
        Ok(())
    }
}

struct SpawnedProcess {
    process: OwnedHandle,
    thread: OwnedHandle,
    pid: u32,
}

fn spawn_suspended(
    executable_path: &Path,
    pipe_name: &str,
    boot_token: BootToken,
    artifact_root: &Path,
) -> Result<SpawnedProcess, HostIoError> {
    let application = wide_null(executable_path.as_os_str());
    let command_line = format!(
        "\"{}\" --pipe \"{}\" --boot-token {} --artifact-root \"{}\"",
        executable_path.display(),
        pipe_name,
        boot_token.to_hex(),
        artifact_root.display()
    );
    let mut command_line = wide_null(OsStr::new(&command_line));
    let mut startup: STARTUPINFOW = unsafe { zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    let mut process_info: PROCESS_INFORMATION = unsafe { zeroed() };
    unsafe {
        CreateProcessW(
            PCWSTR(application.as_ptr()),
            Some(PWSTR(command_line.as_mut_ptr())),
            None,
            None,
            false,
            CREATE_NO_WINDOW | CREATE_SUSPENDED,
            None,
            None,
            &startup,
            &mut process_info,
        )
    }
    .map_err(|error| host_error(HostIoErrorKind::Other, error.to_string()))?;
    Ok(SpawnedProcess {
        process: OwnedHandle(process_info.hProcess),
        thread: OwnedHandle(process_info.hThread),
        pid: process_info.dwProcessId,
    })
}

fn create_kill_on_close_job() -> Result<OwnedHandle, HostIoError> {
    let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
        .map_err(|error| host_error(HostIoErrorKind::Other, error.to_string()))?;
    let job = OwnedHandle(handle);
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            &limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    }
    .map_err(|error| host_error(HostIoErrorKind::Other, error.to_string()))?;
    Ok(job)
}

struct SecureNamedPipe {
    handle: OwnedHandle,
}

impl SecureNamedPipe {
    fn create(pipe_name: &str) -> Result<Self, HostIoError> {
        // Protected DACL grants generic-all only to the named object's owner (the current user).
        // PIPE_REJECT_REMOTE_CLIENTS separately rejects network-originated opens.
        let sddl = wide_null(OsStr::new("D:P(A;;GA;;;OW)"));
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(sddl.as_ptr()),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
        }
        .map_err(|error| host_error(HostIoErrorKind::Other, error.to_string()))?;
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        };
        let name = wide_null(OsStr::new(pipe_name));
        let handle = unsafe {
            CreateNamedPipeW(
                PCWSTR(name.as_ptr()),
                FILE_FLAGS_AND_ATTRIBUTES(PIPE_ACCESS_DUPLEX.0 | FILE_FLAG_FIRST_PIPE_INSTANCE.0),
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                PIPE_BUFFER_LEN,
                PIPE_BUFFER_LEN,
                0,
                Some(&mut attributes),
            )
        };
        unsafe { LocalFree(Some(HLOCAL(descriptor.0))) };
        if handle.is_invalid() {
            return Err(last_host_error(
                HostIoErrorKind::Other,
                "create ACL-restricted computer-use named pipe",
            ));
        }
        Ok(Self {
            handle: OwnedHandle(handle),
        })
    }

    fn connect(self, expected_pid: u32, process: HANDLE) -> Result<File, HostIoError> {
        let deadline = Instant::now() + PIPE_CONNECT_TIMEOUT;
        loop {
            let connected = unsafe { ConnectNamedPipe(self.handle.0, None) };
            match connected {
                Ok(()) => break,
                Err(_) if unsafe { GetLastError() }.0 == ERROR_PIPE_CONNECTED_CODE => break,
                Err(_)
                    if matches!(
                        unsafe { GetLastError() }.0,
                        ERROR_PIPE_LISTENING_CODE | ERROR_NO_DATA_CODE
                    ) =>
                {
                    if unsafe { WaitForSingleObject(process, 0) } == WAIT_OBJECT_0 {
                        return Err(host_error(
                            HostIoErrorKind::ProcessExited,
                            "computer-use sidecar exited before connecting its named pipe",
                        ));
                    }
                    if Instant::now() >= deadline {
                        return Err(host_error(
                            HostIoErrorKind::Timeout,
                            "timed out waiting for computer-use sidecar pipe connection",
                        ));
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => {
                    return Err(host_error(HostIoErrorKind::BrokenPipe, error.to_string()));
                }
            }
        }
        let mut client_pid = 0_u32;
        unsafe { GetNamedPipeClientProcessId(self.handle.0, &mut client_pid) }
            .map_err(|error| host_error(HostIoErrorKind::Protocol, error.to_string()))?;
        if client_pid != expected_pid {
            return Err(host_error(
                HostIoErrorKind::Protocol,
                format!(
                    "named-pipe client PID mismatch: expected {expected_pid}, got {client_pid}"
                ),
            ));
        }
        let blocking_byte_mode = NAMED_PIPE_MODE(0);
        unsafe { SetNamedPipeHandleState(self.handle.0, Some(&blocking_byte_mode), None, None) }
            .map_err(|error| host_error(HostIoErrorKind::Protocol, error.to_string()))?;
        let raw = self.handle.into_raw();
        Ok(unsafe { File::from_raw_handle(raw.0) })
    }
}

struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn into_raw(mut self) -> HANDLE {
        let handle = self.0;
        self.0 = HANDLE::default();
        handle
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
}

fn process_executable_path(process: HANDLE) -> Result<PathBuf, HostIoError> {
    let mut buffer = vec![0_u16; 32_768];
    let mut len = buffer.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut len,
        )
    }
    .map_err(|error| host_error(HostIoErrorKind::Other, error.to_string()))?;
    buffer.truncate(len as usize);
    Ok(PathBuf::from(String::from_utf16_lossy(&buffer)))
}

fn same_path(left: &Path, right: &Path) -> bool {
    normalize_path(left) == normalize_path(right)
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn wide_null(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn last_host_error(kind: HostIoErrorKind, context: &str) -> HostIoError {
    host_error(
        kind,
        format!("{context}: {}", std::io::Error::last_os_error()),
    )
}

fn host_error(kind: HostIoErrorKind, message: impl Into<String>) -> HostIoError {
    HostIoError::new(kind, message)
}
