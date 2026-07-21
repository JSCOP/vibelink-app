#![cfg(windows)]

use crate::computer_use::{
    ActionMethod, AppRecord, BackendError, BackendErrorKind, ComputerAction, ComputerBackend,
    ElementRecord, IntegrityLevel, Point, ProviderCapability, RawSnapshot, Rect,
    ScreenshotArtifact, SemanticAction, SnapshotLimits, SnapshotTruncation, WindowIdentity,
};
use std::{
    collections::{HashMap, VecDeque},
    ffi::c_void,
    fs,
    mem::size_of,
    path::PathBuf,
};
use uuid::Uuid;
use windows::{
    core::{BOOL, BSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, FILETIME, HANDLE, HWND, LPARAM, RECT},
        Security::{
            GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel,
            TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
        },
        System::{
            Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED},
            Ole::{SafeArrayDestroy, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound},
            Threading::{
                GetCurrentProcess, GetProcessTimes, OpenProcess, OpenProcessToken,
                QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::{
            Accessibility::{
                CUIAutomation8, IUIAutomation, IUIAutomationElement,
                IUIAutomationExpandCollapsePattern, IUIAutomationInvokePattern,
                IUIAutomationLegacyIAccessiblePattern, IUIAutomationRangeValuePattern,
                IUIAutomationScrollPattern, IUIAutomationSelectionItemPattern,
                IUIAutomationTogglePattern, IUIAutomationValuePattern, ScrollAmount,
                UIA_ButtonControlTypeId, UIA_CheckBoxControlTypeId, UIA_ComboBoxControlTypeId,
                UIA_EditControlTypeId, UIA_ExpandCollapsePatternId, UIA_InvokePatternId,
                UIA_LegacyIAccessiblePatternId, UIA_ListItemControlTypeId,
                UIA_MenuItemControlTypeId, UIA_RangeValuePatternId, UIA_ScrollPatternId,
                UIA_SelectionItemPatternId, UIA_SliderControlTypeId, UIA_TabItemControlTypeId,
                UIA_TextControlTypeId, UIA_TogglePatternId, UIA_TreeItemControlTypeId,
                UIA_ValuePatternId,
            },
            Input::KeyboardAndMouse::{
                SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
                KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN,
                MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
                MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, VIRTUAL_KEY,
            },
            WindowsAndMessaging::{
                EnumWindows, GetSystemMetrics, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
                GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow,
                SetWindowPos, ShowWindow, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
                SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
                SW_RESTORE, WHEEL_DELTA,
            },
        },
    },
};

const MAX_SCREENSHOT_HISTORY: usize = 16;
type ElementCacheKey = (u64, u64, Vec<i32>);

pub struct WindowsComputerBackend {
    automation: IUIAutomation,
    artifact_root: PathBuf,
    provider_integrity: IntegrityLevel,
    element_cache: HashMap<ElementCacheKey, IUIAutomationElement>,
    screenshot_history: VecDeque<PathBuf>,
}

impl WindowsComputerBackend {
    pub fn new(artifact_root: PathBuf) -> Result<Self, BackendError> {
        fs::create_dir_all(&artifact_root).map_err(|error| backend_internal(error.to_string()))?;
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(map_windows_error)?;
        let automation = unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }
            .map_err(map_windows_error)?;
        let provider_integrity = process_integrity(unsafe { GetCurrentProcess() })?;
        Ok(Self {
            automation,
            artifact_root,
            provider_integrity,
            element_cache: HashMap::new(),
            screenshot_history: VecDeque::new(),
        })
    }

    fn element(
        &self,
        window: &WindowIdentity,
        runtime_id: &[i32],
    ) -> Result<&IUIAutomationElement, BackendError> {
        self.element_cache
            .get(&(window.handle, window.generation, runtime_id.to_vec()))
            .ok_or_else(|| {
                BackendError::new(
                    BackendErrorKind::StaleElement,
                    "UI Automation element is no longer present in the live snapshot cache",
                )
            })
    }

    fn retain_screenshot(&mut self, path: PathBuf) {
        retain_screenshot_path(&mut self.screenshot_history, path);
    }
}

