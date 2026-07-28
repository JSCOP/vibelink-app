use super::model::AutomationRuntimeIdentity;
use anyhow::{anyhow, Result};
use std::{
    collections::HashMap,
    io,
    os::windows::io::AsRawHandle,
    process::{Child, Command, ExitStatus},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex, MutexGuard, Weak,
    },
    thread,
};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{CloseHandle, FILETIME, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{
                GetProcessTimes, OpenProcess, TerminateProcess, WaitForSingleObject,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
            },
        },
    },
};

const TERMINATE_WAIT_MS: u32 = 5_000;

#[derive(Clone)]
pub struct AutomationProcessRegistry {
    inner: Arc<RegistryInner>,
}

struct RegistryInner {
    processes: Mutex<HashMap<String, RegisteredEntry>>,
    next_generation: AtomicU64,
}

struct RegisteredEntry {
    identity: AutomationRuntimeIdentity,
    control: ProcessControl,
    completion: Arc<Completion>,
    cancelled: Arc<AtomicBool>,
}

pub struct RegisteredProcess {
    registry: Weak<RegistryInner>,
    run_id: String,
    identity: AutomationRuntimeIdentity,
    completion: Arc<Completion>,
    cancelled: Arc<AtomicBool>,
}

struct ProcessControl {
    process: OwnedHandle,
    job: OwnedHandle,
}

struct Completion {
    outcome: Mutex<Option<WaitOutcome>>,
    changed: Condvar,
}

#[derive(Clone)]
enum WaitOutcome {
    Exited(ExitStatus),
    Failed(WaitError),
}

#[derive(Clone)]
struct WaitError {
    kind: io::ErrorKind,
    raw_os_error: Option<i32>,
    message: String,
}

struct OwnedHandle(HANDLE);

// SAFETY: Windows kernel handles (`HANDLE`) are process-wide identifiers, not bound to the thread
// that created them. `OwnedHandle` uniquely owns the underlying handle (and closes it on Drop),
// and all operations using `OwnedHandle` are synchronized via external mutexes/ownership bounds,
// making it safe to transfer ownership (`Send`) across threads.
unsafe impl Send for OwnedHandle {}

impl AutomationProcessRegistry {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RegistryInner {
                processes: Mutex::new(HashMap::new()),
                next_generation: AtomicU64::new(1),
            }),
        }
    }

    pub fn spawn(&self, run_id: &str, command: &mut Command) -> io::Result<RegisteredProcess> {
        let child = command.spawn()?;
        self.register(run_id, child)
    }

    pub fn register(&self, run_id: &str, mut child: Child) -> io::Result<RegisteredProcess> {
        if run_id.trim().is_empty() {
            terminate_unregistered(&mut child);
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "automation run id must not be empty",
            ));
        }
        let generation = self.take_generation()?;
        let identity = match process_identity(&child, generation) {
            Ok(identity) => identity,
            Err(error) => {
                terminate_unregistered(&mut child);
                return Err(error);
            }
        };
        let control = match ProcessControl::assign(&child, identity.process_start_time) {
            Ok(control) => control,
            Err(error) => {
                terminate_unregistered(&mut child);
                return Err(error);
            }
        };
        let completion = Arc::new(Completion::new());
        let cancelled = Arc::new(AtomicBool::new(false));
        spawn_waiter(child, Arc::clone(&completion))?;
        let entry = RegisteredEntry {
            identity: identity.clone(),
            control,
            completion: Arc::clone(&completion),
            cancelled: Arc::clone(&cancelled),
        };
        let collision = {
            let mut processes = lock_unpoison(&self.inner.processes);
            if processes.contains_key(run_id) {
                Some(entry)
            } else {
                processes.insert(run_id.to_string(), entry);
                None
            }
        };
        if let Some(entry) = collision {
            let cleanup = terminate_entry(entry, false);
            return Err(cleanup.err().unwrap_or_else(|| {
                io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!("automation run {run_id} already owns a process"),
                )
            }));
        }
        Ok(RegisteredProcess {
            registry: Arc::downgrade(&self.inner),
            run_id: run_id.to_string(),
            identity,
            completion,
            cancelled,
        })
    }

    pub fn cancel(&self, run_id: &str) -> Result<bool> {
        self.inner
            .cancel_current(run_id)
            .map_err(|error| anyhow!("cancel automation run {run_id}: {error}"))
    }

    pub fn unregister(&self, run_id: &str, generation: u64) -> io::Result<bool> {
        self.inner.unregister(run_id, generation)
    }

    pub fn cancel_all(&self) -> Result<()> {
        self.inner
            .cancel_all()
            .map_err(|error| anyhow!("cancel automation processes: {error}"))
    }

    fn take_generation(&self) -> io::Result<u64> {
        let generation = self.inner.next_generation.fetch_add(1, Ordering::Relaxed);
        if generation == 0 || generation == u64::MAX {
            return Err(io::Error::other(
                "automation process generation space exhausted",
            ));
        }
        Ok(generation)
    }
}

