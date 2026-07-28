pub mod agent_history;
pub mod agent_hooks;
pub mod agents;
pub mod android_device_lab;
pub mod board;
pub mod browser;
pub mod capture;
pub mod cli;
pub mod cli_path;
pub mod commands;
pub mod computer_use;
pub mod daemon_client;
pub mod fsops;
pub mod git;
pub mod hermes;
pub mod license;
pub mod mcp_check;
pub mod orchestration;
pub mod provider_integrations;
pub mod skills;
pub mod spawn_daemon;
pub mod tray;
#[cfg(windows)]
mod webview_renderer;

#[cfg(windows)]
mod window_chrome;

use crate::browser::{BrowserManager, BrowserPolicy, NativeBrowserProvider};
use daemon_client::DaemonClient;
use std::sync::Arc;
use tauri::Manager;

/// Exit policy shared with the frontend `settings.sessionRestore`.
///
/// Orca parity: quitting is a real quit. `Resume` keeps the detached daemon
/// alive so the next launch reattaches the very same processes; `Clean` stops
/// every terminal and marks the workspaces clean so nothing is restored.
pub struct ExitPrefs {
    /// `true` => stop all terminals on quit (the `clean` restore mode).
    clean: std::sync::atomic::AtomicBool,
    /// `true` => the window close button hides to the tray instead of quitting.
    minimize_to_tray: std::sync::atomic::AtomicBool,
}

