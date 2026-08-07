use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MEMORY_ROOT: &str = "memory";
const WORKSPACE_SCOPE_DIR: &str = "workspaces";
const GLOBAL_MEMORY_FILE: &str = "global.jsonl";
const MEMORY_COMPACT_LINES: usize = 2_000;
const MEMORY_SNAPSHOT_MAX: usize = 1_500;
const HARVEST_FILE_MAX_BYTES: usize = 512 * 1024;
const HARVEST_BODY_MAX_CHARS: usize = 4_000;

const HARVEST_SOURCES: &[(&str, &[&str])] = &[
    (
        "AGENTS.md",
        &[
            "codex",
            "opencode",
            "omp",
            "pi",
            "amp",
            "cursor",
            "droid",
            "copilot",
            "command-code",
            "mimo-code",
            "kimi",
            "devin",
            "grok",
        ],
    ),
    ("CLAUDE.md", &["claude"]),
    (".claude/CLAUDE.md", &["claude"]),
    ("GEMINI.md", &["gemini", "antigravity"]),
    (".github/copilot-instructions.md", &["copilot"]),
    (".cursor/rules.md", &["cursor"]),
    ("PROJECT_MEMORY.md", &[]),
    ("docs/KNOWHOW.md", &[]),
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryScope {
    Workspace,
    Global,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryQueryScope {
    Workspace,
    Global,
    All,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryOriginKind {
    Agent,
    User,
    Harvest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryOrigin {
    pub kind: MemoryOriginKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub id: String,
    pub scope: MemoryScope,
    pub session_id: Option<String>,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub refs: Vec<String>,
    pub origin: MemoryOrigin,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub deleted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryAddInput {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub refs: Vec<String>,
    pub scope: MemoryScope,
    #[serde(default)]
    pub session_id: Option<String>,
    pub origin: MemoryOrigin,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryWorkspaceRef {
    pub session_id: String,
    pub name: String,
    pub workspace_folder: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: String,
    pub scope: MemoryScope,
    pub session_id: Option<String>,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub refs: Vec<String>,
    pub origin: MemoryOrigin,
    pub created_at: u64,
    pub updated_at: u64,
    pub pinned: bool,
    pub readers: Vec<String>,
}

impl MemoryEntry {
    fn from_record(record: MemoryRecord, readers: Vec<String>) -> Self {
        Self {
            id: record.id,
            scope: record.scope,
            session_id: record.session_id,
            title: record.title,
            body: record.body,
            tags: record.tags,
            refs: record.refs,
            origin: record.origin,
            created_at: record.created_at,
            updated_at: record.updated_at,
            pinned: record.pinned,
            readers,
        }
    }
}

impl From<MemoryRecord> for MemoryEntry {
    fn from(record: MemoryRecord) -> Self {
        Self::from_record(record, Vec::new())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshot {
    pub workspaces: Vec<MemoryWorkspaceRef>,
    pub entries: Vec<MemoryEntry>,
    pub truncated: bool,
}

pub fn list_memory(session_id: Option<&str>, scope: MemoryQueryScope) -> Result<Vec<MemoryRecord>> {
    let data_dir = crate::daemon::paths::daemon_paths()?.data_dir;
    list_memory_at(&data_dir, session_id, scope)
}

pub fn add_memory(input: MemoryAddInput) -> Result<MemoryRecord> {
    let data_dir = crate::daemon::paths::daemon_paths()?.data_dir;
    add_memory_at(&data_dir, input)
}

pub fn remove_memory(id: &str, session_id: Option<&str>, scope: MemoryScope) -> Result<()> {
    let data_dir = crate::daemon::paths::daemon_paths()?.data_dir;
    remove_memory_at(&data_dir, id, session_id, scope)
}

pub fn set_memory_pinned(
    id: &str,
    session_id: Option<&str>,
    scope: MemoryScope,
    pinned: bool,
) -> Result<MemoryRecord> {
    let data_dir = crate::daemon::paths::daemon_paths()?.data_dir;
    set_memory_pinned_at(&data_dir, id, session_id, scope, pinned)
}

pub fn search_memory(
    session_id: Option<&str>,
    scope: MemoryQueryScope,
    query: &str,
    limit: usize,
) -> Result<Vec<MemoryRecord>> {
    let data_dir = crate::daemon::paths::daemon_paths()?.data_dir;
    search_memory_at(&data_dir, session_id, scope, query, limit)
}

pub fn add_memory_at(data_dir: &Path, input: MemoryAddInput) -> Result<MemoryRecord> {
    let MemoryAddInput {
        title,
        body,
        tags,
        refs,
        scope,
        session_id,
        origin,
        pinned,
        id,
    } = input;
    let title = validate_text("title", title, 200)?;
    let body = validate_text("body", body, 8_000)?;
    let tags = normalize_tags(tags)?;
    let refs = normalize_refs(refs)?;
    let session_id = match scope {
        MemoryScope::Workspace => Some(required_session_id(session_id.as_deref())?),
        MemoryScope::Global => {
            optional_session_id(session_id.as_deref())?;
            None
        }
    };
    let id = match id {
        Some(id) if !id.trim().is_empty() => id.trim().to_string(),
        Some(_) => bail!("memory id must not be empty"),
        None => uuid::Uuid::new_v4().to_string(),
    };
    let now = current_time_millis()?;
    let record = MemoryRecord {
        id,
        scope,
        session_id,
        title,
        body,
        tags,
        refs,
        origin,
        created_at: now,
        updated_at: now,
        pinned,
        deleted: false,
    };
    let path = memory_file_path(data_dir, scope, record.session_id.as_deref())?;
    append_record(&path, &record)?;
    Ok(record)
}

fn list_memory_at(
    data_dir: &Path,
    session_id: Option<&str>,
    scope: MemoryQueryScope,
) -> Result<Vec<MemoryRecord>> {
    let mut records = Vec::new();
    match scope {
        MemoryQueryScope::Workspace => {
            let session_id = required_session_id(session_id)?;
            records.extend(read_records(&workspace_memory_path(data_dir, &session_id))?);
        }
        MemoryQueryScope::Global => {
            records.extend(read_records(&global_memory_path(data_dir))?);
        }
        MemoryQueryScope::All => {
            if let Some(session_id) = optional_session_id(session_id)? {
                records.extend(read_records(&workspace_memory_path(data_dir, &session_id))?);
            }
            records.extend(read_records(&global_memory_path(data_dir))?);
        }
    }
    sort_records(&mut records);
    Ok(records)
}

fn remove_memory_at(
    data_dir: &Path,
    id: &str,
    session_id: Option<&str>,
    scope: MemoryScope,
) -> Result<()> {
    let id = id.trim();
    if id.is_empty() {
        bail!("memory id must not be empty");
    }
    let session_id = scoped_session_id(session_id, scope)?;
    let path = memory_file_path(data_dir, scope, session_id.as_deref())?;
    let mut record = read_records(&path)?
        .into_iter()
        .find(|record| record.id == id)
        .ok_or_else(|| anyhow!("memory entry not found: {id}"))?;
    record.deleted = true;
    record.updated_at = current_time_millis()?;
    append_record(&path, &record)
}

fn set_memory_pinned_at(
    data_dir: &Path,
    id: &str,
    session_id: Option<&str>,
    scope: MemoryScope,
    pinned: bool,
) -> Result<MemoryRecord> {
    let id = id.trim();
    if id.is_empty() {
        bail!("memory id must not be empty");
    }
    let session_id = scoped_session_id(session_id, scope)?;
    let path = memory_file_path(data_dir, scope, session_id.as_deref())?;
    let mut record = read_records(&path)?
        .into_iter()
        .find(|record| record.id == id)
        .ok_or_else(|| anyhow!("memory entry not found: {id}"))?;
    record.pinned = pinned;
    record.updated_at = current_time_millis()?;
    append_record(&path, &record)?;
    Ok(record)
}

fn search_memory_at(
    data_dir: &Path,
    session_id: Option<&str>,
    scope: MemoryQueryScope,
    query: &str,
    limit: usize,
) -> Result<Vec<MemoryRecord>> {
    let terms = query
        .split_whitespace()
        .take(8)
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    if terms.is_empty() {
        bail!("memory search query must not be empty");
    }
    let limit = if limit == 0 { 50 } else { limit.clamp(1, 500) };
    let mut matches = list_memory_at(data_dir, session_id, scope)?
        .into_iter()
        .filter_map(|record| score_record(&record, &terms).map(|score| (record, score)))
        .collect::<Vec<_>>();
    matches.sort_by(|left, right| {
        right
            .0
            .pinned
            .cmp(&left.0.pinned)
            .then_with(|| right.1.cmp(&left.1))
            .then_with(|| right.0.updated_at.cmp(&left.0.updated_at))
            .then_with(|| left.0.id.cmp(&right.0.id))
    });
    matches.truncate(limit);
    Ok(matches.into_iter().map(|(record, _)| record).collect())
}

fn score_record(record: &MemoryRecord, terms: &[String]) -> Option<u32> {
    let title = record.title.to_ascii_lowercase();
    let body = record.body.to_ascii_lowercase();
    let tags = record.tags.join(" ").to_ascii_lowercase();
    let refs = record.refs.join(" ").to_ascii_lowercase();
    let mut score = 0;
    for term in terms {
        let title_hit = title.contains(term);
        let metadata_hit = tags.contains(term) || refs.contains(term);
        let body_hit = body.contains(term);
        if !(title_hit || metadata_hit || body_hit) {
            return None;
        }
        score += u32::from(title_hit) * 4 + u32::from(metadata_hit) * 2 + u32::from(body_hit);
    }
    Some(score)
}

fn append_record(path: &Path, record: &MemoryRecord) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create memory directory {}", parent.display()))?;
    }
    let mut line = serde_json::to_string(record).context("serialize memory record")?;
    line.push('\n');
    // A single JSON document would let a UI write and a concurrent `vibelink memory add`
    // silently drop each other's entry. Appending one complete line avoids that lost update.
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("open memory store {}", path.display()))?;
    file.write_all(line.as_bytes())
        .with_context(|| format!("append memory store {}", path.display()))?;
    file.flush()
        .with_context(|| format!("flush memory store {}", path.display()))
}

fn read_records(path: &Path) -> Result<Vec<MemoryRecord>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(error).with_context(|| format!("open memory store {}", path.display()))
        }
    };
    let mut reader = BufReader::new(file);
    let mut bytes = Vec::new();
    let mut line_count = 0;
    let mut records = BTreeMap::new();
    loop {
        bytes.clear();
        let read = reader
            .read_until(b'\n', &mut bytes)
            .with_context(|| format!("read memory store {}", path.display()))?;
        if read == 0 {
            break;
        }
        line_count += 1;
        while bytes
            .last()
            .is_some_and(|byte| matches!(byte, b'\n' | b'\r'))
        {
            bytes.pop();
        }
        if let Ok(record) = serde_json::from_slice::<MemoryRecord>(&bytes) {
            records.insert(record.id.clone(), record);
        }
    }
    drop(reader);
    records.retain(|_, record| !record.deleted);
    if line_count > MEMORY_COMPACT_LINES {
        // ponytail: whole-file compaction; switch to segment files only if a workspace ever exceeds ~10k live entries.
        compact_records(path, records.values())?;
    }
    Ok(records.into_values().collect())
}

fn compact_records<'a>(path: &Path, records: impl Iterator<Item = &'a MemoryRecord>) -> Result<()> {
    let mut bytes = Vec::new();
    for record in records {
        serde_json::to_writer(&mut bytes, record).context("serialize compacted memory record")?;
        bytes.push(b'\n');
    }
    crate::storage::write_bytes(path, &bytes)
}

fn validate_text(name: &str, value: String, max_chars: usize) -> Result<String> {
    let value = value.trim();
    let count = value.chars().count();
    if !(1..=max_chars).contains(&count) {
        bail!("memory {name} must contain 1..={max_chars} characters");
    }
    Ok(value.to_string())
}

fn normalize_tags(tags: Vec<String>) -> Result<Vec<String>> {
    if tags.len() > 16 {
        bail!("memory may contain at most 16 tags");
    }
    tags.into_iter()
        .map(|tag| {
            let tag = tag.trim().to_ascii_lowercase();
            let valid = (1..=40).contains(&tag.len())
                && tag.bytes().enumerate().all(|(index, byte)| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || (index > 0 && byte == b'-')
                });
            if !valid {
                bail!("invalid memory tag '{tag}'");
            }
            Ok(tag)
        })
        .collect()
}