pub fn terminate_persisted_process(identity: &AutomationRuntimeIdentity) -> io::Result<bool> {
    let process = match open_exact_process(identity.pid, identity.process_start_time) {
        Ok(process) => process,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    let wait = unsafe { WaitForSingleObject(process.0, 0) };
    if wait == WAIT_OBJECT_0 {
        return Ok(false);
    }
    if wait != WAIT_TIMEOUT {
        return Err(io::Error::last_os_error());
    }
    unsafe { TerminateProcess(process.0, 1) }.map_err(windows_error)?;
    let terminated = unsafe { WaitForSingleObject(process.0, TERMINATE_WAIT_MS) };
    if terminated != WAIT_OBJECT_0 {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!(
                "persisted automation process {} did not terminate",
                identity.pid
            ),
        ));
    }
    Ok(true)
}

impl Default for AutomationProcessRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl RegisteredProcess {
    pub fn runtime_identity(&self) -> AutomationRuntimeIdentity {
        self.identity.clone()
    }

    pub fn try_wait(&self) -> io::Result<Option<ExitStatus>> {
        let Some(outcome) = self.completion.try_outcome() else {
            return Ok(None);
        };
        if let Some(registry) = self.registry.upgrade() {
            let _ = registry.unregister(&self.run_id, self.identity.generation)?;
        }
        outcome.into_result().map(Some)
    }

    pub fn terminate_and_wait(&self) -> io::Result<()> {
        if let Some(registry) = self.registry.upgrade() {
            let _ = registry.cancel_generation(&self.run_id, self.identity.generation)?;
        }
        self.completion.wait().into_result().map(|_| ())
    }

    pub fn was_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

impl Drop for RegisteredProcess {
    fn drop(&mut self) {
        if let Some(registry) = self.registry.upgrade() {
            let _ = registry.cancel_generation(&self.run_id, self.identity.generation);
        }
    }
}

impl RegistryInner {
    fn cancel_current(&self, run_id: &str) -> io::Result<bool> {
        match lock_unpoison(&self.processes).remove(run_id) {
            Some(entry) => terminate_entry(entry, true).map(|()| true),
            None => Ok(false),
        }
    }

    fn cancel_generation(&self, run_id: &str, generation: u64) -> io::Result<bool> {
        let entry = {
            let mut processes = lock_unpoison(&self.processes);
            match processes.get(run_id) {
                Some(entry) if entry.identity.generation == generation => processes.remove(run_id),
                _ => None,
            }
        };
        match entry {
            Some(entry) => terminate_entry(entry, true).map(|()| true),
            None => Ok(false),
        }
    }

    fn unregister(&self, run_id: &str, generation: u64) -> io::Result<bool> {
        let entry = {
            let mut processes = lock_unpoison(&self.processes);
            match processes.get(run_id) {
                Some(entry) if entry.identity.generation == generation => processes.remove(run_id),
                _ => None,
            }
        };
        match entry {
            Some(entry) => terminate_entry(entry, false).map(|()| true),
            None => Ok(false),
        }
    }

