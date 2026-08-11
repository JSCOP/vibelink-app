use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(test)]
use uuid::Uuid;

const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_LOGCAT_LINES: usize = 20_000;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 10 * 60 * 1000;

static OWNED_PROCESSES: LazyLock<Mutex<HashMap<String, Arc<OwnedProcess>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLabFailure {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl DeviceLabFailure {
    fn new(code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            retryable,
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_argument", message, false)
    }
}

impl std::fmt::Display for DeviceLabFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for DeviceLabFailure {}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SdkDiscovery {
    pub available: bool,
    pub root: Option<String>,
    pub adb_path: Option<String>,
    pub emulator_path: Option<String>,
    pub avd_manager_path: Option<String>,
    pub sdk_manager_path: Option<String>,
    pub scrcpy_path: Option<String>,
    pub source: Option<String>,
    pub missing: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdbDevice {
    pub serial: String,
    pub state: String,
    pub product: Option<String>,
    pub model: Option<String>,
    pub device: Option<String>,
    pub transport_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub operation_id: String,
    pub executable: String,
    pub args: Vec<String>,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OwnedProcessInfo {
    pub operation_id: String,
    pub kind: String,
    pub pid: u32,
    pub executable: String,
    pub args: Vec<String>,
    pub started_at_ms: u64,
    pub running: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRequest {
    pub operation_id: String,
    #[serde(default)]
    pub sdk_root: Option<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRequest {
    pub operation_id: String,
    #[serde(default)]
    pub sdk_root: Option<String>,
    pub serial: String,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvdStartRequest {
    pub operation_id: String,
    #[serde(default)]
    pub sdk_root: Option<String>,
    pub avd_name: String,
    #[serde(default)]
    pub cold_boot: bool,
    #[serde(default)]
    pub wipe_data: bool,
    #[serde(default)]
    pub no_window: bool,
    #[serde(default)]
    pub writable_system: bool,
    #[serde(default)]
    pub port: Option<u16>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    pub operation_id: String,
    #[serde(default)]
    pub sdk_root: Option<String>,
    pub serial: String,
    pub apk_path: String,
    #[serde(default = "default_true")]
    pub replace: bool,
    #[serde(default)]
    pub allow_downgrade: bool,
    #[serde(default = "default_install_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub operation_id: String,
    #[serde(default)]
    pub sdk_root: Option<String>,
    pub serial: String,
    pub package: String,
    #[serde(default)]
    pub activity: Option<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionAction {
    Grant,
    Revoke,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub operation_id: String,
    #[serde(default)]
    pub sdk_root: Option<String>,
    pub serial: String,
    pub package: String,
    pub permission: String,
    pub action: PermissionAction,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilityStatus {
    pub enabled: bool,
    pub services: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogcatRequest {
    pub operation_id: String,
    #[serde(default)]
    pub sdk_root: Option<String>,
    pub serial: String,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default = "default_logcat_lines")]
    pub max_lines: usize,
    #[serde(default)]
    pub filters: Vec<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrcpyStartRequest {
    pub operation_id: String,
    #[serde(default)]
    pub sdk_root: Option<String>,
    #[serde(default)]
    pub scrcpy_path: Option<String>,
    pub serial: String,
    #[serde(default)]
    pub max_size: Option<u32>,
    #[serde(default)]
    pub video_bit_rate: Option<String>,
    #[serde(default)]
    pub stay_awake: bool,
    #[serde(default)]
    pub turn_screen_off: bool,
    #[serde(default)]
    pub no_audio: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelProcessRequest {
    pub operation_id: String,
    pub expected_pid: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandSpec {
    pub executable: PathBuf,
    pub args: Vec<OsString>,
}

struct OwnedProcess {
    operation_id: String,
    kind: String,
    pid: u32,
    executable: PathBuf,
    args: Vec<String>,
    started_at_ms: u64,
    cancelled: AtomicBool,
    child: Mutex<Option<Child>>,
}

fn default_timeout_ms() -> u64 {
    DEFAULT_TIMEOUT_MS
}

fn default_install_timeout_ms() -> u64 {
    2 * 60 * 1000
}

fn default_logcat_lines() -> usize {
    2_000
}

fn default_true() -> bool {
    true
}

pub fn discover_sdk(sdk_root: Option<&str>) -> SdkDiscovery {
    discover_sdk_from(
        sdk_root,
        |key| std::env::var_os(key),
        std::env::var_os("PATH"),
    )
}

fn discover_sdk_from<F>(
    sdk_root: Option<&str>,
    env_value: F,
    path_env: Option<OsString>,
) -> SdkDiscovery
where
    F: Fn(&str) -> Option<OsString>,
{
    let explicit = sdk_root
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let candidates = [
        explicit.clone().map(|path| (path, "request".to_string())),
        env_value("ANDROID_SDK_ROOT")
            .map(|path| (PathBuf::from(path), "ANDROID_SDK_ROOT".to_string())),
        env_value("ANDROID_HOME").map(|path| (PathBuf::from(path), "ANDROID_HOME".to_string())),
        env_value("LOCALAPPDATA").map(|path| {
            (
                PathBuf::from(path).join("Android").join("Sdk"),
                "LOCALAPPDATA".to_string(),
            )
        }),
        env_value("USERPROFILE").map(|path| {
            (
                PathBuf::from(path)
                    .join("AppData")
                    .join("Local")
                    .join("Android")
                    .join("Sdk"),
                "USERPROFILE".to_string(),
            )
        }),
    ];

    let selected = candidates
        .into_iter()
        .flatten()
        .find(|(root, _)| root.is_dir());
    let (root, source) = match selected {
        Some(value) => value,
        None => {
            let scrcpy = find_on_path("scrcpy", path_env.as_deref());
            return SdkDiscovery {
                available: false,
                root: explicit.map(display_path),
                adb_path: None,
                emulator_path: None,
                avd_manager_path: None,
                sdk_manager_path: None,
                scrcpy_path: scrcpy.map(display_path),
                source: None,
                missing: vec![
                    "Android SDK root".to_string(),
                    "platform-tools/adb".to_string(),
                ],
            };
        }
    };

    let adb = executable_if_file(root.join("platform-tools").join(executable_name("adb")));
    let emulator = executable_if_file(root.join("emulator").join(executable_name("emulator")));
    let avd_manager = find_cmdline_tool(&root, "avdmanager");
    let sdk_manager = find_cmdline_tool(&root, "sdkmanager");
    let scrcpy = find_on_path("scrcpy", path_env.as_deref());
    let mut missing = Vec::new();
    if adb.is_none() {
        missing.push("platform-tools/adb".to_string());
    }
    if emulator.is_none() {
        missing.push("emulator/emulator".to_string());
    }
    if avd_manager.is_none() {
        missing.push("cmdline-tools/avdmanager".to_string());
    }
    if sdk_manager.is_none() {
        missing.push("cmdline-tools/sdkmanager".to_string());
    }
    SdkDiscovery {
        available: adb.is_some(),
        root: Some(display_path(root)),
        adb_path: adb.map(display_path),
        emulator_path: emulator.map(display_path),
        avd_manager_path: avd_manager.map(display_path),
        sdk_manager_path: sdk_manager.map(display_path),
        scrcpy_path: scrcpy.map(display_path),
        source: Some(source),
        missing,
    }
}

pub fn adb_devices(request: OperationRequest) -> Result<Vec<AdbDevice>, DeviceLabFailure> {
    let spec = adb_spec(request.sdk_root.as_deref(), ["devices", "-l"])?;
    let output = run_bounded(spec, &request.operation_id, request.timeout_ms, "adb")?;
    ensure_success(&output, "adb devices")?;
    parse_adb_devices(&output.stdout)
}

pub fn avd_list(request: OperationRequest) -> Result<Vec<String>, DeviceLabFailure> {
    let sdk = discover_sdk(request.sdk_root.as_deref());
    let executable = required_tool(sdk.emulator_path, "Android emulator")?;
    let output = run_bounded(
        CommandSpec {
            executable,
            args: vec![OsString::from("-list-avds")],
        },
        &request.operation_id,
        request.timeout_ms,
        "emulator-list",
    )?;
    ensure_success(&output, "list Android virtual devices")?;
    Ok(output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

pub fn avd_start(request: AvdStartRequest) -> Result<OwnedProcessInfo, DeviceLabFailure> {
    let spec = avd_start_spec(&request)?;
    start_owned(spec, &request.operation_id, "avd")
}

pub fn apk_install(request: InstallRequest) -> Result<CommandOutput, DeviceLabFailure> {
    validate_serial(&request.serial)?;
    let apk = PathBuf::from(request.apk_path.trim());
    let apk = apk
        .canonicalize()
        .map_err(|error| DeviceLabFailure::invalid(format!("APK path is unavailable: {error}")))?;
    if !apk.is_file()
        || apk
            .extension()
            .and_then(|extension| extension.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("apk"))
    {
        return Err(DeviceLabFailure::invalid(
            "install path must be an existing .apk file",
        ));
    }
    let mut args = vec![
        OsString::from("-s"),
        OsString::from(&request.serial),
        OsString::from("install"),
    ];
    if request.replace {
        args.push(OsString::from("-r"));
    }
    if request.allow_downgrade {
        args.push(OsString::from("-d"));
    }
    args.push(apk.into_os_string());
    let spec = CommandSpec {
        executable: adb_path(request.sdk_root.as_deref())?,
        args,
    };
    let output = run_bounded(
        spec,
        &request.operation_id,
        request.timeout_ms,
        "adb-install",
    )?;
    ensure_success(&output, "install APK")?;
    Ok(output)
}

pub fn app_launch(request: LaunchRequest) -> Result<CommandOutput, DeviceLabFailure> {
    let spec = launch_spec(&request)?;
    let output = run_bounded(
        spec,
        &request.operation_id,
        request.timeout_ms,
        "adb-launch",
    )?;
    ensure_success(&output, "launch Android application")?;
    Ok(output)
}

pub fn permission_change(request: PermissionRequest) -> Result<CommandOutput, DeviceLabFailure> {
    validate_serial(&request.serial)?;
    validate_android_identifier(&request.package, "package")?;
    validate_permission(&request.permission)?;
    let action = match request.action {
        PermissionAction::Grant => "grant",
        PermissionAction::Revoke => "revoke",
    };
    let spec = adb_spec(
        request.sdk_root.as_deref(),
        [
            "-s",
            request.serial.as_str(),
            "shell",
            "pm",
            action,
            request.package.as_str(),
            request.permission.as_str(),
        ],
    )?;
    let output = run_bounded(
        spec,
        &request.operation_id,
        request.timeout_ms,
        "adb-permission",
    )?;
    ensure_success(&output, "change Android permission")?;
    Ok(output)
}

pub fn accessibility_status(
    request: DeviceRequest,
) -> Result<AccessibilityStatus, DeviceLabFailure> {
    validate_serial(&request.serial)?;
    let enabled = run_bounded(
        adb_spec(
            request.sdk_root.as_deref(),
            [
                "-s",
                request.serial.as_str(),
                "shell",
                "settings",
                "get",
                "secure",
                "accessibility_enabled",
            ],
        )?,
        &request.operation_id,
        request.timeout_ms,
        "adb-accessibility-enabled",
    )?;
    ensure_success(&enabled, "read Android accessibility status")?;
    let services = run_bounded(
        adb_spec(
            request.sdk_root.as_deref(),
            [
                "-s",
                request.serial.as_str(),
                "shell",
                "settings",
                "get",
                "secure",
                "enabled_accessibility_services",
            ],
        )?,
        &request.operation_id,
        request.timeout_ms,
        "adb-accessibility-services",
    )?;
    ensure_success(&services, "read Android accessibility services")?;
    Ok(parse_accessibility_status(
        &enabled.stdout,
        &services.stdout,
    ))
}

pub fn logcat(request: LogcatRequest) -> Result<CommandOutput, DeviceLabFailure> {
    validate_serial(&request.serial)?;
    let max_lines = request.max_lines.clamp(1, MAX_LOGCAT_LINES);
    let mut args = vec![
        OsString::from("-s"),
        OsString::from(&request.serial),
        OsString::from("logcat"),
        OsString::from("-d"),
        OsString::from("-t"),
        OsString::from(max_lines.to_string()),
    ];
    if let Some(pid) = request.pid {
        if pid == 0 {
            return Err(DeviceLabFailure::invalid(
                "logcat pid must be greater than zero",
            ));
        }
        args.push(OsString::from(format!("--pid={pid}")));
    }
    for filter in &request.filters {
        validate_logcat_filter(filter)?;
        args.push(OsString::from(filter));
    }
    let output = run_bounded(
        CommandSpec {
            executable: adb_path(request.sdk_root.as_deref())?,
            args,
        },
        &request.operation_id,
        request.timeout_ms,
        "adb-logcat",
    )?;
    ensure_success(&output, "read Android logcat")?;
    Ok(output)
}

pub fn scrcpy_start(request: ScrcpyStartRequest) -> Result<OwnedProcessInfo, DeviceLabFailure> {
    let spec = scrcpy_spec(&request)?;
    start_owned(spec, &request.operation_id, "scrcpy")
}

pub fn process_status(
    operation_id: &str,
    expected_pid: u32,
) -> Result<OwnedProcessInfo, DeviceLabFailure> {
    validate_operation_id(operation_id)?;
    let process = owned_process(operation_id)?;
    if process.pid != expected_pid {
        return Err(DeviceLabFailure::new(
            "stale_process",
            "operation id no longer identifies the expected process",
            false,
        ));
    }
    let running = {
        let mut child = process.child.lock().map_err(|_| {
            DeviceLabFailure::new("internal", "process state is unavailable", false)
        })?;
        match child.as_mut() {
            Some(child) => child
                .try_wait()
                .map_err(|error| DeviceLabFailure::new("process_failed", error.to_string(), true))?
                .is_none(),
            None => false,
        }
    };
    if !running {
        remove_owned(operation_id, expected_pid);
    }
    Ok(process.info(running))
}

pub fn cancel_process(request: CancelProcessRequest) -> Result<OwnedProcessInfo, DeviceLabFailure> {
    validate_operation_id(&request.operation_id)?;
    let process = owned_process(&request.operation_id)?;
    if process.pid != request.expected_pid {
        return Err(DeviceLabFailure::new(
            "stale_process",
            "operation id no longer identifies the expected process",
            false,
        ));
    }
    process.cancelled.store(true, Ordering::SeqCst);
    let running = {
        let mut child = process.child.lock().map_err(|_| {
            DeviceLabFailure::new("internal", "process state is unavailable", false)
        })?;
        if let Some(child) = child.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => false,
                Ok(None) => {
                    child.kill().map_err(|error| {
                        DeviceLabFailure::new(
                            "process_cancel_failed",
                            format!("stop exact owned PID {}: {error}", process.pid),
                            true,
                        )
                    })?;
                    let _ = child.wait();
                    false
                }
                Err(error) => {
                    return Err(DeviceLabFailure::new(
                        "process_cancel_failed",
                        format!("inspect exact owned PID {}: {error}", process.pid),
                        true,
                    ))
                }
            }
        } else {
            false
        }
    };
    remove_owned(&request.operation_id, request.expected_pid);
    Ok(process.info(running))
}

pub fn owned_processes() -> Vec<OwnedProcessInfo> {
    let ids = OWNED_PROCESSES
        .lock()
        .map(|processes| processes.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    ids.into_iter()
        .filter_map(|id| {
            let process = owned_process(&id).ok()?;
            let running = {
                let mut child = process.child.lock().ok()?;
                match child.as_mut() {
                    Some(child) => child.try_wait().ok()?.is_none(),
                    None => false,
                }
            };
            if !running {
                remove_owned(&id, process.pid);
            }
            Some(process.info(running))
        })
        .collect()
}

fn run_bounded(
    spec: CommandSpec,
    operation_id: &str,
    timeout_ms: u64,
    kind: &str,
) -> Result<CommandOutput, DeviceLabFailure> {
    validate_operation_id(operation_id)?;
    let timeout = Duration::from_millis(timeout_ms.clamp(1, MAX_TIMEOUT_MS));
    let executable_display = display_path(spec.executable.clone());
    let args_display = display_args(&spec.args);
    let mut command = Command::new(&spec.executable);
    command
        .args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|error| {
        DeviceLabFailure::new(
            "tool_unavailable",
            format!("start {executable_display}: {error}"),
            false,
        )
    })?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let process = Arc::new(OwnedProcess {
        operation_id: operation_id.to_string(),
        kind: kind.to_string(),
        pid: child.id(),
        executable: spec.executable,
        args: args_display.clone(),
        started_at_ms: now_ms(),
        cancelled: AtomicBool::new(false),
        child: Mutex::new(Some(child)),
    });
    if let Err(error) = insert_owned(process.clone()) {
        terminate_unregistered(&process);
        return Err(error);
    }
    let stdout_reader = thread::spawn(move || read_bounded(stdout));
    let stderr_reader = thread::spawn(move || read_bounded(stderr));
    let started = Instant::now();
    let mut exit_status: Option<ExitStatus> = None;
    let mut timed_out = false;
    loop {
        {
            let mut child = process.child.lock().map_err(|_| {
                DeviceLabFailure::new("internal", "process state is unavailable", false)
            })?;
            if let Some(child) = child.as_mut() {
                exit_status = child.try_wait().map_err(|error| {
                    DeviceLabFailure::new(
                        "process_failed",
                        format!("wait for exact PID {}: {error}", process.pid),
                        true,
                    )
                })?;
                if exit_status.is_some() {
                    break;
                }
                if started.elapsed() >= timeout {
                    timed_out = true;
                    child.kill().map_err(|error| {
                        DeviceLabFailure::new(
                            "process_timeout",
                            format!("stop timed-out exact PID {}: {error}", process.pid),
                            true,
                        )
                    })?;
                    exit_status = child.wait().ok();
                    break;
                }
            } else {
                break;
            }
        }
        thread::sleep(Duration::from_millis(20));
    }
    let cancelled = process.cancelled.load(Ordering::SeqCst);
    remove_owned(operation_id, process.pid);
    let stdout = stdout_reader
        .join()
        .map_err(|_| DeviceLabFailure::new("internal", "stdout reader failed", false))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| DeviceLabFailure::new("internal", "stderr reader failed", false))?;
    if cancelled {
        return Err(DeviceLabFailure::new(
            "cancelled",
            format!(
                "operation {operation_id} was cancelled at exact PID {}",
                process.pid
            ),
            false,
        ));
    }
    if timed_out {
        return Err(DeviceLabFailure::new(
            "timeout",
            format!(
                "operation {operation_id} timed out after {} ms",
                timeout.as_millis()
            ),
            true,
        ));
    }
    Ok(CommandOutput {
        operation_id: operation_id.to_string(),
        executable: executable_display,
        args: args_display,
        exit_code: exit_status.and_then(|status| status.code()),
        stdout: stdout.text,
        stderr: stderr.text,
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
        duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

fn start_owned(
    spec: CommandSpec,
    operation_id: &str,
    kind: &str,
) -> Result<OwnedProcessInfo, DeviceLabFailure> {
    validate_operation_id(operation_id)?;
    let executable_display = display_path(spec.executable.clone());
    let args = display_args(&spec.args);
    let mut command = Command::new(&spec.executable);
    command
        .args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let child = command.spawn().map_err(|error| {
        DeviceLabFailure::new(
            "tool_unavailable",
            format!("start {executable_display}: {error}"),
            false,
        )
    })?;
    let process = Arc::new(OwnedProcess {
        operation_id: operation_id.to_string(),
        kind: kind.to_string(),
        pid: child.id(),
        executable: spec.executable,
        args,
        started_at_ms: now_ms(),
        cancelled: AtomicBool::new(false),
        child: Mutex::new(Some(child)),
    });
    if let Err(error) = insert_owned(process.clone()) {
        terminate_unregistered(&process);
        return Err(error);
    }
    Ok(process.info(true))
}

fn insert_owned(process: Arc<OwnedProcess>) -> Result<(), DeviceLabFailure> {
    let mut processes = OWNED_PROCESSES
        .lock()
        .map_err(|_| DeviceLabFailure::new("internal", "process registry is unavailable", false))?;
    if let Some(existing) = processes.get(&process.operation_id) {
        return Err(DeviceLabFailure::new(
            "conflict",
            format!(
                "operation {} already owns exact PID {}",
                process.operation_id, existing.pid
            ),
            false,
        ));
    }
    processes.insert(process.operation_id.clone(), process);
    Ok(())
}

fn terminate_unregistered(process: &OwnedProcess) {
    if let Ok(mut child) = process.child.lock() {
        if let Some(child) = child.as_mut() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn owned_process(operation_id: &str) -> Result<Arc<OwnedProcess>, DeviceLabFailure> {
    OWNED_PROCESSES
        .lock()
        .map_err(|_| DeviceLabFailure::new("internal", "process registry is unavailable", false))?
        .get(operation_id)
        .cloned()
        .ok_or_else(|| DeviceLabFailure::new("not_found", "owned process was not found", false))
}

fn remove_owned(operation_id: &str, pid: u32) {
    if let Ok(mut processes) = OWNED_PROCESSES.lock() {
        if processes
            .get(operation_id)
            .is_some_and(|process| process.pid == pid)
        {
            processes.remove(operation_id);
        }
    }
}

impl OwnedProcess {
    fn info(&self, running: bool) -> OwnedProcessInfo {
        OwnedProcessInfo {
            operation_id: self.operation_id.clone(),
            kind: self.kind.clone(),
            pid: self.pid,
            executable: display_path(self.executable.clone()),
            args: self.args.clone(),
            started_at_ms: self.started_at_ms,
            running,
        }
    }
}

struct BoundedRead {
    text: String,
    truncated: bool,
}

fn read_bounded<R: Read>(reader: Option<R>) -> BoundedRead {
    let Some(mut reader) = reader else {
        return BoundedRead {
            text: String::new(),
            truncated: false,
        };
    };
    let mut retained = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut total = 0usize;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                total = total.saturating_add(read);
                if retained.len() < MAX_OUTPUT_BYTES {
                    let remaining = MAX_OUTPUT_BYTES - retained.len();
                    retained.extend_from_slice(&buffer[..read.min(remaining)]);
                }
            }
        }
    }
    BoundedRead {
        text: String::from_utf8_lossy(&retained).into_owned(),
        truncated: total > retained.len(),
    }
}

fn ensure_success(output: &CommandOutput, operation: &str) -> Result<(), DeviceLabFailure> {
    if output.exit_code == Some(0) {
        return Ok(());
    }
    let detail = if output.stderr.trim().is_empty() {
        output.stdout.trim()
    } else {
        output.stderr.trim()
    };
    Err(DeviceLabFailure::new(
        "tool_failed",
        format!(
            "{operation} failed with exit code {}{}",
            output
                .exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        ),
        false,
    ))
}

fn adb_spec<I, S>(sdk_root: Option<&str>, args: I) -> Result<CommandSpec, DeviceLabFailure>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    Ok(CommandSpec {
        executable: adb_path(sdk_root)?,
        args: args
            .into_iter()
            .map(|arg| OsString::from(arg.as_ref()))
            .collect(),
    })
}

fn adb_path(sdk_root: Option<&str>) -> Result<PathBuf, DeviceLabFailure> {
    required_tool(discover_sdk(sdk_root).adb_path, "adb")
}

fn required_tool(path: Option<String>, label: &str) -> Result<PathBuf, DeviceLabFailure> {
    path.map(PathBuf::from).ok_or_else(|| {
        DeviceLabFailure::new(
            "tool_unavailable",
            format!("{label} is unavailable; configure a valid Android SDK"),
            false,
        )
    })
}

pub fn avd_start_spec(request: &AvdStartRequest) -> Result<CommandSpec, DeviceLabFailure> {
    validate_operation_id(&request.operation_id)?;
    validate_avd_name(&request.avd_name)?;
    let sdk = discover_sdk(request.sdk_root.as_deref());
    let executable = required_tool(sdk.emulator_path, "Android emulator")?;
    let mut args = vec![OsString::from("-avd"), OsString::from(&request.avd_name)];
    if request.cold_boot {
        args.push(OsString::from("-no-snapshot-load"));
    }
    if request.wipe_data {
        args.push(OsString::from("-wipe-data"));
    }
    if request.no_window {
        args.push(OsString::from("-no-window"));
    }
    if request.writable_system {
        args.push(OsString::from("-writable-system"));
    }
    if let Some(port) = request.port {
        if !(5554..=5682).contains(&port) || port % 2 != 0 {
            return Err(DeviceLabFailure::invalid(
                "emulator port must be an even value from 5554 through 5682",
            ));
        }
        args.push(OsString::from("-port"));
        args.push(OsString::from(port.to_string()));
    }
    Ok(CommandSpec { executable, args })
}

pub fn launch_spec(request: &LaunchRequest) -> Result<CommandSpec, DeviceLabFailure> {
    validate_operation_id(&request.operation_id)?;
    validate_serial(&request.serial)?;
    validate_android_identifier(&request.package, "package")?;
    let mut args = vec![
        OsString::from("-s"),
        OsString::from(&request.serial),
        OsString::from("shell"),
    ];
    if let Some(activity) = request
        .activity
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        validate_activity(activity)?;
        args.extend([
            OsString::from("am"),
            OsString::from("start"),
            OsString::from("-n"),
            OsString::from(format!("{}/{}", request.package, activity)),
        ]);
    } else {
        args.extend([
            OsString::from("monkey"),
            OsString::from("-p"),
            OsString::from(&request.package),
            OsString::from("-c"),
            OsString::from("android.intent.category.LAUNCHER"),
            OsString::from("1"),
        ]);
    }
    Ok(CommandSpec {
        executable: adb_path(request.sdk_root.as_deref())?,
        args,
    })
}

pub fn scrcpy_spec(request: &ScrcpyStartRequest) -> Result<CommandSpec, DeviceLabFailure> {
    validate_operation_id(&request.operation_id)?;
    validate_serial(&request.serial)?;
    let executable = if let Some(path) = request
        .scrcpy_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let path = PathBuf::from(path);
        if !path.is_file() {
            return Err(DeviceLabFailure::invalid(
                "scrcpy path is not an existing file",
            ));
        }
        path
    } else {
        let sdk = discover_sdk(request.sdk_root.as_deref());
        required_tool(sdk.scrcpy_path, "scrcpy")?
    };
    let mut args = vec![OsString::from("--serial"), OsString::from(&request.serial)];
    if let Some(max_size) = request.max_size {
        if !(256..=8192).contains(&max_size) {
            return Err(DeviceLabFailure::invalid(
                "scrcpy max size must be 256 through 8192",
            ));
        }
        args.push(OsString::from(format!("--max-size={max_size}")));
    }
    if let Some(bit_rate) = request
        .video_bit_rate
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        validate_bit_rate(bit_rate)?;
        args.push(OsString::from(format!("--video-bit-rate={bit_rate}")));
    }
    if request.stay_awake {
        args.push(OsString::from("--stay-awake"));
    }
    if request.turn_screen_off {
        args.push(OsString::from("--turn-screen-off"));
    }
    if request.no_audio {
        args.push(OsString::from("--no-audio"));
    }
    Ok(CommandSpec { executable, args })
}

pub fn parse_adb_devices(output: &str) -> Result<Vec<AdbDevice>, DeviceLabFailure> {
    let mut devices = Vec::new();
    for line in output.lines().map(str::trim) {
        if line.is_empty() || line.starts_with("List of devices attached") || line.starts_with('*')
        {
            continue;
        }
        let mut fields = line.split_whitespace();
        let serial = fields.next().unwrap_or_default();
        let state = fields.next().unwrap_or_default();
        if serial.is_empty() || state.is_empty() {
            return Err(DeviceLabFailure::new(
                "provider_parse_failed",
                format!("invalid adb devices row: {line}"),
                false,
            ));
        }
        let mut metadata = HashMap::new();
        for field in fields {
            if let Some((key, value)) = field.split_once(':') {
                metadata.insert(key, value);
            }
        }
        devices.push(AdbDevice {
            serial: serial.to_string(),
            state: state.to_string(),
            product: metadata.get("product").map(|value| (*value).to_string()),
            model: metadata.get("model").map(|value| (*value).to_string()),
            device: metadata.get("device").map(|value| (*value).to_string()),
            transport_id: metadata
                .get("transport_id")
                .map(|value| (*value).to_string()),
        });
    }
    Ok(devices)
}

pub fn parse_accessibility_status(enabled: &str, services: &str) -> AccessibilityStatus {
    let enabled = enabled.trim() == "1";
    let services = services
        .trim()
        .split(':')
        .map(str::trim)
        .filter(|service| !service.is_empty() && *service != "null")
        .map(ToOwned::to_owned)
        .collect();
    AccessibilityStatus { enabled, services }
}

fn validate_operation_id(operation_id: &str) -> Result<(), DeviceLabFailure> {
    let operation_id = operation_id.trim();
    if operation_id.is_empty()
        || operation_id.len() > 128
        || !operation_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.')
        })
    {
        return Err(DeviceLabFailure::invalid(
            "operation id must be 1-128 safe identifier characters",
        ));
    }
    Ok(())
}

fn validate_serial(serial: &str) -> Result<(), DeviceLabFailure> {
    let serial = serial.trim();
    if serial.is_empty()
        || serial.len() > 128
        || !serial.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.')
        })
    {
        return Err(DeviceLabFailure::invalid("invalid adb device serial"));
    }
    Ok(())
}

fn validate_avd_name(name: &str) -> Result<(), DeviceLabFailure> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 128
        || !name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ' ')
        })
    {
        return Err(DeviceLabFailure::invalid(
            "invalid Android virtual device name",
        ));
    }
    Ok(())
}

