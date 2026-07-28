use super::{authorization::Capability, entitlement::EntitlementSupervisor};
use std::{
    borrow::Cow,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use xcap::Monitor;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const FFMPEG_DOWNLOAD_URL: &str =
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
const FFMPEG_BIN_DIR: &str = "ffmpeg-bin";
const FFMPEG_ZIP_NAME: &str = "ffmpeg.zip";

#[derive(Default)]
pub struct CaptureState {
    pub recording: Arc<Mutex<Option<Recording>>>,
    next_recording_generation: AtomicU64,
    ffmpeg_provisioning: Mutex<FfmpegProvisioning>,
    ffmpeg_provisioning_changed: Condvar,
}

#[derive(Default)]
struct FfmpegProvisioning {
    in_progress: bool,
    generation: u64,
    completed: Option<(u64, Result<String, String>)>,
}

#[derive(Clone)]
pub struct Recording {
    generation: u64,
    child: Arc<Mutex<std::process::Child>>,
    path: PathBuf,
    started_at_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FfmpegDownloadProgress {
    downloaded: u64,
    total: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureRecordingEvent {
    started_at_ms: u64,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRecordingState {
    started_at_ms: u64,
}

/// One physical display, in virtual-desktop coordinates.
///
/// The overlay spans the whole virtual desktop so a selection may cross
/// monitors, but the bounding box is NOT fully covered by real displays: with a
/// 2560x1440 primary at (0,0) and a portrait 1440x2560 secondary at
/// (-1440,-510) the box is 4000x2560 and the uncovered corners would capture as
/// black. The overlay paints those gaps opaque and refuses selections there.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMonitorRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureVirtualScreen {
    pub bounds: CaptureMonitorRect,
    pub monitors: Vec<CaptureMonitorRect>,
}

impl CaptureMonitorRect {
    fn right(self) -> i64 {
        self.x as i64 + self.width as i64
    }

    fn bottom(self) -> i64 {
        self.y as i64 + self.height as i64
    }
}

/// Bounding box of every monitor. Returns `None` when the list is empty.
fn virtual_bounds(monitors: &[CaptureMonitorRect]) -> Option<CaptureMonitorRect> {
    let first = *monitors.first()?;
    let mut left = first.x as i64;
    let mut top = first.y as i64;
    let mut right = first.right();
    let mut bottom = first.bottom();
    for monitor in &monitors[1..] {
        left = left.min(monitor.x as i64);
        top = top.min(monitor.y as i64);
        right = right.max(monitor.right());
        bottom = bottom.max(monitor.bottom());
    }
    Some(CaptureMonitorRect {
        x: left as i32,
        y: top as i32,
        width: (right - left) as u32,
        height: (bottom - top) as u32,
    })
}

fn recording_generation_is_current(current_generation: u64, monitor_generation: u64) -> bool {
    current_generation == monitor_generation
}

fn take_recording_if_generation(
    recording: &Mutex<Option<Recording>>,
    generation: u64,
) -> Option<Recording> {
    let mut slot = recording.lock().ok()?;
    if !slot
        .as_ref()
        .is_some_and(|current| recording_generation_is_current(current.generation, generation))
    {
        return None;
    }
    slot.take()
}

fn spawn_recording_monitor(
    recording_slot: Arc<Mutex<Option<Recording>>>,
    app: tauri::AppHandle,
    recording: Recording,
) -> Result<(), String> {
    thread::Builder::new()
        .name(format!("vibelink-capture-monitor-{}", recording.generation))
        .spawn(move || loop {
            thread::sleep(Duration::from_millis(100));
            let finished = match recording.child.lock() {
                Ok(mut child) => child
                    .try_wait()
                    .map(|status| status.is_some())
                    .map_err(to_string),
                Err(_) => Err("recording child unavailable".to_string()),
            };
            match finished {
                Ok(false) => continue,
                Ok(true) => {}
                Err(_) if stop_recording_child(&recording.child).is_ok() => {}
                Err(_) => break,
            }
            if let Some(retired) =
                take_recording_if_generation(&recording_slot, recording.generation)
            {
                let _ = app.emit(
                    "capture://recording-stopped",
                    CaptureRecordingEvent {
                        started_at_ms: retired.started_at_ms,
                        path: retired.path.to_string_lossy().into_owned(),
                    },
                );
            }
            break;
        })
        .map(|_| ())
        .map_err(to_string)
}

fn stop_recording_child(child: &Mutex<std::process::Child>) -> Result<(), String> {
    let mut child = child
        .lock()
        .map_err(|_| "recording child unavailable".to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"q");
        let _ = stdin.flush();
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait().map_err(to_string)? {
            Some(_) => return Ok(()),
            None if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            None => {
                child.kill().map_err(to_string)?;
                child.wait().map_err(to_string)?;
                return Ok(());
            }
        }
    }
}
fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn hide_console(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn default_capture_root() -> PathBuf {
    if let Some(user_dirs) = directories::UserDirs::new() {
        let base = user_dirs
            .picture_dir()
            .unwrap_or_else(|| user_dirs.home_dir());
        return base.join("VibeLink");
    }

    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("VibeLink")
}

fn resolve_dir(dir: &str, sub: &str) -> std::io::Result<PathBuf> {
    let base = if dir.is_empty() {
        default_capture_root()
    } else {
        PathBuf::from(dir)
    };
    let base = if base.is_absolute() {
        base
    } else {
        std::env::current_dir()?.join(base)
    };
    let path = base.join(sub);
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

fn unique_path(dir: &Path, file_name: &str) -> PathBuf {
    let first = dir.join(file_name);
    if !first.exists() {
        return first;
    }

    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(file_name);
    let extension = path.extension().and_then(|value| value.to_str());

    for index in 1.. {
        let name = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem}-{index}.{extension}"),
            _ => format!("{stem}-{index}"),
        };
        let candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }

    unreachable!()
}
fn configured_ffmpeg_path(ffmpeg_path: &str) -> Option<PathBuf> {
    let trimmed = ffmpeg_path.trim().trim_matches('"').trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

fn run_ffmpeg_version(program: impl AsRef<std::ffi::OsStr>) -> bool {
    let mut command = Command::new(program);
    command
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    matches!(hide_console(&mut command).status(), Ok(status) if status.success())
}

fn valid_ffmpeg_file(path: &Path) -> bool {
    path.is_file() && run_ffmpeg_version(path.as_os_str())
}

fn ffmpeg_bin_dir() -> Result<PathBuf, String> {
    Ok(crate::daemon::paths::daemon_paths()
        .map_err(to_string)?
        .data_dir
        .join(FFMPEG_BIN_DIR))
}

fn managed_ffmpeg_path() -> Result<PathBuf, String> {
    Ok(ffmpeg_bin_dir()?.join("ffmpeg.exe"))
}

fn resolve_ffmpeg(ffmpeg_path: &str) -> Result<String, String> {
    if let Some(path) = configured_ffmpeg_path(ffmpeg_path) {
        if valid_ffmpeg_file(&path) {
            return Ok(path.to_string_lossy().into_owned());
        }
    }

    if run_ffmpeg_version("ffmpeg") {
        return Ok("ffmpeg".to_string());
    }

    if let Ok(path) = managed_ffmpeg_path() {
        if valid_ffmpeg_file(&path) {
            return Ok(path.to_string_lossy().into_owned());
        }
    }

    if configured_ffmpeg_path(ffmpeg_path).is_some() {
        Err("configured ffmpeg path is not valid, ffmpeg was not found on PATH, and managed ffmpeg is not installed".to_string())
    } else {
        Err("ffmpeg was not found on PATH and managed ffmpeg is not installed".to_string())
    }
}

fn emit_ffmpeg_progress(app: &tauri::AppHandle, downloaded: u64, total: Option<u64>) {
    let _ = app.emit(
        "ffmpeg://progress",
        FfmpegDownloadProgress { downloaded, total },
    );
}

fn begin_ffmpeg_provision(state: &CaptureState) -> Result<Option<Result<String, String>>, String> {
    let mut guard = state
        .ffmpeg_provisioning
        .lock()
        .map_err(|_| "ffmpeg provisioning state unavailable".to_string())?;

    if guard.in_progress {
        loop {
            guard = state
                .ffmpeg_provisioning_changed
                .wait(guard)
                .map_err(|_| "ffmpeg provisioning state unavailable".to_string())?;
            if !guard.in_progress {
                if let Some((_, result)) = &guard.completed {
                    return Ok(Some(result.clone()));
                }
                return Err("ffmpeg provisioning finished without a result".to_string());
            }
        }
    }

    guard.in_progress = true;
    guard.generation = guard.generation.saturating_add(1);
    guard.completed = None;
    Ok(None)
}

fn finish_ffmpeg_provision(
    state: &CaptureState,
    result: Result<String, String>,
) -> Result<(), String> {
    let mut guard = state
        .ffmpeg_provisioning
        .lock()
        .map_err(|_| "ffmpeg provisioning state unavailable".to_string())?;
    let generation = guard.generation;
    guard.in_progress = false;
    guard.completed = Some((generation, result));
    state.ffmpeg_provisioning_changed.notify_all();
    Ok(())
}

fn download_ffmpeg_zip(app: &tauri::AppHandle, zip_path: &Path) -> Result<(), String> {
    emit_ffmpeg_progress(app, 0, None);
    let response = ureq::get(FFMPEG_DOWNLOAD_URL)
        .set("User-Agent", "VibeLink/0.1 ffmpeg-provisioner")
        .call()
        .map_err(|error| format!("download ffmpeg: {error}"))?;
    let total = response
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok());
    emit_ffmpeg_progress(app, 0, total);

    let mut reader = response.into_reader();
    let mut file = fs::File::create(zip_path).map_err(to_string)?;
    let mut downloaded = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer).map_err(to_string)?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read]).map_err(to_string)?;
        downloaded = downloaded.saturating_add(read as u64);
        emit_ffmpeg_progress(app, downloaded, total);
    }
    file.flush().map_err(to_string)?;

    if matches!(total, Some(expected) if downloaded < expected) {
        return Err("ffmpeg download ended before all bytes were received".to_string());
    }

    Ok(())
}

