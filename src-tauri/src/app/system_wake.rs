use anyhow::{anyhow, Context, Result};
use std::{
    ptr::{null, null_mut},
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    System::{
        LibraryLoader::GetModuleHandleW,
        RemoteDesktop::{
            WTSRegisterSessionNotification, WTSUnRegisterSessionNotification,
            NOTIFY_FOR_THIS_SESSION,
        },
    },
    UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
        GetWindowLongPtrW, PostMessageW, PostQuitMessage, RegisterClassW, SetWindowLongPtrW,
        TranslateMessage, CREATESTRUCTW, GWLP_USERDATA, HWND_MESSAGE, MSG, PBT_APMRESUMEAUTOMATIC,
        PBT_APMRESUMESUSPEND, WM_CLOSE, WM_DESTROY, WM_NCCREATE, WM_POWERBROADCAST,
        WM_WTSSESSION_CHANGE, WNDCLASSW, WTS_SESSION_UNLOCK,
    },
};

const SYSTEM_RESUMED_EVENT: &str = "system-resumed";
const WAKE_DEDUPE_WINDOW: Duration = Duration::from_secs(2);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) struct SystemWakeRelay {
    hwnd: isize,
    thread: Mutex<Option<JoinHandle<()>>>,
}

struct RelayWindowState {
    app: AppHandle,
    last_emitted_at: Option<Instant>,
    session_notifications_registered: bool,
}

impl SystemWakeRelay {
    pub(crate) fn start(app: AppHandle) -> Result<Self> {
        let (startup_tx, startup_rx) = mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("vibelink-system-wake".to_string())
            .spawn(move || run_relay_thread(app, startup_tx))
            .context("spawn system wake relay thread")?;

        match startup_rx.recv_timeout(STARTUP_TIMEOUT) {
            Ok(Ok(hwnd)) => Ok(Self {
                hwnd,
                thread: Mutex::new(Some(thread)),
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(anyhow!(error))
            }
            Err(error) => {
                drop(startup_rx);
                let _ = thread.join();
                Err(anyhow!("system wake relay startup timed out: {error}"))
            }
        }
    }

    pub(crate) fn shutdown(&self) {
        let thread = self.thread.lock().ok().and_then(|mut slot| slot.take());
        let Some(thread) = thread else {
            return;
        };
        unsafe {
            let _ = PostMessageW(self.hwnd as HWND, WM_CLOSE, 0, 0);
        }
        let _ = thread.join();
    }
}

impl Drop for SystemWakeRelay {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run_relay_thread(app: AppHandle, startup_tx: mpsc::SyncSender<Result<isize, String>>) {
    let (hwnd, state, raw_state) = match unsafe { create_relay_window(app) } {
        Ok(created) => created,
        Err(error) => {
            let _ = startup_tx.send(Err(error.to_string()));
            return;
        }
    };

    if startup_tx.send(Ok(hwnd as isize)).is_err() {
        unsafe {
            let _ = DestroyWindow(hwnd);
            drop(Arc::from_raw(raw_state));
        }
        return;
    }