fn retain_screenshot_path(history: &mut VecDeque<PathBuf>, path: PathBuf) {
    history.push_back(path);
    while history.len() > MAX_SCREENSHOT_HISTORY {
        if let Some(expired) = history.pop_front() {
            let _ = fs::remove_file(expired);
        }
    }
}

impl ComputerBackend for WindowsComputerBackend {
    fn capabilities(&self) -> Vec<ProviderCapability> {
        vec![
            ProviderCapability::Observe,
            ProviderCapability::Control,
            ProviderCapability::Screenshots,
            ProviderCapability::SemanticActions,
            ProviderCapability::CoordinateFallback,
            ProviderCapability::RestoreWindow,
            ProviderCapability::ClipboardPaste,
        ]
    }

    fn provider_integrity(&self) -> IntegrityLevel {
        self.provider_integrity
    }

    fn list_apps(&mut self) -> Result<Vec<AppRecord>, BackendError> {
        let windows = enumerate_windows()?;
        let mut apps = HashMap::<u32, AppRecord>::new();
        for window in windows {
            let entry = apps.entry(window.process_id).or_insert_with(|| AppRecord {
                identity: window.app_identity(),
                display_name: window.executable_name.clone(),
                window_count: 0,
                blocked: false,
            });
            entry.window_count = entry.window_count.saturating_add(1);
        }
        let mut apps = apps.into_values().collect::<Vec<_>>();
        apps.sort_by(|left, right| {
            left.display_name
                .to_ascii_lowercase()
                .cmp(&right.display_name.to_ascii_lowercase())
                .then_with(|| left.identity.process_id.cmp(&right.identity.process_id))
        });
        Ok(apps)
    }

    fn list_windows(
        &mut self,
        process_id: Option<u32>,
    ) -> Result<Vec<WindowIdentity>, BackendError> {
        let mut windows = enumerate_windows()?;
        if let Some(process_id) = process_id {
            windows.retain(|window| window.process_id == process_id);
        }
        Ok(windows)
    }

    fn current_window(&mut self, window: &WindowIdentity) -> Result<WindowIdentity, BackendError> {
        current_window_identity(window.handle)
    }

    fn restore_window(&mut self, window: &WindowIdentity) -> Result<(), BackendError> {
        let hwnd = hwnd(window.handle);
        unsafe {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            SetWindowPos(
                hwnd,
                None,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER,
            )
            .map_err(map_windows_error)?;
        }
        Ok(())
    }

    fn snapshot_window(
        &mut self,
        window: &WindowIdentity,
        limits: SnapshotLimits,
    ) -> Result<RawSnapshot, BackendError> {
        let current_window = current_window_identity(window.handle)?;
        if current_window.process_id != window.process_id {
            return Err(BackendError::new(
                BackendErrorKind::StaleElement,
                "window handle now belongs to a different process",
            ));
        }
        let root = unsafe { self.automation.ElementFromHandle(hwnd(window.handle)) }
            .map_err(map_windows_error)?;
        let walker = unsafe { self.automation.ControlViewWalker() }.map_err(map_windows_error)?;
        self.element_cache
            .retain(|(handle, _, _), _| *handle != current_window.handle);

        let mut state = SnapshotBuildState {
            elements: Vec::new(),
            tree_lines: Vec::new(),
            focused_summary: None,
            selected_text: None,
            truncation: SnapshotTruncation::default(),
            max_nodes: limits.max_nodes.max(1) as usize,
            max_depth: limits.max_depth.max(1) as usize,
        };
        walk_element(
            &walker,
            &root,
            &current_window,
            0,
            &mut state,
            &mut self.element_cache,
        )?;

        Ok(RawSnapshot {
            window: current_window,
            tree_lines: state.tree_lines,
            focused_summary: state.focused_summary,
            selected_text: state.selected_text,
            elements: state.elements,
            truncation: state.truncation,
        })
    }

