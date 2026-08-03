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
    let renderer = resolve_renderer(preference);

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
        let reason = "explicit software override";
        eprintln!("WebView2 software rendering enabled: {reason}");
    }
}

pub(crate) fn resolved_renderer_mode() -> &'static str {
    match std::env::var(RESOLVED_RENDERER_ENV).ok().as_deref() {
        Some("software") => "software",
        _ => "hardware",
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

fn resolve_renderer(preference: RendererPreference) -> ResolvedRenderer {
    match preference {
        RendererPreference::Software => ResolvedRenderer::Software,
        RendererPreference::Auto | RendererPreference::Hardware => ResolvedRenderer::Hardware,
    }
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
    fn auto_keeps_hardware_acceleration() {
        assert_eq!(
            resolve_renderer(RendererPreference::Auto),
            ResolvedRenderer::Hardware
        );
    }

    #[test]
    fn explicit_preference_selects_the_renderer() {
        assert_eq!(
            resolve_renderer(RendererPreference::Hardware),
            ResolvedRenderer::Hardware
        );
        assert_eq!(
            resolve_renderer(RendererPreference::Software),
            ResolvedRenderer::Software
        );
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