fn extract_ffmpeg_exe(zip_path: &Path, target_path: &Path) -> Result<(), String> {
    let zip_file = fs::File::open(zip_path).map_err(to_string)?;
    let mut archive = zip::ZipArchive::new(zip_file).map_err(to_string)?;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(to_string)?;
        if entry.is_dir() {
            continue;
        }
        let normalized_name = entry.name().replace('\\', "/").to_ascii_lowercase();
        if normalized_name != "ffmpeg.exe" && !normalized_name.ends_with("/ffmpeg.exe") {
            continue;
        }

        let parent = target_path
            .parent()
            .ok_or_else(|| "ffmpeg target has no parent directory".to_string())?;
        fs::create_dir_all(parent).map_err(to_string)?;
        let mut output = fs::File::create(target_path).map_err(to_string)?;
        std::io::copy(&mut entry, &mut output).map_err(to_string)?;
        output.flush().map_err(to_string)?;
        return Ok(());
    }

    Err("downloaded ffmpeg archive did not contain ffmpeg.exe".to_string())
}

fn provision_ffmpeg(app: &tauri::AppHandle) -> Result<String, String> {
    let bin_dir = ffmpeg_bin_dir()?;
    fs::create_dir_all(&bin_dir).map_err(to_string)?;
    let zip_path = bin_dir.join(FFMPEG_ZIP_NAME);
    let exe_path = bin_dir.join("ffmpeg.exe");

    if exe_path.exists() && !valid_ffmpeg_file(&exe_path) {
        let _ = fs::remove_file(&exe_path);
    }

    download_ffmpeg_zip(app, &zip_path).inspect_err(|_| {
        let _ = fs::remove_file(&zip_path);
    })?;
    extract_ffmpeg_exe(&zip_path, &exe_path).inspect_err(|_| {
        let _ = fs::remove_file(&zip_path);
    })?;

    if !valid_ffmpeg_file(&exe_path) {
        let _ = fs::remove_file(&exe_path);
        let _ = fs::remove_file(&zip_path);
        return Err("downloaded ffmpeg failed validation".to_string());
    }

    let _ = fs::remove_file(&zip_path);
    Ok(exe_path.to_string_lossy().into_owned())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn copy_path_to_clipboard(path: &str) {
    let _ =
        arboard::Clipboard::new().and_then(|mut clipboard| clipboard.set_text(path.to_string()));
}

fn copy_rgba_to_clipboard(width: u32, height: u32, bytes: Vec<u8>) -> Result<(), String> {
    let image = arboard::ImageData {
        width: width as usize,
        height: height as usize,
        bytes: Cow::Owned(bytes),
    };
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_image(image))
        .map_err(to_string)
}