    fn capture_window(
        &mut self,
        window: &WindowIdentity,
        redactions: &[Rect],
    ) -> Result<ScreenshotArtifact, BackendError> {
        let source = xcap::Window::all()
            .map_err(|error| {
                BackendError::new(BackendErrorKind::ProtectedContent, error.to_string())
            })?
            .into_iter()
            .find(|candidate| {
                candidate
                    .id()
                    .ok()
                    .is_some_and(|id| u64::from(id) == window.handle)
            })
            .ok_or_else(|| {
                BackendError::new(BackendErrorKind::StaleElement, "capture window is stale")
            })?;
        let mut image = source.capture_image().map_err(|error| {
            BackendError::new(
                BackendErrorKind::ProtectedContent,
                format!("window capture is unavailable or protected: {error}"),
            )
        })?;
        let width = image.width();
        let height = image.height();
        for redaction in redactions {
            let left = redaction.left.max(0).min(width as i32) as u32;
            let top = redaction.top.max(0).min(height as i32) as u32;
            let right = redaction.right.max(0).min(width as i32) as u32;
            let bottom = redaction.bottom.max(0).min(height as i32) as u32;
            for y in top..bottom {
                for x in left..right {
                    image.put_pixel(x, y, [0, 0, 0, 255].into());
                }
            }
        }
        let path = self
            .artifact_root
            .join(format!("computer-{}.png", Uuid::new_v4()));
        image
            .save(&path)
            .map_err(|error| backend_internal(format!("write screenshot artifact: {error}")))?;
        self.retain_screenshot(path.clone());
        Ok(ScreenshotArtifact {
            path: path.to_string_lossy().into_owned(),
            width,
            height,
            format: "png".to_string(),
        })
    }

