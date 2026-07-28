use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use std::{
    cmp::Ordering,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::SystemTime,
};

const MAX_PARSE_LINES: usize = 200;
const MAX_FILES_PER_AGENT: usize = 1_000;
const MAX_TITLE_CHARS: usize = 80;
const TAIL_READ_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationInfo {
    pub id: String,
    pub title: String,
    pub agent: String,
    pub updated_at: Option<String>,
    pub cwd: Option<String>,
    pub path: String,
}

#[derive(Debug)]
struct FileCandidate {
    path: PathBuf,
    mtime: Option<SystemTime>,
}

#[derive(Debug)]
struct ScannedConversation {
    info: AgentConversationInfo,
    mtime: Option<SystemTime>,
}

#[tauri::command]
pub async fn agent_conversations_list(
    workspace_folder: Option<String>,
) -> Result<Vec<AgentConversationInfo>, String> {
    let Some(home) = user_home() else {
        return Ok(Vec::new());
    };

    tauri::async_runtime::spawn_blocking(move || {
        let mut conversations = scan_all_agents(&home);
        if let Some(workspace) = workspace_folder
            .as_deref()
            .map(str::trim)
            .filter(|workspace| !workspace.is_empty())
        {
            conversations.retain(|conversation| {
                conversation
                    .info
                    .cwd
                    .as_deref()
                    .is_some_and(|cwd| cwd_matches_workspace(cwd, workspace))
            });
        }

        // Drop entries with no human-derived title (title fell back to the raw
        // session id): these are Codex subagent threads and context-only
        // sessions that carry no readable prompt, and would clutter the list
        // with UUID rows.
        conversations.retain(|conversation| conversation.info.title != conversation.info.id);
        sort_conversations(&mut conversations);
        conversations.truncate(300);
        conversations
            .into_iter()
            .map(|conversation| conversation.info)
            .collect()
    })
    .await
    .map_err(|err| format!("failed to scan agent conversations: {err}"))
}

pub(crate) fn parse_conversation(
    lines: impl Iterator<Item = String>,
    agent: &str,
    path: &str,
    mtime: Option<String>,
) -> Option<AgentConversationInfo> {
    match agent {
        "omp" => parse_omp(lines, path),
        "codex" => parse_codex(lines, path),
        "claude" => parse_claude(lines, path, mtime),
        _ => None,
    }
}

fn parse_omp(lines: impl Iterator<Item = String>, path: &str) -> Option<AgentConversationInfo> {
    let mut id = None;
    let mut cwd = None;
    let mut title_record = None;
    let mut session_title = None;
    let mut first_user = None;
    let mut title_updated_at = None;
    let mut session_timestamp = None;
    let mut saw_session = false;

    for line in lines.take(MAX_PARSE_LINES) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        match value.get("type").and_then(Value::as_str) {
            Some("title") => {
                title_record = title_record.or_else(|| title_field(&value, "title"));
                title_updated_at = title_updated_at.or_else(|| string_field(&value, "updatedAt"));
            }
            Some("session") => {
                saw_session = true;
                id = id.or_else(|| string_field(&value, "id"));
                cwd = cwd.or_else(|| string_field(&value, "cwd"));
                session_title = session_title.or_else(|| title_field(&value, "title"));
                session_timestamp = session_timestamp.or_else(|| string_field(&value, "timestamp"));
            }
            _ => {
                if first_user.is_none() {
                    first_user = extract_user_text(&value, false);
                }
            }
        }

        if id.is_some()
            && cwd.is_some()
            && (session_title.is_some()
                || (saw_session && title_record.is_some())
                || (saw_session && first_user.is_some()))
        {
            break;
        }
    }

    let id = id.or_else(|| file_stem(path))?;
    let title = session_title
        .or(title_record)
        .or(first_user)
        .unwrap_or_else(|| id.clone());

    Some(AgentConversationInfo {
        id,
        title,
        agent: "omp".to_string(),
        updated_at: title_updated_at.or(session_timestamp),
        cwd,
        path: path.to_string(),
    })
}

