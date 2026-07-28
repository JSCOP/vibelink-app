use std::ops::Range;

pub const PROD_MAIN_WEBVIEW_CDP_PORT: u16 = 9_333;
pub const DEV_MAIN_WEBVIEW_CDP_PORT: u16 = 19_333;
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

pub const fn current_main_webview_cdp_port() -> u16 {
    main_webview_cdp_port(cfg!(debug_assertions))
}

pub const fn default_remote_port(debug_build: bool) -> u16 {
    if debug_build {
        DEV_REMOTE_PORT
    } else {
        PROD_REMOTE_PORT
    }
}

pub fn browser_profile_port_candidates(main_port: u16) -> Range<u16> {
    let start = main_port.saturating_add(1);
    start..start.saturating_add(BROWSER_PROFILE_PORT_CAPACITY)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_and_development_port_blocks_do_not_overlap() {
        let production_profiles = browser_profile_port_candidates(PROD_MAIN_WEBVIEW_CDP_PORT);
        let development_profiles = browser_profile_port_candidates(DEV_MAIN_WEBVIEW_CDP_PORT);

        assert!(!production_profiles.contains(&DEV_MAIN_WEBVIEW_CDP_PORT));
        assert!(!development_profiles.contains(&PROD_MAIN_WEBVIEW_CDP_PORT));
        assert!(production_profiles.end <= development_profiles.start);
        assert_ne!(PROD_REMOTE_PORT, DEV_REMOTE_PORT);
    }

    #[test]
    fn build_flavor_selects_stable_runtime_ports() {
        assert_eq!(main_webview_cdp_port(false), PROD_MAIN_WEBVIEW_CDP_PORT);
        assert_eq!(main_webview_cdp_port(true), DEV_MAIN_WEBVIEW_CDP_PORT);
        assert_eq!(default_remote_port(false), PROD_REMOTE_PORT);
        assert_eq!(default_remote_port(true), DEV_REMOTE_PORT);
    }
}
