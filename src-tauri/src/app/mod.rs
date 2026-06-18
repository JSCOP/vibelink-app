pub mod commands;
pub mod daemon_client;
pub mod spawn_daemon;

use daemon_client::DaemonClient;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .setup(|app| {
            let stream = spawn_daemon::ensure_daemon().map_err(|err| {
                let boxed: Box<dyn std::error::Error> = err.into();
                boxed
            })?;
            app.manage(DaemonClient::new(stream));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::attach_pane,
            commands::attach_session,
            commands::close_pane,
            commands::create_session,
            commands::delete_session,
            commands::detach_session,
            commands::init_terminal_output,
            commands::list_sessions,
            commands::ping,
            commands::rename_session,
            commands::resize_pane,
            commands::save_layout,
            commands::spawn_pane,
            commands::write_pane,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
