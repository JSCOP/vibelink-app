use std::collections::{HashMap, HashSet, VecDeque};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

/// Collect every descendant PID below `root` from a parent -> children map.
pub fn descendant_pids(children: &HashMap<u32, Vec<u32>>, root: u32) -> Vec<u32> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut queue = VecDeque::new();

    if let Some(kids) = children.get(&root) {
        for &kid in kids {
            queue.push_back(kid);
        }
    }

    while let Some(pid) = queue.pop_front() {
        if !seen.insert(pid) {
            continue;
        }
        out.push(pid);
        if let Some(kids) = children.get(&pid) {
            for &kid in kids {
                queue.push_back(kid);
            }
        }
    }

    out
}

fn child_map(sys: &System) -> HashMap<u32, Vec<u32>> {
    let mut map: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, process) in sys.processes() {
        if let Some(parent) = process.parent() {
            map.entry(parent.as_u32()).or_default().push(pid.as_u32());
        }
    }
    map
}

/// One process listing with NO per-process detail. `refresh_processes` defaults
/// to exe + memory + CPU + disk usage, which opens a handle and reads the PEB of
/// EVERY process on the machine — measured at 250-300 ms with ~490 processes
/// live. PID and parent PID both come straight from the kernel snapshot, so the
/// tree walk and the liveness check need nothing more.
fn process_snapshot() -> System {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    sys
}

/// Kill `root` first, then every currently visible descendant process deepest-first.
///
/// This is the FALLBACK path: a pane whose root sits in a `PaneProcessJob` is
/// killed through `PaneProcessJob::terminate`, one syscall for the whole tree.
/// Walking the tree here is expensive on Windows because `sysinfo`'s `kill()`
/// shells out to `taskkill.exe /F` once per process.
pub fn kill_process_tree(root: u32) {
    let sys = process_snapshot();
    let children = child_map(&sys);
    let mut descendants = descendant_pids(&children, root);

    if let Some(process) = sys.process(Pid::from_u32(root)) {
        let _ = process.kill();
    }

    descendants.reverse();
    for pid in descendants {
        if let Some(process) = sys.process(Pid::from_u32(pid)) {
            let _ = process.kill();
        }
    }
}

/// Return whether the exact PID is still present.
pub fn process_exists(pid: u32) -> bool {
    process_snapshot().process(Pid::from_u32(pid)).is_some()
}

#[cfg(windows)]
pub struct PaneProcessJob {
    handle: OwnedHandle,
}

#[cfg(windows)]
impl PaneProcessJob {
    /// Create a kill-on-close job and assign the exact pane root process to it.
    pub fn assign(pid: u32) -> std::io::Result<Self> {
        use std::{ffi::c_void, mem::size_of};
        use windows::{
            core::PCWSTR,
            Win32::System::{
                JobObjects::{
                    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
                Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
            },
        };

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

        let process = OwnedHandle(
            unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid) }
                .map_err(windows_error)?,
        );
        unsafe { AssignProcessToJobObject(job.0, process.0) }.map_err(windows_error)?;

        Ok(Self { handle: job })
    }

    /// Kill every process in the job with one syscall. Descendants inherit the
    /// job (no `JOB_OBJECT_LIMIT_BREAKAWAY_OK`), so this replaces a whole
    /// process-tree walk — see `kill_process_tree` for why that matters.
    pub fn terminate(&self) -> std::io::Result<()> {
        use windows::Win32::System::JobObjects::TerminateJobObject;

        unsafe { TerminateJobObject(self.handle.0, 1) }.map_err(windows_error)
    }
}

#[cfg(windows)]
struct OwnedHandle(windows::Win32::Foundation::HANDLE);

#[cfg(windows)]
// SAFETY: Windows kernel handles are process-wide identifiers. This wrapper uniquely owns
// the job handle, closes it on Drop, and is only moved with its owning Pane.
unsafe impl Send for OwnedHandle {}

#[cfg(windows)]
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        use windows::Win32::Foundation::CloseHandle;

        if !self.0.is_invalid() {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(windows)]
fn windows_error(error: windows::core::Error) -> std::io::Error {
    std::io::Error::other(error.to_string())
}

#[cfg(windows)]
pub fn wait_for_process_exit(pid: u32, timeout: std::time::Duration) -> std::io::Result<bool> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::Threading::{OpenProcess, WaitForSingleObject},
    };
    const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;

    let process = unsafe { OpenProcess(SYNCHRONIZE_ACCESS, 0, pid) };
    if process.is_null() {
        if !process_exists(pid) {
            return Ok(true);
        }
        return Err(std::io::Error::last_os_error());
    }
    let timeout_ms = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
    let result = unsafe { WaitForSingleObject(process, timeout_ms) };
    unsafe { CloseHandle(process) };
    match result {
        WAIT_OBJECT_0 => Ok(true),
        WAIT_TIMEOUT => Ok(false),
        _ => Err(std::io::Error::last_os_error()),
    }
}