    fn cancel_all(&self) -> io::Result<()> {
        let entries = lock_unpoison(&self.processes)
            .drain()
            .map(|(_, entry)| entry)
            .collect::<Vec<_>>();
        let mut first_error = None;
        for entry in entries {
            if let Err(error) = terminate_entry(entry, true) {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

impl Drop for RegistryInner {
    fn drop(&mut self) {
        let entries = match self.processes.get_mut() {
            Ok(processes) => processes
                .drain()
                .map(|(_, entry)| entry)
                .collect::<Vec<_>>(),
            Err(poisoned) => poisoned
                .into_inner()
                .drain()
                .map(|(_, entry)| entry)
                .collect::<Vec<_>>(),
        };
        for entry in entries {
            let _ = terminate_entry(entry, true);
        }
    }
}

impl ProcessControl {
    fn assign(child: &Child, expected_start_time: u64) -> io::Result<Self> {
        use std::{ffi::c_void, mem::size_of};
        let process = open_exact_process(child.id(), expected_start_time)?;
        let job =
            OwnedHandle(unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(windows_error)?);
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
        .map_err(windows_error)?;
        unsafe { AssignProcessToJobObject(job.0, HANDLE(child.as_raw_handle())) }
            .map_err(windows_error)?;
        Ok(Self { process, job })
    }

    fn terminate_and_wait(&self) -> io::Result<()> {
        match unsafe { WaitForSingleObject(self.process.0, 0) } {
            WAIT_OBJECT_0 => return Ok(()),
            WAIT_TIMEOUT => {}
            _ => return Err(io::Error::last_os_error()),
        }
        if let Err(error) = unsafe { TerminateJobObject(self.job.0, 1) } {
            if unsafe { WaitForSingleObject(self.process.0, 0) } != WAIT_OBJECT_0 {
                return Err(windows_error(error));
            }
        }
        match unsafe { WaitForSingleObject(self.process.0, TERMINATE_WAIT_MS) } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "timed out waiting for the exact automation process job to exit",
            )),
            _ => Err(io::Error::last_os_error()),
        }
    }
}

impl Completion {
    fn new() -> Self {
        Self {
            outcome: Mutex::new(None),
            changed: Condvar::new(),
        }
    }

    fn finish(&self, outcome: WaitOutcome) {
        *lock_unpoison(&self.outcome) = Some(outcome);
        self.changed.notify_all();
    }

    fn try_outcome(&self) -> Option<WaitOutcome> {
        lock_unpoison(&self.outcome).clone()
    }

    fn wait(&self) -> WaitOutcome {
        let mut outcome = lock_unpoison(&self.outcome);
        loop {
            if let Some(outcome) = outcome.clone() {
                return outcome;
            }
            outcome = match self.changed.wait(outcome) {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
        }
    }
}

impl WaitOutcome {
    fn from_result(result: io::Result<ExitStatus>) -> Self {
        match result {
            Ok(status) => Self::Exited(status),
            Err(error) => Self::Failed(WaitError {
                kind: error.kind(),
                raw_os_error: error.raw_os_error(),
                message: error.to_string(),
            }),
        }
    }

    fn into_result(self) -> io::Result<ExitStatus> {
        match self {
            Self::Exited(status) => Ok(status),
            Self::Failed(error) => match error.raw_os_error {
                Some(code) => Err(io::Error::from_raw_os_error(code)),
                None => Err(io::Error::new(error.kind, error.message)),
            },
        }
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
}

fn process_identity(child: &Child, generation: u64) -> io::Result<AutomationRuntimeIdentity> {
    Ok(AutomationRuntimeIdentity {
        pid: child.id(),
        process_start_time: process_start_time(HANDLE(child.as_raw_handle()))?,
        generation,
    })
}

fn open_exact_process(pid: u32, expected_start_time: u64) -> io::Result<OwnedHandle> {
    let process = OwnedHandle(
        unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
                false,
                pid,
            )
        }
        .map_err(windows_error)?,
    );
    if process_start_time(process.0)? != expected_start_time {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "automation process identity changed before registration",
        ));
    }
    Ok(process)
}

fn process_start_time(process: HANDLE) -> io::Result<u64> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) }
        .map_err(windows_error)?;
    Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
}

fn spawn_waiter(mut child: Child, completion: Arc<Completion>) -> io::Result<()> {
    let holder = Arc::new(Mutex::new(Some(child)));
    let waiter_holder = Arc::clone(&holder);
    let waiter_completion = Arc::clone(&completion);
    match thread::Builder::new()
        .name("vibelink-automation-process-wait".to_string())
        .spawn(move || {
            let mut child = lock_unpoison(&waiter_holder)
                .take()
                .expect("automation waiter owns child");
            waiter_completion.finish(WaitOutcome::from_result(child.wait()));
        }) {
        Ok(_) => Ok(()),
        Err(error) => {
            child = lock_unpoison(&holder)
                .take()
                .expect("failed waiter returns child");
            let _ = child.kill();
            completion.finish(WaitOutcome::from_result(child.wait()));
            Err(error)
        }
    }
}

fn terminate_entry(entry: RegisteredEntry, cancelled: bool) -> io::Result<()> {
    if cancelled {
        entry.cancelled.store(true, Ordering::Release);
    }
    let termination = entry.control.terminate_and_wait();
    let reaped = entry.completion.wait().into_result().map(|_| ());
    termination.and(reaped)
}

