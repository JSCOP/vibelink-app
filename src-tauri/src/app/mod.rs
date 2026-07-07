pub mod board;
pub mod capture;
pub mod commands;
pub mod daemon_client;
pub mod git;
pub mod hermes;
pub mod skills;
pub mod spawn_daemon;

use daemon_client::DaemonClient;
use std::sync::Arc;
use tauri::Manager;

pub struct KeepAlivePrefs(pub std::sync::atomic::AtomicBool);

impl Default for KeepAlivePrefs {
    fn default() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let stream = spawn_daemon::ensure_daemon().map_err(|err| {
                let boxed: Box<dyn std::error::Error> = err.into();
                boxed
            })?;
            app.manage(DaemonClient::new(stream));
            app.manage(Arc::new(hermes::HermesManager::new()));
            app.manage(capture::CaptureState::default());
            app.manage(KeepAlivePrefs::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            board::board_read,
            board::board_write,
            commands::attach_pane,
            commands::attach_session,
            commands::close_pane,
            commands::clear_session,
            commands::create_session,
            commands::delete_session,
            commands::detach_session,
            commands::init_terminal_output,
            commands::terminal_ws_port,
            hermes::hermes_cancel,
            hermes::hermes_respond_permission,
            hermes::hermes_send,
            hermes::hermes_set_mode,
            hermes::hermes_set_model,
            hermes::hermes_start,
            hermes::hermes_stop,
            hermes::hermes_new_session,
            hermes::hermes_resume_session,
            hermes::hermes_list_sessions,
            hermes::hermes_session_transcript,
            hermes::hermes_archive_session,
            hermes::init_hermes_output,
            hermes::hermes_gateway_provision,
            hermes::hermes_gateway_start,
            hermes::hermes_gateway_status,
            hermes::hermes_gateway_stop,
            hermes::hermes_auth_list,
            hermes::hermes_workspace_home,
            hermes::hermes_cli_command,
            hermes::hermes_install_runtime,
            hermes::hermes_ensure_workspace,
            hermes::hermes_workspace_state,
            hermes::hermes_runtime_status,
            git::git_changed_files,
            git::git_file_contents,
            git::git_is_available,
            git::git_snapshot_baseline,
            git::git_worktree_create,
            git::git_worktree_remove,
            commands::list_installed_fonts,
            commands::list_sessions,
            commands::ping,
            commands::rename_session,
            commands::resource_snapshot,
            commands::restart_daemon,
            commands::set_keep_terminals_alive_on_close,
            commands::resize_pane,
            commands::save_layout,
            commands::set_pane_title,
            commands::spawn_pane,
            commands::write_pane,
            skills::awt_skill_list,
            skills::awt_skill_get,
            skills::awt_skill_apply,
            skills::awt_skill_delete,
            capture::default_capture_dir,
            capture::check_ffmpeg,
            capture::ensure_ffmpeg,
            capture::open_path,
            capture::open_capture_overlay,
            capture::capture_region_image,
            capture::clipboard_write_image,
            capture::read_capture_file,
            capture::start_video_capture,
            capture::stop_video_capture,
            capture::capture_recording_state,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(client) = app.try_state::<DaemonClient>() {
                client.prepare_shutdown();
            }
            if let Some(manager) = app.try_state::<Arc<hermes::HermesManager>>() {
                manager.shutdown_all();
            }
            let keep_alive = app
                .try_state::<KeepAlivePrefs>()
                .map(|prefs| prefs.0.load(std::sync::atomic::Ordering::Acquire))
                .unwrap_or(false);
            if !keep_alive {
                let _ = spawn_daemon::shutdown_daemon();
            }
        }
    });
}
