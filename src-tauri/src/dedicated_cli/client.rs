use super::error::{CliError, ErrorCode};
use crate::{
    app::spawn_daemon::{authenticate_daemon_stream, load_ipc_secret},
    protocol::{read_frame, write_frame, ClientKind, ClientToDaemon, DaemonToClient, ReplyResult},
};
use interprocess::{
    local_socket::{prelude::*, GenericNamespaced},
    ConnectWaitMode,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{env, process::Command as ProcessCommand, sync::mpsc, thread, time::Duration};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Flavor {
    Dev,
    Prod,
}

impl Flavor {
    pub fn parse(value: &str) -> Result<Self, CliError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "dev" => Ok(Self::Dev),
            "prod" => Ok(Self::Prod),
            _ => Err(CliError::invalid("flavor must be 'dev' or 'prod'")),
        }
    }

    pub fn detect() -> Result<Self, CliError> {
        match env::var("VIBELINK_APP_FLAVOR") {
            Ok(value) => Self::parse(&value),
            Err(env::VarError::NotPresent) => {
                if cfg!(debug_assertions) {
                    Ok(Self::Dev)
                } else {
                    Ok(Self::Prod)
                }
            }
            Err(error) => Err(CliError::invalid(format!(
                "read VIBELINK_APP_FLAVOR: {error}"
            ))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dev => "dev",
            Self::Prod => "prod",
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct ControlSocketConfig {
    pub flavor: Flavor,
    pub user_sid: String,
    pub timeout: Duration,
}

impl ControlSocketConfig {
    pub fn detect(flavor: Option<Flavor>, timeout: Duration) -> Result<Self, CliError> {
        Ok(Self {
            flavor: flavor.unwrap_or(Flavor::detect()?),
            user_sid: current_user_sid(),
            timeout,
        })
    }

    pub fn socket_name(&self) -> String {
        socket_name_for_user(self.flavor, &self.user_sid)
    }
}

pub fn socket_name_for_user(flavor: Flavor, username: &str) -> String {
    format!(
        "vibelink-{}-daemon-{:016x}",
        flavor.as_str(),
        fnv1a64(username.as_bytes())
    )
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;
    let mut hash = OFFSET;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

fn current_user_sid() -> String {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if let Ok(output) = ProcessCommand::new("whoami.exe")
            .args(["/user", "/fo", "csv", "/nh"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                if let Some(sid) = text
                    .split(',')
                    .map(|part| part.trim().trim_matches('"'))
                    .find(|part| part.starts_with("S-1-"))
                {
                    return sid.to_string();
                }
            }
        }
    }
    env::var("USERDOMAIN")
        .ok()
        .zip(env::var("USERNAME").ok())
        .map(|(domain, user)| format!("{domain}\\{user}"))
        .or_else(|| env::var("USER").ok())
        .unwrap_or_else(|| "unknown".to_string())
}

pub struct ControlSocketClient {
    stream: LocalSocketStream,
    config: ControlSocketConfig,
}

impl ControlSocketClient {
    pub fn connect(config: ControlSocketConfig) -> Result<Self, CliError> {
        let timeout = config.timeout;
        run_timed("control socket connect", timeout, move || {
            Self::connect_blocking(config)
        })
    }

    fn connect_blocking(config: ControlSocketConfig) -> Result<Self, CliError> {
        let socket_name = config.socket_name();
        let name = socket_name
            .clone()
            .to_ns_name::<GenericNamespaced>()
            .map_err(|error| {
                CliError::unavailable(format!("resolve control socket '{socket_name}': {error}"))
            })?;
        let stream = interprocess::local_socket::ConnectOptions::new()
            .name(name)
            .wait_mode(ConnectWaitMode::Timeout(config.timeout))
            .connect_sync()
            .map_err(|error| map_connect_error(&socket_name, error))?;
        let _ = stream.set_send_timeout(Some(config.timeout));
        let _ = stream.set_recv_timeout(Some(config.timeout));
        Ok(Self { stream, config })
    }

    pub fn socket_name(&self) -> String {
        self.config.socket_name()
    }

    pub fn flavor(&self) -> Flavor {
        self.config.flavor
    }

    pub fn ping(self) -> Result<(), CliError> {
        let timeout = self.config.timeout;
        run_timed("control-plane ping", timeout, move || self.ping_blocking())
    }

    pub fn execute_json(self, operation_id: Uuid, command_json: String) -> Result<Value, CliError> {
        let timeout = self.config.timeout;
        run_timed("control-plane request", timeout, move || {
            self.execute_json_blocking(operation_id, command_json)
        })
    }

    pub(crate) fn authenticate(&mut self) -> Result<(), CliError> {
        let secret = load_ipc_secret().map_err(|error| CliError::unavailable(error.to_string()))?;
        authenticate_daemon_stream(&mut self.stream, ClientKind::Cli, &secret)
            .map(|_| ())
            .map_err(|error| map_daemon_error(error.to_string()))
    }

    pub(crate) fn execute_json_in_place(
        &mut self,
        req: u64,
        operation_id: Uuid,
        command_json: String,
    ) -> Result<Value, CliError> {
        self.write(&ClientToDaemon::Cli {
            req,
            operation_id,
            request_json: command_json,
        })?;
        loop {
            match self.read()? {
                DaemonToClient::Reply {
                    req: reply_req,
                    result: ReplyResult::Cli(response_json),
                } if reply_req == req => {
                    return serde_json::from_str(&response_json).map_err(|error| {
                        CliError::internal(format!("parse control-plane response: {error}"))
                    })
                }
                DaemonToClient::Error {
                    req: Some(reply_req),
                    message,
                } if reply_req == req => return Err(map_daemon_error(message)),
                _ => {}
            }
        }
    }

    fn ping_blocking(mut self) -> Result<(), CliError> {
        let req = 1;
        self.authenticate()?;
        self.write(&ClientToDaemon::Ping { req })?;
        loop {
            match self.read()? {
                DaemonToClient::Pong { req: reply_req } if reply_req == req => return Ok(()),
                DaemonToClient::Error {
                    req: Some(reply_req),
                    message,
                } if reply_req == req => return Err(map_daemon_error(message)),
                _ => {}
            }
        }
    }

    fn execute_json_blocking(
        mut self,
        operation_id: Uuid,
        command_json: String,
    ) -> Result<Value, CliError> {
        let req = 1;
        self.authenticate()?;
        self.write(&ClientToDaemon::Cli {
            req,
            operation_id,
            request_json: command_json,
        })?;
        loop {
            match self.read()? {
                DaemonToClient::Reply {
                    req: reply_req,
                    result: ReplyResult::Cli(response_json),
                } if reply_req == req => {
                    return serde_json::from_str(&response_json).map_err(|error| {
                        CliError::internal(format!("parse control-plane response: {error}"))
                    })
                }
                DaemonToClient::Error {
                    req: Some(reply_req),
                    message,
                } if reply_req == req => return Err(map_daemon_error(message)),
                _ => {}
            }
        }
    }

    fn write(&mut self, message: &ClientToDaemon) -> Result<(), CliError> {
        write_frame(&mut self.stream, message)
            .map_err(|error| CliError::unavailable(format!("write control socket: {error}")))
    }

    fn read(&mut self) -> Result<DaemonToClient, CliError> {
        read_frame(&mut self.stream)
            .map_err(|error| CliError::unavailable(format!("read control socket: {error}")))
    }
}

fn run_timed<T: Send + 'static>(
    operation: &'static str,
    timeout: Duration,
    run: impl FnOnce() -> Result<T, CliError> + Send + 'static,
) -> Result<T, CliError> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name(format!("vibelink-cli-{}", operation.replace(' ', "-")))
        .spawn(move || {
            let _ = sender.send(run());
        })
        .map_err(|error| CliError::internal(format!("start {operation}: {error}")))?;
    match receiver.recv_timeout(timeout) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => Err(CliError::timeout(format!(
            "{operation} timed out after {}ms",
            timeout.as_millis()
        ))),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(CliError::internal(format!(
            "{operation} stopped without a result"
        ))),
    }
}

