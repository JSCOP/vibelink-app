use std::ops::Range;

pub const DEV_VITE_PORT_START: u16 = 1_420;
pub const DEV_VITE_PORT_END: u16 = 1_439;
pub const PROD_MAIN_WEBVIEW_CDP_PORT: u16 = 9_333;
pub const DEV_MAIN_WEBVIEW_CDP_PORT: u16 = 19_333;
pub const DEV_MAIN_WEBVIEW_CDP_PORT_END: u16 = 19_363;
pub const PROD_BROWSER_PROFILE_PORT_START: u16 = 9_334;
pub const DEV_BROWSER_PROFILE_PORT_START: u16 = 19_400;
pub const BROWSER_PROFILE_PORT_CAPACITY: u16 = 256;
pub const PROD_REMOTE_PORT: u16 = 42_811;
pub const DEV_REMOTE_PORT: u16 = 42_812;

pub const fn main_webview_cdp_port(debug_build: bool) -> u16 {
    if debug_build {
        DEV_MAIN_WEBVIEW_CDP_PORT
    } else {
        PROD_MAIN_WEBVIEW_CDP_PORT
    }
}

pub fn configured_main_webview_cdp_port(
    debug_build: bool,
    configured: Option<&str>,
) -> u16 {
    if !debug_build {
        return PROD_MAIN_WEBVIEW_CDP_PORT;
    }
    configured
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| (DEV_MAIN_WEBVIEW_CDP_PORT..=DEV_MAIN_WEBVIEW_CDP_PORT_END).contains(port))
        .unwrap_or(DEV_MAIN_WEBVIEW_CDP_PORT)
}

pub fn current_main_webview_cdp_port() -> u16 {
    configured_main_webview_cdp_port(
        cfg!(debug_assertions),
        std::env::var("VIBELINK_BROWSER_CDP_PORT").ok().as_deref(),
    )
}

pub const fn default_remote_port(debug_build: bool) -> u16 {
    if debug_build {
        DEV_REMOTE_PORT
    } else {
        PROD_REMOTE_PORT
    }
}

pub fn browser_profile_port_candidates(main_port: u16) -> Range<u16> {
    let start = if (DEV_MAIN_WEBVIEW_CDP_PORT..=DEV_MAIN_WEBVIEW_CDP_PORT_END).contains(&main_port) {
        DEV_BROWSER_PROFILE_PORT_START
    } else if main_port == PROD_MAIN_WEBVIEW_CDP_PORT {
        PROD_BROWSER_PROFILE_PORT_START
    } else {
        main_port.saturating_add(1)
    };
    start..start.saturating_add(BROWSER_PROFILE_PORT_CAPACITY)
}

pub fn is_dev_vite_url(value: &str) -> bool {
    ["http://localhost:", "https://localhost:", "http://127.0.0.1:", "https://127.0.0.1:"]
        .iter()
        .filter_map(|prefix| value.strip_prefix(prefix))
        .filter_map(|rest| rest.split(['/', '?', '#']).next())
        .filter_map(|port| port.parse::<u16>().ok())
        .any(|port| (DEV_VITE_PORT_START..=DEV_VITE_PORT_END).contains(&port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_and_development_port_blocks_do_not_overlap() {
        let production_profiles = browser_profile_port_candidates(PROD_MAIN_WEBVIEW_CDP_PORT);
        let development_profiles = browser_profile_port_candidates(DEV_MAIN_WEBVIEW_CDP_PORT_END);

        assert!(production_profiles.end <= DEV_MAIN_WEBVIEW_CDP_PORT);
        assert!(DEV_MAIN_WEBVIEW_CDP_PORT_END < development_profiles.start);
        assert_ne!(PROD_REMOTE_PORT, DEV_REMOTE_PORT);
    }

    #[test]
    fn development_cdp_accepts_only_its_bounded_fallback_range() {
        assert_eq!(
            configured_main_webview_cdp_port(true, Some("19347")),
            19_347
        );
        assert_eq!(
            configured_main_webview_cdp_port(true, Some("9333")),
            DEV_MAIN_WEBVIEW_CDP_PORT
        );
        assert_eq!(
            configured_main_webview_cdp_port(false, Some("19347")),
            PROD_MAIN_WEBVIEW_CDP_PORT
        );
    }

    #[test]
    fn development_browser_profiles_use_their_own_fixed_block() {
        assert_eq!(
            browser_profile_port_candidates(DEV_MAIN_WEBVIEW_CDP_PORT),
            DEV_BROWSER_PROFILE_PORT_START
                ..DEV_BROWSER_PROFILE_PORT_START + BROWSER_PROFILE_PORT_CAPACITY
        );
        assert_eq!(
            browser_profile_port_candidates(DEV_MAIN_WEBVIEW_CDP_PORT_END),
            DEV_BROWSER_PROFILE_PORT_START
                ..DEV_BROWSER_PROFILE_PORT_START + BROWSER_PROFILE_PORT_CAPACITY
        );
    }

    #[test]
    fn development_vite_urls_match_the_bounded_fallback_range() {
        assert!(is_dev_vite_url("http://localhost:1420/"));
        assert!(is_dev_vite_url("http://127.0.0.1:1439/path"));
        assert!(!is_dev_vite_url("http://localhost:1440/"));
        assert!(!is_dev_vite_url("https://example.test:1420/"));
    }
}