fn validate_android_identifier(value: &str, label: &str) -> Result<(), DeviceLabFailure> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 255
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '.'))
        || !value.contains('.')
    {
        return Err(DeviceLabFailure::invalid(format!(
            "invalid Android {label}"
        )));
    }
    Ok(())
}

fn validate_activity(value: &str) -> Result<(), DeviceLabFailure> {
    if value.len() > 255
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '$')
        })
    {
        return Err(DeviceLabFailure::invalid("invalid Android activity"));
    }
    Ok(())
}

fn validate_permission(value: &str) -> Result<(), DeviceLabFailure> {
    if value.trim().len() > 255
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '.'))
        || !value.contains('.')
    {
        return Err(DeviceLabFailure::invalid("invalid Android permission"));
    }
    Ok(())
}

fn validate_logcat_filter(value: &str) -> Result<(), DeviceLabFailure> {
    if value.trim().is_empty()
        || value.len() > 128
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | ':' | '*')
        })
    {
        return Err(DeviceLabFailure::invalid("invalid logcat filter"));
    }
    Ok(())
}

fn validate_bit_rate(value: &str) -> Result<(), DeviceLabFailure> {
    let digits = value
        .strip_suffix('M')
        .or_else(|| value.strip_suffix('K'))
        .unwrap_or(value);
    if digits.is_empty()
        || digits.len() > 8
        || !digits.chars().all(|character| character.is_ascii_digit())
    {
        return Err(DeviceLabFailure::invalid("invalid scrcpy video bit rate"));
    }
    Ok(())
}

