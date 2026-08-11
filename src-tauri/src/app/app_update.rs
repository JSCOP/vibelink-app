//! Desktop update availability.
//!
//! VibeLink ships through the Microsoft Store and the website's direct download
//! routes, so the app never installs anything itself. It only needs to know
//! whether a newer public build exists so the workspace can surface an update
//! card instead of silently leaving users on an old binary.
//!
//! The manifest is served by the same `vibelink.moobang.net` origin the
//! entitlement client already talks to. Querying GitHub directly was rejected:
//! it adds a second desktop-facing origin, exposes users to anonymous API rate
//! limits, and can disagree with the version `/releases` and `/api/download/*`
//! actually serve.

use serde::{Deserialize, Serialize};
use std::time::Duration;

const UPDATE_API_ORIGIN: &str = env!("VIBELINK_API_URL");
const UPDATE_MANIFEST_PATH: &str = "/api/releases/latest";
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateStatusDto {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_notes_url: String,
    /// Opened by the card's primary action; the website redirects it to the
    /// exact checksum-verified installer for the published version.
    pub install_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseManifestDto {
    version: String,
    release_notes_url: String,
    download_url: String,
    installer_url: Option<String>,
}

/// `major.minor.patch`, plus whether a pre-release suffix was present.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ReleaseVersion {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: bool,
}

fn parse_version(value: &str) -> Option<ReleaseVersion> {
    let core = value.trim().trim_start_matches('v');
    let core = core.split('+').next()?;
    let (core, prerelease) = match core.split_once('-') {
        Some((head, tail)) if !tail.is_empty() => (head, true),
        _ => (core, false),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(ReleaseVersion {
        major,
        minor,
        patch,
        prerelease,
    })
}

/// Fails closed: an unparsable version on either side never nags the user.
fn is_newer(latest: &str, current: &str) -> bool {
    let (Some(latest), Some(current)) = (parse_version(latest), parse_version(current)) else {
        return false;
    };
    let latest_core = (latest.major, latest.minor, latest.patch);
    let current_core = (current.major, current.minor, current.patch);
    if latest_core != current_core {
        return latest_core > current_core;
    }
    // Same triple: only a finished release supersedes a local pre-release.
    current.prerelease && !latest.prerelease
}

fn fetch_manifest() -> Result<ReleaseManifestDto, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(10))
        .redirects(0)
        .user_agent(&format!("VibeLink/{CURRENT_VERSION}"))
        .build();
    agent
        .get(&format!("{UPDATE_API_ORIGIN}{UPDATE_MANIFEST_PATH}"))
        .set("Accept", "application/json")
        .call()
        .map_err(|_| "Update service is unreachable.".to_string())?
        .into_json::<ReleaseManifestDto>()
        .map_err(|_| "Update service returned an unexpected response.".to_string())
}

fn status_from_manifest(manifest: ReleaseManifestDto) -> AppUpdateStatusDto {
    let install_url = manifest.installer_url.unwrap_or(manifest.download_url);
    AppUpdateStatusDto {
        update_available: is_newer(&manifest.version, CURRENT_VERSION),
        current_version: CURRENT_VERSION.to_string(),
        latest_version: manifest.version,
        release_notes_url: manifest.release_notes_url,
        install_url,
    }
}

#[tauri::command]
pub async fn app_update_check() -> Result<AppUpdateStatusDto, String> {
    tauri::async_runtime::spawn_blocking(|| fetch_manifest().map(status_from_manifest))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_and_decorated_versions() {
        assert_eq!(
            parse_version("v1.2.3"),
            Some(ReleaseVersion {
                major: 1,
                minor: 2,
                patch: 3,
                prerelease: false
            })
        );
        assert_eq!(
            parse_version("1.2.3-rc.1+build.9"),
            Some(ReleaseVersion {
                major: 1,
                minor: 2,
                patch: 3,
                prerelease: true
            })
        );
        assert_eq!(parse_version("1.2"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
        assert_eq!(parse_version("latest"), None);
    }

    #[test]
    fn detects_only_strictly_newer_releases() {
        assert!(is_newer("0.3.3", "0.3.2"));
        assert!(is_newer("0.4.0", "0.3.99"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("0.3.2", "0.3.2"));
        // The local dev build is routinely ahead of the published release.
        assert!(!is_newer("0.3.2", "0.4.13"));
    }

    #[test]
    fn treats_a_finished_release_as_newer_than_the_same_prerelease() {
        assert!(is_newer("0.4.0", "0.4.0-rc.1"));
        assert!(!is_newer("0.4.0-rc.2", "0.4.0"));
        assert!(!is_newer("0.4.0-rc.2", "0.4.0-rc.1"));
    }

    #[test]
    fn unparsable_versions_never_announce_an_update() {
        assert!(!is_newer("not-a-version", "0.3.2"));
        assert!(!is_newer("0.4.0", "not-a-version"));
    }

    #[test]
    fn falls_back_to_the_download_page_when_no_installer_url_is_published() {
        let status = status_from_manifest(ReleaseManifestDto {
            version: "9.9.9".to_string(),
            release_notes_url: "https://vibelink.moobang.net/releases".to_string(),
            download_url: "https://vibelink.moobang.net/download".to_string(),
            installer_url: None,
        });
        assert!(status.update_available);
        assert_eq!(status.current_version, CURRENT_VERSION);
        assert_eq!(status.latest_version, "9.9.9");
        assert_eq!(status.install_url, "https://vibelink.moobang.net/download");
    }

    #[test]
    fn prefers_the_direct_installer_url_when_published() {
        let status = status_from_manifest(ReleaseManifestDto {
            version: "0.0.1".to_string(),
            release_notes_url: "https://vibelink.moobang.net/releases".to_string(),
            download_url: "https://vibelink.moobang.net/download".to_string(),
            installer_url: Some(
                "https://vibelink.moobang.net/api/download/windows-exe".to_string(),
            ),
        });
        assert!(!status.update_available);
        assert_eq!(
            status.install_url,
            "https://vibelink.moobang.net/api/download/windows-exe"
        );
    }
}