    fn semantic_action(
        &mut self,
        _window: &WindowIdentity,
        runtime_id: &[i32],
        semantic: SemanticAction,
        action: &ComputerAction,
    ) -> Result<(), BackendError> {
        let element = self.element(_window, runtime_id)?.clone();
        unsafe {
            match semantic {
                SemanticAction::Invoke => element
                    .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                    .and_then(|pattern| pattern.Invoke()),
                SemanticAction::Value => {
                    let value = match action {
                        ComputerAction::TypeText { text }
                        | ComputerAction::PasteText { text }
                        | ComputerAction::SetValue { value: text } => text,
                        _ => return Err(unsupported("value pattern requires text")),
                    };
                    let value = BSTR::from(value.as_str());
                    element
                        .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                        .and_then(|pattern| pattern.SetValue(&value))
                }
                SemanticAction::Toggle => element
                    .GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                    .and_then(|pattern| pattern.Toggle()),
                SemanticAction::SelectionItem => element
                    .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                        UIA_SelectionItemPatternId,
                    )
                    .and_then(|pattern| pattern.Select()),
                SemanticAction::ExpandCollapse => {
                    let pattern = element
                        .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                            UIA_ExpandCollapsePatternId,
                        )
                        .map_err(map_windows_error)?;
                    match action {
                        ComputerAction::Expand => pattern.Expand(),
                        ComputerAction::Collapse => pattern.Collapse(),
                        _ => Err(windows::core::Error::new(
                            windows::core::HRESULT(0x8007_0057_u32 as i32),
                            "expand/collapse action mismatch",
                        )),
                    }
                }
                SemanticAction::Scroll => {
                    let (delta_x, delta_y) = match action {
                        ComputerAction::Scroll { delta_x, delta_y } => (*delta_x, *delta_y),
                        _ => return Err(unsupported("scroll pattern requires scroll deltas")),
                    };
                    let horizontal = scroll_amount(delta_x);
                    let vertical = scroll_amount(delta_y);
                    element
                        .GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
                        .and_then(|pattern| pattern.Scroll(horizontal, vertical))
                }
                SemanticAction::RangeValue => {
                    let value = match action {
                        ComputerAction::SetRangeValue { value } => *value as f64,
                        _ => return Err(unsupported("range pattern requires a numeric value")),
                    };
                    element
                        .GetCurrentPatternAs::<IUIAutomationRangeValuePattern>(
                            UIA_RangeValuePatternId,
                        )
                        .and_then(|pattern| pattern.SetValue(value))
                }
                SemanticAction::LegacyDefaultAction => element
                    .GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(
                        UIA_LegacyIAccessiblePatternId,
                    )
                    .and_then(|pattern| pattern.DoDefaultAction()),
                SemanticAction::SecondaryAction => {
                    return Err(unsupported(
                        "UI Automation has no generic secondary-action pattern",
                    ))
                }
            }
        }
        .map_err(map_windows_error)
    }

    fn coordinate_action(
        &mut self,
        window: &WindowIdentity,
        point: Point,
        action: &ComputerAction,
    ) -> Result<ActionMethod, BackendError> {
        unsafe {
            let _ = SetForegroundWindow(hwnd(window.handle));
        }
        let screen_point = Point {
            x: window.bounds.left.saturating_add(point.x),
            y: window.bounds.top.saturating_add(point.y),
        };
        move_pointer(screen_point)?;
        match action {
            ComputerAction::Click => mouse_click(false)?,
            ComputerAction::Invoke => {
                return Err(unsupported(
                    "invoke requires a semantic UI Automation pattern",
                ));
            }
            ComputerAction::SecondaryAction => mouse_click(true)?,
            ComputerAction::Scroll { delta_y, .. } => mouse_wheel(*delta_y)?,
            ComputerAction::Drag { to } => {
                let screen_to = Point {
                    x: window.bounds.left.saturating_add(to.x),
                    y: window.bounds.top.saturating_add(to.y),
                };
                mouse_drag(screen_point, screen_to)?;
            }
            ComputerAction::TypeText { text } => {
                mouse_click(false)?;
                type_unicode(text)?;
                return Ok(ActionMethod::Keyboard);
            }
            ComputerAction::PasteText { text } => {
                let mut clipboard = arboard::Clipboard::new()
                    .map_err(|error| backend_internal(format!("open clipboard: {error}")))?;
                clipboard
                    .set_text(text)
                    .map_err(|error| backend_internal(format!("set clipboard text: {error}")))?;
                mouse_click(false)?;
                send_virtual_key_chord(&[0x11, 0x56])?;
                return Ok(ActionMethod::Keyboard);
            }
            ComputerAction::PressKey { key } => {
                mouse_click(false)?;
                send_named_key(key)?;
                return Ok(ActionMethod::Keyboard);
            }
            ComputerAction::Hotkey { keys } => {
                mouse_click(false)?;
                let virtual_keys = keys
                    .iter()
                    .map(|key| virtual_key(key))
                    .collect::<Result<Vec<_>, _>>()?;
                send_virtual_key_chord(&virtual_keys)?;
                return Ok(ActionMethod::Keyboard);
            }
            ComputerAction::Toggle
            | ComputerAction::Select
            | ComputerAction::Expand
            | ComputerAction::Collapse => mouse_click(false)?,
            ComputerAction::SetValue { .. } | ComputerAction::SetRangeValue { .. } => {
                return Err(unsupported("unsafe coordinate fallback for value mutation"));
            }
            ComputerAction::Approved { .. } => {
                return Err(backend_internal(
                    "approved action wrapper reached the Windows backend",
                ));
            }
        }
        Ok(ActionMethod::Coordinate)
    }
}

struct SnapshotBuildState {
    elements: Vec<ElementRecord>,
    tree_lines: Vec<String>,
    focused_summary: Option<String>,
    selected_text: Option<String>,
    truncation: SnapshotTruncation,
    max_nodes: usize,
    max_depth: usize,
}