fn executable_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

fn command_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.bat")
    } else {
        base.to_string()
    }
}

fn executable_if_file(path: PathBuf) -> Option<PathBuf> {
    path.is_file().then_some(path)
}

fn find_cmdline_tool(root: &Path, tool: &str) -> Option<PathBuf> {
    let command = command_name(tool);
    let latest = root
        .join("cmdline-tools")
        .join("latest")
        .join("bin")
        .join(&command);
    if latest.is_file() {
        return Some(latest);
    }
    let base = root.join("cmdline-tools");
    let mut versions = std::fs::read_dir(base)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .collect::<Vec<_>>();
    versions.sort_by_key(|entry| entry.file_name());
    versions
        .into_iter()
        .rev()
        .map(|entry| entry.path().join("bin").join(&command))
        .find(|path| path.is_file())
}

fn find_on_path(base: &str, path_env: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let executable = executable_name(base);
    std::env::split_paths(path_env?)
        .map(|directory| directory.join(&executable))
        .find(|candidate| candidate.is_file())
}

fn display_path(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

fn display_args(args: &[OsString]) -> Vec<String> {
    args.iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

async fn blocking<T, F>(operation: F) -> Result<T, DeviceLabFailure>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, DeviceLabFailure> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| DeviceLabFailure::new("internal", error.to_string(), false))?
}