fn normalize_refs(refs: Vec<String>) -> Result<Vec<String>> {
    if refs.len() > 32 {
        bail!("memory may contain at most 32 refs");
    }
    refs.into_iter()
        .map(|reference| {
            normalize_relative_path(&reference)
                .ok_or_else(|| anyhow!("invalid memory ref '{}'", reference.trim()))
        })
        .collect()
}

fn normalize_relative_path(value: &str) -> Option<String> {
    let trimmed = value.trim().replace('\\', "/");
    let bytes = trimmed.as_bytes();
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        || trimmed.contains('\0')
    {
        return None;
    }
    let segments = trimmed.split('/').collect::<Vec<_>>();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || matches!(*segment, "." | ".."))
    {
        return None;
    }
    Some(segments.join("/"))
}

fn optional_session_id(session_id: Option<&str>) -> Result<Option<String>> {
    session_id
        .and_then(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then_some(trimmed)
        })
        .map(super::skills::sanitize_session_id)
        .transpose()
}

fn required_session_id(session_id: Option<&str>) -> Result<String> {
    optional_session_id(session_id)?
        .ok_or_else(|| anyhow!("sessionId is required for workspace memory"))
}

fn scoped_session_id(session_id: Option<&str>, scope: MemoryScope) -> Result<Option<String>> {
    match scope {
        MemoryScope::Workspace => Ok(Some(required_session_id(session_id)?)),
        MemoryScope::Global => {
            optional_session_id(session_id)?;
            Ok(None)
        }
    }
}

