//! Durable agent-chat registry and timeline rows in the control-plane SQLite
//! database (schema v11). The ACP runtime in `app/acp.rs` is the single writer;
//! readers are the desktop chat panel and, later, remote-v2 mobile clients.
//!
//! The timeline is append-only. A tool-call update writes a NEW row carrying the
//! same `entity_id`; readers collapse rows by `entity_id`, last row wins. That
//! keeps "give me everything after seq N" the only query a client ever needs.

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const AGENT_TIMELINE_BODY_LIMIT: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatInfo {
    pub chat_id: String,
    pub session_id: String,
    pub provider: String,
    pub acp_session_id: Option<String>,
    pub cwd: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTimelineEntry {
    /// Assigned by the database on append; 0 on input.
    #[serde(default)]
    pub seq: i64,
    pub role: String,
    pub kind: String,
    #[serde(default)]
    pub entity_id: Option<String>,
    pub body: String,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTimelinePage {
    pub entries: Vec<AgentTimelineEntry>,
    pub last_seq: i64,
}

const ROLES: [&str; 3] = ["user", "assistant", "system"];
const KINDS: [&str; 6] = [
    "message",
    "thought",
    "toolCall",
    "plan",
    "permission",
    "error",
];

pub fn migrate_agent_chat_v11(connection: &Connection) -> Result<()> {
    if super::control_plane::table_exists(connection, "agent_chats")? {
        return Ok(());
    }
    connection
        .execute_batch(
            "CREATE TABLE agent_chats (
              chat_id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              provider TEXT NOT NULL,
              acp_session_id TEXT,
              cwd TEXT NOT NULL,
              title TEXT NOT NULL DEFAULT '',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX agent_chats_session ON agent_chats(session_id, updated_at DESC);
            CREATE TABLE agent_timeline (
              chat_id TEXT NOT NULL REFERENCES agent_chats(chat_id) ON DELETE CASCADE,
              seq INTEGER NOT NULL,
              role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
              kind TEXT NOT NULL CHECK(kind IN ('message','thought','toolCall','plan','permission','error')),
              entity_id TEXT,
              body TEXT NOT NULL,
              truncated INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              PRIMARY KEY (chat_id, seq)
            );",
        )
        .context("create agent chat tables (schema v11)")?;
    Ok(())
}

/// Returns the existing chat for `(session_id, provider)` or creates one.
/// `chat_id` for a newly created chat is caller-supplied so the caller can
/// reuse a legacy per-workspace state directory as the first chat's identity.
pub fn ensure_chat(
    connection: &Connection,
    session_id: &str,
    provider: &str,
    cwd: &str,
    new_chat_id: &str,
    initial_acp_session_id: Option<&str>,
    now: i64,
) -> Result<AgentChatInfo> {
    if let Some(existing) = connection
        .query_row(
            "SELECT chat_id, session_id, provider, acp_session_id, cwd, title, created_at, updated_at
             FROM agent_chats WHERE session_id = ?1 AND provider = ?2
             ORDER BY updated_at DESC LIMIT 1",
            params![session_id, provider],
            row_to_chat,
        )
        .optional()?
    {
        return Ok(existing);
    }
    connection.execute(
        "INSERT INTO agent_chats(chat_id, session_id, provider, acp_session_id, cwd, title, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, ?6)",
        params![new_chat_id, session_id, provider, initial_acp_session_id, cwd, now],
    )?;
    connection
        .query_row(
            "SELECT chat_id, session_id, provider, acp_session_id, cwd, title, created_at, updated_at
             FROM agent_chats WHERE chat_id = ?1",
            params![new_chat_id],
            row_to_chat,
        )
        .context("read back created agent chat")
}

pub fn list_chats(connection: &Connection, session_id: &str) -> Result<Vec<AgentChatInfo>> {
    let mut statement = connection.prepare(
        "SELECT chat_id, session_id, provider, acp_session_id, cwd, title, created_at, updated_at
         FROM agent_chats WHERE session_id = ?1 ORDER BY updated_at DESC",
    )?;
    let rows = statement.query_map(params![session_id], row_to_chat)?;
    let mut chats = Vec::new();
    for row in rows {
        chats.push(row?);
    }
    Ok(chats)
}

pub fn set_chat_acp_session(
    connection: &Connection,
    chat_id: &str,
    acp_session_id: &str,
    now: i64,
) -> Result<()> {
    let changed = connection.execute(
        "UPDATE agent_chats SET acp_session_id = ?2, updated_at = ?3 WHERE chat_id = ?1",
        params![chat_id, acp_session_id, now],
    )?;
    if changed == 0 {
        bail!("unknown agent chat {chat_id}");
    }
    Ok(())
}

pub fn delete_chat(connection: &Connection, chat_id: &str) -> Result<()> {
    connection.execute(
        "DELETE FROM agent_timeline WHERE chat_id = ?1",
        params![chat_id],
    )?;
    connection.execute(
        "DELETE FROM agent_chats WHERE chat_id = ?1",
        params![chat_id],
    )?;
    Ok(())
}

/// Appends entries in order. `seq` is allocated inside the caller's
/// transaction, so ordering is total even if a second writer ever appears.
pub fn append_entries(
    connection: &Connection,
    chat_id: &str,
    entries: &[AgentTimelineEntry],
    now: i64,
) -> Result<i64> {
    let mut last_seq: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM agent_timeline WHERE chat_id = ?1",
            params![chat_id],
            |row| row.get(0),
        )
        .context("read agent timeline tail")?;
    for entry in entries {
        if !ROLES.contains(&entry.role.as_str()) {
            bail!("invalid timeline role {}", entry.role);
        }
        if !KINDS.contains(&entry.kind.as_str()) {
            bail!("invalid timeline kind {}", entry.kind);
        }
        let (body, truncated) = cap_body(&entry.body);
        last_seq += 1;
        connection.execute(
            "INSERT INTO agent_timeline(chat_id, seq, role, kind, entity_id, body, truncated, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                chat_id,
                last_seq,
                entry.role,
                entry.kind,
                entry.entity_id,
                body,
                truncated || entry.truncated,
                if entry.created_at > 0 { entry.created_at } else { now },
            ],
        )?;
    }
    connection.execute(
        "UPDATE agent_chats SET updated_at = ?2 WHERE chat_id = ?1",
        params![chat_id, now],
    )?;
    Ok(last_seq)
}