#[tauri::command]
pub async fn device_lab_sdk_discover(
    sdk_root: Option<String>,
) -> Result<SdkDiscovery, DeviceLabFailure> {
    blocking(move || Ok(discover_sdk(sdk_root.as_deref()))).await
}

#[tauri::command]
pub async fn device_lab_adb_devices(
    request: OperationRequest,
) -> Result<Vec<AdbDevice>, DeviceLabFailure> {
    blocking(move || adb_devices(request)).await
}

#[tauri::command]
pub async fn device_lab_avd_list(
    request: OperationRequest,
) -> Result<Vec<String>, DeviceLabFailure> {
    blocking(move || avd_list(request)).await
}

#[tauri::command]
pub async fn device_lab_avd_start(
    request: AvdStartRequest,
) -> Result<OwnedProcessInfo, DeviceLabFailure> {
    blocking(move || avd_start(request)).await
}

#[tauri::command]
pub async fn device_lab_apk_install(
    request: InstallRequest,
) -> Result<CommandOutput, DeviceLabFailure> {
    blocking(move || apk_install(request)).await
}

#[tauri::command]
pub async fn device_lab_app_launch(
    request: LaunchRequest,
) -> Result<CommandOutput, DeviceLabFailure> {
    blocking(move || app_launch(request)).await
}

