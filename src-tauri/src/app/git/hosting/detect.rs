use super::auth::{normalize_host, token_status};
use super::HostingInfo;
use crate::app::git::exec::git_read_allow_fail;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const OVERRIDES_FILE: &str = "git-hosting.json";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RemoteOrigin {
    pub host: String,
    pub owner: String,
    pub repo: String,
    pub web_url: String,
}

#[derive(Default, Deserialize, Serialize)]
struct ProviderOverrides(BTreeMap<String, String>);

pub(crate) fn detect_hosting(repo: &str) -> Result<HostingInfo> {
    let output = match git_read_allow_fail(repo, ["config", "--get", "remote.origin.url"])? {
        Some(output) => output,
        None => return Ok(empty_hosting_info()),
    };
    let remote_url = String::from_utf8(output)
        .context("remote.origin.url is not valid UTF-8")?
        .trim()
        .to_string();
    let Some(origin) = parse_remote_origin(&remote_url) else {
        return Ok(empty_hosting_info());
    };

    let provider = provider_for_host(&origin.host, &load_provider_overrides(&overrides_path()?)?);
    let token_present = token_status(&origin.host)?;
    Ok(HostingInfo {
        provider,
        host: Some(origin.host),
        owner: Some(origin.owner),
        repo: Some(origin.repo),
        web_url: Some(origin.web_url),
        token_present,
    })
}

pub(crate) fn set_provider_override(host: &str, provider: &str) -> Result<()> {
    set_provider_override_at(&overrides_path()?, host, provider)
}

pub(crate) fn parse_remote_origin(remote_url: &str) -> Option<RemoteOrigin> {
    let remote_url = remote_url.trim();
    let (host, path) = if let Some(rest) = remote_url.strip_prefix("https://") {
        let (host, path) = rest.split_once('/')?;
        if host.contains('@') || host.is_empty() {
            return None;
        }
        (host, path)
    } else if let Some(rest) = remote_url.strip_prefix("ssh://") {
        let (authority, path) = rest.split_once('/')?;
        let host = authority
            .strip_prefix("git@")
            .filter(|host| !host.is_empty())?;
        (host, path)
    } else {
        let rest = remote_url.strip_prefix("git@")?;
        let (host, path) = rest.split_once(':')?;
        if host.is_empty() {
            return None;
        }
        (host, path)
    };

    let host = normalize_host(host).ok()?;
    let (owner, repo) = parse_repository_path(path)?;
    let web_url = format!("https://{host}/{owner}/{repo}");
    Some(RemoteOrigin {
        host,
        owner,
        repo,
        web_url,
    })
}

fn parse_repository_path(path: &str) -> Option<(String, String)> {
    if path.is_empty()
        || path.starts_with('/')
        || path.ends_with('/')
        || path.contains('?')
        || path.contains('#')
        || path.contains('\\')
        || path.chars().any(char::is_whitespace)
    {
        return None;
    }
    let mut parts = path.split('/').collect::<Vec<_>>();
    if parts.len() < 2
        || parts
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return None;
    }
    let repo = parts.pop()?;
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    if repo.is_empty() {
        return None;
    }
    Some((parts.join("/"), repo.to_string()))
}

fn provider_for_host(host: &str, overrides: &ProviderOverrides) -> Option<String> {
    match host {
        "github.com" => Some("github".to_string()),
        "gitlab.com" => Some("gitlab".to_string()),
        _ => overrides.0.get(host).cloned(),
    }
}

fn overrides_path() -> Result<PathBuf> {
    Ok(crate::daemon::paths::daemon_paths()?
        .data_dir
        .join(OVERRIDES_FILE))
}

fn load_provider_overrides(path: &Path) -> Result<ProviderOverrides> {
    if !path.exists() {
        return Ok(ProviderOverrides::default());
    }
    let json = fs::read_to_string(path)
        .with_context(|| format!("read Git hosting overrides from {}", path.display()))?;
    let mut overrides: ProviderOverrides = serde_json::from_str(&json)
        .with_context(|| format!("parse Git hosting overrides from {}", path.display()))?;
    overrides.0.retain(|host, provider| {
        normalize_host(host).is_ok_and(|normalized| normalized == *host)
            && matches!(provider.as_str(), "github" | "gitlab")
    });
    Ok(overrides)
}

