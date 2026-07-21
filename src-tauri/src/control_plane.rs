use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const CONTROL_SCHEMA_VERSION: i64 = 3;
const MAX_BACKUPS: usize = 3;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BoardDoc {
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub tasks: HashMap<String, Task>,
    #[serde(default)]
    pub task_order: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<Brief>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Brief {
    pub purpose: String,
    pub notes: String,
    pub updated_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TaskStatus {
    Pending,
    Assigned,
    InProgress,
    Done,
}
impl Serialize for TaskStatus {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(status_text(*self))
    }
}

impl<'de> Deserialize<'de> for TaskStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        match String::deserialize(deserializer)?.as_str() {
            "pending" => Ok(Self::Pending),
            "assigned" => Ok(Self::Assigned),
            "in-progress" => Ok(Self::InProgress),
            "done" => Ok(Self::Done),
            value => Err(serde::de::Error::custom(format!(
                "invalid task status: {value}"
            ))),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub session_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub status: TaskStatus,
    #[serde(default)]
    pub status_timestamps: HashMap<TaskStatus, u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assigned_pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assigned_role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_summary: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub title: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub description: Option<Option<String>>,
    #[serde(default)]
    pub status: Option<TaskStatus>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub assigned_pane_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub assigned_role: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub baseline_ref: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub worktree_path: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub commit_message: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub result_summary: Option<Option<String>>,
}

mod double_option {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
    where
        D: Deserializer<'de>,
        T: Deserialize<'de>,
    {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ControlCommand {
    BoardRead {
        session_id: String,
    },
    BoardWrite {
        session_id: String,
        board: BoardDoc,
        expected_revision: u64,
    },
    TaskCreate {
        session_id: String,
        title: String,
        description: Option<String>,
    },
    TaskUpdate {
        session_id: String,
        task_id: String,
        patch: TaskPatch,
    },
    TaskDelete {
        session_id: String,
        task_id: String,
    },
    TaskDone {
        session_id: String,
        task_id: String,
        commit_msg: Option<String>,
        result_summary: Option<String>,
    },
    TaskNote {
        session_id: String,
        task_id: String,
        message: String,
    },
    BriefGet {
        session_id: String,
    },
    BriefSet {
        session_id: String,
        purpose: String,
        notes: String,
    },
}

impl ControlCommand {
    fn session_id(&self) -> &str {
        match self {
            Self::BoardRead { session_id }
            | Self::BoardWrite { session_id, .. }
            | Self::TaskCreate { session_id, .. }
            | Self::TaskUpdate { session_id, .. }
            | Self::TaskDelete { session_id, .. }
            | Self::TaskDone { session_id, .. }
            | Self::TaskNote { session_id, .. }
            | Self::BriefGet { session_id }
            | Self::BriefSet { session_id, .. } => session_id,
        }
    }

    fn event_type(&self) -> &'static str {
        match self {
            Self::BoardRead { .. } | Self::BriefGet { .. } => "control.read",
            Self::BoardWrite { .. } => "work_items.replaced",
            Self::TaskCreate { .. } => "work_item.created",
            Self::TaskUpdate { .. } => "work_item.updated",
            Self::TaskDelete { .. } => "work_item.deleted",
            Self::TaskDone { .. } => "work_item.completed",
            Self::TaskNote { .. } => "work_item.noted",
            Self::BriefSet { .. } => "workspace_brief.updated",
        }
    }

    fn mutates(&self) -> bool {
        !matches!(self, Self::BoardRead { .. } | Self::BriefGet { .. })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum ControlResponse {
    Board(BoardDoc),
    Task(Task),
    Brief(Option<Brief>),
    Ack,
}

pub struct ControlPlane {
    connection: Mutex<Connection>,
    data_dir: PathBuf,
    database_path: PathBuf,
}

impl ControlPlane {
    pub fn open(data_dir: &Path) -> Result<Self> {
        let control_dir = data_dir.join("control");
        fs::create_dir_all(&control_dir)
            .with_context(|| format!("create control directory {}", control_dir.display()))?;
        let database_path = control_dir.join("vibelink-control.sqlite3");
        let connection = match open_connection(&database_path) {
            Ok(connection) => connection,
            Err(error) if database_path.exists() && is_corruption_error(&error) => {
                quarantine_database(&database_path)?;
                restore_latest_backup(&control_dir, &database_path)?;
                open_connection(&database_path).context("open recovered control database")?
            }
            Err(error) => return Err(error),
        };
        let plane = Self {
            connection: Mutex::new(connection),
            data_dir: data_dir.to_path_buf(),
            database_path,
        };
        plane.import_legacy_boards()?;
        plane.rotate_backup()?;
        Ok(plane)
    }

    pub fn execute(&self, operation_id: Uuid, command: ControlCommand) -> Result<ControlResponse> {
        validate_session_id(command.session_id())?;
        let request_json = serde_json::to_string(&command)?;
        let request_hash = digest_hex(request_json.as_bytes());
        let mut connection = self
            .connection
            .lock()
            .expect("control plane mutex poisoned");
        if let Some((stored_hash, response_json)) = connection
            .query_row(
                "SELECT request_hash, response_json FROM operations WHERE operation_id = ?1",
                [operation_id.to_string()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
        {
            if stored_hash != request_hash {
                bail!("operation id conflict");
            }
            return serde_json::from_str(&response_json)
                .context("parse idempotent control response");
        }

        if !command.mutates() {
            return execute_read(&connection, command);
        }

        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let session_id = command.session_id().to_string();
        let event_type = command.event_type();
        let response = execute_mutation(&transaction, command)?;
        let response_json = serde_json::to_string(&response)?;
        transaction.execute(
            "INSERT INTO operations(operation_id, request_hash, response_json, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![operation_id.to_string(), request_hash, response_json, now_millis()],
        )?;
        transaction.execute(
            "INSERT INTO run_events(run_id, domain, event_type, entity_id, operation_id, payload_json, created_at) VALUES (NULL, 'control', ?1, ?2, ?3, ?4, ?5)",
            params![
                event_type,
                session_id,
                operation_id.to_string(),
                serde_json::json!({"sessionId": session_id}).to_string(),
                now_millis(),
            ],
        )?;
        transaction.commit()?;
        Ok(response)
    }

    fn import_legacy_boards(&self) -> Result<()> {
        let legacy_dir = self.data_dir.join("kanban");
        let entries = match fs::read_dir(&legacy_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error).context("read legacy board directory"),
        };
        for entry in entries {
            let path = entry?.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let source =
                fs::read(&path).with_context(|| format!("read legacy board {}", path.display()))?;
            let source_hash = digest_hex(&source);
            let source_path = path.to_string_lossy().to_string();
            let already_imported = self
                .connection
                .lock()
                .expect("control plane mutex poisoned")
                .query_row(
                    "SELECT 1 FROM legacy_migrations WHERE source_path = ?1 AND source_hash = ?2 AND migration_version = 1",
                    params![source_path, source_hash],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if already_imported {
                continue;
            }
            let mut board: BoardDoc = match serde_json::from_slice(&source) {
                Ok(board) => board,
                Err(error) => {
                    tracing::warn!(?error, path = %path.display(), "legacy board migration skipped invalid JSON");
                    continue;
                }
            };
            normalize_board(&mut board);
            let session_id = path
                .file_stem()
                .and_then(|value| value.to_str())
                .ok_or_else(|| anyhow!("invalid legacy board file name"))?
                .to_string();
            validate_session_id(&session_id)?;
            let rollback = path.with_extension("json.rollback-v1");
            if !rollback.exists() {
                fs::copy(&path, &rollback).with_context(|| {
                    format!("create legacy board rollback copy {}", rollback.display())
                })?;
            }
            let mut connection = self
                .connection
                .lock()
                .expect("control plane mutex poisoned");
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let existing_count: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM work_items WHERE session_id = ?1",
                [&session_id],
                |row| row.get(0),
            )?;
            if existing_count == 0 {
                replace_board(&transaction, &session_id, &board, None)?;
            }
            transaction.execute(
                "INSERT OR REPLACE INTO legacy_migrations(source_path, source_hash, migration_version, imported_at) VALUES (?1, ?2, 1, ?3)",
                params![source_path, source_hash, now_millis()],
            )?;
            transaction.commit()?;
        }
        Ok(())
    }

    fn rotate_backup(&self) -> Result<()> {
        let control_dir = self
            .database_path
            .parent()
            .ok_or_else(|| anyhow!("control database has no parent"))?;
        let backup_dir = control_dir.join("backups");
        fs::create_dir_all(&backup_dir)?;
        let backup_path = backup_dir.join(format!("vibelink-control-{}.sqlite3", now_millis()));
        {
            let connection = self
                .connection
                .lock()
                .expect("control plane mutex poisoned");
            let _: (i64, i64, i64) =
                connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?;
            connection.execute("VACUUM INTO ?1", [backup_path.to_string_lossy().as_ref()])?;
        }
        let mut backups = fs::read_dir(&backup_dir)?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("sqlite3"))
            .collect::<Vec<_>>();
        backups.sort_by_key(|path| {
            fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok()
        });
        while backups.len() > MAX_BACKUPS {
            let oldest = backups.remove(0);
            let _ = fs::remove_file(oldest);
        }
        Ok(())
    }
    pub(crate) fn with_connection<T>(&self, operation: impl FnOnce(&Connection) -> T) -> T {
        let connection = self
            .connection
            .lock()
            .expect("control plane mutex poisoned");
        operation(&connection)
    }

    pub(crate) fn with_connection_mut<T>(&self, operation: impl FnOnce(&mut Connection) -> T) -> T {
        let mut connection = self
            .connection
            .lock()
            .expect("control plane mutex poisoned");
        operation(&mut connection)
    }
}

fn open_connection(path: &Path) -> Result<Connection> {
    let connection = Connection::open(path)
        .with_context(|| format!("open control database {}", path.display()))?;
    connection.busy_timeout(Duration::from_secs(5))?;
    let journal_mode: String =
        connection.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        bail!("control database did not enter WAL mode: {journal_mode}");
    }
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    migrate_schema(&connection)?;
    let integrity: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        bail!("control database quick_check failed: {integrity}");
    }
    Ok(connection)
}

fn migrate_schema(connection: &Connection) -> Result<()> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > CONTROL_SCHEMA_VERSION {
        bail!("control database schema {version} is newer than supported {CONTROL_SCHEMA_VERSION}");
    }
    if version == 0 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
            CREATE TABLE workspace_revisions (
              session_id TEXT PRIMARY KEY,
              revision INTEGER NOT NULL DEFAULT 0,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE work_items (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              position INTEGER NOT NULL,
              title TEXT NOT NULL,
              description TEXT NOT NULL,
              status TEXT NOT NULL CHECK(status IN ('pending','assigned','in-progress','done')),
              task_json TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              UNIQUE(session_id, position)
            );
            CREATE INDEX work_items_session_status ON work_items(session_id, status, position);
            CREATE TABLE workspace_briefs (
              session_id TEXT PRIMARY KEY,
              purpose TEXT NOT NULL,
              notes TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE orchestration_runs (
              id TEXT PRIMARY KEY, session_id TEXT NOT NULL, goal TEXT NOT NULL,
              status TEXT NOT NULL CHECK(status IN ('queued','planning','running','waiting','paused','completed','failed','cancelled')),
              revision INTEGER NOT NULL DEFAULT 0, policy_json TEXT NOT NULL DEFAULT '{}',
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE TABLE orchestration_tasks (
              id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
              title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL CHECK(status IN ('pending','ready','dispatched','completed','failed','blocked','cancelled')),
              revision INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL, result_json TEXT,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE TABLE task_dependencies (
              task_id TEXT NOT NULL REFERENCES orchestration_tasks(id) ON DELETE CASCADE,
              depends_on_task_id TEXT NOT NULL REFERENCES orchestration_tasks(id) ON DELETE CASCADE,
              PRIMARY KEY(task_id, depends_on_task_id), CHECK(task_id <> depends_on_task_id)
            );
            CREATE TABLE agent_instances (
              id TEXT PRIMARY KEY, provider TEXT NOT NULL, profile TEXT,
              workspace_path TEXT NOT NULL, worktree_path TEXT, runtime_identity TEXT,
              status TEXT NOT NULL, resumable INTEGER NOT NULL DEFAULT 0,
              generation INTEGER NOT NULL DEFAULT 0, last_heartbeat_at INTEGER,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE TABLE dispatches (
              id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES orchestration_tasks(id) ON DELETE CASCADE,
              attempt INTEGER NOT NULL, agent_instance_id TEXT REFERENCES agent_instances(id),
              status TEXT NOT NULL CHECK(status IN ('pending','dispatched','running','waiting','completed','failed','circuit_broken','cancelled')),
              pane_id TEXT, process_generation INTEGER, base_revision TEXT, branch TEXT, worktree_path TEXT,
              failure_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
              UNIQUE(task_id, attempt)
            );
            CREATE TABLE messages (
              id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
              task_id TEXT, dispatch_id TEXT, parent_id TEXT, sender_kind TEXT NOT NULL,
              message_type TEXT NOT NULL CHECK(message_type IN ('status','dispatch','worker_done','merge_ready','escalation','handoff','decision_gate','heartbeat','chat')),
              payload_json TEXT NOT NULL, unread INTEGER NOT NULL DEFAULT 1,
              delivered_at INTEGER, created_at INTEGER NOT NULL
            );
            CREATE TABLE decision_gates (
              id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
              task_id TEXT, dispatch_id TEXT,
              status TEXT NOT NULL CHECK(status IN ('pending','resolved','timeout','cancelled')),
              gate_type TEXT NOT NULL, prompt TEXT NOT NULL, options_json TEXT NOT NULL DEFAULT '[]',
              resolution_json TEXT, expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE TABLE run_events (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, domain TEXT NOT NULL,
              event_type TEXT NOT NULL, entity_id TEXT, operation_id TEXT,
              payload_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
            );
            CREATE INDEX run_events_run_sequence ON run_events(run_id, sequence);
            CREATE TABLE event_acknowledgements (
              consumer_id TEXT NOT NULL, run_id TEXT NOT NULL,
              acknowledged_sequence INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
              PRIMARY KEY(consumer_id, run_id)
            );
            CREATE TABLE run_decisions (
              run_id TEXT PRIMARY KEY REFERENCES orchestration_runs(id) ON DELETE CASCADE,
              decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected')),
              payload_json TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE TABLE automations (
              id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL,
              schedule_kind TEXT NOT NULL, schedule_value TEXT NOT NULL, timezone TEXT NOT NULL,
              enabled INTEGER NOT NULL DEFAULT 1, workspace_mode TEXT NOT NULL,
              precheck_json TEXT, policy_json TEXT NOT NULL DEFAULT '{}',
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE TABLE automation_runs (
              id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
              orchestration_run_id TEXT, status TEXT NOT NULL, dispatch_token TEXT NOT NULL UNIQUE,
              output_summary TEXT, output_truncated INTEGER NOT NULL DEFAULT 0,
              precheck_json TEXT, worktree_path TEXT, branch TEXT,
              started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
            );
            CREATE TABLE notifications (
              id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, host_id TEXT,
              kind TEXT NOT NULL, entity_id TEXT, unread INTEGER NOT NULL DEFAULT 1,
              acknowledged_at INTEGER, payload_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
            );
            CREATE TABLE operations (
              operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
              response_json TEXT NOT NULL, created_at INTEGER NOT NULL
            );
            CREATE TABLE legacy_migrations (
              source_path TEXT NOT NULL, source_hash TEXT NOT NULL,
              migration_version INTEGER NOT NULL, imported_at INTEGER NOT NULL,
              PRIMARY KEY(source_path, migration_version)
            );
            PRAGMA user_version = 3;
            COMMIT;",
        )?;
    }
    if version == 1 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
            CREATE TABLE messages_v2 (
              id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
              task_id TEXT, dispatch_id TEXT, parent_id TEXT, sender_kind TEXT NOT NULL,
              message_type TEXT NOT NULL CHECK(message_type IN ('status','dispatch','worker_done','merge_ready','escalation','handoff','decision_gate','heartbeat','chat')),
              payload_json TEXT NOT NULL, unread INTEGER NOT NULL DEFAULT 1,
              delivered_at INTEGER, created_at INTEGER NOT NULL
            );
            INSERT INTO messages_v2(id,run_id,task_id,dispatch_id,parent_id,sender_kind,message_type,payload_json,unread,delivered_at,created_at)
            SELECT id,run_id,task_id,dispatch_id,parent_id,sender_kind,message_type,payload_json,unread,delivered_at,created_at FROM messages;
            DROP TABLE messages;
            ALTER TABLE messages_v2 RENAME TO messages;
            CREATE TABLE event_acknowledgements (
              consumer_id TEXT NOT NULL, run_id TEXT NOT NULL,
              acknowledged_sequence INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
              PRIMARY KEY(consumer_id, run_id)
            );
            CREATE TABLE run_decisions (
              run_id TEXT PRIMARY KEY REFERENCES orchestration_runs(id) ON DELETE CASCADE,
              decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected')),
              payload_json TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            ALTER TABLE automation_runs ADD COLUMN precheck_json TEXT;
            ALTER TABLE automation_runs ADD COLUMN worktree_path TEXT;
            ALTER TABLE automation_runs ADD COLUMN branch TEXT;
            PRAGMA user_version = 3;
            COMMIT;",
        )?;
    }
    if version == 2 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
            CREATE TABLE event_acknowledgements (
              consumer_id TEXT NOT NULL, run_id TEXT NOT NULL,
              acknowledged_sequence INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
              PRIMARY KEY(consumer_id, run_id)
            );
            CREATE TABLE run_decisions (
              run_id TEXT PRIMARY KEY REFERENCES orchestration_runs(id) ON DELETE CASCADE,
              decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected')),
              payload_json TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            ALTER TABLE automation_runs ADD COLUMN precheck_json TEXT;
            ALTER TABLE automation_runs ADD COLUMN worktree_path TEXT;
            ALTER TABLE automation_runs ADD COLUMN branch TEXT;
            PRAGMA user_version = 3;
            COMMIT;",
        )?;
    }
    Ok(())
}

fn execute_read(connection: &Connection, command: ControlCommand) -> Result<ControlResponse> {
    match command {
        ControlCommand::BoardRead { session_id } => {
            Ok(ControlResponse::Board(read_board(connection, &session_id)?))
        }
        ControlCommand::BriefGet { session_id } => {
            Ok(ControlResponse::Brief(read_brief(connection, &session_id)?))
        }
        _ => bail!("mutation command cannot execute through read path"),
    }
}

fn execute_mutation(
    transaction: &Transaction<'_>,
    command: ControlCommand,
) -> Result<ControlResponse> {
    match command {
        ControlCommand::BoardWrite {
            session_id,
            mut board,
            expected_revision,
        } => {
            normalize_board(&mut board);
            replace_board(transaction, &session_id, &board, Some(expected_revision))?;
            Ok(ControlResponse::Ack)
        }
        ControlCommand::TaskCreate {
            session_id,
            title,
            description,
        } => {
            let title = title.trim();
            if title.is_empty() {
                bail!("task title is required");
            }
            let now = now_millis_u64();
            let task = Task {
                id: Uuid::new_v4().to_string(),
                session_id: session_id.clone(),
                title: title.to_string(),
                description: description.unwrap_or_default(),
                status: TaskStatus::Pending,
                status_timestamps: HashMap::from([(TaskStatus::Pending, now)]),
                assigned_pane_id: None,
                assigned_role: None,
                baseline_ref: None,
                worktree_path: None,
                commit_message: None,
                result_summary: None,
                created_at: now,
                updated_at: now,
            };
            let position: i64 = transaction.query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM work_items WHERE session_id = ?1",
                [&session_id],
                |row| row.get(0),
            )?;
            insert_task(transaction, &task, position)?;
            bump_revision(transaction, &session_id)?;
            Ok(ControlResponse::Task(task))
        }
        ControlCommand::TaskUpdate {
            session_id,
            task_id,
            patch,
        } => {
            let mut task = read_task(transaction, &session_id, &task_id)?;
            apply_task_patch(&mut task, patch)?;
            update_task(transaction, &task)?;
            bump_revision(transaction, &session_id)?;
            Ok(ControlResponse::Task(task))
        }
        ControlCommand::TaskDelete {
            session_id,
            task_id,
        } => {
            let position: i64 = transaction
                .query_row(
                    "SELECT position FROM work_items WHERE session_id = ?1 AND id = ?2",
                    params![session_id, task_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| anyhow!("task not found: {task_id}"))?;
            transaction.execute(
                "DELETE FROM work_items WHERE session_id = ?1 AND id = ?2",
                params![session_id, task_id],
            )?;
            transaction.execute("UPDATE work_items SET position = position - 1 WHERE session_id = ?1 AND position > ?2", params![session_id, position])?;
            bump_revision(transaction, &session_id)?;
            Ok(ControlResponse::Ack)
        }
        ControlCommand::TaskDone {
            session_id,
            task_id,
            commit_msg,
            result_summary,
        } => {
            let mut task = read_task(transaction, &session_id, &task_id)?;
            apply_task_patch(
                &mut task,
                TaskPatch {
                    status: Some(TaskStatus::Done),
                    commit_message: commit_msg.map(Some),
                    result_summary: result_summary.map(Some),
                    ..TaskPatch::default()
                },
            )?;
            update_task(transaction, &task)?;
            bump_revision(transaction, &session_id)?;
            Ok(ControlResponse::Task(task))
        }
        ControlCommand::TaskNote {
            session_id,
            task_id,
            message,
        } => {
            let note = message.trim();
            if note.is_empty() {
                bail!("task note is required");
            }
            let mut task = read_task(transaction, &session_id, &task_id)?;
            task.result_summary = Some(
                [task.result_summary.as_deref(), Some(note)]
                    .into_iter()
                    .flatten()
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
            if task.status != TaskStatus::Done {
                task.status = TaskStatus::InProgress;
                task.status_timestamps
                    .insert(TaskStatus::InProgress, now_millis_u64());
            }
            task.updated_at = now_millis_u64();
            update_task(transaction, &task)?;
            bump_revision(transaction, &session_id)?;
            Ok(ControlResponse::Task(task))
        }
        ControlCommand::BriefSet {
            session_id,
            purpose,
            notes,
        } => {
            let brief = Brief {
                purpose: purpose.trim().to_string(),
                notes: notes.trim().to_string(),
                updated_at: chrono::Utc::now().to_rfc3339(),
            };
            transaction.execute(
                "INSERT INTO workspace_briefs(session_id, purpose, notes, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(session_id) DO UPDATE SET purpose=excluded.purpose, notes=excluded.notes, updated_at=excluded.updated_at",
                params![session_id, brief.purpose, brief.notes, brief.updated_at],
            )?;
            bump_revision(transaction, &session_id)?;
            Ok(ControlResponse::Brief(Some(brief)))
        }
        ControlCommand::BoardRead { .. } | ControlCommand::BriefGet { .. } => {
            bail!("read command cannot execute through mutation path")
        }
    }
}

fn read_board(connection: &Connection, session_id: &str) -> Result<BoardDoc> {
    let revision = current_revision(connection, session_id)?;
    let mut statement = connection
        .prepare("SELECT task_json FROM work_items WHERE session_id = ?1 ORDER BY position ASC")?;
    let tasks = statement
        .query_map([session_id], |row| row.get::<_, String>(0))?
        .map(|row| -> Result<Task> { Ok(serde_json::from_str(&row?)?) })
        .collect::<Result<Vec<_>>>()?;
    let task_order = tasks.iter().map(|task| task.id.clone()).collect();
    let tasks = tasks
        .into_iter()
        .map(|task| (task.id.clone(), task))
        .collect();
    Ok(BoardDoc {
        revision,
        tasks,
        task_order,
        brief: read_brief(connection, session_id)?,
    })
}

fn read_brief(connection: &Connection, session_id: &str) -> Result<Option<Brief>> {
    connection
        .query_row(
            "SELECT purpose, notes, updated_at FROM workspace_briefs WHERE session_id = ?1",
            [session_id],
            |row| {
                Ok(Brief {
                    purpose: row.get(0)?,
                    notes: row.get(1)?,
                    updated_at: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

fn replace_board(
    transaction: &Transaction<'_>,
    session_id: &str,
    board: &BoardDoc,
    expected_revision: Option<u64>,
) -> Result<()> {
    let revision = current_revision(transaction, session_id)?;
    if expected_revision.is_some_and(|expected| expected != revision) {
        bail!(
            "stale board revision: expected {}, current {revision}",
            expected_revision.unwrap_or_default()
        );
    }
    transaction.execute("DELETE FROM work_items WHERE session_id = ?1", [session_id])?;
    for (position, task_id) in board.task_order.iter().enumerate() {
        let task = board
            .tasks
            .get(task_id)
            .ok_or_else(|| anyhow!("board order references missing task: {task_id}"))?;
        if task.session_id != session_id {
            bail!("task session does not match board session");
        }
        insert_task(transaction, task, position as i64)?;
    }
    match &board.brief {
        Some(brief) => {
            transaction.execute(
                "INSERT INTO workspace_briefs(session_id, purpose, notes, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(session_id) DO UPDATE SET purpose=excluded.purpose, notes=excluded.notes, updated_at=excluded.updated_at",
                params![session_id, brief.purpose, brief.notes, brief.updated_at],
            )?;
        }
        None => {
            transaction.execute(
                "DELETE FROM workspace_briefs WHERE session_id = ?1",
                [session_id],
            )?;
        }
    }
    set_revision(transaction, session_id, revision.saturating_add(1))?;
    Ok(())
}

fn insert_task(transaction: &Transaction<'_>, task: &Task, position: i64) -> Result<()> {
    transaction.execute(
        "INSERT INTO work_items(id, session_id, position, title, description, status, task_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![task.id, task.session_id, position, task.title, task.description, status_text(task.status), serde_json::to_string(task)?, task.created_at as i64, task.updated_at as i64],
    )?;
    Ok(())
}

fn update_task(transaction: &Transaction<'_>, task: &Task) -> Result<()> {
    let changed = transaction.execute(
        "UPDATE work_items SET title=?3, description=?4, status=?5, task_json=?6, updated_at=?7 WHERE session_id=?1 AND id=?2",
        params![task.session_id, task.id, task.title, task.description, status_text(task.status), serde_json::to_string(task)?, task.updated_at as i64],
    )?;
    if changed != 1 {
        bail!("task not found: {}", task.id);
    }
    Ok(())
}

fn read_task(transaction: &Transaction<'_>, session_id: &str, task_id: &str) -> Result<Task> {
    let json: String = transaction
        .query_row(
            "SELECT task_json FROM work_items WHERE session_id = ?1 AND id = ?2",
            params![session_id, task_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| anyhow!("task not found: {task_id}"))?;
    serde_json::from_str(&json).context("parse stored work item")
}

fn current_revision(connection: &Connection, session_id: &str) -> Result<u64> {
    let value = connection
        .query_row(
            "SELECT revision FROM workspace_revisions WHERE session_id = ?1",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0);
    Ok(value.max(0) as u64)
}

fn bump_revision(transaction: &Transaction<'_>, session_id: &str) -> Result<u64> {
    let next = current_revision(transaction, session_id)?.saturating_add(1);
    set_revision(transaction, session_id, next)?;
    Ok(next)
}

fn set_revision(transaction: &Transaction<'_>, session_id: &str, revision: u64) -> Result<()> {
    transaction.execute(
        "INSERT INTO workspace_revisions(session_id, revision, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision, updated_at=excluded.updated_at",
        params![session_id, revision as i64, now_millis()],
    )?;
    Ok(())
}

fn normalize_board(board: &mut BoardDoc) {
    board.task_order.retain(|id| board.tasks.contains_key(id));
    let mut missing = board
        .tasks
        .values()
        .filter(|task| !board.task_order.contains(&task.id))
        .map(|task| task.id.clone())
        .collect::<Vec<_>>();
    missing.sort_by_key(|id| {
        board
            .tasks
            .get(id)
            .map(|task| task.created_at)
            .unwrap_or_default()
    });
    board.task_order.extend(missing);
}

fn apply_task_patch(task: &mut Task, patch: TaskPatch) -> Result<()> {
    if let Some(title) = patch.title {
        let title = title.unwrap_or_default().trim().to_string();
        if title.is_empty() {
            bail!("task title is required");
        }
        task.title = title;
    }
    if let Some(description) = patch.description {
        task.description = description.unwrap_or_default();
    }
    if let Some(status) = patch.status {
        if status != task.status {
            task.status = status;
            task.status_timestamps.insert(status, now_millis_u64());
        }
    }
    apply_optional_string(&mut task.assigned_pane_id, patch.assigned_pane_id);
    apply_optional_string(&mut task.assigned_role, patch.assigned_role);
    apply_optional_string(&mut task.baseline_ref, patch.baseline_ref);
    apply_optional_string(&mut task.worktree_path, patch.worktree_path);
    apply_optional_string(&mut task.commit_message, patch.commit_message);
    apply_optional_string(&mut task.result_summary, patch.result_summary);
    task.updated_at = now_millis_u64();
    Ok(())
}

fn apply_optional_string(target: &mut Option<String>, patch: Option<Option<String>>) {
    if let Some(value) = patch {
        *target = value.and_then(|value| {
            let trimmed = value.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        });
    }
}

fn status_text(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Pending => "pending",
        TaskStatus::Assigned => "assigned",
        TaskStatus::InProgress => "in-progress",
        TaskStatus::Done => "done",
    }
}

fn validate_session_id(session_id: &str) -> Result<()> {
    Uuid::parse_str(session_id).context("invalid control-plane session id")?;
    Ok(())
}

fn digest_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn now_millis() -> i64 {
    now_millis_u64().min(i64::MAX as u64) as i64
}
fn now_millis_u64() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn is_corruption_error(error: &anyhow::Error) -> bool {
    let message = format!("{error:#}").to_ascii_lowercase();
    message.contains("malformed")
        || message.contains("not a database")
        || message.contains("disk image is malformed")
        || message.contains("quick_check failed")
}

fn quarantine_database(path: &Path) -> Result<()> {
    let suffix = format!("corrupt-{}", now_millis());
    for candidate in [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.display())),
        PathBuf::from(format!("{}-shm", path.display())),
    ] {
        if candidate.exists() {
            let file_name = candidate
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("control.sqlite3");
            fs::rename(
                &candidate,
                candidate.with_file_name(format!("{file_name}.{suffix}")),
            )?;
        }
    }
    Ok(())
}

fn restore_latest_backup(control_dir: &Path, database_path: &Path) -> Result<()> {
    let backup_dir = control_dir.join("backups");
    let mut backups = match fs::read_dir(&backup_dir) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .collect::<Vec<_>>(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    backups.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH)
    });
    if let Some(latest) = backups.pop() {
        fs::copy(latest, database_path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plane() -> (PathBuf, ControlPlane) {
        let directory = std::env::temp_dir().join(format!("vibelink-control-{}", Uuid::new_v4()));
        let plane = ControlPlane::open(&directory).expect("open control plane");
        (directory, plane)
    }

    #[test]
    fn board_mutations_are_revisioned_and_idempotent() {
        let (directory, plane) = plane();
        let session_id = Uuid::new_v4().to_string();
        let operation_id = Uuid::new_v4();
        let command = ControlCommand::TaskCreate {
            session_id: session_id.clone(),
            title: "Ship".into(),
            description: None,
        };
        let first = plane
            .execute(operation_id, command.clone())
            .expect("create task");
        let second = plane
            .execute(operation_id, command)
            .expect("replay create task");
        let (ControlResponse::Task(first), ControlResponse::Task(second)) = (first, second) else {
            panic!("task responses")
        };
        assert_eq!(first.id, second.id);
        let ControlResponse::Board(board) = plane
            .execute(Uuid::new_v4(), ControlCommand::BoardRead { session_id })
            .expect("read board")
        else {
            panic!("board response")
        };
        assert_eq!(board.revision, 1);
        assert_eq!(board.task_order, vec![first.id]);
        drop(plane);
        fs::remove_dir_all(directory).expect("cleanup control plane");
    }

    #[test]
    fn stale_board_replacement_is_rejected() {
        let (directory, plane) = plane();
        let session_id = Uuid::new_v4().to_string();
        plane
            .execute(
                Uuid::new_v4(),
                ControlCommand::TaskCreate {
                    session_id: session_id.clone(),
                    title: "Current".into(),
                    description: None,
                },
            )
            .expect("create task");
        let error = plane
            .execute(
                Uuid::new_v4(),
                ControlCommand::BoardWrite {
                    session_id,
                    board: BoardDoc::default(),
                    expected_revision: 0,
                },
            )
            .expect_err("reject stale board");
        assert!(error.to_string().contains("stale board revision"));
        drop(plane);
        fs::remove_dir_all(directory).expect("cleanup control plane");
    }

    #[test]
    fn schema_contains_all_control_domains() {
        let (directory, plane) = plane();
        let connection = plane.connection.lock().expect("control plane mutex");
        for table in [
            "work_items",
            "workspace_briefs",
            "orchestration_runs",
            "orchestration_tasks",
            "task_dependencies",
            "dispatches",
            "agent_instances",
            "messages",
            "decision_gates",
            "run_events",
            "automations",
            "automation_runs",
            "notifications",
        ] {
            let exists: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |row| row.get(0),
                )
                .expect("query table");
            assert_eq!(exists, 1, "missing {table}");
        }
        drop(connection);
        drop(plane);
        fs::remove_dir_all(directory).expect("cleanup control plane");
    }

    #[test]
    fn message_schema_accepts_chat_messages() {
        let (directory, plane) = plane();
        let connection = plane.connection.lock().expect("control plane mutex");
        connection
            .execute(
                "INSERT INTO orchestration_runs(id,session_id,goal,status,revision,policy_json,created_at,updated_at) VALUES('run','session','goal','running',0,'{}',1,1)",
                [],
            )
            .expect("insert orchestration run");
        connection
            .execute(
                "INSERT INTO messages(id,run_id,sender_kind,message_type,payload_json,unread,created_at) VALUES('message','run','cli','chat','{}',1,1)",
                [],
            )
            .expect("insert chat message");
        drop(connection);
        drop(plane);
        fs::remove_dir_all(directory).expect("cleanup control plane");
    }

    #[test]
    fn version_one_messages_are_preserved_when_chat_is_added() {
        let connection = Connection::open_in_memory().expect("open legacy database");
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                CREATE TABLE orchestration_runs (
                  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, goal TEXT NOT NULL,
                  status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
                  policy_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                );
                CREATE TABLE messages (
                  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
                  task_id TEXT, dispatch_id TEXT, parent_id TEXT, sender_kind TEXT NOT NULL,
                  message_type TEXT NOT NULL CHECK(message_type IN ('status','dispatch','worker_done','merge_ready','escalation','handoff','decision_gate','heartbeat')),
                  payload_json TEXT NOT NULL, unread INTEGER NOT NULL DEFAULT 1,
                  delivered_at INTEGER, created_at INTEGER NOT NULL
                );
                CREATE TABLE automation_runs (
                  id TEXT PRIMARY KEY, automation_id TEXT NOT NULL,
                  orchestration_run_id TEXT, status TEXT NOT NULL,
                  dispatch_token TEXT NOT NULL UNIQUE, output_summary TEXT,
                  output_truncated INTEGER NOT NULL DEFAULT 0,
                  started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
                );
                INSERT INTO orchestration_runs(id,session_id,goal,status,revision,policy_json,created_at,updated_at)
                VALUES('run','session','goal','running',0,'{}',1,1);
                INSERT INTO messages(id,run_id,sender_kind,message_type,payload_json,unread,created_at)
                VALUES('status-message','run','coordinator','status','{}',1,1);
                PRAGMA user_version = 1;",
            )
            .expect("seed version one database");

        migrate_schema(&connection).expect("migrate version one database");

        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read schema version");
        assert_eq!(version, CONTROL_SCHEMA_VERSION);
        let preserved: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE id='status-message'",
                [],
                |row| row.get(0),
            )
            .expect("read preserved message");
        assert_eq!(preserved, 1);
        connection
            .execute(
                "INSERT INTO messages(id,run_id,sender_kind,message_type,payload_json,unread,created_at) VALUES('chat-message','run','cli','chat','{}',1,2)",
                [],
            )
            .expect("insert chat message after migration");
    }

    #[test]
    fn corrupt_database_is_quarantined_and_recreated() {
        let directory =
            std::env::temp_dir().join(format!("vibelink-control-corrupt-{}", Uuid::new_v4()));
        let control_dir = directory.join("control");
        fs::create_dir_all(&control_dir).expect("create control directory");
        let database = control_dir.join("vibelink-control.sqlite3");
        fs::write(&database, b"not a sqlite database").expect("seed corrupt database");

        let plane = ControlPlane::open(&directory).expect("recover corrupt database");

        assert!(database.exists());
        assert!(fs::read_dir(&control_dir)
            .expect("list control directory")
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-")));
        drop(plane);
        fs::remove_dir_all(directory).expect("cleanup control plane");
    }

    #[test]
    fn legacy_board_imports_once_and_preserves_user_fields() {
        let directory =
            std::env::temp_dir().join(format!("vibelink-control-legacy-{}", Uuid::new_v4()));
        let session_id = Uuid::new_v4().to_string();
        let legacy_dir = directory.join("kanban");
        fs::create_dir_all(&legacy_dir).expect("create legacy directory");
        let legacy_path = legacy_dir.join(format!("{session_id}.json"));
        let task = Task {
            id: "legacy-task".to_string(),
            session_id: session_id.clone(),
            title: "Legacy title".to_string(),
            description: "Legacy description".to_string(),
            status: TaskStatus::Assigned,
            status_timestamps: HashMap::from([
                (TaskStatus::Pending, 10),
                (TaskStatus::Assigned, 20),
            ]),
            assigned_pane_id: Some("pane-1".to_string()),
            assigned_role: Some("Reviewer".to_string()),
            baseline_ref: Some("base".to_string()),
            worktree_path: Some("E:/worktree".to_string()),
            commit_message: None,
            result_summary: None,
            created_at: 10,
            updated_at: 20,
        };
        let brief = Brief {
            purpose: "Preserve purpose".to_string(),
            notes: "Preserve notes".to_string(),
            updated_at: "2026-07-21T00:00:00Z".to_string(),
        };
        let board = BoardDoc {
            revision: 7,
            tasks: HashMap::from([(task.id.clone(), task.clone())]),
            task_order: vec![task.id.clone()],
            brief: Some(brief.clone()),
        };
        fs::write(
            &legacy_path,
            serde_json::to_vec(&board).expect("serialize legacy board"),
        )
        .expect("write legacy board");

        let plane = ControlPlane::open(&directory).expect("import legacy board");
        let ControlResponse::Board(imported) = plane
            .execute(
                Uuid::new_v4(),
                ControlCommand::BoardRead {
                    session_id: session_id.clone(),
                },
            )
            .expect("read imported board")
        else {
            panic!("board response");
        };
        assert_eq!(imported.task_order, vec![task.id.clone()]);
        assert_eq!(imported.tasks[&task.id], task);
        assert_eq!(imported.brief, Some(brief));
        plane
            .execute(
                Uuid::new_v4(),
                ControlCommand::TaskDelete {
                    session_id: session_id.clone(),
                    task_id: "legacy-task".to_string(),
                },
            )
            .expect("delete imported task");
        drop(plane);

        let reopened = ControlPlane::open(&directory).expect("reopen control plane");
        let ControlResponse::Board(after) = reopened
            .execute(Uuid::new_v4(), ControlCommand::BoardRead { session_id })
            .expect("read after reopen")
        else {
            panic!("board response");
        };
        assert!(
            after.task_order.is_empty(),
            "legacy board must not re-import"
        );
        assert!(legacy_path.with_extension("json.rollback-v1").exists());
        drop(reopened);
        fs::remove_dir_all(directory).expect("cleanup control plane");
    }
}
