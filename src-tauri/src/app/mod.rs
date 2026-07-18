pub mod agents;
pub mod authorization;
pub mod board;
pub mod capture;
pub mod entitlement;
pub mod commands;
pub mod daemon_client;
pub mod fsops;
pub mod git;
pub mod hermes;
pub mod license;
pub mod mcp_check;
pub mod skills;
pub mod spawn_daemon;
#[cfg(windows)]
mod window_chrome;

use crate::remote::RemoteServer;
use daemon_client::DaemonClient;
use std::sync::Arc;
use tauri::{Emitter, Manager};

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
            #[cfg(windows)]
            {
                let main_window = app.get_webview_window("main").ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::NotFound, "main window not found")
                })?;
                window_chrome::disable_system_menu(&main_window)?;
            }
            let stream = spawn_daemon::ensure_daemon().map_err(|err| {
                let boxed: Box<dyn std::error::Error> = err.into();
                boxed
            })?;
            app.manage(DaemonClient::new_with_app(stream, app.handle().clone()));
            app.manage(Arc::new(hermes::HermesManager::new()));
            let license = Arc::new(license::LicenseService::new().map_err(|error| {
                let boxed: Box<dyn std::error::Error> = error.into();
                boxed
            })?);
            let entitlement = entitlement::EntitlementSupervisor::new(
                Arc::clone(&license),
                app.handle().clone(),
            )
            .map_err(|error| {
                let boxed: Box<dyn std::error::Error> = error.into();
                boxed
            })?;
            entitlement.start_background();
            app.manage(license);
            app.manage(entitlement);
            let data_dir = crate::daemon::paths::daemon_paths()
                .map_err(|error| {
                    let boxed: Box<dyn std::error::Error> = error.into();
                    boxed
                })?
                .data_dir;
            let app_handle = app.handle().clone();
            let remote = Arc::new(
                RemoteServer::new_with_pane_lease_notifier(data_dir, move |event| {
                    let _ = app_handle.emit("remote://pane-lease", event);
                })
                .map_err(|error| {
                    let boxed: Box<dyn std::error::Error> = error.into();
                    boxed
                })?,
            );
            if let Err(error) = remote.start_if_enabled() {
                tracing::warn!(?error, "remote access auto-start failed");
            }
            app.manage(remote);
            app.manage(capture::CaptureState::default());
            app.manage(KeepAlivePrefs::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agents::agent_cli_status,
            board::board_read,
            board::board_write,
            board::board_task_create,
            board::board_task_update,
            board::board_task_delete,
            board::board_task_done,
            board::board_task_note,
            board::board_brief_get,
            board::board_brief_set,
            commands::attach_pane,
            commands::attach_session,
            commands::close_pane,
            commands::clear_session,
            commands::create_session,
            commands::delete_session,
            commands::detach_session,
            commands::init_terminal_output,
            commands::terminal_ws_port,
            commands::remote_get_status,
            commands::remote_get_pane_lease,
            commands::remote_set_enabled,
            commands::remote_set_port,
            commands::remote_create_pairing,
            commands::remote_revoke_device,
            commands::remote_regenerate_identity,
            commands::remote_firewall_status,
            commands::remote_setup_firewall,
            commands::set_remote_appearance,
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
            hermes::init_hermes_output,
            hermes::hermes_auth_list,
            hermes::hermes_cli_command,
            mcp_check::mcp_self_check,
            hermes::hermes_workspace_state,
            hermes::agent_workspace_cleanup,
            hermes::hermes_runtime_status,
            license::license_status,
            license::license_revalidate,
            license::license_deactivate_device,
            license::license_forget_local,
            license::account_sign_in_start,
            license::account_sign_in_poll,
            license::account_sign_out,
            fsops::fs_create_dir,
            fsops::fs_create_file,
            fsops::fs_delete,
            fsops::fs_list_dir,
            fsops::fs_read_image,
            fsops::fs_read_text,
            fsops::fs_rename,
            fsops::open_in_editor,
            git::branch::git_branch_create,
            git::branch::git_branch_delete,
            git::branch::git_branch_rename,
            git::branch::git_branches,
            git::status::git_check_ignored,
            git::hosting::hosting_ci_status,
            git::hosting::hosting_detect,
            git::hosting::hosting_github_device_poll,
            git::hosting::hosting_github_device_start,
            git::hosting::hosting_pr_create,
            git::hosting::hosting_pr_detail,
            git::hosting::hosting_prs_list,
            git::hosting::hosting_provider_override,
            git::hosting::hosting_token_clear,
            git::hosting::hosting_token_set,
            git::hosting::hosting_token_status,
            git::git_changed_files,
            git::branch::git_checkout,
            git::remote::git_clone,
            git::stage::git_commit,
            git::log::git_commit_detail,
            git::diff::git_commit_file_contents,
            git::branch::git_conflict_take,
            git::diff::git_diff_refs,
            git::diff::git_diff_refs_file,
            git::stage::git_discard,
            git::remote::git_fetch,
            git::git_file_contents,
            git::stage::git_init,
            git::git_is_available,
            git::log::git_log,
            git::branch::git_merge,
            git::branch::git_merge_abort,
            git::remote::git_pull,
            git::remote::git_push,
            git::branch::git_rebase,
            git::branch::git_rebase_abort,
            git::branch::git_rebase_continue,
            git::status::git_repo_info,
            git::git_snapshot_baseline,
            git::stage::git_stage,
            git::stage::git_stage_all,
            git::stage::git_stash_apply,
            git::stage::git_stash_drop,
            git::stage::git_stash_list,
            git::stage::git_stash_pop,
            git::stage::git_stash_save,
            git::branch::git_tag_create,
            git::branch::git_tag_delete,
            git::branch::git_tag_list,
            git::stage::git_unstage,
            git::stage::git_unstage_all,
            git::diff::git_working_file_contents,
            git::status::git_working_status,
            git::git_worktree_create,
            git::git_worktree_remove,
            commands::list_installed_fonts,
            commands::list_sessions,
            commands::ping,
            commands::rename_session,
            commands::resource_snapshot,
            commands::set_pane_role,
            commands::restart_daemon,
            commands::set_keep_terminals_alive_on_close,
            commands::resize_pane,
            commands::save_layout,
            commands::set_pane_title,
            commands::spawn_pane,
            commands::write_pane,
            skills::vibelink_skill_list,
            skills::vibelink_skill_get,
            skills::vibelink_skill_apply,
            skills::vibelink_skill_delete,
            capture::default_capture_dir,
            capture::check_ffmpeg,
            capture::ensure_ffmpeg,
            capture::open_path,
            capture::reveal_path,
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
            if let Some(remote) = app.try_state::<Arc<RemoteServer>>() {
                remote.stop();
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
