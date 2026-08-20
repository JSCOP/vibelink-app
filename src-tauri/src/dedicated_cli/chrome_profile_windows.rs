#[cfg(windows)]
use anyhow::{anyhow, Context};
use anyhow::{bail, Result};
use std::path::Path;
#[cfg(windows)]
use std::time::Duration;

#[cfg(windows)]
const PROCESS_EXIT_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(windows)]
struct OwnedHandle(windows::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for OwnedHandle {}

#[cfg(windows)]
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(windows)]
struct ManagedProcess {
    process: OwnedHandle,
    job: OwnedHandle,
    pid: u32,
}
#[cfg(windows)]
impl ManagedProcess {
    fn terminate(&self) -> Result<()> {
        unsafe { windows::Win32::System::JobObjects::TerminateJobObject(self.job.0, 1) }
            .context("terminate the exact managed Chrome job object")?;
        wait_for_process_handle(self.process.0, PROCESS_EXIT_TIMEOUT)
    }
}

#[cfg(windows)]
static MANAGED_PROCESSES: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, ManagedProcess>>,
> = std::sync::LazyLock::new(Default::default);

pub(super) struct LaunchedChrome {
    #[cfg(windows)]
    process: Option<OwnedHandle>,
    #[cfg(windows)]
    job: Option<OwnedHandle>,
    #[cfg(windows)]
    profile_id: String,
    pid: u32,
}

impl LaunchedChrome {
    pub(super) fn pid(&self) -> u32 {
        self.pid
    }

    pub(super) fn is_alive(&self) -> Result<bool> {
        #[cfg(windows)]
        if let Some(process) = self.process.as_ref() {
            return process_handle_is_alive(process.0);
        }
        Ok(false)
    }

    pub(super) fn commit_to_daemon(&mut self, commit: impl FnOnce() -> Result<()>) -> Result<()> {
        #[cfg(windows)]
        {
            let mut processes = MANAGED_PROCESSES
                .lock()
                .map_err(|_| anyhow!("managed Chrome process registry lock was poisoned"))?;
            let process = ManagedProcess {
                process: self
                    .process
                    .take()
                    .context("managed Chrome process handle is missing")?,
                job: self
                    .job
                    .take()
                    .context("managed Chrome job handle is missing")?,
                pid: self.pid,
            };
            if let Err(error) = commit() {
                let _ = process.terminate();
                return Err(error);
            }
            processes.insert(self.profile_id.clone(), process);
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = commit;
            bail!("managed copied-profile Chrome is supported only on Windows")
        }
    }
}

impl Drop for LaunchedChrome {
    fn drop(&mut self) {
        #[cfg(windows)]
        if let Some(job) = self.job.as_ref() {
            let _ = unsafe { windows::Win32::System::JobObjects::TerminateJobObject(job.0, 1) };
            if let Some(process) = self.process.as_ref() {
                let _ = wait_for_process_handle(process.0, PROCESS_EXIT_TIMEOUT);
            }
        }
    }
}

pub(super) struct CreationLock {
    #[cfg(windows)]
    handle: OwnedHandle,
}

#[cfg(windows)]
impl Drop for CreationLock {
    fn drop(&mut self) {
        let _ = unsafe { windows::Win32::System::Threading::ReleaseMutex(self.handle.0) };
    }
}

pub(super) fn lock_creation(port: u16) -> Result<CreationLock> {
    #[cfg(windows)]
    {
        use windows::{
            core::PCWSTR,
            Win32::{
                Foundation::{WAIT_ABANDONED, WAIT_OBJECT_0},
                System::Threading::{CreateMutexW, WaitForSingleObject, INFINITE},
            },
        };
        let flavor = if port == 9_333 { "prod" } else { "dev" };
        let name = wide_null(&format!("Local\\VibeLinkChromeProfileCreation-{flavor}"));
        let lock = CreationLock {
            handle: OwnedHandle(
                unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }
                    .context("create the Chrome profile creation lock")?,
            ),
        };
        match unsafe { WaitForSingleObject(lock.handle.0, INFINITE) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(lock),
            status => bail!("wait for the Chrome profile creation lock failed: {status:?}"),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = port;
        bail!("managed copied-profile Chrome is supported only on Windows")
    }
}

pub(super) fn launch(
    artifact_root: &Path,
    chrome: &Path,
    profile_id: &str,
    user_data_dir: &Path,
    port: u16,
    reservation: std::net::TcpListener,
) -> Result<LaunchedChrome> {
    #[cfg(windows)]
    {
        launch_windows(
            artifact_root,
            chrome,
            profile_id,
            user_data_dir,
            port,
            reservation,
        )
    }
    #[cfg(not(windows))]
    {
        let _ = (
            artifact_root,
            chrome,
            profile_id,
            user_data_dir,
            port,
            reservation,
        );
        bail!("managed copied-profile Chrome is supported only on Windows")
    }
}

pub(super) fn managed_process_pid(profile_id: &str) -> Result<Option<u32>> {
    #[cfg(windows)]
    {
        let processes = MANAGED_PROCESSES
            .lock()
            .map_err(|_| anyhow!("managed Chrome process registry lock was poisoned"))?;
        if let Some(process) = processes.get(profile_id) {
            return process_handle_is_alive(process.process.0)
                .map(|alive| alive.then_some(process.pid));
        }
    }
    let _ = profile_id;
    Ok(None)
}

