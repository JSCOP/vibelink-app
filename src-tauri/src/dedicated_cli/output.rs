use super::error::CliError;
use serde::Serialize;
use std::io::Write;
use std::time::Duration;

pub const ENVELOPE_VERSION: u16 = 1;

#[derive(Debug, Serialize)]
pub struct SuccessEnvelope<'a, T: ?Sized> {
    pub version: u16,
    pub ok: bool,
    pub result: &'a T,
}

#[derive(Debug, Serialize)]
pub struct ErrorEnvelope<'a> {
    pub version: u16,
    pub ok: bool,
    pub error: &'a CliError,
}

pub struct OutputStreams<Out, Err> {
    stdout: Out,
    stderr: Err,
}

impl<Out: Write, Err: Write> OutputStreams<Out, Err> {
    pub fn new(stdout: Out, stderr: Err) -> Self {
        Self { stdout, stderr }
    }

    pub fn success<T: Serialize + ?Sized>(
        &mut self,
        result: &T,
        json_mode: bool,
    ) -> Result<(), CliError> {
        if json_mode {
            serde_json::to_writer(
                &mut self.stdout,
                &SuccessEnvelope {
                    version: ENVELOPE_VERSION,
                    ok: true,
                    result,
                },
            )
            .map_err(|error| CliError::internal(format!("serialize JSON result: {error}")))?;
        } else {
            serde_json::to_writer_pretty(&mut self.stdout, result)
                .map_err(|error| CliError::internal(format!("serialize result: {error}")))?;
        }
        self.stdout
            .write_all(b"\n")
            .map_err(|error| CliError::internal(format!("write stdout: {error}")))?;
        self.stdout
            .flush()
            .map_err(|error| CliError::internal(format!("flush stdout: {error}")))
    }

    pub fn failure(&mut self, error: &CliError, json_mode: bool) -> Result<(), CliError> {
        if json_mode {
            serde_json::to_writer(
                &mut self.stdout,
                &ErrorEnvelope {
                    version: ENVELOPE_VERSION,
                    ok: false,
                    error,
                },
            )
            .map_err(|write_error| {
                CliError::internal(format!("serialize JSON error: {write_error}"))
            })?;
            self.stdout.write_all(b"\n").map_err(|write_error| {
                CliError::internal(format!("write stdout: {write_error}"))
            })?;
            self.stdout.flush().map_err(|write_error| {
                CliError::internal(format!("flush stdout: {write_error}"))
            })?;
        } else {
            writeln!(self.stderr, "error[{:?}]: {}", error.code, error.message).map_err(
                |write_error| CliError::internal(format!("write stderr: {write_error}")),
            )?;
            self.stderr.flush().map_err(|write_error| {
                CliError::internal(format!("flush stderr: {write_error}"))
            })?;
        }
        Ok(())
    }

    pub fn diagnostic(&mut self, message: &str) -> Result<(), CliError> {
        writeln!(self.stderr, "{message}")
            .map_err(|error| CliError::internal(format!("write stderr: {error}")))?;
        self.stderr
            .flush()
            .map_err(|error| CliError::internal(format!("flush stderr: {error}")))
    }

    pub fn into_parts(self) -> (Out, Err) {
        (self.stdout, self.stderr)
    }
}

pub struct StderrKeepalive {
    interval: Duration,
    next_at: Duration,
    message: String,
}

impl StderrKeepalive {
    pub fn new(interval: Duration, message: impl Into<String>) -> Self {
        Self {
            interval,
            next_at: interval,
            message: message.into(),
        }
    }

    pub fn emit_if_due(
        &mut self,
        elapsed: Duration,
        stderr: &mut impl Write,
    ) -> Result<bool, CliError> {
        if elapsed < self.next_at {
            return Ok(false);
        }
        writeln!(stderr, "{}", self.message)
            .map_err(|error| CliError::internal(format!("write keepalive: {error}")))?;
        stderr
            .flush()
            .map_err(|error| CliError::internal(format!("flush keepalive: {error}")))?;
        while self.next_at <= elapsed {
            self.next_at = self.next_at.saturating_add(self.interval);
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dedicated_cli::ErrorCode;

    #[test]
    fn json_result_is_a_stable_stdout_only_envelope() {
        let mut streams = OutputStreams::new(Vec::new(), Vec::new());
        streams
            .success(&serde_json::json!({"state": "running"}), true)
            .expect("write result");
        let (stdout, stderr) = streams.into_parts();
        assert_eq!(
            String::from_utf8(stdout).expect("utf8"),
            "{\"version\":1,\"ok\":true,\"result\":{\"state\":\"running\"}}\n"
        );
        assert!(stderr.is_empty());
    }

    #[test]
    fn json_error_is_a_stable_stdout_only_envelope() {
        let mut streams = OutputStreams::new(Vec::new(), Vec::new());
        streams
            .failure(
                &CliError::new(ErrorCode::Conflict, "revision changed"),
                true,
            )
            .expect("write error");
        let (stdout, stderr) = streams.into_parts();
        assert_eq!(
            String::from_utf8(stdout).expect("utf8"),
            "{\"version\":1,\"ok\":false,\"error\":{\"code\":\"conflict\",\"message\":\"revision changed\"}}\n"
        );
        assert!(stderr.is_empty());
    }

    #[test]
    fn diagnostics_and_keepalives_never_touch_stdout() {
        let mut streams = OutputStreams::new(Vec::new(), Vec::new());
        streams.diagnostic("connecting").expect("diagnostic");
        let (stdout, mut stderr) = streams.into_parts();
        let mut keepalive = StderrKeepalive::new(Duration::from_secs(15), "still waiting");
        assert!(!keepalive
            .emit_if_due(Duration::from_secs(14), &mut stderr)
            .expect("early keepalive"));
        assert!(keepalive
            .emit_if_due(Duration::from_secs(15), &mut stderr)
            .expect("due keepalive"));
        assert!(stdout.is_empty());
        assert_eq!(
            String::from_utf8(stderr).expect("utf8"),
            "connecting\nstill waiting\n"
        );
    }
}
