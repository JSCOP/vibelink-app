use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use xcap::Monitor;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
pub struct CaptureState {
    pub recording: Mutex<Option<Recording>>,
}

pub struct Recording {
    pub child: std::process::Child,
    pub path: PathBuf,
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
        return base.join("AgenticWorkspaceTerminal");
    }

    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("AgenticWorkspaceTerminal")
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

fn resolve_ffmpeg(ffmpeg_path: &str) -> Result<String, String> {
    if !ffmpeg_path.is_empty() && Path::new(ffmpeg_path).is_file() {
        return Ok(ffmpeg_path.to_string());
    }

    let mut command = Command::new("ffmpeg");
    command
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let status = hide_console(&mut command).status();
    if matches!(status, Ok(status) if status.success()) {
        return Ok("ffmpeg".to_string());
    }

    if ffmpeg_path.is_empty() {
        Err("ffmpeg not found on PATH".to_string())
    } else {
        Err("ffmpeg path not found and ffmpeg not found on PATH".to_string())
    }
}

fn copy_path_to_clipboard(path: &str) {
    let _ = arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(path.to_string()));
}

#[tauri::command]
pub async fn default_capture_dir() -> Result<String, String> {
    Ok(default_capture_root().to_string_lossy().to_string())
}

#[tauri::command]
pub async fn check_ffmpeg(ffmpeg_path: String) -> Result<(), String> {
    resolve_ffmpeg(&ffmpeg_path).map(|_| ())
}

#[tauri::command]
pub async fn open_path(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("not found".to_string());
    }

    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", ""]).arg(&path);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&path);
        command
    };

    #[cfg(not(any(windows, target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(&path);
        command
    };

    hide_console(&mut command).spawn().map_err(to_string)?;
    Ok(())
}

#[tauri::command]
pub async fn open_capture_overlay(
    app: tauri::AppHandle,
    mode: String,
    dir: String,
    ffmpeg_path: String,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("capture-overlay") {
        window.close().map_err(to_string)?;
    }

    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let monitor = main
        .current_monitor()
        .map_err(to_string)?
        .ok_or_else(|| "no monitor".to_string())?;
    let scale = monitor.scale_factor();
    let position = monitor.position();
    let size = monitor.size();
    let logical_x = position.x as f64 / scale;
    let logical_y = position.y as f64 / scale;
    let logical_width = size.width as f64 / scale;
    let logical_height = size.height as f64 / scale;
    let mode_json = serde_json::to_string(&mode).map_err(to_string)?;
    let dir_json = serde_json::to_string(&dir).map_err(to_string)?;
    let ffmpeg_json = serde_json::to_string(&ffmpeg_path).map_err(to_string)?;
    let initialization_script = format!(
        "window.__AWT_CAPTURE__={{mode:{mode_json},dir:{dir_json},ffmpeg:{ffmpeg_json}}};"
    );

    WebviewWindowBuilder::new(
        &app,
        "capture-overlay",
        WebviewUrl::App("index.html".into()),
    )
    .title("Capture")
    .inner_size(logical_width, logical_height)
    .position(logical_x, logical_y)
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

    Ok(())
}

#[tauri::command]
pub async fn capture_region_image(
    dir: String,
    file_name: String,
    monitor_x: i32,
    monitor_y: i32,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
) -> Result<String, String> {
    let dir = resolve_dir(&dir, "Images").map_err(to_string)?;
    let monitor = Monitor::from_point(monitor_x + 1, monitor_y + 1).map_err(to_string)?;
    let full = monitor.capture_image().map_err(to_string)?;

    if x >= full.width() || y >= full.height() {
        return Err("empty region".to_string());
    }

    let crop_width = w.min(full.width().saturating_sub(x));
    let crop_height = h.min(full.height().saturating_sub(y));
    if crop_width == 0 || crop_height == 0 {
        return Err("empty region".to_string());
    }

    let cropped = xcap::image::imageops::crop_imm(&full, x, y, crop_width, crop_height).to_image();
    let output = unique_path(&dir, &file_name);
    cropped
        .save_with_format(&output, xcap::image::ImageFormat::Png)
        .map_err(to_string)?;
    let path = output.to_string_lossy().to_string();
    copy_path_to_clipboard(&path);
    Ok(path)
}

#[tauri::command]
pub async fn start_video_capture(
    state: tauri::State<'_, CaptureState>,
    dir: String,
    file_name: String,
    ffmpeg_path: String,
    offset_x: i32,
    offset_y: i32,
    w: u32,
    h: u32,
) -> Result<String, String> {
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

    let mut child = hide_console(&mut command).spawn().map_err(to_string)?;
    thread::sleep(Duration::from_millis(400));
    match child.try_wait() {
        Ok(Some(_)) => return Err("ffmpeg failed to start (check region/codec)".to_string()),
        Ok(None) => {}
        Err(error) => {
            let _ = child.kill();
            return Err(error.to_string());
        }
    }

    let path = output.to_string_lossy().to_string();
    let mut slot = state
        .recording
        .lock()
        .map_err(|_| "recording state unavailable".to_string())?;
    if slot.is_some() {
        let _ = child.kill();
        let _ = child.wait();
        return Err("already recording".to_string());
    }
    *slot = Some(Recording {
        child,
        path: output,
    });
    Ok(path)
}

#[tauri::command]
pub async fn stop_video_capture(state: tauri::State<'_, CaptureState>) -> Result<String, String> {
    let mut recording = {
        let mut slot = state
            .recording
            .lock()
            .map_err(|_| "recording state unavailable".to_string())?;
        slot.take().ok_or_else(|| "not recording".to_string())?
    };

    if let Some(mut stdin) = recording.child.stdin.take() {
        let _ = stdin.write_all(b"q");
        let _ = stdin.flush();
    }
    let _ = recording.child.wait();

    let path = recording.path.to_string_lossy().to_string();
    copy_path_to_clipboard(&path);
    Ok(path)
}
