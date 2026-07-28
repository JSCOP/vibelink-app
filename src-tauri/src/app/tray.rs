//! System tray icon.
//!
//! Orca parity (`createSystemTray` in its `out/main/index.js`): the tray is
//! ALWAYS present, exposes exactly `Open` and `Quit`, and a left click on the
//! icon shows the window. The tray is what makes "hide instead of quit" a safe
//! option — without a visible way back, a hidden window is an invisible
//! process leak.
//!
//! Quitting from the tray must bypass the close-confirmation flow: the user
//! already expressed the intent explicitly.

use tauri::{
    menu::{Menu, MenuEvent, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

pub const TRAY_ID: &str = "vibelink-tray";
const MENU_OPEN: &str = "vibelink-tray-open";
const MENU_QUIT: &str = "vibelink-tray-quit";

/// Brings the main window back from a tray-hidden state.
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.show();
    // A window hidden while minimized stays minimized after `show`.
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.set_focus();
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, MENU_OPEN, "Open VibeLink", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            tauri::Error::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "default window icon missing",
            ))
        })?)
        .tooltip("VibeLink")
        .menu(&menu)
        // The menu must NOT open on a left click; left click shows the window.
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        MENU_OPEN => show_main_window(app),
        MENU_QUIT => {
            // Explicit intent: skip the close-confirmation round trip that the
            // window close button uses, but still run `RunEvent::Exit` so the
            // clean-exit/daemon policy applies.
            app.exit(0);
        }
        _ => {}
    }
}
