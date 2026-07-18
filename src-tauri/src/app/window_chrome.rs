use anyhow::{anyhow, Result};
use tauri::WebviewWindow;
use windows_sys::Win32::{
    Foundation::{GetLastError, SetLastError, ERROR_SUCCESS, HWND},
    UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_STYLE, SWP_FRAMECHANGED,
        SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_SYSMENU,
    },
};

pub fn disable_system_menu(window: &WebviewWindow) -> Result<()> {
    let hwnd = window.hwnd()?.0;
    unsafe { disable_system_menu_for_hwnd(hwnd) }
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
}