fn copy_png_to_clipboard(png_bytes: &[u8]) -> Result<(), String> {
    let image = xcap::image::load_from_memory(png_bytes)
        .map_err(to_string)?
        .to_rgba8();
    copy_rgba_to_clipboard(image.width(), image.height(), image.into_raw())
}

fn resolve_capture_image_file(dir: &str, path: &str) -> Result<PathBuf, String> {
    let root = resolve_dir(dir, "Images")
        .map_err(to_string)?
        .canonicalize()
        .map_err(to_string)?;
    let requested = Path::new(path);
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };
    let canonical = candidate.canonicalize().map_err(to_string)?;
    if !canonical.starts_with(&root) {
        return Err("capture file path escapes image directory".to_string());
    }
    if !canonical.is_file() {
        return Err("capture file not found".to_string());
    }
    Ok(canonical)
}

fn read_capture_file_native(dir: &str, path: &str) -> Result<Vec<u8>, String> {
    let path = resolve_capture_image_file(dir, path)?;
    std::fs::read(path).map_err(to_string)
}

#[tauri::command]
pub async fn default_capture_dir(
    supervisor: tauri::State<'_, Arc<EntitlementSupervisor>>,
) -> Result<String, String> {
    supervisor
        .authorize(Capability::WorkspaceRead)
        .map_err(to_string)?;
    Ok(default_capture_root().to_string_lossy().to_string())
}

