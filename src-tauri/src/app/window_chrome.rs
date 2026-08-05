use anyhow::{anyhow, Result};
use tauri::{Emitter, WebviewWindow};
use windows_sys::Win32::{
    Foundation::{GetLastError, SetLastError, ERROR_SUCCESS, HWND, LPARAM, LRESULT, WPARAM},
    UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            GetForegroundWindow, GetWindowLongPtrW, PostMessageW, SetWindowLongPtrW, SetWindowPos,
            GWL_STYLE, SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WA_INACTIVE,
            WM_ACTIVATE, WM_APP, WM_NCDESTROY, WS_SYSMENU,
        },
    },
};

pub fn disable_system_menu(window: &WebviewWindow) -> Result<()> {
    let hwnd = window.hwnd()?.0;
    unsafe { disable_system_menu_for_hwnd(hwnd) }
}

const ACTIVATION_FOCUS_SUBCLASS_ID: usize = 0x564c_464f;
const CHECK_ACTIVATION_FOCUS_MESSAGE: u32 = WM_APP + 0x564;
const MAIN_WINDOW_ACTIVATED_EVENT: &str = "vibelink://main-window-activated";

struct ActivationFocusHook {
    window: WebviewWindow,
}

pub fn install_activation_focus_recovery(window: &WebviewWindow) -> Result<()> {
    let hwnd = window.hwnd()?.0;
    let state = Box::new(ActivationFocusHook {
        window: window.clone(),
    });
    let state_ptr = Box::into_raw(state);
    if unsafe {
        SetWindowSubclass(
            hwnd,
            Some(activation_focus_subclass_proc),
            ACTIVATION_FOCUS_SUBCLASS_ID,
            state_ptr as usize,
        )
    } == 0
    {
        unsafe { drop(Box::from_raw(state_ptr)) };
        return Err(anyhow!(
            "failed to install main window activation focus recovery: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

unsafe extern "system" fn activation_focus_subclass_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    subclass_id: usize,
    ref_data: usize,
) -> LRESULT {
    if is_window_activation(message, wparam) {
        let _ = PostMessageW(hwnd, CHECK_ACTIVATION_FOCUS_MESSAGE, 0, 0);
    } else if message == CHECK_ACTIVATION_FOCUS_MESSAGE {
        if GetForegroundWindow() == hwnd && ref_data != 0 {
            let state = &*(ref_data as *const ActivationFocusHook);
            // Re-entering WebView focus from this HWND subclass callback can deadlock
            // the Tauri UI thread. Let the frontend restore terminal focus after the event.
            let _ = state.window.emit(MAIN_WINDOW_ACTIVATED_EVENT, ());
        }
        return 0;
    } else if message == WM_NCDESTROY {
        let result = DefSubclassProc(hwnd, message, wparam, lparam);
        let _ = RemoveWindowSubclass(hwnd, Some(activation_focus_subclass_proc), subclass_id);
        if ref_data != 0 {
            drop(Box::from_raw(ref_data as *mut ActivationFocusHook));
        }
        return result;
    }

    DefSubclassProc(hwnd, message, wparam, lparam)
}

fn is_window_activation(message: u32, wparam: WPARAM) -> bool {
    message == WM_ACTIVATE && (wparam & 0xffff) != WA_INACTIVE as usize
}

unsafe fn disable_system_menu_for_hwnd(hwnd: HWND) -> Result<()> {
    SetLastError(ERROR_SUCCESS);
    let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
    let error = GetLastError();
    if style == 0 && error != ERROR_SUCCESS {
        return Err(anyhow!(
            "failed to read the main window style: {}",
            std::io::Error::from_raw_os_error(error as i32)
        ));
    }

    let updated_style = style_without_system_menu(style);
    if updated_style == style {
        return Ok(());
    }

    SetLastError(ERROR_SUCCESS);
    let previous_style = SetWindowLongPtrW(hwnd, GWL_STYLE, updated_style);
    let error = GetLastError();
    if previous_style == 0 && error != ERROR_SUCCESS {
        return Err(anyhow!(
            "failed to disable the main window system menu: {}",
            std::io::Error::from_raw_os_error(error as i32)
        ));
    }

    if SetWindowPos(
        hwnd,
        std::ptr::null_mut(),
        0,
        0,
        0,
        0,
        SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER,
    ) == 0
    {
        return Err(anyhow!(
            "failed to refresh the main window frame after disabling its system menu: {}",
            std::io::Error::last_os_error()
        ));
    }

    Ok(())
}

fn style_without_system_menu(style: isize) -> isize {
    style & !(WS_SYSMENU as isize)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_THICKFRAME,
    };

    #[test]
    fn removes_only_the_system_menu_style() {
        let style = (WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX) as isize;

        let updated = style_without_system_menu(style);

        assert_eq!(updated & WS_SYSMENU as isize, 0);
        assert_ne!(updated & WS_THICKFRAME as isize, 0);
        assert_ne!(updated & WS_MINIMIZEBOX as isize, 0);
        assert_ne!(updated & WS_MAXIMIZEBOX as isize, 0);
    }

    #[test]
    fn removing_the_system_menu_style_is_idempotent() {
        let style = (WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX) as isize;

        assert_eq!(style_without_system_menu(style), style);
    }

    #[test]
    fn detects_real_window_activation_messages() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{WA_ACTIVE, WA_CLICKACTIVE};

        assert!(is_window_activation(WM_ACTIVATE, WA_ACTIVE as usize));
        assert!(is_window_activation(WM_ACTIVATE, WA_CLICKACTIVE as usize));
        assert!(!is_window_activation(WM_ACTIVATE, WA_INACTIVE as usize));
        assert!(!is_window_activation(WM_APP, WA_ACTIVE as usize));
    }
}