    unsafe {
        let mut message = MSG::default();
        loop {
            let status = GetMessageW(&mut message, null_mut(), 0, 0);
            if status <= 0 {
                break;
            }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        drop(Arc::from_raw(raw_state));
    }
    drop(state);
}

type RelayWindow = (
    HWND,
    Arc<Mutex<RelayWindowState>>,
    *const Mutex<RelayWindowState>,
);

unsafe fn create_relay_window(app: AppHandle) -> Result<RelayWindow> {
    let instance = GetModuleHandleW(null());
    if instance.is_null() {
        return Err(anyhow!(
            "resolve system wake relay module handle: {}",
            std::io::Error::last_os_error()
        ));
    }

    let class_name: Vec<u16> = "VibeLink.SystemWakeRelay\0".encode_utf16().collect();
    let window_class = WNDCLASSW {
        lpfnWndProc: Some(system_wake_window_proc),
        hInstance: instance,
        lpszClassName: class_name.as_ptr(),
        ..Default::default()
    };
    if RegisterClassW(&window_class) == 0 {
        return Err(anyhow!(
            "register system wake relay window class: {}",
            std::io::Error::last_os_error()
        ));
    }

    let state = Arc::new(Mutex::new(RelayWindowState {
        app,
        last_emitted_at: None,
        session_notifications_registered: false,
    }));
    let raw_state = Arc::into_raw(Arc::clone(&state));
    let window_name = [0u16];
    let hwnd = CreateWindowExW(
        0,
        class_name.as_ptr(),
        window_name.as_ptr(),
        0,
        0,
        0,
        0,
        0,
        HWND_MESSAGE,
        null_mut(),
        instance,
        raw_state.cast(),
    );
    if hwnd.is_null() {
        drop(Arc::from_raw(raw_state));
        return Err(anyhow!(
            "create system wake relay window: {}",
            std::io::Error::last_os_error()
        ));
    }

    let registered = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) != 0;
    if registered {
        if let Ok(mut state) = state.lock() {
            state.session_notifications_registered = true;
        }
    } else {
        eprintln!(
            "register Windows session-unlock notification: {}",
            std::io::Error::last_os_error()
        );
    }

    Ok((hwnd, state, raw_state))
}

unsafe extern "system" fn system_wake_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCCREATE {
        let create = lparam as *const CREATESTRUCTW;
        if !create.is_null() {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, (*create).lpCreateParams as isize);
        }
        return 1;
    }

    let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Mutex<RelayWindowState>;
    if is_system_wake_message(message, wparam) {
        if let Some(state) = state.as_ref() {
            emit_system_resumed(state);
        }
        return 1;
    }

    match message {
        WM_CLOSE => {
            let _ = DestroyWindow(hwnd);
            0
        }
        WM_DESTROY => {
            if let Some(state) = state.as_ref() {
                if let Ok(mut state) = state.lock() {
                    if state.session_notifications_registered {
                        let _ = WTSUnRegisterSessionNotification(hwnd);
                        state.session_notifications_registered = false;
                    }
                }
            }
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}

fn is_system_wake_message(message: u32, wparam: WPARAM) -> bool {
    (message == WM_POWERBROADCAST
        && matches!(wparam as u32, PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND))
        || (message == WM_WTSSESSION_CHANGE && wparam as u32 == WTS_SESSION_UNLOCK)
}

fn emit_system_resumed(state: &Mutex<RelayWindowState>) {
    let Ok(mut state) = state.lock() else {
        return;
    };
    let now = Instant::now();
    if !should_emit_wake(state.last_emitted_at, now) {
        return;
    }
    state.last_emitted_at = Some(now);
    if let Err(error) = state.app.emit(SYSTEM_RESUMED_EVENT, ()) {
        eprintln!("emit {SYSTEM_RESUMED_EVENT}: {error}");
    }
}

fn should_emit_wake(last_emitted_at: Option<Instant>, now: Instant) -> bool {
    match last_emitted_at {
        Some(last) => now.saturating_duration_since(last) >= WAKE_DEDUPE_WINDOW,
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_resume_and_session_unlock_messages() {
        assert!(is_system_wake_message(
            WM_POWERBROADCAST,
            PBT_APMRESUMEAUTOMATIC as WPARAM
        ));
        assert!(is_system_wake_message(
            WM_POWERBROADCAST,
            PBT_APMRESUMESUSPEND as WPARAM
        ));
        assert!(is_system_wake_message(
            WM_WTSSESSION_CHANGE,
            WTS_SESSION_UNLOCK as WPARAM
        ));
        assert!(!is_system_wake_message(WM_POWERBROADCAST, 0));
    }

    #[test]
    fn dedupes_wake_events_inside_two_seconds() {
        let first = Instant::now();
        assert!(should_emit_wake(None, first));
        assert!(!should_emit_wake(
            Some(first),
            first + Duration::from_millis(1999)
        ));
        assert!(should_emit_wake(
            Some(first),
            first + Duration::from_secs(2)
        ));
    }
}