#[tauri::command]
pub async fn check_ffmpeg(
    supervisor: tauri::State<'_, Arc<EntitlementSupervisor>>,
    ffmpeg_path: String,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceRead)
        .map_err(to_string)?;
    resolve_ffmpeg(&ffmpeg_path).map(|_| ())
}

#[tauri::command]
pub async fn ensure_ffmpeg(
    supervisor: tauri::State<'_, Arc<EntitlementSupervisor>>,
    app: tauri::AppHandle,
    state: tauri::State<'_, CaptureState>,
    ffmpeg_path: String,
) -> Result<String, String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    if let Ok(program) = resolve_ffmpeg(&ffmpeg_path) {
        return Ok(program);
    }

    if let Some(result) = begin_ffmpeg_provision(&state)? {
        return result;
    }

    if let Ok(program) = resolve_ffmpeg(&ffmpeg_path) {
        let result = Ok(program.clone());
        finish_ffmpeg_provision(&state, result)?;
        return Ok(program);
    }

    let result = provision_ffmpeg(&app);
    finish_ffmpeg_provision(&state, result.clone())?;
    result
}

#[tauri::command]
pub async fn open_path(
    supervisor: tauri::State<'_, Arc<EntitlementSupervisor>>,
    path: String,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    let target = normalize_open_target(&path)?;

    // Windows: call ShellExecuteW directly from this process instead of
    // spawning an intermediary (rundll32). An intermediary breaks the
    // foreground-activation permission chain, so the viewer/Explorer window
    // opened for a file or folder appears BEHIND the app and looks like the
    // click did nothing. URLs only worked because browsers self-activate.
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let target_wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
        let result = tauri::async_runtime::spawn_blocking(move || unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                std::ptr::null(),
                target_wide.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            ) as isize
        })
        .await
        .map_err(to_string)?;
        // Per ShellExecuteW docs, values <= 32 are error codes.
        if result <= 32 {
            return Err(format!(
                "open failed (ShellExecute code {result}): {target}"
            ));
        }
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.arg(&target);
        hide_console(&mut command).spawn().map_err(to_string)?;
        Ok(())
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let mut command = Command::new("xdg-open");
        command.arg(&target);
        hide_console(&mut command).spawn().map_err(to_string)?;
        Ok(())
    }
}

#[tauri::command]
pub async fn reveal_path(
    supervisor: tauri::State<'_, Arc<EntitlementSupervisor>>,
    path: String,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    let target = normalize_local_target(&path)?;

    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("explorer.exe");
        if target.is_file() {
            command.arg("/select,").arg(&target);
        } else {
            command.arg(&target);
        }
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        if target.is_file() {
            command.arg("-R").arg(&target);
        } else {
            command.arg(&target);
        }
        command
    };

    #[cfg(not(any(windows, target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(if target.is_file() {
            target.parent().unwrap_or(&target)
        } else {
            &target
        });
        command
    };

    hide_console(&mut command).spawn().map_err(to_string)?;
    Ok(())
}

fn normalize_open_target(path: &str) -> Result<String, String> {
    let target = trim_open_target(path);
    if is_supported_uri(target) {
        return Ok(target.to_string());
    }

    Ok(normalize_local_target(target)?
        .to_string_lossy()
        .into_owned())
}

fn normalize_local_target(path: &str) -> Result<PathBuf, String> {
    let target = trim_open_target(path);
    if is_supported_uri(target) {
        return Err("local path required".to_string());
    }
    let expanded = expand_home_path(target);
    if !expanded.exists() {
        return Err("not found".to_string());
    }
    Ok(expanded)
}

fn trim_open_target(path: &str) -> &str {
    path.trim()
        .trim_matches(|character| matches!(character, '"' | '\'' | '`'))
}

fn is_supported_uri(target: &str) -> bool {
    let lower = target.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("file://")
}

fn expand_home_path(target: &str) -> PathBuf {
    let Some(rest) = target
        .strip_prefix("~/")
        .or_else(|| target.strip_prefix("~\\"))
    else {
        return PathBuf::from(target);
    };
    directories::UserDirs::new()
        .map(|dirs| dirs.home_dir().join(rest))
        .unwrap_or_else(|| PathBuf::from(target))
}