fn walk_element(
    walker: &windows::Win32::UI::Accessibility::IUIAutomationTreeWalker,
    element: &IUIAutomationElement,
    window: &WindowIdentity,
    depth: usize,
    state: &mut SnapshotBuildState,
    cache: &mut HashMap<ElementCacheKey, IUIAutomationElement>,
) -> Result<(), BackendError> {
    if state.elements.len() >= state.max_nodes {
        state.truncation.node_limit_reached = true;
        state.truncation.omitted_nodes = state.truncation.omitted_nodes.saturating_add(1);
        return Ok(());
    }
    if depth > state.max_depth {
        state.truncation.depth_limit_reached = true;
        state.truncation.omitted_nodes = state.truncation.omitted_nodes.saturating_add(1);
        return Ok(());
    }

    let record = element_record(element, state.elements.len() as u32, window.bounds)?;
    if record.focused {
        state.focused_summary = Some(format!("{} {}", record.role, record.name));
    }
    state.tree_lines.push(format!(
        "{}[{}] {} \"{}\"",
        "  ".repeat(depth),
        record.index,
        record.role,
        record.name
    ));
    cache.insert(
        (window.handle, window.generation, record.runtime_id.clone()),
        element.clone(),
    );
    state.elements.push(record);

    let mut child = unsafe { walker.GetFirstChildElement(element) }.ok();
    while let Some(current) = child {
        walk_element(walker, &current, window, depth + 1, state, cache)?;
        child = unsafe { walker.GetNextSiblingElement(&current) }.ok();
    }
    Ok(())
}

fn element_record(
    element: &IUIAutomationElement,
    index: u32,
    window_bounds: Rect,
) -> Result<ElementRecord, BackendError> {
    let name = unsafe { element.CurrentName() }
        .map(|value| value.to_string())
        .unwrap_or_default();
    let control_type = unsafe { element.CurrentControlType() }.map_err(map_windows_error)?;
    let role = control_type_name(control_type.0).to_string();
    let password = unsafe { element.CurrentIsPassword() }
        .map(|value| value.as_bool())
        .unwrap_or(false);
    let enabled = unsafe { element.CurrentIsEnabled() }
        .map(|value| value.as_bool())
        .unwrap_or(false);
    let offscreen = unsafe { element.CurrentIsOffscreen() }
        .map(|value| value.as_bool())
        .unwrap_or(true);
    let focused = unsafe { element.CurrentHasKeyboardFocus() }
        .map(|value| value.as_bool())
        .unwrap_or(false);
    let bounds = unsafe { element.CurrentBoundingRectangle() }
        .ok()
        .map(rect_from_windows)
        .map(|bounds| Rect {
            left: bounds.left.saturating_sub(window_bounds.left),
            top: bounds.top.saturating_sub(window_bounds.top),
            right: bounds.right.saturating_sub(window_bounds.left),
            bottom: bounds.bottom.saturating_sub(window_bounds.top),
        })
        .filter(|bounds| bounds.is_visible());
    let runtime_id = runtime_id(element)?;
    let supported_actions = supported_actions(element);
    let value = if password {
        None
    } else {
        unsafe {
            element
                .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .and_then(|pattern| pattern.CurrentValue())
                .ok()
                .map(|value| value.to_string())
        }
    };
    Ok(ElementRecord {
        index,
        runtime_id,
        role,
        name,
        value,
        bounds,
        enabled,
        offscreen,
        focused,
        password,
        redacted: false,
        supported_actions,
    })
}

fn supported_actions(element: &IUIAutomationElement) -> Vec<SemanticAction> {
    let mut actions = Vec::new();
    unsafe {
        if element
            .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
            .is_ok()
        {
            actions.push(SemanticAction::Invoke);
        }
        if element
            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .is_ok()
        {
            actions.push(SemanticAction::Value);
        }
        if element
            .GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
            .is_ok()
        {
            actions.push(SemanticAction::Toggle);
        }
        if element
            .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
            .is_ok()
        {
            actions.push(SemanticAction::SelectionItem);
        }
        if element
            .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
            .is_ok()
        {
            actions.push(SemanticAction::ExpandCollapse);
        }
        if element
            .GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
            .is_ok()
        {
            actions.push(SemanticAction::Scroll);
        }
        if element
            .GetCurrentPatternAs::<IUIAutomationRangeValuePattern>(UIA_RangeValuePatternId)
            .is_ok()
        {
            actions.push(SemanticAction::RangeValue);
        }
        if element
            .GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(
                UIA_LegacyIAccessiblePatternId,
            )
            .is_ok()
        {
            actions.push(SemanticAction::LegacyDefaultAction);
        }
    }
    actions
}