fn set_provider_override_at(path: &Path, host: &str, provider: &str) -> Result<()> {
    let host = normalize_host(host)?;
    if !matches!(provider, "github" | "gitlab") {
        return Err(anyhow!("Git hosting provider must be github or gitlab"));
    }
    let mut overrides = load_provider_overrides(path)?;
    overrides.0.insert(host, provider.to_string());
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "create Git hosting overrides directory {}",
                parent.display()
            )
        })?;
    }
    let json = serde_json::to_string_pretty(&overrides.0)
        .context("serialize Git hosting provider overrides")?;
    fs::write(path, json)
        .with_context(|| format!("write Git hosting overrides to {}", path.display()))
}

fn empty_hosting_info() -> HostingInfo {
    HostingInfo {
        provider: None,
        host: None,
        owner: None,
        repo: None,
        web_url: None,
        token_present: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_https_remote() {
        assert_eq!(
            parse_remote_origin("https://github.com/JSCOP/vibelink-app.git"),
            Some(RemoteOrigin {
                host: "github.com".to_string(),
                owner: "JSCOP".to_string(),
                repo: "vibelink-app".to_string(),
                web_url: "https://github.com/JSCOP/vibelink-app".to_string(),
            })
        );
    }

    #[test]
    fn parses_scp_style_remote() {
        assert_eq!(
            parse_remote_origin("git@gitlab.com:group/project.git"),
            Some(RemoteOrigin {
                host: "gitlab.com".to_string(),
                owner: "group".to_string(),
                repo: "project".to_string(),
                web_url: "https://gitlab.com/group/project".to_string(),
            })
        );
    }

    #[test]
    fn parses_ssh_remote_and_nested_owner() {
        assert_eq!(
            parse_remote_origin("ssh://git@git.example.test/team/subteam/project.git"),
            Some(RemoteOrigin {
                host: "git.example.test".to_string(),
                owner: "team/subteam".to_string(),
                repo: "project".to_string(),
                web_url: "https://git.example.test/team/subteam/project".to_string(),
            })
        );
    }

    #[test]
    fn rejects_invalid_remote_urls() {
        for invalid in [
            "",
            "http://github.com/owner/repo",
            "https://github.com/repo",
            "https://github.com/owner/",
            "https://github.com/owner/../repo",
            "https://user@github.com/owner/repo",
            "https://:/owner/repo",
            "https://bad..host/owner/repo",
            "ssh://root@github.com/owner/repo",
            "git@github.com:owner",
            "git@github.com:/owner/repo",
            "git@github.com:owner/../repo",
            "C:\\repo",
        ] {
            assert!(parse_remote_origin(invalid).is_none(), "accepted {invalid}");
        }
    }

    #[test]
    fn provider_defaults_are_fixed_and_custom_hosts_need_override() {
        let mut overrides = ProviderOverrides::default();
        overrides
            .0
            .insert("git.example.test".to_string(), "github".to_string());
        assert_eq!(
            provider_for_host("github.com", &overrides).as_deref(),
            Some("github")
        );
        assert_eq!(
            provider_for_host("gitlab.com", &overrides).as_deref(),
            Some("gitlab")
        );
        assert_eq!(
            provider_for_host("git.example.test", &overrides).as_deref(),
            Some("github")
        );
        assert_eq!(provider_for_host("unknown.test", &overrides), None);
    }

    #[test]
    fn provider_override_persists_as_host_map() {
        let dir = std::env::temp_dir().join(format!(
            "vibelink-hosting-overrides-{}",
            uuid::Uuid::new_v4()
        ));
        let path = dir.join(OVERRIDES_FILE);
        set_provider_override_at(&path, "Git.Example.Test", "gitlab").expect("set gitlab override");
        set_provider_override_at(&path, "code.example.test", "github")
            .expect("set github override");

        let overrides = load_provider_overrides(&path).expect("load overrides");
        assert_eq!(
            overrides.0.get("git.example.test").map(String::as_str),
            Some("gitlab")
        );
        assert_eq!(
            overrides.0.get("code.example.test").map(String::as_str),
            Some("github")
        );
        let json = fs::read_to_string(&path).expect("read override json");
        assert!(json.contains(r#""git.example.test": "gitlab""#));
        assert!(json.contains(r#""code.example.test": "github""#));

        fs::remove_dir_all(dir).expect("remove temp override directory");
    }

    #[test]
    fn provider_override_rejects_unknown_provider() {
        let path = std::env::temp_dir().join(format!(
            "vibelink-hosting-invalid-{}.json",
            uuid::Uuid::new_v4()
        ));
        assert!(set_provider_override_at(&path, "git.example.test", "bitbucket").is_err());
        assert!(!path.exists());
    }
}