/// Every overlay gets a fresh, unique window label.
///
/// Tauri only frees a window/webview label when the runtime reports
/// `WindowEvent::Destroyed` for it. On Windows the overlay is a transparent,
/// always-on-top `WebviewWindow`; when its `WM_DESTROY` never reaches the Tao
/// event loop (the app holds the last `Arc<Window>` alive, so the window is
/// only hidden), the label stays registered forever. Reusing the fixed
/// `capture-overlay` label then makes every later capture fail with
/// "a webview with label `capture-overlay` already exists", permanently
/// breaking screenshots and recording until the app restarts.
pub const CAPTURE_OVERLAY_LABEL_PREFIX: &str = "capture-overlay";

fn next_capture_overlay_label() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let generation = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{CAPTURE_OVERLAY_LABEL_PREFIX}-{generation}")
}

pub fn is_capture_overlay_label(label: &str) -> bool {
    label
        .strip_prefix(CAPTURE_OVERLAY_LABEL_PREFIX)
        .is_some_and(|rest| {
            rest.is_empty()
                || rest.strip_prefix('-').is_some_and(|generation| {
                    !generation.is_empty() && generation.bytes().all(|byte| byte.is_ascii_digit())
                })
        })
}

#[tauri::command]
pub async fn open_capture_overlay(
    supervisor: tauri::State<'_, Arc<EntitlementSupervisor>>,
    app: tauri::AppHandle,
    mode: String,
    dir: String,
    ffmpeg_path: String,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    // Close every live or leaked overlay from the generated label family.
    for (label, window) in app.webview_windows() {
        if is_capture_overlay_label(&label) {
            let _ = window.destroy();
        }
    }

    // The overlay spans the ENTIRE virtual desktop, so a region may cross
    // monitors and a second display is reachable without moving VibeLink.
    // Coordinates are virtual-desktop physical pixels and go negative for
    // monitors left of / above the primary one.
    let monitors: Vec<CaptureMonitorRect> = app
        .available_monitors()
        .map_err(to_string)?
        .iter()
        .map(|monitor| CaptureMonitorRect {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        })
        .collect();
    let bounds = virtual_bounds(&monitors).ok_or_else(|| "no monitor".to_string())?;
    let screen = CaptureVirtualScreen {
        bounds,
        monitors: monitors.clone(),
    };

    let mode_json = serde_json::to_string(&mode).map_err(to_string)?;
    let dir_json = serde_json::to_string(&dir).map_err(to_string)?;
    let ffmpeg_json = serde_json::to_string(&ffmpeg_path).map_err(to_string)?;
    let screen_json = serde_json::to_string(&screen).map_err(to_string)?;
    let initialization_script = format!(
        "window.__VIBELINK_CAPTURE__={{mode:{mode_json},dir:{dir_json},ffmpeg:{ffmpeg_json},screen:{screen_json}}};"
    );

    let window = WebviewWindowBuilder::new(
        &app,
        next_capture_overlay_label(),
        WebviewUrl::App("index.html".into()),
    )
    .title("Capture")
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .resizable(false)
    .focused(true)
    .initialization_script(initialization_script)
    .build()
    .map_err(to_string)?;

    // Position BEFORE size: a transparent always-on-top window sized to the
    // full virtual desktop while still at the default origin would briefly
    // cover every display.
    window
        .set_position(tauri::PhysicalPosition::new(bounds.x, bounds.y))
        .map_err(to_string)?;
    window
        .set_size(tauri::PhysicalSize::new(bounds.width, bounds.height))
        .map_err(to_string)?;

    Ok(())
}

/// Intersection of a requested virtual-desktop region with one monitor,
/// expressed as the monitor-local source rect and the destination offset inside
/// the stitched output image.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MonitorCrop {
    src_x: u32,
    src_y: u32,
    dest_x: u32,
    dest_y: u32,
    width: u32,
    height: u32,
}

fn monitor_crop(region: CaptureMonitorRect, monitor: CaptureMonitorRect) -> Option<MonitorCrop> {
    let left = (region.x as i64).max(monitor.x as i64);
    let top = (region.y as i64).max(monitor.y as i64);
    let right = region.right().min(monitor.right());
    let bottom = region.bottom().min(monitor.bottom());
    if right <= left || bottom <= top {
        return None;
    }
    Some(MonitorCrop {
        src_x: (left - monitor.x as i64) as u32,
        src_y: (top - monitor.y as i64) as u32,
        dest_x: (left - region.x as i64) as u32,
        dest_y: (top - region.y as i64) as u32,
        width: (right - left) as u32,
        height: (bottom - top) as u32,
    })
}

