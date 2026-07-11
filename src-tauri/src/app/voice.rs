use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::daemon::paths::daemon_paths;

use super::voice_hook;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
pub struct VoiceState {
    child: Mutex<Option<VoiceSidecar>>,
}

struct VoiceSidecar {
    process: Child,
    port: u16,
    token: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSidecarInfo {
    pub port: u16,
    pub token: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfoDto {
    pub name: String,
    pub vendor_id: u32,
    pub dedicated_video_memory_mb: u64,
    pub is_nvidia: bool,
}

#[tauri::command]
pub fn voice_start_sidecar(
    app: AppHandle,
    state: State<'_, VoiceState>,
) -> Result<VoiceSidecarInfo, String> {
    let mut child_guard = state.child.lock().map_err(|error| error.to_string())?;
    if let Some(sidecar) = child_guard.as_mut() {
        match sidecar.process.try_wait() {
            Ok(None) => {
                return Ok(VoiceSidecarInfo {
                    port: sidecar.port,
                    token: sidecar.token.clone(),
                })
            }
            Ok(Some(status)) => tracing::warn!(%status, "voice_sidecar_exited_before_reuse"),
            Err(error) => tracing::warn!(%error, "voice_sidecar_status_failed"),
        }
        *child_guard = None;
    }

    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    drop(listener);
    let token = generate_token();
    let binary = resolve_sidecar_binary(&app)?;
    let models_dir = daemon_paths()
        .map_err(|error| error.to_string())?
        .data_dir
        .join("voice")
        .join("models");
    std::fs::create_dir_all(&models_dir).map_err(|error| {
        format!(
            "failed to create voice model directory '{}': {error}",
            models_dir.display()
        )
    })?;

    let mut command = Command::new(&binary);
    command
        .arg("--port")
        .arg(port.to_string())
        .arg("--token")
        .arg(&token)
        .arg("--models-dir")
        .arg(&models_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_no_window(&mut command);
    let mut process = command.spawn().map_err(|error| {
        format!(
            "failed to start voice sidecar '{}': {error}",
            binary.display()
        )
    })?;
    pipe_logs(process.stdout.take(), "stdout");
    pipe_logs(process.stderr.take(), "stderr");
    tracing::info!(pid = process.id(), port, path = %binary.display(), "voice_sidecar_started");
    *child_guard = Some(VoiceSidecar {
        process,
        port,
        token: token.clone(),
    });
    Ok(VoiceSidecarInfo { port, token })
}

#[tauri::command]
pub fn voice_stop_sidecar(state: State<'_, VoiceState>) -> Result<(), String> {
    stop_sidecar(&state)
}

#[tauri::command]
pub fn voice_enable_hotkey(app: AppHandle) -> Result<(), String> {
    voice_hook::enable(app)
}

#[tauri::command]
pub fn voice_disable_hotkey() -> Result<(), String> {
    voice_hook::disable();
    Ok(())
}

#[tauri::command]
pub fn voice_gpu_info() -> Result<GpuInfoDto, String> {
    gpu_info()
}

#[tauri::command]
pub fn voice_models_dir() -> Result<String, String> {
    Ok(daemon_paths()
        .map_err(|error| error.to_string())?
        .data_dir
        .join("voice")
        .join("models")
        .to_string_lossy()
        .into_owned())
}

pub fn shutdown(state: &VoiceState) {
    voice_hook::disable();
    let _ = stop_sidecar_inner(state);
}

fn stop_sidecar(state: &VoiceState) -> Result<(), String> {
    stop_sidecar_inner(state)
}

fn stop_sidecar_inner(state: &VoiceState) -> Result<(), String> {
    let sidecar = state
        .child
        .lock()
        .map_err(|error| error.to_string())?
        .take();
    if let Some(mut sidecar) = sidecar {
        let pid = sidecar.process.id();
        #[cfg(windows)]
        {
            let mut command = Command::new("taskkill");
            command.args(["/F", "/T", "/PID", &pid.to_string()]);
            apply_no_window(&mut command);
            let _ = command.output();
        }
        #[cfg(not(windows))]
        let _ = sidecar.process.kill();
        let _ = sidecar.process.wait();
        tracing::info!(pid, "voice_sidecar_stopped");
    }
    Ok(())
}

fn resolve_sidecar_binary(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("VIBELINK_VOICE_SIDECAR").map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "VIBELINK_VOICE_SIDECAR does not point to a file: {}",
            path.display()
        ));
    }

    let exe_dir = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .ok_or_else(|| "application executable has no parent directory".to_owned())?
        .to_path_buf();
    let mut candidates = vec![exe_dir.join("vibelink-voice-sidecar.exe")];
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(
            resource_dir
                .join("resources")
                .join("voice")
                .join("vibelink-voice-sidecar.exe"),
        );
        candidates.push(
            resource_dir
                .join("voice")
                .join("vibelink-voice-sidecar.exe"),
        );
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "VibeLink voice sidecar binary was not found beside the app or in bundled resources"
                .to_owned()
        })
}

fn generate_token() -> String {
    let first = Uuid::new_v4().simple().to_string();
    let second = Uuid::new_v4().simple().to_string();
    format!("{first}{}", &second[..16])
}

fn pipe_logs<R: std::io::Read + Send + 'static>(stream: Option<R>, channel: &'static str) {
    if let Some(stream) = stream {
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                tracing::info!(target: "voice_sidecar", %channel, %line);
            }
        });
    }
}

fn apply_no_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

#[cfg(windows)]
fn gpu_info() -> Result<GpuInfoDto, String> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};

    let factory: IDXGIFactory1 =
        unsafe { CreateDXGIFactory1() }.map_err(|error| error.to_string())?;
    let mut best = GpuInfoDto {
        name: String::new(),
        vendor_id: 0,
        dedicated_video_memory_mb: 0,
        is_nvidia: false,
    };
    let mut index = 0;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(index) } {
        index += 1;
        let desc = unsafe { adapter.GetDesc1() }.map_err(|error| error.to_string())?;
        if desc.VendorId == 0x1414 {
            continue;
        }
        let memory_mb = (desc.DedicatedVideoMemory as u64) / (1024 * 1024);
        if memory_mb < best.dedicated_video_memory_mb {
            continue;
        }
        let name_len = desc
            .Description
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(desc.Description.len());
        best = GpuInfoDto {
            name: String::from_utf16_lossy(&desc.Description[..name_len]),
            vendor_id: desc.VendorId,
            dedicated_video_memory_mb: memory_mb,
            is_nvidia: desc.VendorId == 0x10DE,
        };
    }
    Ok(best)
}

#[cfg(not(windows))]
fn gpu_info() -> Result<GpuInfoDto, String> {
    Ok(GpuInfoDto {
        name: String::new(),
        vendor_id: 0,
        dedicated_video_memory_mb: 0,
        is_nvidia: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn token_is_random_ascii_and_48_chars() {
        let left = generate_token();
        let right = generate_token();
        assert_eq!(left.len(), 48);
        assert!(left.is_ascii());
        assert_ne!(left, right);
    }
    #[test]
    fn gpu_probe_returns_a_valid_dto() {
        let gpu = gpu_info().expect("DXGI probe should not fail");
        println!(
            "GPU={} VRAM={}MB NVIDIA={}",
            gpu.name, gpu.dedicated_video_memory_mb, gpu.is_nvidia
        );
        if gpu.name.is_empty() {
            assert_eq!(gpu.dedicated_video_memory_mb, 0);
        }
    }
}