fn memory_file_path(
    data_dir: &Path,
    scope: MemoryScope,
    session_id: Option<&str>,
) -> Result<PathBuf> {
    match scope {
        MemoryScope::Workspace => Ok(workspace_memory_path(
            data_dir,
            &required_session_id(session_id)?,
        )),
        MemoryScope::Global => Ok(global_memory_path(data_dir)),
    }
}

fn workspace_memory_path(data_dir: &Path, session_id: &str) -> PathBuf {
    data_dir
        .join(MEMORY_ROOT)
        .join(WORKSPACE_SCOPE_DIR)
        .join(format!("{session_id}.jsonl"))
}

fn global_memory_path(data_dir: &Path) -> PathBuf {
    data_dir.join(MEMORY_ROOT).join(GLOBAL_MEMORY_FILE)
}

fn current_time_millis() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before Unix epoch")?
        .as_millis()
        .min(u128::from(u64::MAX)) as u64)
}

fn sort_records(records: &mut [MemoryRecord]) {
    records.sort_by(|left, right| {
        right
            .pinned
            .cmp(&left.pinned)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| left.id.cmp(&right.id))
    });
}

pub fn harvest_workspace_memory(session_id: &str, workspace_folder: &Path) -> Vec<MemoryRecord> {
    if !workspace_folder.is_dir() {
        return Vec::new();
    }
    let mut records = Vec::new();
    for (source_path, _) in HARVEST_SOURCES {
        let path = workspace_folder.join(source_path);
        let Ok(mut content) = fs::read_to_string(&path) else {
            continue;
        };
        truncate_utf8_bytes(&mut content, HARVEST_FILE_MAX_BYTES);
        let updated_at = path
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
            .unwrap_or(0);
        for (index, section) in split_harvest_sections(&content, source_path)
            .into_iter()
            .enumerate()
        {
            records.push(MemoryRecord {
                id: format!("harvest:{source_path}:{index:04}"),
                scope: MemoryScope::Workspace,
                session_id: Some(session_id.to_string()),
                title: truncate_chars(section.title.trim(), 200),
                body: truncate_chars(section.body.trim(), HARVEST_BODY_MAX_CHARS),
                tags: Vec::new(),
                refs: extract_refs(&section.body),
                origin: MemoryOrigin {
                    kind: MemoryOriginKind::Harvest,
                    agent_id: None,
                    pane_id: None,
                    source_path: Some((*source_path).to_string()),
                },
                created_at: updated_at,
                updated_at,
                pinned: false,
                deleted: false,
            });
        }
    }
    records
}