fn runtime_id(element: &IUIAutomationElement) -> Result<Vec<i32>, BackendError> {
    let array = unsafe { element.GetRuntimeId() }.map_err(map_windows_error)?;
    if array.is_null() {
        return Err(BackendError::new(
            BackendErrorKind::StaleElement,
            "UI Automation element has no runtime id",
        ));
    }
    let result = (|| {
        let lower = unsafe { SafeArrayGetLBound(array, 1) }.map_err(map_windows_error)?;
        let upper = unsafe { SafeArrayGetUBound(array, 1) }.map_err(map_windows_error)?;
        let mut values = Vec::with_capacity(upper.saturating_sub(lower).saturating_add(1) as usize);
        for index in lower..=upper {
            let mut value = 0_i32;
            unsafe { SafeArrayGetElement(array, &index, &mut value as *mut i32 as *mut c_void) }
                .map_err(map_windows_error)?;
            values.push(value);
        }
        Ok(values)
    })();
    let _ = unsafe { SafeArrayDestroy(array) };
    result
}

fn enumerate_windows() -> Result<Vec<WindowIdentity>, BackendError> {
    unsafe extern "system" fn callback(hwnd: HWND, parameter: LPARAM) -> BOOL {
        let records = &mut *(parameter.0 as *mut Vec<WindowIdentity>);
        if !IsWindowVisible(hwnd).as_bool() || GetWindowTextLengthW(hwnd) <= 0 {
            return BOOL(1);
        }
        if let Ok(record) = window_identity(hwnd) {
            records.push(record);
        }
        BOOL(1)
    }

    let mut records: Vec<WindowIdentity> = Vec::new();
    unsafe {
        EnumWindows(
            Some(callback),
            LPARAM((&mut records as *mut Vec<WindowIdentity>) as isize),
        )
        .map_err(map_windows_error)?;
    }
    records.sort_by(|left, right| {
        left.title
            .to_ascii_lowercase()
            .cmp(&right.title.to_ascii_lowercase())
    });
    Ok(records)
}

fn current_window_identity(handle: u64) -> Result<WindowIdentity, BackendError> {
    window_identity(hwnd(handle))
}

fn window_identity(hwnd: HWND) -> Result<WindowIdentity, BackendError> {
    let title_len = unsafe { GetWindowTextLengthW(hwnd) };
    let mut title = vec![0_u16; title_len.max(0) as usize + 1];
    let copied = unsafe { GetWindowTextW(hwnd, &mut title) };
    title.truncate(copied.max(0) as usize);
    let title = String::from_utf16_lossy(&title);
    let mut process_id = 0_u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };
    if process_id == 0 {
        return Err(backend_internal("window has no process id"));
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }
        .map_err(map_windows_error)?;
    let result = (|| {
        let executable_path = process_path(process)?;
        let executable_name = PathBuf::from(&executable_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("unknown.exe")
            .to_string();
        let mut bounds = RECT::default();
        unsafe { GetWindowRect(hwnd, &mut bounds) }.map_err(map_windows_error)?;
        let integrity = process_integrity(process)?;
        let generation = process_generation(process)?;
        Ok(WindowIdentity {
            handle: hwnd.0 as usize as u64,
            process_id,
            generation,
            title,
            executable_name,
            bounds: rect_from_windows(bounds),
            visible: unsafe { IsWindowVisible(hwnd) }.as_bool(),
            minimized: unsafe { IsIconic(hwnd) }.as_bool(),
            integrity,
        })
    })();
    unsafe { CloseHandle(process) }.ok();
    result
}

fn process_path(process: HANDLE) -> Result<String, BackendError> {
    let mut buffer = vec![0_u16; 32_768];
    let mut len = buffer.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut len,
        )
    }
    .map_err(map_windows_error)?;
    buffer.truncate(len as usize);
    Ok(String::from_utf16_lossy(&buffer))
}

fn process_generation(process: HANDLE) -> Result<u64, BackendError> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) }
        .map_err(map_windows_error)?;
    Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
}