fn map_connect_error(socket_name: &str, error: std::io::Error) -> CliError {
    let message = format!("connect to VibeLink control socket '{socket_name}': {error}");
    if error.kind() == std::io::ErrorKind::TimedOut {
        CliError::timeout(message)
    } else {
        CliError::unavailable(message)
    }
}

fn map_daemon_error(message: String) -> CliError {
    let folded = message.to_ascii_lowercase();
    let code = if folded.contains("ambiguous") {
        ErrorCode::AmbiguousSelector
    } else if folded.contains("not found") || folded.contains("does not exist") {
        ErrorCode::NotFound
    } else if folded.contains("stale_ref") {
        ErrorCode::StaleRef
    } else if folded.contains("stale") {
        ErrorCode::StaleTarget
    } else if folded.contains("denied")
        || folded.contains("not authorized")
        || folded.contains("app_blocked")
        || folded.contains("appblocked")
        || folded.contains("elevation_required")
        || folded.contains("elevationrequired")
    {
        ErrorCode::DeniedCapability
    } else if folded.contains("conflict") || folded.contains("revision") {
        ErrorCode::Conflict
    } else if folded.contains("timeout") || folded.contains("timed out") {
        ErrorCode::Timeout
    } else if folded.contains("unsupported")
        || folded.contains("unavailable")
        || folded.contains("not running")
    {
        ErrorCode::UnavailableRuntime
    } else if folded.contains("invalid")
        || folded.contains(" is required")
        || folded.contains(" must ")
    {
        ErrorCode::InvalidArguments
    } else {
        ErrorCode::InternalFailure
    };
    CliError::new(code, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_names_match_existing_flavor_isolation_contract() {
        let dev = socket_name_for_user(Flavor::Dev, "tester");
        let prod = socket_name_for_user(Flavor::Prod, "tester");
        assert!(dev.starts_with("vibelink-dev-daemon-"));
        assert!(prod.starts_with("vibelink-prod-daemon-"));
        assert_ne!(dev, prod);
        assert_eq!(dev.len(), "vibelink-dev-daemon-".len() + 16);
    }

    #[test]
    fn daemon_error_mapping_preserves_stable_codes() {
        assert_eq!(
            map_daemon_error("expected revision 2 but found 3".to_string()).code,
            ErrorCode::Conflict
        );
        assert_eq!(
            map_daemon_error("pane not found".to_string()).code,
            ErrorCode::NotFound
        );
        assert_eq!(
            map_daemon_error("capability denied".to_string()).code,
            ErrorCode::DeniedCapability
        );
        assert_eq!(
            map_daemon_error(
                "AppBlocked: computer use is blocked for this sensitive application".to_string()
            )
            .code,
            ErrorCode::DeniedCapability
        );
        assert_eq!(
            map_daemon_error(
                "ElevationRequired: target process has a higher Windows integrity level"
                    .to_string()
            )
            .code,
            ErrorCode::DeniedCapability
        );
        assert_eq!(
            map_daemon_error("ambiguous window selector: Notepad".to_string()).code,
            ErrorCode::AmbiguousSelector
        );
        assert_eq!(
            map_daemon_error("unsupported: workspace action requires GUI authority".to_string())
                .code,
            ErrorCode::UnavailableRuntime
        );
    }

    #[test]
    fn timed_operation_returns_before_blocked_worker_finishes() {
        let started = std::time::Instant::now();
        let error = run_timed("timeout test", Duration::from_millis(25), || {
            thread::sleep(Duration::from_millis(500));
            Ok(())
        })
        .expect_err("blocked operation must time out");

        assert_eq!(error.code, ErrorCode::Timeout);
        assert!(started.elapsed() < Duration::from_millis(250));
    }
}
