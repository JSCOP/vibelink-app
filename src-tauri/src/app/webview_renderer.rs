use std::{mem::size_of, ptr::null};
use windows_sys::Win32::{
    Graphics::Gdi::{
        EnumDisplayDevicesW, DISPLAY_DEVICEW, DISPLAY_DEVICE_ACTIVE,
        DISPLAY_DEVICE_MIRRORING_DRIVER, DISPLAY_DEVICE_REMOTE,
    },
    UI::WindowsAndMessaging::{GetSystemMetrics, SM_REMOTESESSION},
};

const RENDERER_PREFERENCE_ENV: &str = "VIBELINK_WEBVIEW_RENDERER";
const RESOLVED_RENDERER_ENV: &str = "VIBELINK_WEBVIEW_RENDERER_RESOLVED";
const WEBVIEW_ARGUMENTS_ENV: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
const SOFTWARE_RENDERING_FLAG: &str = "--disable-gpu";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RendererPreference {
    Auto,
    Hardware,
    Software,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ResolvedRenderer {
    Hardware,
    Software,
}

pub(crate) fn configure_main_webview() {
    let preference =
        RendererPreference::parse(std::env::var(RENDERER_PREFERENCE_ENV).ok().as_deref());
    let remote_session = unsafe { GetSystemMetrics(SM_REMOTESESSION) } != 0;
    let active_remote_adapter = active_display_state_flags()
        .iter()
        .any(|flags| display_requires_software_rendering(*flags));
    let renderer = resolve_renderer(preference, remote_session, active_remote_adapter);

    std::env::set_var(
        RESOLVED_RENDERER_ENV,
        match renderer {
            ResolvedRenderer::Hardware => "hardware",
            ResolvedRenderer::Software => "software",
        },
    );

    if renderer == ResolvedRenderer::Software {
        let existing = std::env::var(WEBVIEW_ARGUMENTS_ENV).unwrap_or_default();
        std::env::set_var(
            WEBVIEW_ARGUMENTS_ENV,
            append_unique_argument(&existing, SOFTWARE_RENDERING_FLAG),
        );
        let reason = match preference {
            RendererPreference::Software => "explicit software override",
            RendererPreference::Auto if remote_session => "remote Windows session",
            RendererPreference::Auto => "active remote or mirrored display adapter",
            RendererPreference::Hardware => {
                unreachable!("hardware override cannot resolve to software")
            }
        };
        eprintln!("WebView2 software rendering enabled: {reason}");
    }
}

pub(crate) fn append_resolved_renderer_argument(arguments: &str) -> String {
    if std::env::var(RESOLVED_RENDERER_ENV).as_deref() == Ok("software") {
        append_unique_argument(arguments, SOFTWARE_RENDERING_FLAG)
    } else {
        arguments.trim().to_string()
    }
}

impl RendererPreference {
    fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("hardware") => Self::Hardware,
            Some("software") => Self::Software,
            _ => Self::Auto,
        }
    }
}

fn resolve_renderer(
    preference: RendererPreference,
    remote_session: bool,
    active_remote_adapter: bool,
) -> ResolvedRenderer {
    match preference {
        RendererPreference::Hardware => ResolvedRenderer::Hardware,
        RendererPreference::Software => ResolvedRenderer::Software,
        RendererPreference::Auto if remote_session || active_remote_adapter => {
            ResolvedRenderer::Software
        }
        RendererPreference::Auto => ResolvedRenderer::Hardware,
    }
}

fn active_display_state_flags() -> Vec<u32> {
    let mut result = Vec::new();
    for index in 0..u32::MAX {
        let mut device = DISPLAY_DEVICEW::default();
        device.cb = size_of::<DISPLAY_DEVICEW>() as u32;
        if unsafe { EnumDisplayDevicesW(null(), index, &mut device, 0) } == 0 {
            break;
        }
        if device.StateFlags & DISPLAY_DEVICE_ACTIVE != 0 {
            result.push(device.StateFlags);
        }
    }
    result
}

fn display_requires_software_rendering(state_flags: u32) -> bool {
    state_flags & (DISPLAY_DEVICE_REMOTE | DISPLAY_DEVICE_MIRRORING_DRIVER) != 0
}

fn append_unique_argument(arguments: &str, argument: &str) -> String {
    let trimmed = arguments.trim();
    if trimmed.split_whitespace().any(|item| item == argument) {
        return trimmed.to_string();
    }
    if trimmed.is_empty() {
        argument.to_string()
    } else {
        format!("{trimmed} {argument}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_uses_software_for_remote_rendering_paths() {
        assert_eq!(
            resolve_renderer(RendererPreference::Auto, true, false),
            ResolvedRenderer::Software
        );
        assert_eq!(
            resolve_renderer(RendererPreference::Auto, false, true),
            ResolvedRenderer::Software
        );
    }

    #[test]
    fn explicit_preference_overrides_display_detection() {
        assert_eq!(
            resolve_renderer(RendererPreference::Hardware, true, true),
            ResolvedRenderer::Hardware
        );
        assert_eq!(
            resolve_renderer(RendererPreference::Software, false, false),
            ResolvedRenderer::Software
        );
    }

    #[test]
    fn remote_and_mirroring_flags_are_detected() {
        assert!(display_requires_software_rendering(DISPLAY_DEVICE_REMOTE));
        assert!(display_requires_software_rendering(
            DISPLAY_DEVICE_ACTIVE | DISPLAY_DEVICE_MIRRORING_DRIVER
        ));
        assert!(!display_requires_software_rendering(DISPLAY_DEVICE_ACTIVE));
    }

    #[test]
    fn browser_arguments_are_preserved_without_duplicates() {
        assert_eq!(
            append_unique_argument("--remote-debugging-port=9334", SOFTWARE_RENDERING_FLAG),
            "--remote-debugging-port=9334 --disable-gpu"
        );
        assert_eq!(
            append_unique_argument(
                "--remote-debugging-port=9334 --disable-gpu",
                SOFTWARE_RENDERING_FLAG
            ),
            "--remote-debugging-port=9334 --disable-gpu"
        );
    }
}
