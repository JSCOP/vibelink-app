const RESOLVED_RENDERER_ENV: &str = "VIBELINK_WEBVIEW_RENDERER_RESOLVED";
const WEBVIEW_ARGUMENTS_ENV: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
const SOFTWARE_RENDERING_FLAG: &str = "--disable-gpu";

pub(crate) fn configure_main_webview() {
    std::env::set_var(RESOLVED_RENDERER_ENV, "hardware");

    let existing = std::env::var(WEBVIEW_ARGUMENTS_ENV).unwrap_or_default();
    std::env::set_var(
        WEBVIEW_ARGUMENTS_ENV,
        strip_software_renderer_argument(&existing),
    );
}

pub(crate) fn resolved_renderer_mode() -> &'static str {
    "hardware"
}

fn strip_software_renderer_argument(arguments: &str) -> String {
    arguments
        .split_whitespace()
        .filter(|argument| *argument != SOFTWARE_RENDERING_FLAG)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::strip_software_renderer_argument;

    #[test]
    fn software_renderer_argument_is_stripped() {
        assert_eq!(strip_software_renderer_argument(""), "");
        assert_eq!(
            strip_software_renderer_argument("--remote-debugging-port=9333"),
            "--remote-debugging-port=9333"
        );
        assert_eq!(
            strip_software_renderer_argument("--disable-gpu --remote-debugging-port=9333"),
            "--remote-debugging-port=9333"
        );
        assert_eq!(
            strip_software_renderer_argument("--remote-debugging-port=9333 --disable-gpu"),
            "--remote-debugging-port=9333"
        );
    }
}