#[tauri::command]
pub async fn capture_region_image(
    supervisor: tauri::State<'_, Arc<EntitlementSupervisor>>,
    dir: String,
    file_name: String,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<String, String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    if w == 0 || h == 0 {
        return Err("empty region".to_string());
    }
    let dir = resolve_dir(&dir, "Images").map_err(to_string)?;
    let region = CaptureMonitorRect {
        x,
        y,
        width: w,
        height: h,
    };

    // The region is in virtual-desktop coordinates and may span monitors, so
    // every intersecting display is grabbed and blitted into one image. Areas
    // the region covers but no monitor does stay transparent rather than
    // silently becoming black.
    let mut stitched = xcap::image::RgbaImage::new(w, h);
    let mut captured_any = false;
    for monitor in Monitor::all().map_err(to_string)? {
        let bounds = CaptureMonitorRect {
            x: monitor.x().map_err(to_string)?,
            y: monitor.y().map_err(to_string)?,
            width: monitor.width().map_err(to_string)?,
            height: monitor.height().map_err(to_string)?,
        };
        let Some(crop) = monitor_crop(region, bounds) else {
            continue;
        };
        let source = monitor
            .capture_region(crop.src_x, crop.src_y, crop.width, crop.height)
            .map_err(to_string)?;
        xcap::image::imageops::replace(
            &mut stitched,
            &source,
            crop.dest_x as i64,
            crop.dest_y as i64,
        );
        captured_any = true;
    }
    if !captured_any {
        return Err("empty region".to_string());
    }

    let output = unique_path(&dir, &file_name);
    stitched
        .save_with_format(&output, xcap::image::ImageFormat::Png)
        .map_err(to_string)?;
    copy_rgba_to_clipboard(stitched.width(), stitched.height(), stitched.into_raw())?;
    Ok(output.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn clipboard_write_image(
    supervisor: tauri::State<'_, Arc<EntitlementSupervisor>>,
    png_bytes: Vec<u8>,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    copy_png_to_clipboard(&png_bytes)
}

#[tauri::command]
pub async fn clipboard_write_text(
    supervisor: tauri::State<'_, Arc<EntitlementSupervisor>>,
    text: String,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    // Native clipboard access remains focus-independent for embedded WebView2 pages.
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(text))
        .map_err(to_string)
}

#[tauri::command]
pub fn read_capture_file(
    supervisor: tauri::State<'_, Arc<EntitlementSupervisor>>,
    dir: String,
    path: String,
) -> Result<Vec<u8>, String> {
    supervisor
        .authorize(Capability::WorkspaceRead)
        .map_err(to_string)?;
    read_capture_file_native(&dir, &path)
}

#[tauri::command]
pub async fn start_video_capture(
    supervisor: tauri::State<'_, Arc<EntitlementSupervisor>>,
    app: tauri::AppHandle,
    state: tauri::State<'_, CaptureState>,
    dir: String,
    file_name: String,
    ffmpeg_path: String,
    offset_x: i32,
    offset_y: i32,
    w: u32,
    h: u32,
) -> Result<String, String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    let w = w & !1;
    let h = h & !1;
    if w < 16 || h < 16 {
        return Err("region too small".to_string());
    }

    let program = resolve_ffmpeg(&ffmpeg_path)?;
    let dir = resolve_dir(&dir, "Video").map_err(to_string)?;
    let output = unique_path(&dir, &file_name);
    {
        let slot = state
            .recording
            .lock()
            .map_err(|_| "recording state unavailable".to_string())?;
        if slot.is_some() {
            return Err("already recording".to_string());
        }
    }

    let offset_x = offset_x.to_string();
    let offset_y = offset_y.to_string();
    let video_size = format!("{w}x{h}");
    let mut command = Command::new(&program);
    command
        .args([
            "-f",
            "gdigrab",
            "-framerate",
            "30",
            "-draw_mouse",
            "1",
            "-offset_x",
        ])
        .arg(&offset_x)
        .arg("-offset_y")
        .arg(&offset_y)
        .arg("-video_size")
        .arg(&video_size)
        .args([
            "-i",
            "desktop",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+frag_keyframe+empty_moov+default_base_moof",
        ])
        .arg(&output)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let generation = state
        .next_recording_generation
        .fetch_add(1, Ordering::AcqRel)
        + 1;
    let mut child = hide_console(&mut command).spawn().map_err(to_string)?;
    thread::sleep(Duration::from_millis(400));
    match child.try_wait() {
        Ok(Some(_)) => return Err("ffmpeg failed to start (check region/codec)".to_string()),
        Ok(None) => {}
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.to_string());
        }
    }

    let path = output.to_string_lossy().to_string();
    let started_at_ms = now_ms();
    let mut slot = state
        .recording
        .lock()
        .map_err(|_| "recording state unavailable".to_string())?;
    if slot.is_some() {
        let _ = child.kill();
        let _ = child.wait();
        return Err("already recording".to_string());
    }
    let recording = Recording {
        generation,
        child: Arc::new(Mutex::new(child)),
        path: output,
        started_at_ms,
    };
    *slot = Some(recording.clone());
    drop(slot);
    if let Err(error) =
        spawn_recording_monitor(Arc::clone(&state.recording), app.clone(), recording.clone())
    {
        take_recording_if_generation(&state.recording, generation);
        let _ = stop_recording_child(&recording.child);
        return Err(error);
    }
    let _ = app.emit(
        "capture://recording-started",
        CaptureRecordingEvent {
            started_at_ms,
            path: path.clone(),
        },
    );
    Ok(path)
}