impl Default for ExitPrefs {
    fn default() -> Self {
        Self {
            clean: std::sync::atomic::AtomicBool::new(false),
            minimize_to_tray: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

impl ExitPrefs {
    pub fn set_clean(&self, value: bool) {
        self.clean
            .store(value, std::sync::atomic::Ordering::Release);
    }

    pub fn set_minimize_to_tray(&self, value: bool) {
        self.minimize_to_tray
            .store(value, std::sync::atomic::Ordering::Release);
    }

    fn should_stop(&self) -> bool {
        self.clean.load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn minimizes_to_tray(&self) -> bool {
        self.minimize_to_tray
            .load(std::sync::atomic::Ordering::Acquire)
    }
}

pub fn run() {
    configure_browser_cdp();
    #[cfg(windows)]
    webview_renderer::configure_main_webview();
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
                if let Err(error) = window_chrome::disable_system_menu(&main_window) {
                    eprintln!("disable system menu: {error}");
                }
                // WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS MUST stay set for the
                // whole process lifetime. WebView2 keeps one browser
                // environment per (user data dir, options) pair, and creating a
                // later webview in the same profile with different options
                // fails with ERROR_INVALID_STATE (0x8007139F). Clearing it here
                // — after the main window was created WITH the arguments — made
                // every capture overlay silently fail to build its webview:
                // `WebviewWindowBuilder::build()` still returned Ok and Tauri
                // still registered the label, so screenshots and recording
                // broke permanently with "a webview with label
                // `capture-overlay` already exists".
                //
                // Child processes must not inherit the debugging port, so the
                // variable is removed per spawned command instead
                // (`daemon::pty` and `app::spawn_daemon`).
            }
            if let Ok(cli_executable) = cli_path::dedicated_cli_path() {
                std::env::set_var("VIBELINK_CLI_EXE", cli_executable);
            }
            if let Ok(computer_host) = cli_path::computer_host_path() {
                std::env::set_var("VIBELINK_COMPUTER_HOST_EXE", computer_host);
            }
            let stream = spawn_daemon::ensure_daemon().map_err(|err| {
                let boxed: Box<dyn std::error::Error> = err.into();
                boxed
            })?;
            app.manage(DaemonClient::new_with_app(stream, app.handle().clone()));
            app.manage(Arc::new(hermes::HermesManager::new()));
            app.manage(Arc::new(license::LicenseService::new().map_err(
                |error| {
                    let boxed: Box<dyn std::error::Error> = error.into();
                    boxed
                },
            )?));
            let data_dir = crate::daemon::paths::daemon_paths()
                .map_err(|error| {
                    let boxed: Box<dyn std::error::Error> = error.into();
                    boxed
                })?
                .data_dir;
            let browser_root = data_dir.join("browser");
            let browser_policy = BrowserPolicy::new(
                false,
                Vec::new(),
                browser_root.join("downloads"),
                browser_root.join("artifacts"),
                64 * 1024 * 1024,
            )
            .map_err(|error| {
                let boxed: Box<dyn std::error::Error> = error.into();
                boxed
            })?;
            let browser_cdp_port = std::env::var("VIBELINK_BROWSER_CDP_PORT")
                .ok()
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(9333);
            let browser_event_app = app.handle().clone();
            let browser_provider = Arc::new(NativeBrowserProvider::new(
                app.handle().clone(),
                "main",
                browser_root.join("cdp-registry.json"),
                browser_cdp_port,
                move || browser::schedule_browser_event_pump(browser_event_app.clone()),
            ));
            app.manage(Arc::new(BrowserManager::new(
                browser_provider,
                browser_policy,
                browser_root.join("profiles"),
            )));
            app.manage(capture::CaptureState::default());
            app.manage(ExitPrefs::default());
            if let Err(error) = tray::build(app.handle()) {
                // A missing tray must never block startup; it only removes the
                // way back from a hidden window, which the close handler
                // already guards by refusing to hide without a tray.
                eprintln!("build tray icon: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agents::agent_cli_status,
            agent_history::agent_conversations_list,
            board::board_read,
            board::board_write,
            board::board_task_create,
            board::board_task_update,
            board::board_task_delete,
            board::board_task_done,
            board::board_task_note,
            board::board_brief_get,
            board::board_brief_set,
            orchestration::orchestration_request,
            browser::browser_initialize,
            browser::browser_project_targets,
            browser::browser_create_profile,
            browser::browser_create_tab,
            browser::browser_navigate,
            browser::browser_go_back,
            cli::cli_request,
            browser::browser_go_forward,
            computer_use::computer_request,
            browser::browser_set_design_mode,
            browser::browser_reload,
            browser::browser_set_surface,
            browser::browser_set_device_metrics,
            browser::browser_capture_state,
            browser::browser_capture_crop,
            browser::browser_create_annotation,
            browser::browser_detect_cookie_import_source,
            browser::browser_import_cookies,
            browser::browser_resolve_permission,
            browser::browser_resolve_certificate,
            browser::browser_resolve_dialog,
            browser::browser_close_tab,
            browser::browser_cleanup_workspace,
            provider_integrations::provider_scopes_list,
            provider_integrations::provider_credential_capture,
            provider_integrations::provider_credential_status,
            provider_integrations::provider_credential_delete,
            provider_integrations::provider_discover,
            provider_integrations::provider_assigned_items,
            provider_integrations::provider_workspace_input,
            provider_integrations::provider_review_comment,
            android_device_lab::device_lab_sdk_discover,
            android_device_lab::device_lab_adb_devices,
            android_device_lab::device_lab_avd_list,
            android_device_lab::device_lab_avd_start,
            android_device_lab::device_lab_apk_install,
            android_device_lab::device_lab_app_launch,
            android_device_lab::device_lab_permission_change,
            android_device_lab::device_lab_accessibility_status,
            android_device_lab::device_lab_logcat,
            android_device_lab::device_lab_scrcpy_start,
            android_device_lab::device_lab_process_status,
            android_device_lab::device_lab_process_cancel,
            android_device_lab::device_lab_owned_processes,
            commands::attach_pane,
            commands::subscribe_pane,
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
            commands::remote_reclaim_pane_lease,
            commands::remote_set_enabled,
            commands::remote_set_port,
            commands::remote_set_lan_enabled,
            commands::remote_create_pairing,
            commands::remote_create_pairing_v2,
            commands::remote_revoke_device,
            commands::remote_regenerate_identity,
            commands::remote_firewall_status,
            commands::remote_setup_firewall,
            commands::set_remote_appearance,
            commands::set_desktop_selection,
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
            license::bug_report_submit,
            fsops::fs_create_dir,
            fsops::fs_create_file,
            fsops::fs_delete,
            fsops::fs_list_dir,
            fsops::fs_read_image,
            fsops::fs_read_text,
            fsops::fs_open_text_document,
            fsops::fs_text_document_revision,
            fsops::fs_save_text_document,
            fsops::fs_save_text_document_as,
            fsops::fs_rename,
            fsops::open_in_editor,
            git::branch::git_branch_create,
            git::branch::git_branch_delete,
            git::branch::git_branch_rename,
            git::branch::git_branches,
            git::status::git_check_ignored,
            git::hosting::hosting_ci_status,
            git::hosting::hosting_pr_merge,
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
            git::diff::git_compare_refs,
            git::diff::git_compare_refs_file,
            git::diff::git_commit_file_contents,
            git::branch::git_conflict_take,
            git::diff::git_diff_refs,
            git::diff::git_diff_refs_file,
            git::status::git_dir_entries,
            git::discover::git_discover_repos,
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
            git::submodule::git_submodule_sync,
            git::submodule::git_submodule_update,
            git::git_snapshot_baseline,
            git::stage::git_stage,
            git::stage::git_diff_hunks,
            git::stage::git_apply_hunk,
            git::stage::git_stage_all,
            git::stage::git_stash_apply,
            git::stage::git_stash_drop,
            git::stage::git_stash_list,
            git::stage::git_stash_pop,
            git::stage::git_stash_save,
            git::branch::git_tag_create,
            git::branch::git_tag_list,
            git::stage::git_unstage,
            git::stage::git_unstage_all,
            git::diff::git_working_file_contents,
            git::status::git_working_status,
            git::git_worktree_resolve_root,
            git::git_worktree_storage_options,
            git::worktree_registry_list,
            git::worktree_registry_reconcile,
            git::worktree_registry_import,
            git::worktree_lifecycle_create,
            git::worktree_lifecycle_cancel,
            git::worktree_lifecycle_move,
            git::worktree_removal_preflight,
            git::worktree_lifecycle_remove,
            git::worktree_registry_set,
            git::worktree_checkpoint_create,
            git::worktree_checkpoints_list,
            git::worktree_review_comment_create,
            git::worktree_review_comments_list,
            commands::list_installed_fonts,
            commands::list_sessions,
            commands::ping,
            commands::rename_session,
            commands::set_session_workspace_folder,
            commands::resource_snapshot,
            commands::attention_snapshot,
            commands::agent_hook_status,
            commands::set_agent_hook_enabled,
            commands::set_pane_role,
            commands::restart_daemon,
            commands::set_exit_behavior,
            commands::hide_to_tray,
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
            capture::clipboard_write_text,
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
            let stop_on_exit = app
                .try_state::<ExitPrefs>()
                .map(|prefs| prefs.should_stop())
                .unwrap_or(false);
            if stop_on_exit {
                // Clean mode: stop every terminal AND record the deliberate
                // quit so the next launch opens an initialized screen.
                let _ = spawn_daemon::shutdown_daemon_clean();
            }
        }
    });
    fn configure_browser_cdp() {
        let flavor = crate::daemon::paths::app_flavor();
        let port = if flavor == "dev" { 9334 } else { 9333 };
        std::env::set_var("VIBELINK_BROWSER_CDP_PORT", port.to_string());
        let flag = format!("--remote-debugging-port={port}");
        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        if !existing
            .split_whitespace()
            .any(|argument| argument.starts_with("--remote-debugging-port="))
        {
            let arguments = if existing.trim().is_empty() {
                flag
            } else {
                format!("{} {}", existing.trim(), flag)
            };
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", arguments);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_processes_survive_app_exit_by_default() {
        assert!(!ExitPrefs::default().should_stop());
    }

    #[test]
    fn terminal_processes_stop_only_after_explicit_opt_out() {
        let prefs = ExitPrefs::default();
        prefs.set_clean(true);

        assert!(prefs.should_stop());
    }

    #[test]
    fn window_close_quits_unless_tray_minimize_is_enabled() {
        let prefs = ExitPrefs::default();
        assert!(!prefs.minimizes_to_tray());

        prefs.set_minimize_to_tray(true);
        assert!(prefs.minimizes_to_tray());
    }
}