fn parse_codex(lines: impl Iterator<Item = String>, path: &str) -> Option<AgentConversationInfo> {
    let mut id = None;
    let mut cwd = None;
    let mut updated_at = None;
    let mut first_user = None;

    for line in lines.take(MAX_PARSE_LINES) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        if value.get("type").and_then(Value::as_str) == Some("session_meta") {
            if let Some(payload) = value.get("payload") {
                id = id
                    .or_else(|| string_field(payload, "id"))
                    .or_else(|| string_field(payload, "session_id"));
                cwd = cwd.or_else(|| string_field(payload, "cwd"));
                updated_at = updated_at.or_else(|| string_field(payload, "timestamp"));
            }
        } else if first_user.is_none() {
            first_user = extract_user_text(&value, true);
        }

        if id.is_some() && cwd.is_some() && first_user.is_some() {
            break;
        }
    }

    let id = id.or_else(|| file_stem(path))?;
    let title = first_user.unwrap_or_else(|| id.clone());

    Some(AgentConversationInfo {
        id,
        title,
        agent: "codex".to_string(),
        updated_at,
        cwd,
        path: path.to_string(),
    })
}

fn parse_claude(
    lines: impl Iterator<Item = String>,
    path: &str,
    mtime: Option<String>,
) -> Option<AgentConversationInfo> {
    let mut id = None;
    let mut cwd = None;
    let mut summary = None;
    let mut first_user = None;
    let mut latest_timestamp = None;

    for line in lines.take(MAX_PARSE_LINES) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        id = id.or_else(|| string_field(&value, "sessionId"));
        cwd = cwd.or_else(|| string_field(&value, "cwd"));
        if let Some(timestamp) = string_field(&value, "timestamp") {
            latest_timestamp = Some(timestamp);
        }

        match value.get("type").and_then(Value::as_str) {
            Some("summary") => {
                summary = summary.or_else(|| title_field(&value, "summary"));
            }
            Some("ai-title") => {
                summary = summary.or_else(|| title_field(&value, "aiTitle"));
            }
            _ if first_user.is_none() => {
                first_user = extract_user_text(&value, true);
            }
            _ => {}
        }

        if id.is_some() && cwd.is_some() && (summary.is_some() || first_user.is_some()) {
            break;
        }
    }

    let id = id.or_else(|| file_stem(path))?;
    let title = summary.or(first_user).unwrap_or_else(|| id.clone());

    Some(AgentConversationInfo {
        id,
        title,
        agent: "claude".to_string(),
        updated_at: latest_timestamp.or(mtime),
        cwd,
        path: path.to_string(),
    })
}

fn scan_all_agents(home: &Path) -> Vec<ScannedConversation> {
    let mut conversations = Vec::new();
    scan_agent(
        &home.join(".omp").join("agent").join("sessions"),
        "omp",
        1,
        &mut conversations,
    );
    scan_agent(
        &home.join(".codex").join("sessions"),
        "codex",
        3,
        &mut conversations,
    );
    scan_agent(
        &home.join(".claude").join("projects"),
        "claude",
        1,
        &mut conversations,
    );
    conversations
}

fn scan_agent(
    root: &Path,
    agent: &str,
    max_directory_depth: usize,
    conversations: &mut Vec<ScannedConversation>,
) {
    let mut candidates = Vec::new();
    collect_jsonl_files(root, 0, max_directory_depth, &mut candidates);
    candidates.sort_by(|left, right| {
        right
            .mtime
            .cmp(&left.mtime)
            .then_with(|| left.path.cmp(&right.path))
    });
    candidates.truncate(MAX_FILES_PER_AGENT);

    for candidate in candidates {
        let Ok(file) = File::open(&candidate.path) else {
            continue;
        };
        let path = candidate.path.to_string_lossy().into_owned();
        let mtime = candidate.mtime.map(system_time_to_rfc3339);
        let lines = BufReader::new(file).lines().filter_map(Result::ok);
        let Some(mut info) = parse_conversation(lines, agent, &path, mtime) else {
            continue;
        };

        if agent == "claude" {
            if let Some(timestamp) = read_tail_timestamp(&candidate.path) {
                info.updated_at = Some(timestamp);
            }
        }

        conversations.push(ScannedConversation {
            info,
            mtime: candidate.mtime,
        });
    }
}

fn collect_jsonl_files(
    directory: &Path,
    depth: usize,
    max_directory_depth: usize,
    candidates: &mut Vec<FileCandidate>,
) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };

    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if file_type.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonl"))
        {
            candidates.push(FileCandidate {
                mtime: entry
                    .metadata()
                    .ok()
                    .and_then(|metadata| metadata.modified().ok()),
                path,
            });
        } else if file_type.is_dir() && depth < max_directory_depth {
            collect_jsonl_files(&path, depth + 1, max_directory_depth, candidates);
        }
    }
}