pub fn fetch_entries(
    connection: &Connection,
    chat_id: &str,
    after_seq: i64,
    limit: i64,
) -> Result<AgentTimelinePage> {
    let limit = limit.clamp(1, 500);
    let mut statement = connection.prepare(
        "SELECT seq, role, kind, entity_id, body, truncated, created_at
         FROM agent_timeline WHERE chat_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
    )?;
    let rows = statement.query_map(params![chat_id, after_seq, limit], |row| {
        Ok(AgentTimelineEntry {
            seq: row.get(0)?,
            role: row.get(1)?,
            kind: row.get(2)?,
            entity_id: row.get(3)?,
            body: row.get(4)?,
            truncated: row.get::<_, i64>(5)? != 0,
            created_at: row.get(6)?,
        })
    })?;
    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    let last_seq: i64 = connection.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM agent_timeline WHERE chat_id = ?1",
        params![chat_id],
        |row| row.get(0),
    )?;
    Ok(AgentTimelinePage { entries, last_seq })
}

/// Caps a body at [`AGENT_TIMELINE_BODY_LIMIT`] bytes on a char boundary. A
/// naive byte slice would split a Korean codepoint and poison the row.
fn cap_body(body: &str) -> (String, bool) {
    if body.len() <= AGENT_TIMELINE_BODY_LIMIT {
        return (body.to_string(), false);
    }
    let mut cut = AGENT_TIMELINE_BODY_LIMIT;
    while cut > 0 && !body.is_char_boundary(cut) {
        cut -= 1;
    }
    (body[..cut].to_string(), true)
}