pub(super) fn terminate(profile_id: &str) -> Result<()> {
    #[cfg(windows)]
    if let Some(process) = MANAGED_PROCESSES
        .lock()
        .map_err(|_| anyhow!("managed Chrome process registry lock was poisoned"))?
        .remove(profile_id)
    {
        process.terminate()?;
    }
    let _ = profile_id;
    Ok(())
}

pub(super) fn sweep<'a>(registered: impl IntoIterator<Item = &'a str>) -> Result<()> {
    #[cfg(windows)]
    {
        let registered = registered
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        let stale = MANAGED_PROCESSES
            .lock()
            .map_err(|_| anyhow!("managed Chrome process registry lock was poisoned"))?
            .keys()
            .filter(|profile_id| !registered.contains(profile_id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        for profile_id in stale {
            terminate(&profile_id)?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = registered;
        Ok(())
    }
}

#[cfg(windows)]
fn launch_windows(
    artifact_root: &Path,
    chrome: &Path,
    profile_id: &str,
    user_data_dir: &Path,
    port: u16,
    reservation: std::net::TcpListener,
) -> Result<LaunchedChrome> {
    use std::{ffi::c_void, mem::size_of};
    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::{
            Foundation::HANDLE,
            System::{
                JobObjects::{
                    CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
                    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
                Threading::{
                    CreateProcessW, DeleteProcThreadAttributeList,
                    InitializeProcThreadAttributeList, UpdateProcThreadAttribute,
                    EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
                    PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_JOB_LIST, STARTUPINFOEXW,
                },
            },
        },
    };

    verify_current_daemon(artifact_root)?;
    let executable = chrome
        .canonicalize()
        .context("resolve the Google Chrome executable")?;
    let job = OwnedHandle(
        unsafe { CreateJobObjectW(None, PCWSTR::null()) }
            .context("create the managed Chrome job object")?,
    );
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    }
    .context("configure the managed Chrome job object")?;

    let mut attribute_bytes = 0;
    let _ = unsafe { InitializeProcThreadAttributeList(None, 1, None, &mut attribute_bytes) };
    if attribute_bytes == 0 {
        bail!("size the managed Chrome process attribute list");
    }
    let mut attributes = vec![0_usize; attribute_bytes.div_ceil(size_of::<usize>())];
    let attribute_list = LPPROC_THREAD_ATTRIBUTE_LIST(attributes.as_mut_ptr().cast::<c_void>());
    unsafe {
        InitializeProcThreadAttributeList(Some(attribute_list), 1, None, &mut attribute_bytes)
    }
    .context("initialize the managed Chrome process attribute list")?;
    if let Err(error) = unsafe {
        UpdateProcThreadAttribute(
            attribute_list,
            0,
            PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
            Some((&raw const job.0).cast::<c_void>()),
            size_of::<HANDLE>(),
            None,
            None,
        )
    } {
        unsafe { DeleteProcThreadAttributeList(attribute_list) };
        return Err(error).context("assign the managed Chrome job at process creation");
    }

    let mut command_line = wide_null(&format!(
        "\"{}\" --user-data-dir=\"{}\" --profile-directory=Default --remote-debugging-address=127.0.0.1 --remote-debugging-port={port} --no-first-run --no-default-browser-check --restore-last-session=false about:blank",
        executable.display(),
        user_data_dir.display()
    ));
    let executable_wide = wide_null(&executable.to_string_lossy());
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = attribute_list;
    let mut info = PROCESS_INFORMATION::default();
    drop(reservation);
    let spawned = unsafe {
        CreateProcessW(
            PCWSTR(executable_wide.as_ptr()),
            Some(PWSTR(command_line.as_mut_ptr())),
            None,
            None,
            false,
            EXTENDED_STARTUPINFO_PRESENT,
            None,
            PCWSTR::null(),
            &startup.StartupInfo,
            &mut info,
        )
    };
    unsafe { DeleteProcThreadAttributeList(attribute_list) };
    spawned.context("launch Google Chrome in its managed job object")?;
    let process = OwnedHandle(info.hProcess);
    let _thread = OwnedHandle(info.hThread);
    Ok(LaunchedChrome {
        process: Some(process),
        job: Some(job),
        profile_id: profile_id.to_string(),
        pid: info.dwProcessId,
    })
}

#[cfg(windows)]
fn verify_current_daemon(artifact_root: &Path) -> Result<()> {
    let pid = std::fs::read_to_string(artifact_root.join("daemon.pid"))
        .context("read the VibeLink daemon PID")?
        .trim()
        .parse::<u32>()
        .context("parse the VibeLink daemon PID")?;
    if pid != std::process::id() {
        bail!("managed Chrome must be launched by the exact VibeLink daemon PID");
    }
    Ok(())
}

#[cfg(windows)]
fn process_handle_is_alive(handle: windows::Win32::Foundation::HANDLE) -> Result<bool> {
    use windows::Win32::{
        Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::Threading::WaitForSingleObject,
    };
    match unsafe { WaitForSingleObject(handle, 0) } {
        WAIT_TIMEOUT => Ok(true),
        WAIT_OBJECT_0 => Ok(false),
        status => bail!("inspect the exact managed Chrome PID failed: {status:?}"),
    }
}

#[cfg(windows)]
fn wait_for_process_handle(
    handle: windows::Win32::Foundation::HANDLE,
    timeout: Duration,
) -> Result<()> {
    let deadline = std::time::Instant::now() + timeout;
    while process_handle_is_alive(handle)? && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    if process_handle_is_alive(handle)? {
        bail!("managed Chrome process did not exit before cleanup");
    }
    Ok(())
}

#[cfg(windows)]
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