fn read_tail_timestamp(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    if length == 0 {
        return None;
    }

    let read_length = length.min(TAIL_READ_BYTES);
    file.seek(SeekFrom::Start(length - read_length)).ok()?;
    let mut bytes = Vec::with_capacity(read_length as usize);
    file.read_to_end(&mut bytes).ok()?;

    bytes
        .split(|byte| *byte == b'\n')
        .rev()
        .filter_map(|line| {
            let line = std::str::from_utf8(line).ok()?.trim();
            if line.is_empty() {
                return None;
            }
            let value = serde_json::from_str::<Value>(line).ok()?;
            string_field(&value, "timestamp")
        })
        .next()
}

fn extract_user_text(value: &Value, skip_wrappers: bool) -> Option<String> {
    if value.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return None;
    }

    let message = value
        .get("payload")
        .or_else(|| value.get("message"))
        .unwrap_or(value);
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }

    let content = message.get("content")?;
    match content {
        Value::String(text) => normalize_user_title(text, skip_wrappers),
        Value::Array(items) => items.iter().find_map(|item| {
            let kind = item.get("type").and_then(Value::as_str);
            if !matches!(kind, Some("text" | "input_text")) {
                return None;
            }
            item.get("text")
                .and_then(Value::as_str)
                .and_then(|text| normalize_user_title(text, skip_wrappers))
        }),
        Value::Object(_) => content
            .get("text")
            .and_then(Value::as_str)
            .and_then(|text| normalize_user_title(text, skip_wrappers)),
        _ => None,
    }
}

fn normalize_user_title(text: &str, skip_wrappers: bool) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if skip_wrappers && is_context_injection(trimmed) {
        return None;
    }
    collapse_title(trimmed)
}

/// Whether a user "message" is really a harness-injected context block (system
/// reminders, AGENTS.md / rules content, tag wrappers, tool output) rather than
/// a human prompt. Codex and Claude prepend several of these before the first
/// real request, so titling from them yields useless entries like
/// "# AGENTS.md instructions for ...".
fn is_context_injection(text: &str) -> bool {
    if text.starts_with('<') || text.starts_with('#') || text.starts_with('{') {
        return true;
    }
    let head = text.get(..200).unwrap_or(text).to_lowercase();
    const MARKERS: [&str; 6] = [
        "agents.md",
        "instructions for",
        "system-reminder",
        "<system",
        "environment_context",
        "recommended_plugins",
    ];
    MARKERS.iter().any(|marker| head.contains(marker))
}

