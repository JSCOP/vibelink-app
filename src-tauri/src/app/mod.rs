pub mod commands;
pub mod board;
pub mod git;
pub mod hermes;
pub mod daemon_client;
pub mod spawn_daemon;
pub mod capture;

use daemon_client::DaemonClient;
use std::sync::Arc;
use tauri::Manager;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let stream = spawn_daemon::ensure_daemon().map_err(|err| {
                let boxed: Box<dyn std::error::Error> = err.into();
                boxed
            })?;
            app.manage(DaemonClient::new(stream));
            app.manage(Arc::new(hermes::HermesManager::new()));
            app.manage(capture::CaptureState::default());
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
            hermes::hermes_cancel,
            hermes::hermes_respond_permission,
            hermes::hermes_send,
            hermes::hermes_set_mode,
            hermes::hermes_set_model,
            hermes::hermes_start,
            hermes::hermes_stop,
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
            commands::resize_pane,
            commands::save_layout,
            commands::set_pane_title,
            commands::spawn_pane,
            commands::write_pane,
            capture::default_capture_dir,
            capture::check_ffmpeg,
            capture::open_path,
            capture::open_capture_overlay,
            capture::capture_region_image,
            capture::start_video_capture,
            capture::stop_video_capture,
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
            let _ = spawn_daemon::shutdown_daemon();
        }
    });
}
