use crate::{
    agent_runtime::WorktreeManager,
    app::git::worktree_registry::WorktreeRegistry,
    orchestration::{
        CoordinatorService, CreateRunRequest, CreateTaskRequest, RunPolicy, RunRevisionRequest,
        ScheduleRequest, WorktreeAssignment,
    },
};
use anyhow::{bail, Context, Result};
use chrono::{DateTime, Datelike, Timelike, Utc, Weekday};
use chrono_tz::Tz;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

const MAX_PRECHECK_SECONDS: u64 = 600;
const DEFAULT_PRECHECK_SECONDS: u64 = 60;
const MAX_PRECHECK_OUTPUT_BYTES: usize = 64 * 1024;
const RETAIN_FINAL_RUNS: i64 = 100;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRecord {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub schedule_kind: String,
    pub schedule_value: String,
    pub timezone: String,
    pub enabled: bool,
    pub workspace_mode: String,
    pub precheck: Value,
    pub policy: Value,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunRecord {
    pub id: String,
    pub automation_id: String,
    pub orchestration_run_id: Option<String>,
    pub status: String,
    pub dispatch_token: String,
    pub output_summary: Option<String>,
    pub output_truncated: bool,
    pub precheck: Option<Value>,
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    pub worktree_id: Option<String>,
    pub worktree_instance_id: Option<String>,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub created_at: u64,
}

#[derive(Clone, Debug)]
pub struct CreateAutomation {
    pub session_id: String,
    pub name: String,
    pub schedule_kind: String,
    pub schedule_value: String,
    pub timezone: String,
    pub workspace_mode: String,
    pub precheck: Value,
    pub policy: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrecheckResult {
    pub ok: bool,
    pub workspace_exists: bool,
    pub git_ready: bool,
    pub timed_out: bool,
    pub output: String,
    pub output_truncated: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct AutomationWorktreeProvision {
    pub assignment: WorktreeAssignment,
    pub session_id: String,
}

pub struct AutomationService {
    connection: Mutex<Connection>,
    coordinator: Arc<CoordinatorService>,
    worktrees: WorktreeManager,
}

impl AutomationService {
    pub fn open(
        database_path: &Path,
        artifact_root: PathBuf,
        coordinator: Arc<CoordinatorService>,
        registry: Arc<WorktreeRegistry>,
    ) -> Result<Self> {
        fs::create_dir_all(&artifact_root)?;
        let connection = Connection::open(database_path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;",
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
            coordinator,
            worktrees: WorktreeManager::new(artifact_root.join("worktrees"), registry)?,
        })
    }

    pub fn list(&self, session_id: Option<&str>) -> Result<Vec<AutomationRecord>> {
        let connection = self.lock()?;
        let sql = if session_id.is_some() {
            "SELECT id,session_id,name,schedule_kind,schedule_value,timezone,enabled,workspace_mode,precheck_json,policy_json,created_at,updated_at FROM automations WHERE session_id=?1 ORDER BY name,id"
        } else {
            "SELECT id,session_id,name,schedule_kind,schedule_value,timezone,enabled,workspace_mode,precheck_json,policy_json,created_at,updated_at FROM automations ORDER BY name,id"
        };
        let mut statement = connection.prepare(sql)?;
        let records = if let Some(session_id) = session_id {
            statement
                .query_map([session_id], read_automation)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            statement
                .query_map([], read_automation)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        Ok(records)
    }

    pub fn get(&self, id: &str) -> Result<AutomationRecord> {
        self.lock()?
            .query_row(
                "SELECT id,session_id,name,schedule_kind,schedule_value,timezone,enabled,workspace_mode,precheck_json,policy_json,created_at,updated_at FROM automations WHERE id=?1",
                [id],
                read_automation,
            )
            .optional()?
            .with_context(|| format!("automation not found: {id}"))
    }

    pub fn create(&self, request: CreateAutomation) -> Result<AutomationRecord> {
        validate_automation(&request)?;
        let id = Uuid::new_v4().to_string();
        let now = now_millis();
        self.lock()?.execute(
            "INSERT INTO automations(id,session_id,name,schedule_kind,schedule_value,timezone,enabled,workspace_mode,precheck_json,policy_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,1,?7,?8,?9,?10,?10)",
            params![id,request.session_id,request.name.trim(),request.schedule_kind,request.schedule_value,request.timezone,request.workspace_mode,request.precheck.to_string(),request.policy.to_string(),now as i64],
        )?;
        self.get(&id)
    }

    pub fn update(&self, id: &str, patch: &Value) -> Result<AutomationRecord> {
        let mut record = self.get(id)?;
        if let Some(value) = patch.get("name").and_then(Value::as_str) {
            record.name = value.to_string();
        }
        if let Some(value) = patch.get("scheduleKind").and_then(Value::as_str) {
            record.schedule_kind = value.to_string();
        }
        if let Some(value) = patch.get("scheduleValue").and_then(Value::as_str) {
            record.schedule_value = value.to_string();
        }
        if let Some(value) = patch.get("timezone").and_then(Value::as_str) {
            record.timezone = value.to_string();
        }
        if let Some(value) = patch.get("enabled").and_then(Value::as_bool) {
            record.enabled = value;
        }
        if let Some(value) = patch.get("workspaceMode").and_then(Value::as_str) {
            record.workspace_mode = value.to_string();
        }
        if let Some(value) = patch.get("precheck") {
            record.precheck = value.clone();
        }
        if let Some(value) = patch.get("policy") {
            record.policy = value.clone();
        }
        validate_automation(&CreateAutomation {
            session_id: record.session_id.clone(),
            name: record.name.clone(),
            schedule_kind: record.schedule_kind.clone(),
            schedule_value: record.schedule_value.clone(),
            timezone: record.timezone.clone(),
            workspace_mode: record.workspace_mode.clone(),
            precheck: record.precheck.clone(),
            policy: record.policy.clone(),
        })?;
        record.updated_at = now_millis();
        self.lock()?.execute(
            "UPDATE automations SET name=?2,schedule_kind=?3,schedule_value=?4,timezone=?5,enabled=?6,workspace_mode=?7,precheck_json=?8,policy_json=?9,updated_at=?10 WHERE id=?1",
            params![record.id,record.name,record.schedule_kind,record.schedule_value,record.timezone,record.enabled as i64,record.workspace_mode,record.precheck.to_string(),record.policy.to_string(),record.updated_at as i64],
        )?;
        self.get(id)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let changed = self
            .lock()?
            .execute("DELETE FROM automations WHERE id=?1", [id])?;
        if changed == 0 {
            bail!("automation not found: {id}");
        }
        Ok(())
    }

    pub fn runs(&self, automation_id: &str, limit: u32) -> Result<Vec<AutomationRunRecord>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id,automation_id,orchestration_run_id,status,dispatch_token,output_summary,output_truncated,precheck_json,worktree_path,branch,worktree_id,worktree_instance_id,started_at,finished_at,created_at FROM automation_runs WHERE automation_id=?1 ORDER BY created_at DESC,id DESC LIMIT ?2",
        )?;
        let runs = statement
            .query_map(params![automation_id, limit.clamp(1, 500)], read_run)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(runs)
    }

    pub fn trigger(&self, automation_id: &str) -> Result<AutomationRunRecord> {
        let automation = self.get(automation_id)?;
        self.enforce_resource_budget(&automation)?;
        self.insert_claim(automation_id, format!("manual:{}", Uuid::new_v4()))
    }

    pub fn claim_due(&self, now: DateTime<Utc>) -> Result<Vec<AutomationRunRecord>> {
        let records = self.list(None)?;
        let mut claims = Vec::new();
        for automation in records.into_iter().filter(|record| record.enabled) {
            if self.enforce_resource_budget(&automation).is_err() {
                continue;
            }
            let last_created = self
                .lock()?
                .query_row(
                    "SELECT MAX(created_at) FROM automation_runs WHERE automation_id=?1",
                    [automation.id.as_str()],
                    |row| row.get::<_, Option<i64>>(0),
                )?
                .map(|value| value as u64);
            if let Some(token) = due_token(&automation, now, last_created)? {
                match self.insert_claim(&automation.id, token) {
                    Ok(claim) => claims.push(claim),
                    Err(error) if error.to_string().contains("UNIQUE constraint failed") => {}
                    Err(error) => return Err(error),
                }
            }
        }
        Ok(claims)
    }

    pub fn precheck(&self, automation: &AutomationRecord, workspace: &Path) -> PrecheckResult {
        run_precheck(automation, workspace)
    }

    pub fn execute(
        &self,
        claim: &AutomationRunRecord,
        workspace: &Path,
    ) -> Result<AutomationRunRecord> {
        self.execute_with_worktree(claim, workspace, |_, _, _, _| {
            bail!("automation worktree provisioning requires the daemon lifecycle service")
        })
    }

    pub(crate) fn execute_with_worktree<F>(
        &self,
        claim: &AutomationRunRecord,
        workspace: &Path,
        create_worktree: F,
    ) -> Result<AutomationRunRecord>
    where
        F: FnOnce(
            &AutomationRecord,
            &AutomationRunRecord,
            &Path,
            &WorktreeAssignment,
        ) -> Result<AutomationWorktreeProvision>,
    {
        let automation = self.get(&claim.automation_id)?;
        let precheck = self.precheck(&automation, workspace);
        if !precheck.ok {
            self.finish(
                &claim.id,
                "skipped",
                Some(&format!("precheck failed: {}", precheck.output)),
                precheck.output_truncated,
                Some(&serde_json::to_value(&precheck)?),
            )?;
            return self.run(&claim.id);
        }

        let mut worktree = None;
        let mut run_session_id = automation.session_id.clone();
        let run_workspace = if automation.workspace_mode == "worktree" {
            let authority = self.worktrees.authority(workspace)?;
            let planned = self
                .worktrees
                .plan(&authority, &automation.id, &claim.id, 1)?;
            let provision = create_worktree(&automation, claim, workspace, &planned)?;
            let path = PathBuf::from(&provision.assignment.worktree_path);
            run_session_id = provision.session_id;
            worktree = Some(provision.assignment);
            path
        } else {
            workspace.to_path_buf()
        };
        let goal = automation
            .policy
            .get("goal")
            .and_then(Value::as_str)
            .context("automation mission goal missing")?
            .trim()
            .to_string();
        let max_concurrent = automation
            .policy
            .get("maxConcurrent")
            .and_then(Value::as_u64)
            .unwrap_or(4)
            .clamp(1, 32) as u32;
        let run = self
            .coordinator
            .create_run(
                Uuid::new_v4(),
                CreateRunRequest {
                    session_id: run_session_id,
                    goal: goal.clone(),
                    policy: RunPolicy { max_concurrent },
                },
            )
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let task_titles = automation
            .policy
            .get("tasks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| vec![Value::String(goal)]);
        let mut run_revision = run.revision;
        for task in task_titles {
            let (title, description) = match task {
                Value::String(title) => (title, String::new()),
                Value::Object(object) => (
                    object
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("Automation mission")
                        .to_string(),
                    object
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                ),
                _ => continue,
            };
            self.coordinator
                .create_task(
                    Uuid::new_v4(),
                    CreateTaskRequest {
                        run_id: run.id.clone(),
                        title,
                        description,
                        dependencies: Vec::new(),
                        expected_run_revision: run_revision,
                    },
                )
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            run_revision = self
                .coordinator
                .run(&run.id)
                .map_err(|error| anyhow::anyhow!(error.to_string()))?
                .revision;
        }
        let started = self
            .coordinator
            .start_run(
                Uuid::new_v4(),
                RunRevisionRequest {
                    run_id: run.id.clone(),
                    expected_run_revision: run_revision,
                },
            )
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        self.coordinator
            .schedule_ready(
                Uuid::new_v4(),
                ScheduleRequest {
                    run_id: run.id.clone(),
                    expected_run_revision: started.revision,
                },
            )
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;

        let now = now_millis();
        self.lock()?.execute(
            "UPDATE automation_runs SET orchestration_run_id=?2,status='running',precheck_json=?3,worktree_path=?4,branch=?5,worktree_id=?6,worktree_instance_id=?7,started_at=?8,output_summary=?9 WHERE id=?1",
            params![claim.id,run.id,serde_json::to_string(&precheck)?,worktree.as_ref().map(|value| value.worktree_path.as_str()),worktree.as_ref().map(|value| value.branch.as_str()),worktree.as_ref().and_then(|value| value.worktree_id.as_deref()),worktree.as_ref().and_then(|value| value.instance_id.as_deref()),now as i64,format!("Mission launched in {}",run_workspace.display())],
        )?;
        self.run(&claim.id)
    }

    pub fn sync_run(&self, run_id: &str, _workspace: &Path) -> Result<AutomationRunRecord> {
        let record = self.run(run_id)?;
        if record.status != "running" {
            return Ok(record);
        }
        let Some(orchestration_run_id) = record.orchestration_run_id.as_deref() else {
            return Ok(record);
        };
        let run = self
            .coordinator
            .run(orchestration_run_id)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let status = match run.status {
            crate::orchestration::RunStatus::Completed => Some("completed"),
            crate::orchestration::RunStatus::Failed => Some("failed"),
            crate::orchestration::RunStatus::Cancelled => Some("cancelled"),
            _ => None,
        };
        if let Some(status) = status {
            self.finish(
                &record.id,
                status,
                Some(&format!("Coordinator run {} {status}", run.id)),
                false,
                record.precheck.as_ref(),
            )?;
        }
        self.run(run_id)
    }

    fn enforce_resource_budget(&self, automation: &AutomationRecord) -> Result<()> {
        let max_active = automation
            .policy
            .get("resourceBudget")
            .and_then(|value| value.get("maxActiveRuns"))
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .clamp(1, 32) as i64;
        let active = self.lock()?.query_row(
            "SELECT COUNT(*) FROM automation_runs WHERE automation_id=?1 AND status IN ('queued','running')",
            [&automation.id],
            |row| row.get::<_,i64>(0),
        )?;
        if active >= max_active {
            bail!("automation resource budget is full");
        }
        Ok(())
    }

    fn insert_claim(
        &self,
        automation_id: &str,
        dispatch_token: String,
    ) -> Result<AutomationRunRecord> {
        let id = Uuid::new_v4().to_string();
        let now = now_millis();
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO automation_runs(id,automation_id,status,dispatch_token,output_truncated,created_at) VALUES(?1,?2,'queued',?3,0,?4)",
            params![id,automation_id,dispatch_token,now as i64],
        )?;
        transaction.commit()?;
        drop(connection);
        self.run(&id)
    }

    fn finish(
        &self,
        run_id: &str,
        status: &str,
        summary: Option<&str>,
        truncated: bool,
        precheck: Option<&Value>,
    ) -> Result<()> {
        let now = now_millis();
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "UPDATE automation_runs SET status=?2,output_summary=?3,output_truncated=?4,precheck_json=COALESCE(?5,precheck_json),finished_at=?6 WHERE id=?1",
            params![run_id,status,summary,truncated as i64,precheck.map(Value::to_string),now as i64],
        )?;
        let sequence = transaction.query_row(
            "SELECT COALESCE(MAX(sequence),0)+1 FROM notifications",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        transaction.execute(
            "INSERT INTO notifications(id,sequence,kind,entity_id,payload_json,created_at) VALUES(?1,?2,'automation.completed',?3,?4,?5)",
            params![Uuid::new_v4().to_string(),sequence,run_id,json!({"status":status}).to_string(),now as i64],
        )?;
        transaction.execute(
            "DELETE FROM automation_runs WHERE id IN (SELECT id FROM automation_runs WHERE automation_id=(SELECT automation_id FROM automation_runs WHERE id=?1) AND status NOT IN ('queued','running') ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET ?2)",
            params![run_id,RETAIN_FINAL_RUNS],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn run(&self, id: &str) -> Result<AutomationRunRecord> {
        self.lock()?.query_row(
            "SELECT id,automation_id,orchestration_run_id,status,dispatch_token,output_summary,output_truncated,precheck_json,worktree_path,branch,worktree_id,worktree_instance_id,started_at,finished_at,created_at FROM automation_runs WHERE id=?1",
            [id],read_run,
        ).optional()?.with_context(||format!("automation run not found: {id}"))
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| anyhow::anyhow!("automation database mutex poisoned"))
    }
}

fn validate_automation(request: &CreateAutomation) -> Result<()> {
    validate_schedule(
        &request.schedule_kind,
        &request.schedule_value,
        &request.timezone,
    )?;
    if request.name.trim().is_empty() {
        bail!("automation name is required");
    }
    if !matches!(request.workspace_mode.as_str(), "reuse" | "worktree") {
        bail!("workspace mode must be reuse or worktree");
    }
    let goal = request
        .policy
        .get("goal")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if goal.is_empty() {
        bail!("automation policy mission goal is required");
    }
    if let Some(seconds) = request
        .precheck
        .get("timeoutSeconds")
        .and_then(Value::as_u64)
    {
        if seconds == 0 || seconds > MAX_PRECHECK_SECONDS {
            bail!("precheck timeout must be between 1 and 600 seconds");
        }
    }
    Ok(())
}

fn run_precheck(automation: &AutomationRecord, workspace: &Path) -> PrecheckResult {
    let workspace_exists = workspace.is_dir();
    let require_git = automation.workspace_mode == "worktree"
        || automation
            .precheck
            .get("requireGit")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    let git_ready = !require_git
        || (workspace_exists
            && Command::new("git")
                .args(["rev-parse", "--is-inside-work-tree"])
                .current_dir(workspace)
                .output()
                .is_ok_and(|output| output.status.success()));
    let Some(command) = automation
        .precheck
        .get("command")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    else {
        return PrecheckResult {
            ok: workspace_exists && git_ready,
            workspace_exists,
            git_ready,
            timed_out: false,
            output: String::new(),
            output_truncated: false,
        };
    };
    if !workspace_exists || !git_ready {
        return PrecheckResult {
            ok: false,
            workspace_exists,
            git_ready,
            timed_out: false,
            output: "workspace or Git precheck failed".to_string(),
            output_truncated: false,
        };
    }
    let timeout = automation
        .precheck
        .get("timeoutSeconds")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_PRECHECK_SECONDS)
        .clamp(1, MAX_PRECHECK_SECONDS);
    let output_file =
        std::env::temp_dir().join(format!("vibelink-precheck-{}.log", Uuid::new_v4()));
    let result = (|| -> Result<(bool, bool, Vec<u8>)> {
        let output = fs::File::create(&output_file)?;
        let error_output = output.try_clone()?;
        #[cfg(windows)]
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/S", "/C", command])
            .current_dir(workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::from(output))
            .stderr(Stdio::from(error_output))
            .spawn()?;
        #[cfg(not(windows))]
        let mut child = Command::new("sh")
            .args(["-c", command])
            .current_dir(workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::from(output))
            .stderr(Stdio::from(error_output))
            .spawn()?;
        let deadline = Instant::now() + Duration::from_secs(timeout);
        let (success, timed_out) = loop {
            if let Some(status) = child.try_wait()? {
                break (status.success(), false);
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                break (false, true);
            }
            thread::sleep(Duration::from_millis(50));
        };
        Ok((
            success,
            timed_out,
            fs::read(&output_file).unwrap_or_default(),
        ))
    })();
    let _ = fs::remove_file(&output_file);
    match result {
        Ok((success, timed_out, bytes)) => {
            let truncated = bytes.len() > MAX_PRECHECK_OUTPUT_BYTES;
            let start = bytes.len().saturating_sub(MAX_PRECHECK_OUTPUT_BYTES);
            PrecheckResult {
                ok: success && !timed_out,
                workspace_exists,
                git_ready,
                timed_out,
                output: String::from_utf8_lossy(&bytes[start..]).to_string(),
                output_truncated: truncated,
            }
        }
        Err(error) => PrecheckResult {
            ok: false,
            workspace_exists,
            git_ready,
            timed_out: false,
            output: error.to_string(),
            output_truncated: false,
        },
    }
}

fn validate_schedule(kind: &str, value: &str, timezone: &str) -> Result<()> {
    let _: Tz = timezone
        .parse()
        .with_context(|| format!("unknown timezone: {timezone}"))?;
    match kind {
        "once" => {
            DateTime::parse_from_rfc3339(value).context("once schedule must be RFC3339")?;
        }
        "interval" => {
            if value
                .parse::<u64>()
                .context("interval schedule must be seconds")?
                == 0
            {
                bail!("interval must be positive");
            }
        }
        "hourly" => validate_minute(value)?,
        "daily" | "weekdays" => {
            parse_time(value)?;
        }
        "weekly" => {
            parse_weekly(value)?;
        }
        "cron" => {
            let fields = value.split_whitespace().collect::<Vec<_>>();
            if fields.len() != 5 {
                bail!("cron schedule must have five fields");
            }
            for field in fields {
                validate_cron_field(field)?;
            }
        }
        "rrule" => {
            parse_rrule(value)?;
        }
        _ => bail!("unsupported automation schedule kind"),
    }
    Ok(())
}

fn due_token(
    record: &AutomationRecord,
    now: DateTime<Utc>,
    last_created: Option<u64>,
) -> Result<Option<String>> {
    let timezone: Tz = record.timezone.parse()?;
    let local = now.with_timezone(&timezone);
    let last = last_created.unwrap_or(0);
    let token = match record.schedule_kind.as_str() {
        "once" => {
            if last_created.is_some() {
                return Ok(None);
            }
            let when = DateTime::parse_from_rfc3339(&record.schedule_value)?.with_timezone(&Utc);
            (now >= when).then(|| format!("once:{}", when.timestamp()))
        }
        "interval" => {
            let seconds = record.schedule_value.parse::<u64>()?;
            (now.timestamp_millis().max(0) as u64 >= last.saturating_add(seconds * 1000))
                .then(|| format!("interval:{}", now.timestamp() / seconds as i64))
        }
        "hourly" => {
            let minute = record.schedule_value.parse::<u32>()?;
            (local.minute() >= minute).then(|| format!("hourly:{}", now.timestamp() / 3600))
        }
        "daily" => {
            let (hour, minute) = parse_time(&record.schedule_value)?;
            ((local.hour(), local.minute()) >= (hour, minute))
                .then(|| format!("daily:{}", local.date_naive()))
        }
        "weekdays" => {
            let (hour, minute) = parse_time(&record.schedule_value)?;
            (!matches!(local.weekday(), Weekday::Sat | Weekday::Sun)
                && (local.hour(), local.minute()) >= (hour, minute))
                .then(|| format!("weekdays:{}", local.date_naive()))
        }
        "weekly" => {
            let (weekday, hour, minute) = parse_weekly(&record.schedule_value)?;
            (local.weekday() == weekday && (local.hour(), local.minute()) >= (hour, minute)).then(
                || {
                    format!(
                        "weekly:{}-{}",
                        local.iso_week().year(),
                        local.iso_week().week()
                    )
                },
            )
        }
        "cron" => {
            let fields = record.schedule_value.split_whitespace().collect::<Vec<_>>();
            (cron_matches(fields[0], local.minute())
                && cron_matches(fields[1], local.hour())
                && cron_matches(fields[2], local.day())
                && cron_matches(fields[3], local.month())
                && cron_matches(fields[4], local.weekday().num_days_from_sunday()))
            .then(|| format!("cron:{}", now.timestamp() / 60))
        }
        "rrule" => rrule_due_token(&record.schedule_value, local, now)?,
        _ => None,
    };
    Ok(token)
}

fn validate_minute(value: &str) -> Result<()> {
    let minute = value
        .parse::<u32>()
        .context("hourly schedule must be a minute")?;
    if minute > 59 {
        bail!("hourly minute must be 0-59");
    }
    Ok(())
}
fn parse_time(value: &str) -> Result<(u32, u32)> {
    let (hour, minute) = value
        .split_once(':')
        .context("schedule time must be HH:MM")?;
    let hour = hour.parse::<u32>()?;
    let minute = minute.parse::<u32>()?;
    if hour > 23 || minute > 59 {
        bail!("invalid schedule time");
    }
    Ok((hour, minute))
}
fn parse_weekly(value: &str) -> Result<(Weekday, u32, u32)> {
    let (day, time) = value
        .split_once('@')
        .context("weekly schedule must be DAY@HH:MM")?;
    Ok((
        parse_weekday(day)?,
        parse_time(time)?.0,
        parse_time(time)?.1,
    ))
}
fn parse_weekday(value: &str) -> Result<Weekday> {
    match value.to_ascii_uppercase().as_str() {
        "MON" => Ok(Weekday::Mon),
        "TUE" => Ok(Weekday::Tue),
        "WED" => Ok(Weekday::Wed),
        "THU" => Ok(Weekday::Thu),
        "FRI" => Ok(Weekday::Fri),
        "SAT" => Ok(Weekday::Sat),
        "SUN" => Ok(Weekday::Sun),
        _ => bail!("invalid weekday"),
    }
}

fn parse_rrule(value: &str) -> Result<(String, u32, Option<Vec<Weekday>>)> {
    let mut frequency = None;
    let mut interval = 1;
    let mut byday = None;
    for part in value.split(';') {
        let (key, value) = part.split_once('=').context("invalid RRULE component")?;
        match key.to_ascii_uppercase().as_str() {
            "FREQ" => frequency = Some(value.to_ascii_uppercase()),
            "INTERVAL" => interval = value.parse::<u32>()?.max(1),
            "BYDAY" => {
                byday = Some(
                    value
                        .split(',')
                        .map(parse_weekday)
                        .collect::<Result<Vec<_>>>()?,
                )
            }
            _ => {}
        }
    }
    let frequency = frequency.context("RRULE FREQ is required")?;
    if !matches!(frequency.as_str(), "HOURLY" | "DAILY" | "WEEKLY") {
        bail!("RRULE supports HOURLY, DAILY, or WEEKLY");
    }
    Ok((frequency, interval, byday))
}
fn rrule_due_token(value: &str, local: DateTime<Tz>, now: DateTime<Utc>) -> Result<Option<String>> {
    let (frequency, interval, byday) = parse_rrule(value)?;
    let allowed = byday
        .as_ref()
        .is_none_or(|days| days.contains(&local.weekday()));
    if !allowed {
        return Ok(None);
    }
    let bucket = match frequency.as_str() {
        "HOURLY" => now.timestamp() / 3600 / interval as i64,
        "DAILY" => now.timestamp() / 86400 / interval as i64,
        "WEEKLY" => now.timestamp() / (86400 * 7) / interval as i64,
        _ => 0,
    };
    Ok(Some(format!("rrule:{frequency}:{bucket}")))
}
fn validate_cron_field(field: &str) -> Result<()> {
    if field == "*" {
        return Ok(());
    }
    if let Some(step) = field.strip_prefix("*/") {
        if step.parse::<u32>().is_ok_and(|value| value > 0) {
            return Ok(());
        }
    }
    for part in field.split(',') {
        if part.parse::<u32>().is_err() {
            bail!("unsupported cron field: {field}");
        }
    }
    Ok(())
}
fn cron_matches(field: &str, value: u32) -> bool {
    if field == "*" {
        return true;
    }
    if let Some(step) = field
        .strip_prefix("*/")
        .and_then(|value| value.parse::<u32>().ok())
    {
        return step > 0 && value % step == 0;
    }
    field
        .split(',')
        .filter_map(|part| part.parse::<u32>().ok())
        .any(|candidate| candidate == value)
}

fn read_automation(row: &rusqlite::Row<'_>) -> rusqlite::Result<AutomationRecord> {
    let precheck: String = row.get(8)?;
    let policy: String = row.get(9)?;
    Ok(AutomationRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        name: row.get(2)?,
        schedule_kind: row.get(3)?,
        schedule_value: row.get(4)?,
        timezone: row.get(5)?,
        enabled: row.get::<_, i64>(6)? != 0,
        workspace_mode: row.get(7)?,
        precheck: serde_json::from_str(&precheck).unwrap_or(Value::Null),
        policy: serde_json::from_str(&policy).unwrap_or(Value::Null),
        created_at: row.get::<_, i64>(10)?.max(0) as u64,
        updated_at: row.get::<_, i64>(11)?.max(0) as u64,
    })
}
fn read_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<AutomationRunRecord> {
    let precheck: Option<String> = row.get(7)?;
    Ok(AutomationRunRecord {
        id: row.get(0)?,
        automation_id: row.get(1)?,
        orchestration_run_id: row.get(2)?,
        status: row.get(3)?,
        dispatch_token: row.get(4)?,
        output_summary: row.get(5)?,
        output_truncated: row.get::<_, i64>(6)? != 0,
        precheck: precheck.and_then(|value| serde_json::from_str(&value).ok()),
        worktree_path: row.get(8)?,
        branch: row.get(9)?,
        worktree_id: row.get(10)?,
        worktree_instance_id: row.get(11)?,
        started_at: row
            .get::<_, Option<i64>>(12)?
            .map(|value| value.max(0) as u64),
        finished_at: row
            .get::<_, Option<i64>>(13)?
            .map(|value| value.max(0) as u64),
        created_at: row.get::<_, i64>(14)?.max(0) as u64,
    })
}
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_plane::ControlPlane;

    struct Fixture {
        root: PathBuf,
        service: AutomationService,
        coordinator: Arc<CoordinatorService>,
        workspace: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("vibelink-automation-{}", Uuid::new_v4()));
            let workspace = root.join("workspace");
            fs::create_dir_all(&workspace).expect("workspace");
            let control = Arc::new(ControlPlane::open(&root).expect("control"));
            let coordinator = Arc::new(CoordinatorService::new(Arc::clone(&control)));
            let registry = Arc::new(WorktreeRegistry::new(control));
            let service = AutomationService::open(
                &root.join("control").join("vibelink-control.sqlite3"),
                root.join("artifacts"),
                Arc::clone(&coordinator),
                registry,
            )
            .expect("automation");
            Self {
                root,
                service,
                coordinator,
                workspace,
            }
        }
        fn create(&self, precheck: Value) -> AutomationRecord {
            self.service.create(CreateAutomation{session_id:Uuid::new_v4().to_string(),name:"Mission".to_string(),schedule_kind:"interval".to_string(),schedule_value:"3600".to_string(),timezone:"UTC".to_string(),workspace_mode:"reuse".to_string(),precheck,policy:json!({"goal":"Inspect workspace","maxConcurrent":2,"resourceBudget":{"maxActiveRuns":200}})}).expect("create")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn failed_precheck_skips_without_creating_coordinator_run() {
        let fixture = Fixture::new();
        let automation = fixture.create(json!({"requireGit":true}));
        let claim = fixture.service.trigger(&automation.id).expect("claim");
        let completed = fixture
            .service
            .execute(&claim, &fixture.workspace)
            .expect("execute");
        assert_eq!(completed.status, "skipped");
        assert!(completed.orchestration_run_id.is_none());
        assert!(fixture
            .coordinator
            .runs_for_session(&automation.session_id)
            .expect("runs")
            .is_empty());
    }

    #[test]
    fn successful_automation_launches_durable_mission() {
        let fixture = Fixture::new();
        let automation = fixture.create(json!({}));
        let claim = fixture.service.trigger(&automation.id).expect("claim");
        let running = fixture
            .service
            .execute(&claim, &fixture.workspace)
            .expect("execute");
        assert_eq!(running.status, "running");
        let run_id = running.orchestration_run_id.expect("run id");
        let run = fixture.coordinator.run(&run_id).expect("run");
        assert_eq!(run.goal, "Inspect workspace");
        assert_eq!(fixture.coordinator.tasks(&run_id).expect("tasks").len(), 1);
        assert_eq!(
            fixture
                .coordinator
                .dispatches(&run_id)
                .expect("dispatches")
                .len(),
            1
        );
    }

    #[test]
    fn retention_keeps_newest_one_hundred_final_runs() {
        let fixture = Fixture::new();
        let automation = fixture.create(json!({"requireGit":true}));
        for _ in 0..105 {
            let claim = fixture.service.trigger(&automation.id).expect("claim");
            fixture
                .service
                .execute(&claim, &fixture.workspace)
                .expect("skip");
        }
        let runs = fixture.service.runs(&automation.id, 500).expect("runs");
        assert_eq!(runs.len(), 100);
        assert!(runs.iter().all(|run| run.status == "skipped"));
    }

    #[test]
    fn schedule_validation_covers_plan_kinds() {
        for (kind, value) in [
            ("hourly", "15"),
            ("daily", "09:30"),
            ("weekdays", "09:30"),
            ("weekly", "MON@09:30"),
            ("cron", "*/5 * * * *"),
            ("rrule", "FREQ=WEEKLY;INTERVAL=1;BYDAY=MON,FRI"),
        ] {
            validate_schedule(kind, value, "UTC").expect(kind);
        }
    }
}