#[tauri::command]
pub async fn device_lab_permission_change(
    request: PermissionRequest,
) -> Result<CommandOutput, DeviceLabFailure> {
    blocking(move || permission_change(request)).await
}

#[tauri::command]
pub async fn device_lab_accessibility_status(
    request: DeviceRequest,
) -> Result<AccessibilityStatus, DeviceLabFailure> {
    blocking(move || accessibility_status(request)).await
}

#[tauri::command]
pub async fn device_lab_logcat(request: LogcatRequest) -> Result<CommandOutput, DeviceLabFailure> {
    blocking(move || logcat(request)).await
}

#[tauri::command]
pub async fn device_lab_scrcpy_start(
    request: ScrcpyStartRequest,
) -> Result<OwnedProcessInfo, DeviceLabFailure> {
    blocking(move || scrcpy_start(request)).await
}

#[tauri::command]
pub async fn device_lab_process_status(
    operation_id: String,
    expected_pid: u32,
) -> Result<OwnedProcessInfo, DeviceLabFailure> {
    blocking(move || process_status(&operation_id, expected_pid)).await
}

#[tauri::command]
pub async fn device_lab_process_cancel(
    request: CancelProcessRequest,
) -> Result<OwnedProcessInfo, DeviceLabFailure> {
    blocking(move || cancel_process(request)).await
}