#[tauri::command]
pub fn capture_recording_state(
    supervisor: tauri::State<'_, Arc<EntitlementSupervisor>>,
    state: tauri::State<'_, CaptureState>,
) -> Result<Option<CaptureRecordingState>, String> {
    supervisor
        .authorize(Capability::WorkspaceRead)
        .map_err(to_string)?;
    let recording = state
        .recording
        .lock()
        .map_err(|_| "recording state unavailable".to_string())?
        .clone();
    let Some(recording) = recording else {
        return Ok(None);
    };

    let status = recording
        .child
        .lock()
        .map_err(|_| "recording child unavailable".to_string())?
        .try_wait();
    match status {
        Ok(Some(_)) => {
            take_recording_if_generation(&state.recording, recording.generation);
            Ok(None)
        }
        Ok(None) => Ok(Some(CaptureRecordingState {
            started_at_ms: recording.started_at_ms,
        })),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub async fn stop_video_capture(
    supervisor: tauri::State<'_, Arc<EntitlementSupervisor>>,
    app: tauri::AppHandle,
    state: tauri::State<'_, CaptureState>,
) -> Result<String, String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    let recording = {
        let mut slot = state
            .recording
            .lock()
            .map_err(|_| "recording state unavailable".to_string())?;
        slot.take().ok_or_else(|| "not recording".to_string())?
    };

    stop_recording_child(&recording.child)?;

    let path = recording.path.to_string_lossy().to_string();
    copy_path_to_clipboard(&path);
    let _ = app.emit(
        "capture://recording-stopped",
        CaptureRecordingEvent {
            started_at_ms: recording.started_at_ms,
            path: path.clone(),
        },
    );
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_target_accepts_supported_urls_without_file_check() {
        assert_eq!(
            normalize_open_target("https://example.com/a?b=1").expect("url target"),
            "https://example.com/a?b=1"
        );
        assert_eq!(
            normalize_open_target("file:///E:/captures/a.png").expect("file url target"),
            "file:///E:/captures/a.png"
        );
    }

    #[test]
    fn supported_uri_does_not_treat_windows_drive_as_scheme() {
        assert!(!is_supported_uri(r"E:\captures\a.png"));
    }

    #[test]
    fn local_target_preserves_spaces_and_strips_quotes() {
        let root =
            std::env::temp_dir().join(format!("vibelink-open-path-{}", uuid::Uuid::new_v4()));
        let file = root.join("VibeLink Voice setup.exe");
        std::fs::create_dir_all(&root).expect("create temp directory");
        std::fs::write(&file, b"installer").expect("write temp file");

        let quoted = format!("\"{}\"", file.to_string_lossy());
        assert_eq!(normalize_local_target(&quoted).expect("local path"), file);
        assert!(normalize_local_target("https://example.com/setup.exe").is_err());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn read_capture_file_allows_only_files_inside_images_dir() {
        let root =
            std::env::temp_dir().join(format!("vibelink-capture-read-{}", uuid::Uuid::new_v4()));
        let images = root.join("Images");
        std::fs::create_dir_all(&images).expect("create image dir");
        let inside = images.join("inside.png");
        let outside = root.join("outside.png");
        std::fs::write(&inside, b"inside").expect("write inside file");
        std::fs::write(&outside, b"outside").expect("write outside file");

        let dir = root.to_string_lossy().into_owned();
        let bytes = read_capture_file_native(&dir, &inside.to_string_lossy())
            .expect("inside image can be read");
        assert_eq!(bytes, b"inside");

        let absolute_escape = read_capture_file_native(&dir, &outside.to_string_lossy())
            .expect_err("absolute path outside Images is rejected");
        assert!(absolute_escape.contains("escapes image directory"));

        let traversal = format!("..{}outside.png", std::path::MAIN_SEPARATOR);
        let traversal_escape = read_capture_file_native(&dir, &traversal)
            .expect_err("relative traversal outside Images is rejected");
        assert!(traversal_escape.contains("escapes image directory"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn every_capture_overlay_open_uses_a_fresh_label() {
        let first = next_capture_overlay_label();
        let second = next_capture_overlay_label();
        assert_ne!(
            first, second,
            "reusing a label makes Tauri reject the overlay once a label leaks"
        );
        assert!(is_capture_overlay_label(&first));
        assert!(is_capture_overlay_label(&second));
    }

    #[test]
    fn overlay_label_matching_covers_the_family_without_catching_other_windows() {
        assert!(is_capture_overlay_label("capture-overlay"));
        assert!(is_capture_overlay_label("capture-overlay-1"));
        assert!(is_capture_overlay_label("capture-overlay-42"));

        assert!(!is_capture_overlay_label("main"));
        assert!(!is_capture_overlay_label("capture-overlay-"));
        assert!(!is_capture_overlay_label("capture-overlay-a"));
        assert!(!is_capture_overlay_label("capture-overlay-1x"));
        assert!(!is_capture_overlay_label("xcapture-overlay-1"));
    }

    /// Real layout this was built against: 2560x1440 primary at the origin plus
    /// a portrait 1440x2560 secondary left of and above it.
    fn dual_monitors() -> Vec<CaptureMonitorRect> {
        vec![
            CaptureMonitorRect {
                x: 0,
                y: 0,
                width: 2560,
                height: 1440,
            },
            CaptureMonitorRect {
                x: -1440,
                y: -510,
                width: 1440,
                height: 2560,
            },
        ]
    }

    #[test]
    fn virtual_bounds_span_monitors_placed_at_negative_coordinates() {
        assert_eq!(
            virtual_bounds(&dual_monitors()).expect("bounds"),
            CaptureMonitorRect {
                x: -1440,
                y: -510,
                width: 4000,
                height: 2560
            }
        );
        assert_eq!(virtual_bounds(&[]), None);
    }

    #[test]
    fn a_region_spanning_two_monitors_produces_one_crop_per_monitor() {
        let region = CaptureMonitorRect {
            x: -200,
            y: 100,
            width: 600,
            height: 400,
        };
        let monitors = dual_monitors();

        let primary = monitor_crop(region, monitors[0]).expect("primary overlap");
        assert_eq!(
            primary,
            // Right 400px of the region land on the primary at its left edge,
            // offset 200px into the stitched output.
            MonitorCrop {
                src_x: 0,
                src_y: 100,
                dest_x: 200,
                dest_y: 0,
                width: 400,
                height: 400
            }
        );

        let secondary = monitor_crop(region, monitors[1]).expect("secondary overlap");
        assert_eq!(
            secondary,
            // Left 200px come from the portrait monitor, whose own origin is
            // (-1440,-510), so the source offset stays positive.
            MonitorCrop {
                src_x: 1240,
                src_y: 610,
                dest_x: 0,
                dest_y: 0,
                width: 200,
                height: 400
            }
        );
    }

    #[test]
    fn a_region_inside_an_uncovered_gap_yields_no_crop() {
        // Below the primary monitor and right of the portrait one.
        let gap = CaptureMonitorRect {
            x: 200,
            y: 1600,
            width: 400,
            height: 300,
        };
        assert!(dual_monitors()
            .into_iter()
            .all(|monitor| monitor_crop(gap, monitor).is_none()));
    }

    #[test]
    fn edge_adjacent_regions_do_not_overlap() {
        let monitor = CaptureMonitorRect {
            x: 0,
            y: 0,
            width: 2560,
            height: 1440,
        };
        let touching = CaptureMonitorRect {
            x: 2560,
            y: 0,
            width: 100,
            height: 100,
        };
        assert_eq!(monitor_crop(touching, monitor), None);

        let overlapping = CaptureMonitorRect {
            x: 2460,
            y: 0,
            width: 100,
            height: 100,
        };
        assert_eq!(
            monitor_crop(overlapping, monitor).expect("overlap"),
            MonitorCrop {
                src_x: 2460,
                src_y: 0,
                dest_x: 0,
                dest_y: 0,
                width: 100,
                height: 100
            }
        );
    }

    #[test]
    fn stale_recording_monitor_cannot_retire_new_generation() {
        fn recording(generation: u64) -> Recording {
            let child =
                Command::new(std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()))
                    .args(["/D", "/Q", "/C", "more"])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .expect("spawn recording child");
            assert!(child.stdin.is_some());
            Recording {
                generation,
                child: Arc::new(Mutex::new(child)),
                path: PathBuf::from(format!("capture-{generation}.mp4")),
                started_at_ms: generation,
            }
        }

        let stale = recording(1);
        let current = recording(2);
        let slot = Mutex::new(Some(current.clone()));

        assert!(take_recording_if_generation(&slot, stale.generation).is_none());
        assert_eq!(
            slot.lock()
                .expect("recording slot")
                .as_ref()
                .map(|recording| recording.generation),
            Some(2)
        );

        stop_recording_child(&stale.child).expect("stop stale child");
        let current = take_recording_if_generation(&slot, 2).expect("take current child");
        stop_recording_child(&current.child).expect("stop current child");
    }
}