fn process_integrity(process: HANDLE) -> Result<IntegrityLevel, BackendError> {
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.map_err(map_windows_error)?;
    let result = (|| {
        let mut required = 0_u32;
        let _ = unsafe { GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut required) };
        if required < size_of::<TOKEN_MANDATORY_LABEL>() as u32 {
            return Err(backend_internal(
                "integrity token information is unavailable",
            ));
        }
        let mut storage = vec![0_u8; required as usize];
        unsafe {
            GetTokenInformation(
                token,
                TokenIntegrityLevel,
                Some(storage.as_mut_ptr().cast()),
                required,
                &mut required,
            )
        }
        .map_err(map_windows_error)?;
        let label = unsafe { &*(storage.as_ptr() as *const TOKEN_MANDATORY_LABEL) };
        let count = unsafe { *GetSidSubAuthorityCount(label.Label.Sid) } as u32;
        if count == 0 {
            return Ok(IntegrityLevel::Unknown);
        }
        let rid = unsafe { *GetSidSubAuthority(label.Label.Sid, count - 1) };
        Ok(match rid {
            0x0000..=0x0fff => IntegrityLevel::Low,
            0x1000..=0x2fff => IntegrityLevel::Medium,
            0x3000..=0x3fff => IntegrityLevel::High,
            0x4000.. => IntegrityLevel::System,
        })
    })();
    unsafe { CloseHandle(token) }.ok();
    result
}

fn rect_from_windows(rect: RECT) -> Rect {
    Rect {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    }
}

fn hwnd(handle: u64) -> HWND {
    HWND(handle as usize as *mut c_void)
}

fn control_type_name(control_type: i32) -> &'static str {
    match control_type {
        value if value == UIA_ButtonControlTypeId.0 => "button",
        value if value == UIA_CheckBoxControlTypeId.0 => "checkbox",
        value if value == UIA_ComboBoxControlTypeId.0 => "combobox",
        value if value == UIA_EditControlTypeId.0 => "edit",
        value if value == UIA_ListItemControlTypeId.0 => "listitem",
        value if value == UIA_MenuItemControlTypeId.0 => "menuitem",
        value if value == UIA_SliderControlTypeId.0 => "slider",
        value if value == UIA_TabItemControlTypeId.0 => "tab",
        value if value == UIA_TextControlTypeId.0 => "text",
        value if value == UIA_TreeItemControlTypeId.0 => "treeitem",
        _ => "control",
    }
}

fn scroll_amount(delta: i32) -> ScrollAmount {
    use windows::Win32::UI::Accessibility::{
        ScrollAmount_LargeDecrement, ScrollAmount_LargeIncrement, ScrollAmount_NoAmount,
    };
    match delta.cmp(&0) {
        std::cmp::Ordering::Less => ScrollAmount_LargeDecrement,
        std::cmp::Ordering::Equal => ScrollAmount_NoAmount,
        std::cmp::Ordering::Greater => ScrollAmount_LargeIncrement,
    }
}

fn move_pointer(point: Point) -> Result<(), BackendError> {
    let origin_x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let origin_y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) }.max(1);
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) }.max(1);
    let normalized_x = ((point.x - origin_x) as i64 * 65_535 / i64::from(width - 1).max(1)) as i32;
    let normalized_y = ((point.y - origin_y) as i64 * 65_535 / i64::from(height - 1).max(1)) as i32;
    send_mouse(
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        normalized_x,
        normalized_y,
        0,
    )
}