#[tauri::command]
pub async fn device_lab_owned_processes() -> Result<Vec<OwnedProcessInfo>, DeviceLabFailure> {
    blocking(|| Ok(owned_processes())).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TestDir(PathBuf);

    impl TestDir {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fake_sdk() -> TestDir {
        let root = std::env::temp_dir().join(format!("vibelink-device-lab-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp SDK");
        for relative in [
            PathBuf::from("platform-tools").join(executable_name("adb")),
            PathBuf::from("emulator").join(executable_name("emulator")),
            PathBuf::from("cmdline-tools")
                .join("latest")
                .join("bin")
                .join(command_name("avdmanager")),
            PathBuf::from("cmdline-tools")
                .join("latest")
                .join("bin")
                .join(command_name("sdkmanager")),
        ] {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().expect("parent")).expect("directory");
            fs::write(path, b"tool").expect("tool");
        }
        TestDir(root)
    }

    #[test]
    fn discovers_explicit_sdk_without_running_tools() {
        let sdk = fake_sdk();
        let discovery =
            discover_sdk_from(Some(sdk.path().to_string_lossy().as_ref()), |_| None, None);
        assert!(discovery.available);
        assert_eq!(discovery.source.as_deref(), Some("request"));
        assert!(discovery.adb_path.is_some());
        assert!(discovery.emulator_path.is_some());
        assert!(discovery.avd_manager_path.is_some());
    }

    #[test]
    fn parses_adb_devices_with_typed_metadata() {
        let devices = parse_adb_devices(
            "List of devices attached\nemulator-5554 device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1\nABC offline transport_id:2\n",
        )
        .expect("devices");
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].serial, "emulator-5554");
        assert_eq!(devices[0].model.as_deref(), Some("sdk_gphone64_x86_64"));
        assert_eq!(devices[1].state, "offline");
    }

    #[test]
    fn constructs_exact_avd_launch_arguments() {
        let sdk = fake_sdk();
        let request = AvdStartRequest {
            operation_id: "avd-start-1".into(),
            sdk_root: Some(display_path(sdk.path().to_path_buf())),
            avd_name: "Pixel_9_API_36".into(),
            cold_boot: true,
            wipe_data: false,
            no_window: true,
            writable_system: false,
            port: Some(5556),
        };
        let spec = avd_start_spec(&request).expect("spec");
        assert_eq!(
            display_args(&spec.args),
            vec![
                "-avd",
                "Pixel_9_API_36",
                "-no-snapshot-load",
                "-no-window",
                "-port",
                "5556"
            ]
        );
        assert!(!display_args(&spec.args).contains(&"-wipe-data".to_string()));
    }

    #[test]
    fn constructs_install_launch_permission_logcat_and_scrcpy_without_shells() {
        let sdk = fake_sdk();
        let root = display_path(sdk.path().to_path_buf());
        let launch = launch_spec(&LaunchRequest {
            operation_id: "launch-1".into(),
            sdk_root: Some(root.clone()),
            serial: "emulator-5554".into(),
            package: "com.example.app".into(),
            activity: Some(".MainActivity".into()),
            timeout_ms: 1_000,
        })
        .expect("launch spec");
        assert_eq!(
            display_args(&launch.args),
            vec![
                "-s",
                "emulator-5554",
                "shell",
                "am",
                "start",
                "-n",
                "com.example.app/.MainActivity"
            ]
        );

        let scrcpy_path = sdk.path().join(executable_name("scrcpy"));
        fs::write(&scrcpy_path, b"tool").expect("scrcpy");
        let scrcpy = scrcpy_spec(&ScrcpyStartRequest {
            operation_id: "scrcpy-1".into(),
            sdk_root: Some(root),
            scrcpy_path: Some(display_path(scrcpy_path)),
            serial: "emulator-5554".into(),
            max_size: Some(1920),
            video_bit_rate: Some("8M".into()),
            stay_awake: true,
            turn_screen_off: false,
            no_audio: true,
        })
        .expect("scrcpy spec");
        assert_eq!(
            display_args(&scrcpy.args),
            vec![
                "--serial",
                "emulator-5554",
                "--max-size=1920",
                "--video-bit-rate=8M",
                "--stay-awake",
                "--no-audio"
            ]
        );
    }

    #[test]
    fn exact_process_ownership_rejects_stale_pid() {
        let executable = if cfg!(windows) {
            PathBuf::from("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")
        } else {
            PathBuf::from("/bin/sh")
        };
        let args = if cfg!(windows) {
            vec![
                OsString::from("-NoProfile"),
                OsString::from("-Command"),
                OsString::from("Start-Sleep -Seconds 30"),
            ]
        } else {
            vec![OsString::from("-c"), OsString::from("sleep 30")]
        };
        let spec = CommandSpec { executable, args };
        let process =
            start_owned(spec.clone(), "ownership-test", "test").expect("start exact process");
        assert!(owned_processes().iter().any(|owned| {
            owned.operation_id == "ownership-test" && owned.pid == process.pid && owned.running
        }));
        let conflict =
            start_owned(spec, "ownership-test", "test").expect_err("duplicate operation");
        assert_eq!(conflict.code, "conflict");
        assert_eq!(
            owned_processes()
                .into_iter()
                .filter(|owned| owned.operation_id == "ownership-test")
                .count(),
            1
        );
        let stale = cancel_process(CancelProcessRequest {
            operation_id: "ownership-test".into(),
            expected_pid: process.pid + 1,
        })
        .expect_err("stale PID");
        assert_eq!(stale.code, "stale_process");
        let stopped = cancel_process(CancelProcessRequest {
            operation_id: "ownership-test".into(),
            expected_pid: process.pid,
        })
        .expect("stop exact PID");
        assert!(!stopped.running);
        assert!(process_status("ownership-test", process.pid).is_err());
    }

    #[test]
    fn parses_accessibility_state_and_services() {
        let status =
            parse_accessibility_status("1\n", "com.example/.ReaderService:com.other/.Service\n");
        assert!(status.enabled);
        assert_eq!(status.services.len(), 2);
    }
}
