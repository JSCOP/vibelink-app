#[cfg(windows)]
mod platform {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{LazyLock, Mutex};
    use std::thread::JoinHandle;

    use tauri::Emitter;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Input::KeyboardAndMouse::{VK_LCONTROL, VK_LWIN, VK_RCONTROL, VK_RWIN};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
        HHOOK, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT,
        WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    unsafe extern "system" {
        fn GetCurrentThreadId() -> u32;
    }

    static PRESSED_CTRL: AtomicBool = AtomicBool::new(false);
    static PRESSED_WIN: AtomicBool = AtomicBool::new(false);
    static PTT_ACTIVE: AtomicBool = AtomicBool::new(false);
    static HOOK_RUNNING: AtomicBool = AtomicBool::new(false);
    static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);
    static APP_HANDLE: LazyLock<Mutex<Option<tauri::AppHandle>>> =
        LazyLock::new(|| Mutex::new(None));
    static HOOK_THREAD: LazyLock<Mutex<Option<JoinHandle<()>>>> =
        LazyLock::new(|| Mutex::new(None));

    pub fn enable(app: tauri::AppHandle) -> Result<(), String> {
        if HOOK_RUNNING.load(Ordering::SeqCst) {
            return Ok(());
        }
        PRESSED_CTRL.store(false, Ordering::SeqCst);
        PRESSED_WIN.store(false, Ordering::SeqCst);
        PTT_ACTIVE.store(false, Ordering::SeqCst);
        *APP_HANDLE.lock().map_err(|error| error.to_string())? = Some(app);

        let thread = std::thread::Builder::new()
            .name("vibelink-voice-ptt-hook".to_owned())
            .spawn(hook_thread_main)
            .map_err(|error| format!("failed to spawn voice hotkey thread: {error}"))?;
        *HOOK_THREAD.lock().map_err(|error| error.to_string())? = Some(thread);
        HOOK_RUNNING.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn disable() {
        if !HOOK_RUNNING.swap(false, Ordering::SeqCst) {
            return;
        }
        let thread_id = HOOK_THREAD_ID.load(Ordering::SeqCst);
        if thread_id != 0 {
            unsafe {
                let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
        if let Ok(mut guard) = HOOK_THREAD.lock() {
            if let Some(handle) = guard.take() {
                let _ = handle.join();
            }
        }
        HOOK_THREAD_ID.store(0, Ordering::SeqCst);
        PRESSED_CTRL.store(false, Ordering::SeqCst);
        PRESSED_WIN.store(false, Ordering::SeqCst);
        PTT_ACTIVE.store(false, Ordering::SeqCst);
        if let Ok(mut guard) = APP_HANDLE.lock() {
            *guard = None;
        }
    }

    fn hook_thread_main() {
        let thread_id = unsafe { GetCurrentThreadId() };
        HOOK_THREAD_ID.store(thread_id, Ordering::SeqCst);
        let hook: HHOOK =
            match unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), None, 0) } {
                Ok(hook) => hook,
                Err(error) => {
                    tracing::error!(%error, "voice_hotkey_install_failed");
                    HOOK_RUNNING.store(false, Ordering::SeqCst);
                    return;
                }
            };
        unsafe {
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).as_bool() {}
            if let Err(error) = UnhookWindowsHookEx(hook) {
                tracing::warn!(%error, "voice_hotkey_unhook_failed");
            }
        }
    }

    unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code < 0 {
            return unsafe { CallNextHookEx(None, code, wparam, lparam) };
        }
        let keyboard = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        if keyboard.flags.contains(LLKHF_INJECTED) {
            return unsafe { CallNextHookEx(None, code, wparam, lparam) };
        }
        let message = wparam.0 as u32;
        let is_down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
        let is_up = message == WM_KEYUP || message == WM_SYSKEYUP;
        if !is_down && !is_up {
            return unsafe { CallNextHookEx(None, code, wparam, lparam) };
        }

        let virtual_key = keyboard.vkCode;
        let is_ctrl = virtual_key == VK_LCONTROL.0 as u32 || virtual_key == VK_RCONTROL.0 as u32;
        let is_win = virtual_key == VK_LWIN.0 as u32 || virtual_key == VK_RWIN.0 as u32;
        if !is_ctrl && !is_win {
            return unsafe { CallNextHookEx(None, code, wparam, lparam) };
        }
        if is_ctrl {
            PRESSED_CTRL.store(is_down, Ordering::SeqCst);
        }
        if is_win {
            PRESSED_WIN.store(is_down, Ordering::SeqCst);
        }

        let active = PRESSED_CTRL.load(Ordering::SeqCst) && PRESSED_WIN.load(Ordering::SeqCst);
        let was_active = PTT_ACTIVE.swap(active, Ordering::SeqCst);
        if active && !was_active && is_down {
            emit("vibelink://voice-ptt-pressed");
        } else if !active && was_active && is_up {
            emit("vibelink://voice-ptt-released");
        }

        if is_win && (active || was_active) {
            return LRESULT(1);
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    fn emit(event: &str) {
        if let Ok(guard) = APP_HANDLE.lock() {
            if let Some(app) = guard.as_ref() {
                if let Err(error) = app.emit(event, ()) {
                    tracing::warn!(%error, %event, "voice_hotkey_emit_failed");
                }
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn enable(_app: tauri::AppHandle) -> Result<(), String> {
        Err("voice hotkey is supported only on Windows".to_owned())
    }
    pub fn disable() {}
}

pub use platform::{disable, enable};
