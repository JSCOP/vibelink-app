//! Skill text that updates without shipping a new desktop build.
//!
//! The bundled `SKILL.md` files are `include_str!`-baked into the binary, so
//! before this module a wording fix reached an agent only after a full
//! `tauri:build` and reinstall. Agents read these files every session, so that
//! latency was the difference between an agent knowing about `browser new-tab`
//! and shelling out to `chrome.exe` instead.
//!
//! The published copy at `JSCOP/vibelink-skills` is therefore treated as the
//! authority when it is reachable, and the bundled copy is the offline
//! fallback. This is a supply-chain surface, so it is deliberately narrow: one
//! pinned host, one pinned repository, HTTPS only, a byte cap, a short timeout,
//! and a frontmatter check that the document really is the skill it claims to
//! be. Anything unexpected keeps the bundled text rather than writing a
//! surprise into the user's agent homes.

use anyhow::{bail, Context, Result};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

/// Pinned. Never build this from user input: the whole safety argument is that
/// only this repository can change what an agent is told to do.
const RAW_BASE: &str = "https://raw.githubusercontent.com/JSCOP/vibelink-skills/main/skills";
const MAX_SKILL_BYTES: usize = 256 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
/// Long enough that a normal day costs one request per skill, short enough that
/// a published wording fix lands the same day without an app update.
const CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);


/// Kept under the same `home` the skill installer already receives, so nothing
/// new has to be threaded through and a test temp root isolates the cache for
/// free.
fn cache_dir(home: &Path) -> PathBuf {
    home.join(".vibelink").join("agent-skills-remote")
}

fn cache_path(cache_root: &Path, skill: &str) -> PathBuf {
    cache_dir(cache_root).join(format!("{skill}.md"))
}

/// The cached text for a skill, or `None` when nothing has ever been fetched.
/// Never performs IO against the network: status reads run on every UI refresh
/// and must stay instant and offline-safe.
pub fn cached(cache_root: &Path, skill: &str) -> Option<String> {
    fs::read_to_string(cache_path(cache_root, skill))
        .ok()
        .filter(|text| validate(skill, text).is_ok())
}

fn is_fresh(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age < CACHE_TTL)
}

/// Refreshes the cache for one skill. Returns `Ok(true)` when the cached text
/// changed, which is the only case a caller needs to react to.
///
/// Every failure path is deliberately quiet and non-fatal: a laptop offline at
/// startup must behave exactly like one that has never published a skill.
pub fn refresh(cache_root: &Path, skill: &str) -> Result<bool> {
    let path = cache_path(cache_root, skill);
    if is_fresh(&path) {
        return Ok(false);
    }
    let text = fetch(skill)?;
    let previous = fs::read_to_string(&path).ok();
    if previous.as_deref() == Some(text.as_str()) {
        // Touch so a reachable-but-unchanged skill does not refetch every start.
        let _ = fs::write(&path, text.as_bytes());
        return Ok(false);
    }
    fs::create_dir_all(cache_dir(cache_root)).with_context(|| {
        format!(
            "create agent skill cache directory {}",
            cache_dir(cache_root).display()
        )
    })?;
    crate::persistence::write_bytes_atomic(&path, text.as_bytes())
        .with_context(|| format!("cache published agent skill {skill}"))?;
    Ok(true)
}

fn fetch(skill: &str) -> Result<String> {
    let url = format!("{RAW_BASE}/{skill}/SKILL.md");
    let response = ureq::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .get(&url)
        .call()
        .with_context(|| format!("fetch published agent skill {skill}"))?;
    // `ureq` would otherwise stream an unbounded body into memory. One extra
    // byte past the cap is enough to prove the document is too large.
    let mut body = Vec::new();
    response
        .into_reader()
        .take((MAX_SKILL_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .with_context(|| format!("read published agent skill {skill}"))?;
    if body.len() > MAX_SKILL_BYTES {
        bail!("published agent skill {skill} exceeds {MAX_SKILL_BYTES} bytes");
    }
    let text = String::from_utf8(body)
        .with_context(|| format!("published agent skill {skill} is not UTF-8"))?;
    validate(skill, &text)?;
    Ok(text)
}

/// A published document must look like the skill it claims to be. Without this
/// a redirect to an HTML error page, or a file moved out from under the path,
/// would be written into every agent home as instructions.
fn validate(skill: &str, text: &str) -> Result<()> {
    let trimmed = text.trim_start_matches('\u{feff}');
    if !trimmed.starts_with("---") {
        bail!("published agent skill {skill} has no frontmatter");
    }
    let Some(frontmatter) = trimmed
        .strip_prefix("---")
        .and_then(|rest| rest.split_once("\n---"))
        .map(|(front, _)| front)
    else {
        bail!("published agent skill {skill} has an unterminated frontmatter block");
    };
    if !frontmatter
        .lines()
        .any(|line| line.trim() == format!("name: {skill}"))
    {
        bail!("published agent skill {skill} declares a different name");
    }
    Ok(())
}


#[cfg(test)]
#[path = "agent_skills_remote_tests.rs"]
mod tests;