fn collapse_title(value: &str) -> Option<String> {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    if collapsed.chars().count() <= MAX_TITLE_CHARS {
        return Some(collapsed);
    }

    let mut title = collapsed
        .chars()
        .take(MAX_TITLE_CHARS.saturating_sub(3))
        .collect::<String>();
    title.push_str("...");
    Some(title)
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn title_field(value: &Value, field: &str) -> Option<String> {
    string_field(value, field)
}

fn file_stem(path: &str) -> Option<String> {
    Path::new(path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::trim)
        .filter(|stem| !stem.is_empty())
        .map(str::to_string)
}

fn user_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn normalize_cwd(path: &str) -> String {
    path.trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

fn cwd_matches_workspace(cwd: &str, workspace: &str) -> bool {
    let cwd = normalize_cwd(cwd);
    let workspace = normalize_cwd(workspace);
    if workspace.is_empty() {
        return true;
    }
    if cwd == workspace {
        return true;
    }
    // Match when either path contains the other on the same directory chain, so
    // opening a subfolder workspace still surfaces conversations run from the
    // repository root (the common case), and opening the root surfaces
    // conversations run from its subfolders.
    let is_descendant = |child: &str, ancestor: &str| {
        child
            .strip_prefix(ancestor)
            .is_some_and(|suffix| suffix.starts_with('/'))
    };
    is_descendant(&cwd, &workspace) || is_descendant(&workspace, &cwd)
}

fn sort_conversations(conversations: &mut [ScannedConversation]) {
    conversations.sort_by(|left, right| {
        let left_timestamp = parsed_timestamp(left.info.updated_at.as_deref());
        let right_timestamp = parsed_timestamp(right.info.updated_at.as_deref());

        match (left_timestamp, right_timestamp) {
            (Some(left_timestamp), Some(right_timestamp)) => right_timestamp
                .cmp(&left_timestamp)
                .then_with(|| right.mtime.cmp(&left.mtime)),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => right.mtime.cmp(&left.mtime),
        }
        .then_with(|| left.info.path.cmp(&right.info.path))
    });
}

fn parsed_timestamp(value: Option<&str>) -> Option<DateTime<Utc>> {
    value
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
}

fn system_time_to_rfc3339(time: SystemTime) -> String {
    DateTime::<Utc>::from(time).to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    fn parse_fixture(
        fixture: &str,
        agent: &str,
        path: &str,
        mtime: Option<&str>,
    ) -> AgentConversationInfo {
        parse_conversation(
            fixture.lines().map(str::to_string),
            agent,
            path,
            mtime.map(str::to_string),
        )
        .expect("fixture should parse")
    }

    #[test]
    fn cwd_matches_workspace_along_the_same_directory_chain() {
        // Exact match (case/separator/trailing-slash insensitive).
        assert!(cwd_matches_workspace(
            "E:\\VibeCodingProject\\VibeLink\\",
            "e:/vibecodingproject/vibelink"
        ));
        // Conversation cwd is a subdirectory of the workspace.
        assert!(cwd_matches_workspace(
            "E:\\VibeCodingProject\\VibeLink\\vibelink-app",
            "E:\\VibeCodingProject\\VibeLink\\"
        ));
        // Conversation cwd is an ancestor of the workspace: opening a subfolder
        // workspace still surfaces sessions run from the repository root.
        assert!(cwd_matches_workspace(
            "E:\\VibeCodingProject\\VibeLink",
            "E:\\VibeCodingProject\\VibeLink\\vibelink-app"
        ));
        // A sibling sharing a name prefix must NOT match either direction.
        assert!(!cwd_matches_workspace(
            "E:\\VibeCodingProject\\VibeLink-other",
            "E:\\VibeCodingProject\\VibeLink"
        ));
        assert!(!cwd_matches_workspace(
            "E:\\VibeCodingProject\\VibeLink",
            "E:\\VibeCodingProject\\VibeLink-other"
        ));
    }

    #[test]
    fn omp_session_title_takes_precedence() {
        let fixture = r#"{"type":"title","title":"Title Record","updatedAt":"2026-07-22T15:06:35.532Z"}
{"type":"session","id":"omp-id","timestamp":"2026-07-22T11:52:03.629Z","cwd":"E:\\Workspace","title":"Session Title"}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"First user prompt"}]}}"#;
        let info = parse_fixture(fixture, "omp", "C:/tmp/omp-id.jsonl", None);

        assert_eq!(info.id, "omp-id");
        assert_eq!(info.title, "Session Title");
        assert_eq!(info.updated_at.as_deref(), Some("2026-07-22T15:06:35.532Z"));
    }

    #[test]
    fn codex_skips_wrapper_inputs_and_uses_first_real_prompt() {
        let fixture = r##"{"type":"session_meta","payload":{"id":"codex-id","timestamp":"2026-07-21T06:29:16.055Z","cwd":"E:\\Workspace"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>hidden</environment_context>"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for E:\\Workspace"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"  Review   the\n architecture   thoroughly  "}]}}"##;
        let info = parse_fixture(fixture, "codex", "C:/tmp/codex-id.jsonl", None);

        assert_eq!(info.title, "Review the architecture thoroughly");
    }

    #[test]
    fn claude_summary_takes_precedence_over_user_text() {
        let fixture = r#"{"type":"summary","summary":"Compact Session Summary","sessionId":"claude-id"}
{"type":"user","message":{"role":"user","content":"First user prompt"},"timestamp":"2026-07-18T11:35:06.764Z","cwd":"E:\\Workspace","sessionId":"claude-id"}"#;
        let info = parse_fixture(
            fixture,
            "claude",
            "C:/tmp/claude-id.jsonl",
            Some("2026-07-18T12:00:00Z"),
        );

        assert_eq!(info.title, "Compact Session Summary");
        assert_eq!(info.id, "claude-id");
    }

    #[test]
    fn recency_sort_uses_timestamps_then_missing_file_mtime() {
        let conversation = |id: &str, updated_at: Option<&str>, seconds: u64| ScannedConversation {
            info: AgentConversationInfo {
                id: id.to_string(),
                title: id.to_string(),
                agent: "omp".to_string(),
                updated_at: updated_at.map(str::to_string),
                cwd: None,
                path: format!("C:/tmp/{id}.jsonl"),
            },
            mtime: Some(UNIX_EPOCH + Duration::from_secs(seconds)),
        };
        let mut conversations = vec![
            conversation("missing-old", None, 10),
            conversation("known-old", Some("2026-07-20T00:00:00Z"), 40),
            conversation("missing-new", None, 30),
            conversation("known-new", Some("2026-07-22T00:00:00Z"), 20),
        ];

        sort_conversations(&mut conversations);

        assert_eq!(
            conversations
                .iter()
                .map(|conversation| conversation.info.id.as_str())
                .collect::<Vec<_>>(),
            vec!["known-new", "known-old", "missing-new", "missing-old"]
        );
    }
}
