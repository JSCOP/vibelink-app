pub mod commands;
pub mod daemon_client;
pub mod spawn_daemon;

use daemon_client::DaemonClient;
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::attach_pane,
            commands::attach_session,
            commands::close_pane,
            commands::clear_session,
            commands::create_session,
            commands::delete_session,
            commands::detach_session,
            commands::init_terminal_output,
            commands::list_installed_fonts,
            commands::list_sessions,
            commands::ping,
            commands::rename_session,
            commands::resize_pane,
            commands::save_layout,
            commands::set_pane_title,
            commands::spawn_pane,
            commands::write_pane,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(client) = app.try_state::<DaemonClient>() {
                client.prepare_shutdown();
            }
            let _ = spawn_daemon::shutdown_daemon();
        }
    });
}