struct HarvestSection {
    title: String,
    body: String,
}

fn split_harvest_sections(content: &str, source_path: &str) -> Vec<HarvestSection> {
    let fallback_title = Path::new(source_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(source_path);
    let mut sections = Vec::new();
    let mut preamble_title = None;
    let mut preamble: Vec<&str> = Vec::new();
    let mut current_title: Option<String> = None;
    let mut current_body: Vec<&str> = Vec::new();

    for line in content.lines() {
        if let Some(title) = line.strip_prefix("## ") {
            if let Some(title) = current_title.take() {
                sections.push(HarvestSection {
                    title,
                    body: current_body.join("\n"),
                });
                current_body.clear();
            } else if preamble_title.is_some()
                || preamble.iter().any(|line| !line.trim().is_empty())
            {
                sections.push(HarvestSection {
                    title: preamble_title
                        .take()
                        .unwrap_or_else(|| fallback_title.to_string()),
                    body: preamble.join("\n"),
                });
                preamble.clear();
            }
            current_title = Some(title.trim().to_string());
        } else if current_title.is_some() {
            current_body.push(line);
        } else if preamble_title.is_none() {
            if let Some(title) = line.strip_prefix("# ") {
                preamble_title = Some(title.trim().to_string());
            } else {
                preamble.push(line);
            }
        } else {
            preamble.push(line);
        }
    }

    if let Some(title) = current_title {
        sections.push(HarvestSection {
            title,
            body: current_body.join("\n"),
        });
    } else if preamble_title.is_some() || preamble.iter().any(|line| !line.trim().is_empty()) {
        sections.push(HarvestSection {
            title: preamble_title.unwrap_or_else(|| fallback_title.to_string()),
            body: preamble.join("\n"),
        });
    }
    sections
}

fn extract_refs(body: &str) -> Vec<String> {
    let mut refs = Vec::new();
    let mut seen = HashSet::new();
    let mut remainder = body;
    while let Some(start) = remainder.find('`') {
        remainder = &remainder[start + 1..];
        let Some(end) = remainder.find('`') else {
            break;
        };
        let candidate = &remainder[..end];
        let final_segment = candidate.rsplit('/').next().unwrap_or(candidate);
        let valid = candidate.contains('/')
            && final_segment.contains('.')
            && !candidate.is_empty()
            && candidate.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-' | b'/')
            });
        if valid {
            if let Some(reference) = normalize_relative_path(candidate) {
                push_unique_ref(&mut refs, &mut seen, reference);
            }
        }
        remainder = &remainder[end + 1..];
    }

    remainder = body;
    while let Some(start) = remainder.find("](") {
        remainder = &remainder[start + 2..];
        let Some(end) = remainder.find(')') else {
            break;
        };
        if let Some(reference) = normalize_relative_path(&remainder[..end]) {
            push_unique_ref(&mut refs, &mut seen, reference);
        }
        remainder = &remainder[end + 1..];
    }
    refs
}