fn mouse_click(secondary: bool) -> Result<(), BackendError> {
    let (down, up) = if secondary {
        (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
    } else {
        (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
    };
    send_mouse(down, 0, 0, 0)?;
    send_mouse(up, 0, 0, 0)
}

fn mouse_wheel(delta: i32) -> Result<(), BackendError> {
    let clicks = delta.clamp(-10, 10);
    send_mouse(
        MOUSEEVENTF_WHEEL,
        0,
        0,
        clicks.saturating_mul(WHEEL_DELTA as i32) as u32,
    )
}

fn mouse_drag(from: Point, to: Point) -> Result<(), BackendError> {
    move_pointer(from)?;
    send_mouse(MOUSEEVENTF_LEFTDOWN, 0, 0, 0)?;
    let move_result = move_pointer(to);
    let up_result = send_mouse(MOUSEEVENTF_LEFTUP, 0, 0, 0);
    move_result.and(up_result)
}

fn send_mouse(
    flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS,
    dx: i32,
    dy: i32,
    data: u32,
) -> Result<(), BackendError> {
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    send_inputs(&[input])
}

fn type_unicode(text: &str) -> Result<(), BackendError> {
    let mut inputs = Vec::with_capacity(text.encode_utf16().count() * 2);
    for unit in text.encode_utf16() {
        inputs.push(keyboard_input(0, unit, KEYEVENTF_UNICODE));
        inputs.push(keyboard_input(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }
    send_inputs(&inputs)
}

fn send_named_key(key: &str) -> Result<(), BackendError> {
    let virtual_key = virtual_key(key)?;
    send_virtual_key_chord(&[virtual_key])
}

fn send_virtual_key_chord(keys: &[u16]) -> Result<(), BackendError> {
    let mut inputs = Vec::with_capacity(keys.len() * 2);
    for key in keys {
        inputs.push(keyboard_input(*key, 0, Default::default()));
    }
    for key in keys.iter().rev() {
        inputs.push(keyboard_input(*key, 0, KEYEVENTF_KEYUP));
    }
    send_inputs(&inputs)
}

fn keyboard_input(
    virtual_key: u16,
    scan: u16,
    flags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS,
) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(virtual_key),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn send_inputs(inputs: &[INPUT]) -> Result<(), BackendError> {
    let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
    if sent != inputs.len() as u32 {
        return Err(BackendError::new(
            BackendErrorKind::AccessDenied,
            "SendInput was blocked by Windows UIPI or the target desktop",
        ));
    }
    Ok(())
}

fn virtual_key(name: &str) -> Result<u16, BackendError> {
    let normalized = name.trim().to_ascii_lowercase();
    let value = match normalized.as_str() {
        "ctrl" | "control" => 0x11,
        "shift" => 0x10,
        "alt" => 0x12,
        "enter" | "return" => 0x0d,
        "tab" => 0x09,
        "escape" | "esc" => 0x1b,
        "backspace" => 0x08,
        "delete" => 0x2e,
        "space" => 0x20,
        "left" => 0x25,
        "up" => 0x26,
        "right" => 0x27,
        "down" => 0x28,
        value if value.len() == 1 => value.as_bytes()[0].to_ascii_uppercase() as u16,
        _ => return Err(unsupported(format!("unknown key: {name}"))),
    };
    Ok(value)
}

fn map_windows_error(error: windows::core::Error) -> BackendError {
    let code = error.code().0;
    let kind = match code as u32 {
        0x8007_0005 => BackendErrorKind::AccessDenied,
        0x8004_0201 => BackendErrorKind::StaleElement,
        0x8007_0057 => BackendErrorKind::InvalidArgument,
        _ => BackendErrorKind::Internal,
    };
    BackendError::new(kind, error.to_string()).with_os_code(code)
}

fn unsupported(message: impl Into<String>) -> BackendError {
    BackendError::new(BackendErrorKind::Unsupported, message)
}

fn backend_internal(message: impl Into<String>) -> BackendError {
    BackendError::new(BackendErrorKind::Internal, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screenshot_history_removes_oldest_artifacts_at_bound() {
        let root = std::env::temp_dir().join(format!(
            "vibelink-computer-screenshot-history-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create screenshot test directory");
        let mut history = VecDeque::new();
        let mut paths = Vec::new();
        for index in 0..(MAX_SCREENSHOT_HISTORY + 2) {
            let path = root.join(format!("computer-{index}.png"));
            fs::write(&path, [index as u8]).expect("write screenshot fixture");
            retain_screenshot_path(&mut history, path.clone());
            paths.push(path);
        }
        assert_eq!(history.len(), MAX_SCREENSHOT_HISTORY);
        assert!(!paths[0].exists());
        assert!(!paths[1].exists());
        assert!(paths[2..].iter().all(|path| path.exists()));
        fs::remove_dir_all(root).expect("remove screenshot test directory");
    }
}