#[cfg(not(windows))]
pub fn wait_for_process_exit(pid: u32, timeout: std::time::Duration) -> std::io::Result<bool> {
    let deadline = std::time::Instant::now() + timeout;
    while process_exists(pid) {
        if std::time::Instant::now() >= deadline {
            return Ok(false);
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    Ok(true)
}

/// Return `root` followed by every currently visible descendant PID.
pub fn tree_pids(sys: &System, root: u32) -> Vec<u32> {
    let children = child_map(sys);
    let mut pids = Vec::with_capacity(1);
    pids.push(root);
    pids.extend(descendant_pids(&children, root));
    pids
}

/// Return working-set bytes and process count for `root` plus all descendants.
pub fn tree_metrics(sys: &System, root: u32) -> (u64, u32) {
    let mut mem_bytes = 0u64;
    let mut process_count = 0u32;
    for pid in tree_pids(sys, root) {
        if let Some(process) = sys.process(Pid::from_u32(pid)) {
            mem_bytes += process.memory();
            process_count += 1;
        }
    }

    (mem_bytes, process_count)
}

#[cfg(test)]
mod tests {
    use super::descendant_pids;
    #[cfg(windows)]
    use super::{child_map, kill_process_tree};
    use std::collections::{HashMap, HashSet};
    #[cfg(windows)]
    use std::{
        process::Command,
        thread,
        time::{Duration, Instant},
    };
    #[cfg(windows)]
    use sysinfo::{Pid, ProcessesToUpdate, System};

    #[test]
    fn descendant_pids_returns_only_root_descendants() {
        let mut children = HashMap::new();
        children.insert(10, vec![11, 13]);
        children.insert(11, vec![12]);
        children.insert(20, vec![21]);

        let descendants: HashSet<_> = descendant_pids(&children, 10).into_iter().collect();

        assert_eq!(descendants, HashSet::from([11, 12, 13]));
        assert!(!descendants.contains(&10));
        assert!(!descendants.contains(&20));
        assert!(!descendants.contains(&21));
    }

    #[cfg(windows)]
    #[test]
    fn kill_process_tree_terminates_spawned_descendants() {
        let mut root = Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-Command",
                "$child = Start-Process -FilePath powershell.exe -ArgumentList '-NoLogo -NoProfile -Command Start-Sleep -Seconds 60' -PassThru; Start-Sleep -Seconds 60",
            ])
            .spawn()
            .expect("spawn root powershell");
        let root_pid = root.id();

        let targets = wait_for_descendant(root_pid);
        kill_process_tree(root_pid);

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut sys = System::new();
            sys.refresh_processes(ProcessesToUpdate::All, true);
            if targets
                .iter()
                .all(|pid| sys.process(Pid::from_u32(*pid)).is_none())
            {
                break;
            }
            if Instant::now() >= deadline {
                let _ = root.kill();
                let _ = root.wait();
                panic!("process tree still alive after kill_process_tree: {targets:?}");
            }
            thread::sleep(Duration::from_millis(100));
        }
        let _ = root.wait();
    }

    #[cfg(windows)]
    #[test]
    fn pane_process_job_kills_assigned_process_tree_when_released() {
        let mut root = Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-Command",
                "Start-Sleep -Seconds 1; $child = Start-Process -FilePath powershell.exe -ArgumentList '-NoLogo -NoProfile -Command Start-Sleep -Seconds 60' -PassThru; Start-Sleep -Seconds 60",
            ])
            .spawn()
            .expect("spawn pane job root powershell");
        let root_pid = root.id();
        let job = match super::PaneProcessJob::assign(root_pid) {
            Ok(job) => job,
            Err(error) => {
                kill_process_tree(root_pid);
                let _ = root.wait();
                panic!("assign pane root to kill-on-close job: {error}");
            }
        };
        let targets = wait_for_descendant(root_pid);

        drop(job);

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut sys = System::new();
            sys.refresh_processes(ProcessesToUpdate::All, true);
            if targets
                .iter()
                .all(|pid| sys.process(Pid::from_u32(*pid)).is_none())
            {
                break;
            }
            if Instant::now() >= deadline {
                kill_process_tree(root_pid);
                let _ = root.wait();
                panic!("pane job process tree still alive after job release: {targets:?}");
            }
            thread::sleep(Duration::from_millis(100));
        }
        let _ = root.wait();
    }

    /// `Pane::kill` terminates the job while still HOLDING its handle, so the
    /// tree must die from `TerminateJobObject` alone — not from the drop.
    #[cfg(windows)]
    #[test]
    fn pane_process_job_terminate_kills_tree_while_handle_is_held() {
        let mut root = Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-Command",
                "Start-Sleep -Seconds 1; $child = Start-Process -FilePath powershell.exe -ArgumentList '-NoLogo -NoProfile -Command Start-Sleep -Seconds 60' -PassThru; Start-Sleep -Seconds 60",
            ])
            .spawn()
            .expect("spawn pane job root powershell");
        let root_pid = root.id();
        let job = match super::PaneProcessJob::assign(root_pid) {
            Ok(job) => job,
            Err(error) => {
                kill_process_tree(root_pid);
                let _ = root.wait();
                panic!("assign pane root to kill-on-close job: {error}");
            }
        };
        let targets = wait_for_descendant(root_pid);

        job.terminate().expect("terminate pane job");

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut sys = System::new();
            sys.refresh_processes(ProcessesToUpdate::All, true);
            if targets
                .iter()
                .all(|pid| sys.process(Pid::from_u32(*pid)).is_none())
            {
                break;
            }
            if Instant::now() >= deadline {
                drop(job);
                kill_process_tree(root_pid);
                let _ = root.wait();
                panic!("pane job process tree still alive after terminate: {targets:?}");
            }
            thread::sleep(Duration::from_millis(100));
        }
        drop(job);
        let _ = root.wait();
    }

    #[cfg(windows)]
    fn wait_for_descendant(root_pid: u32) -> Vec<u32> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut sys = System::new();
            sys.refresh_processes(ProcessesToUpdate::All, true);
            let children = child_map(&sys);
            let mut targets = descendant_pids(&children, root_pid);
            targets.push(root_pid);
            if targets.len() >= 2 {
                return targets;
            }
            if Instant::now() >= deadline {
                kill_process_tree(root_pid);
                panic!("spawned powershell descendant did not appear");
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
}