fn push_unique_ref(refs: &mut Vec<String>, seen: &mut HashSet<String>, reference: String) {
    if refs.len() < 32 && seen.insert(reference.clone()) {
        refs.push(reference);
    }
}

fn truncate_utf8_bytes(value: &mut String, max_bytes: usize) {
    if value.len() <= max_bytes {
        return;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn readers_for_source(source_path: &str) -> Vec<String> {
    HARVEST_SOURCES
        .iter()
        .find(|(candidate, _)| *candidate == source_path)
        .map(|(_, readers)| readers.iter().map(|reader| (*reader).to_string()).collect())
        .unwrap_or_default()
}

pub fn memory_snapshot_native(workspaces: &[MemoryWorkspaceRef]) -> Result<MemorySnapshot> {
    let data_dir = crate::daemon::paths::daemon_paths()?.data_dir;
    memory_snapshot_at(&data_dir, workspaces)
}

fn memory_snapshot_at(
    data_dir: &Path,
    workspaces: &[MemoryWorkspaceRef],
) -> Result<MemorySnapshot> {
    let mut entries = Vec::new();
    for workspace in workspaces {
        for record in list_memory_at(
            data_dir,
            Some(&workspace.session_id),
            MemoryQueryScope::Workspace,
        )? {
            entries.push(MemoryEntry::from(record));
        }
        if let Some(folder) = workspace
            .workspace_folder
            .as_deref()
            .map(str::trim)
            .filter(|folder| !folder.is_empty())
        {
            for record in harvest_workspace_memory(&workspace.session_id, Path::new(folder)) {
                let readers = record
                    .origin
                    .source_path
                    .as_deref()
                    .map(readers_for_source)
                    .unwrap_or_default();
                entries.push(MemoryEntry::from_record(record, readers));
            }
        }
    }
    for record in list_memory_at(data_dir, None, MemoryQueryScope::Global)? {
        entries.push(MemoryEntry::from(record));
    }
    entries.sort_by(|left, right| {
        right
            .pinned
            .cmp(&left.pinned)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| left.id.cmp(&right.id))
    });
    let truncated = entries.len() > MEMORY_SNAPSHOT_MAX;
    entries.truncate(MEMORY_SNAPSHOT_MAX);
    Ok(MemorySnapshot {
        workspaces: workspaces.to_vec(),
        entries,
        truncated,
    })
}

#[tauri::command]
pub async fn memory_snapshot(
    workspaces: Vec<MemoryWorkspaceRef>,
) -> Result<MemorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || memory_snapshot_native(&workspaces))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn memory_add(input: MemoryAddInput) -> Result<MemoryEntry, String> {
    tauri::async_runtime::spawn_blocking(move || add_memory(input).map(MemoryEntry::from))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn memory_remove(
    id: String,
    session_id: Option<String>,
    scope: MemoryScope,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remove_memory(&id, session_id.as_deref(), scope))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn memory_set_pinned(
    id: String,
    session_id: Option<String>,
    scope: MemoryScope,
    pinned: bool,
) -> Result<MemoryEntry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        set_memory_pinned(&id, session_id.as_deref(), scope, pinned).map(MemoryEntry::from)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(id: &str, title: &str, body: &str) -> MemoryAddInput {
        MemoryAddInput {
            title: title.to_string(),
            body: body.to_string(),
            tags: Vec::new(),
            refs: Vec::new(),
            scope: MemoryScope::Workspace,
            session_id: Some("session-1".to_string()),
            origin: MemoryOrigin {
                kind: MemoryOriginKind::Agent,
                agent_id: Some("omp".to_string()),
                pane_id: None,
                source_path: None,
            },
            pinned: false,
            id: Some(id.to_string()),
        }
    }

    #[test]
    fn append_read_round_trip() {
        let root = temp_root("memory-round-trip");
        let created = add_memory_at(&root, input("one", "Title", "Body")).expect("add memory");
        let records = list_memory_at(&root, Some("session-1"), MemoryQueryScope::Workspace)
            .expect("list memory");
        assert_eq!(records, vec![created]);
        cleanup_root(root);
    }

    #[test]
    fn later_same_id_record_supersedes() {
        let root = temp_root("memory-supersede");
        add_memory_at(&root, input("same", "First", "Old body")).expect("add first");
        add_memory_at(&root, input("same", "Second", "New body")).expect("add second");
        let records = list_memory_at(&root, Some("session-1"), MemoryQueryScope::Workspace)
            .expect("list memory");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].title, "Second");
        cleanup_root(root);
    }

    #[test]
    fn tombstone_removes_record() {
        let root = temp_root("memory-tombstone");
        add_memory_at(&root, input("gone", "Title", "Body")).expect("add memory");
        remove_memory_at(&root, "gone", Some("session-1"), MemoryScope::Workspace)
            .expect("remove memory");
        assert!(
            list_memory_at(&root, Some("session-1"), MemoryQueryScope::Workspace)
                .expect("list memory")
                .is_empty()
        );
        cleanup_root(root);
    }

    #[test]
    fn compaction_preserves_live_records_and_shrinks_lines() {
        let root = temp_root("memory-compaction");
        let path = workspace_memory_path(&root, "session-1");
        fs::create_dir_all(path.parent().expect("memory parent")).expect("create memory parent");
        let mut file = File::create(&path).expect("create store");
        for index in 0..=MEMORY_COMPACT_LINES {
            let mut record = MemoryRecord {
                id: "same".to_string(),
                scope: MemoryScope::Workspace,
                session_id: Some("session-1".to_string()),
                title: "Title".to_string(),
                body: format!("Body {index}"),
                tags: Vec::new(),
                refs: Vec::new(),
                origin: MemoryOrigin {
                    kind: MemoryOriginKind::Agent,
                    agent_id: None,
                    pane_id: None,
                    source_path: None,
                },
                created_at: 1,
                updated_at: index as u64,
                pinned: false,
                deleted: false,
            };
            if index == MEMORY_COMPACT_LINES - 1 {
                record.deleted = true;
            }
            writeln!(
                file,
                "{}",
                serde_json::to_string(&record).expect("serialize record")
            )
            .expect("write record");
        }
        drop(file);
        let records = read_records(&path).expect("read and compact");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].body, format!("Body {MEMORY_COMPACT_LINES}"));
        assert_eq!(
            fs::read_to_string(&path)
                .expect("read compacted")
                .lines()
                .count(),
            1
        );
        cleanup_root(root);
    }

    #[test]
    fn validation_rejects_bad_tag_and_parent_ref() {
        let root = temp_root("memory-validation");
        let mut bad_tag = input("tag", "Title", "Body");
        bad_tag.tags = vec!["Bad Tag".to_string()];
        assert!(add_memory_at(&root, bad_tag)
            .expect_err("bad tag rejected")
            .to_string()
            .contains("bad tag"));
        let mut bad_ref = input("ref", "Title", "Body");
        bad_ref.refs = vec!["../x".to_string()];
        assert!(add_memory_at(&root, bad_ref)
            .expect_err("parent ref rejected")
            .to_string()
            .contains("../x"));
        cleanup_root(root);
    }

    #[test]
    fn search_ranks_pinned_then_title_then_body() {
        let root = temp_root("memory-search");
        add_memory_at(&root, input("body", "Other", "state machine detail")).expect("add body hit");
        add_memory_at(&root, input("title", "State machine", "Other detail"))
            .expect("add title hit");
        add_memory_at(&root, input("pinned", "Other", "state machine pinned"))
            .expect("add pinned hit");
        set_memory_pinned_at(
            &root,
            "pinned",
            Some("session-1"),
            MemoryScope::Workspace,
            true,
        )
        .expect("pin memory");
        let results = search_memory_at(
            &root,
            Some("session-1"),
            MemoryQueryScope::Workspace,
            "state machine",
            50,
        )
        .expect("search memory");
        assert_eq!(
            results
                .iter()
                .map(|record| record.id.as_str())
                .collect::<Vec<_>>(),
            vec!["pinned", "title", "body"]
        );
        cleanup_root(root);
    }

    #[test]
    fn harvest_splits_headings_and_assigns_readers() {
        let root = temp_root("memory-harvest");
        fs::write(
            root.join("AGENTS.md"),
            "## Build\nUse `src/a.ts`.\n## Test\nSee [suite](tests/a.test.ts).\n",
        )
        .expect("write agents memory");
        let snapshot = memory_snapshot_at(
            &root.join("data"),
            &[MemoryWorkspaceRef {
                session_id: "session-1".to_string(),
                name: "Workspace".to_string(),
                workspace_folder: Some(root.to_string_lossy().into_owned()),
            }],
        )
        .expect("build snapshot");
        assert_eq!(snapshot.entries.len(), 2);
        assert_eq!(snapshot.entries[0].id, "harvest:AGENTS.md:0000");
        assert_eq!(snapshot.entries[1].id, "harvest:AGENTS.md:0001");
        assert_eq!(snapshot.entries[0].refs, vec!["src/a.ts"]);
        assert!(snapshot.entries[0].readers.contains(&"codex".to_string()));
        assert!(snapshot.entries[0].readers.contains(&"omp".to_string()));
        cleanup_root(root);
    }

    #[test]
    fn harvest_missing_folder_is_empty() {
        let root = temp_root("memory-missing-harvest");
        let missing = root.join("missing");
        assert!(harvest_workspace_memory("session-1", &missing).is_empty());
        cleanup_root(root);
    }

    fn temp_root(prefix: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("vibelink-{prefix}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    fn cleanup_root(root: PathBuf) {
        let _ = fs::remove_dir_all(root);
    }
}