fn terminate_unregistered(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn windows_error(error: windows::core::Error) -> io::Error {
    io::Error::other(error.to_string())
}

fn lock_unpoison<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::{Path, PathBuf},
        process::Stdio,
        time::{Duration, Instant},
    };
    use uuid::Uuid;

    struct FakeTreeFiles {
        root: PathBuf,
        ready: PathBuf,
        release: PathBuf,
        descendant: PathBuf,
    }

    impl FakeTreeFiles {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "vibelink-automation-registry-{label}-{}",
                Uuid::new_v4()
            ));
            fs::create_dir_all(&root).unwrap();
            Self {
                ready: root.join("root.pid"),
                release: root.join("release"),
                descendant: root.join("descendant.pid"),
                root,
            }
        }
    }

    impl Drop for FakeTreeFiles {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn cancel_kills_only_owned_root_and_descendant_across_threads() {
        let owned_files = FakeTreeFiles::new("owned");
        let unrelated_files = FakeTreeFiles::new("unrelated");
        let registry = AutomationProcessRegistry::new();
        let unrelated_registry = AutomationProcessRegistry::new();
        let owned = registry
            .register("owned", spawn_fake_tree(&owned_files))
            .unwrap();
        let unrelated = unrelated_registry
            .register("unrelated", spawn_fake_tree(&unrelated_files))
            .unwrap();
        release_tree(&owned_files);
        release_tree(&unrelated_files);
        let owned_descendant = wait_for_pid(&owned_files.descendant);
        let unrelated_descendant = wait_for_pid(&unrelated_files.descendant);

        let clone = registry.clone();
        assert!(thread::spawn(move || clone.cancel("owned"))
            .join()
            .unwrap()
            .unwrap());
        assert!(wait_until(Duration::from_secs(5), || {
            !process_is_alive(owned.runtime_identity().pid) && !process_is_alive(owned_descendant)
        }));
        assert!(process_is_alive(unrelated.runtime_identity().pid));
        assert!(process_is_alive(unrelated_descendant));
        assert!(owned.was_cancelled());
        assert!(owned.try_wait().unwrap().is_some());
        assert!(unrelated_registry.cancel("unrelated").unwrap());
    }

    #[test]
    fn stale_generation_cannot_touch_replacement() {
        let registry = AutomationProcessRegistry::new();
        let first_files = FakeTreeFiles::new("first");
        let first = registry
            .register("same", spawn_fake_tree(&first_files))
            .unwrap();
        release_tree(&first_files);
        let _ = wait_for_pid(&first_files.descendant);
        first.terminate_and_wait().unwrap();

        let second_files = FakeTreeFiles::new("second");
        let second = registry
            .register("same", spawn_fake_tree(&second_files))
            .unwrap();
        release_tree(&second_files);
        let second_descendant = wait_for_pid(&second_files.descendant);
        assert!(!registry
            .unregister("same", first.runtime_identity().generation)
            .unwrap());
        first.terminate_and_wait().unwrap();
        assert!(process_is_alive(second.runtime_identity().pid));
        assert!(process_is_alive(second_descendant));
        assert!(!second.was_cancelled());
        assert!(registry.cancel("same").unwrap());
        assert!(second.was_cancelled());
    }

    fn spawn_fake_tree(files: &FakeTreeFiles) -> Child {
        let script = r#"
$ErrorActionPreference = 'Stop'
Set-Content -LiteralPath $env:VIBELINK_TEST_READY -Value $PID
while (-not (Test-Path -LiteralPath $env:VIBELINK_TEST_RELEASE)) { Start-Sleep -Milliseconds 20 }
$ping = Join-Path $env:SystemRoot 'System32\PING.EXE'
$child = Start-Process -FilePath $ping -ArgumentList '-t','127.0.0.1' -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $env:VIBELINK_TEST_DESCENDANT -Value $child.Id
Wait-Process -Id $child.Id
"#;
        Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ])
            .env("VIBELINK_TEST_READY", &files.ready)
            .env("VIBELINK_TEST_RELEASE", &files.release)
            .env("VIBELINK_TEST_DESCENDANT", &files.descendant)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    fn release_tree(files: &FakeTreeFiles) {
        let _ = wait_for_pid(&files.ready);
        fs::write(&files.release, b"go").unwrap();
    }

    fn wait_for_pid(path: &Path) -> u32 {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(value) = fs::read_to_string(path) {
                if let Ok(pid) = value.trim().parse() {
                    return pid;
                }
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {}",
                path.display()
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn process_is_alive(pid: u32) -> bool {
        let Ok(handle) = (unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }) else {
            return false;
        };
        let handle = OwnedHandle(handle);
        (unsafe { WaitForSingleObject(handle.0, 0) }) == WAIT_TIMEOUT
    }

    fn wait_until(timeout: Duration, condition: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if condition() {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        condition()
    }
}