fn row_to_chat(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentChatInfo> {
    Ok(AgentChatInfo {
        chat_id: row.get(0)?,
        session_id: row.get(1)?,
        provider: row.get(2)?,
        acp_session_id: row.get(3)?,
        cwd: row.get(4)?,
        title: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        migrate_agent_chat_v11(&connection).expect("migrate v11");
        connection
    }

    fn entry(role: &str, kind: &str, body: &str) -> AgentTimelineEntry {
        AgentTimelineEntry {
            seq: 0,
            role: role.to_string(),
            kind: kind.to_string(),
            entity_id: None,
            body: body.to_string(),
            truncated: false,
            created_at: 0,
        }
    }

    #[test]
    fn ensure_chat_reuses_existing_and_creates_once() {
        let connection = test_connection();
        let first = ensure_chat(&connection, "ws-1", "hermes", "E:/repo", "chat-a", None, 10)
            .expect("create");
        let second = ensure_chat(&connection, "ws-1", "hermes", "E:/repo", "chat-b", None, 20)
            .expect("reuse");
        assert_eq!(first.chat_id, "chat-a");
        assert_eq!(second.chat_id, "chat-a");
        let other = ensure_chat(
            &connection,
            "ws-1",
            "claude-code",
            "E:/repo",
            "chat-c",
            None,
            30,
        )
        .expect("second provider gets its own chat");
        assert_eq!(other.chat_id, "chat-c");
    }

    #[test]
    fn append_allocates_contiguous_seq_and_fetch_pages_after() {
        let connection = test_connection();
        ensure_chat(&connection, "ws-1", "hermes", "E:/repo", "chat-a", None, 10).expect("create");
        append_entries(
            &connection,
            "chat-a",
            &[
                entry("user", "message", "질문"),
                entry("assistant", "thought", "생각"),
            ],
            11,
        )
        .expect("append");
        let last = append_entries(
            &connection,
            "chat-a",
            &[entry("assistant", "message", "답변")],
            12,
        )
        .expect("append more");
        assert_eq!(last, 3);
        let page = fetch_entries(&connection, "chat-a", 1, 50).expect("fetch");
        assert_eq!(page.last_seq, 3);
        assert_eq!(page.entries.len(), 2);
        assert_eq!(page.entries[0].seq, 2);
        assert_eq!(page.entries[1].body, "답변");
    }

    #[test]
    fn body_cap_cuts_on_char_boundary_for_hangul() {
        let hangul = "가".repeat(30_000); // 3 bytes each = 90,000 bytes
        let (body, truncated) = cap_body(&hangul);
        assert!(truncated);
        assert!(body.len() <= AGENT_TIMELINE_BODY_LIMIT);
        assert_eq!(body.len() % 3, 0, "must not split a Hangul codepoint");
        assert!(body.chars().all(|ch| ch == '가'));
    }

    #[test]
    fn set_acp_session_updates_resume_pointer() {
        let connection = test_connection();
        ensure_chat(&connection, "ws-1", "hermes", "E:/repo", "chat-a", None, 10).expect("create");
        set_chat_acp_session(&connection, "chat-a", "acp-77", 11).expect("set");
        let chats = list_chats(&connection, "ws-1").expect("list");
        assert_eq!(chats[0].acp_session_id.as_deref(), Some("acp-77"));
        assert!(set_chat_acp_session(&connection, "missing", "acp", 12).is_err());
    }

    #[test]
    fn invalid_role_or_kind_is_rejected() {
        let connection = test_connection();
        ensure_chat(&connection, "ws-1", "hermes", "E:/repo", "chat-a", None, 10).expect("create");
        assert!(
            append_entries(&connection, "chat-a", &[entry("robot", "message", "x")], 11).is_err()
        );
        assert!(append_entries(&connection, "chat-a", &[entry("user", "song", "x")], 11).is_err());
    }
}
