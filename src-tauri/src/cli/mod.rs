use crate::app::daemon_client::{parse_uuid, DaemonClient};
use crate::protocol::{ClientToDaemon, ReplyResult};
use anyhow::{anyhow, bail, Context, Result};
use std::{
    borrow::Cow,
    io::{self, Write},
};
use uuid::Uuid;

#[derive(Debug, PartialEq, Eq)]
enum CliCommand {
    Sessions,
    Panes {
        session_id: Uuid,
    },
    Read {
        session_id: Uuid,
        pane_id: Uuid,
    },
    Write {
        session_id: Uuid,
        pane_id: Uuid,
        text: String,
        enter: bool,
    },
    Help,
}

pub fn run(args: impl IntoIterator<Item = String>) -> Result<()> {
    let command = parse_args(args)?;
    if command == CliCommand::Help {
        print_usage(io::stdout())?;
        return Ok(());
    }

    let stream = crate::app::spawn_daemon::ensure_daemon().context("connect to daemon")?;
    let client = DaemonClient::new(stream);
    execute(&client, command)
}

fn execute(client: &DaemonClient, command: CliCommand) -> Result<()> {
    match command {
        CliCommand::Sessions => {
            match client.request_reply(|req| ClientToDaemon::ListSessions { req })? {
                ReplyResult::Sessions(sessions) => {
                    serde_json::to_writer_pretty(io::stdout(), &sessions)?;
                    println!();
                    Ok(())
                }
                other => bail!("unexpected daemon response: {other:?}"),
            }
        }
        CliCommand::Panes { session_id } => {
            match client.request_reply(|req| ClientToDaemon::AttachSession { req, session_id })? {
                ReplyResult::Attached { panes, .. } => {
                    serde_json::to_writer_pretty(io::stdout(), &panes)?;
                    println!();
                    Ok(())
                }
                other => bail!("unexpected daemon response: {other:?}"),
            }
        }
        CliCommand::Read {
            session_id,
            pane_id,
        } => {
            match client.request_reply(|req| ClientToDaemon::GetScrollback {
                req,
                session_id,
                pane_id,
            })? {
                ReplyResult::ScrollbackData(data) => {
                    let text = String::from_utf8_lossy(&data);
                    print!("{}", strip_ansi(&text));
                    io::stdout().flush()?;
                    Ok(())
                }
                other => bail!("unexpected daemon response: {other:?}"),
            }
        }
        CliCommand::Write {
            session_id,
            pane_id,
            text,
            enter,
        } => {
            let data = write_payload(text, enter);
            client.send(ClientToDaemon::WritePane {
                session_id,
                pane_id,
                data,
            })?;
            println!("{{\"ok\":true}}");
            Ok(())
        }
        CliCommand::Help => unreachable!("handled before daemon connection"),
    }
}

fn parse_args(args: impl IntoIterator<Item = impl AsRef<str>>) -> Result<CliCommand> {
    let mut tokens: Vec<String> = args
        .into_iter()
        .map(|arg| arg.as_ref().to_string())
        .collect();
    if tokens.first().is_some_and(|arg| arg == "cli") {
        tokens.remove(0);
    }

    let Some(command) = tokens.first().map(String::as_str) else {
        return Ok(CliCommand::Help);
    };

    match command {
        "help" | "--help" | "-h" => Ok(CliCommand::Help),
        "sessions" => {
            expect_no_extra(&tokens[1..])?;
            Ok(CliCommand::Sessions)
        }
        "panes" => {
            let session_id = parse_optional_session_flag_or_env(&tokens[1..], "panes")?;
            Ok(CliCommand::Panes { session_id })
        }
        "read" => parse_read(&tokens[1..]),
        "write" => parse_write(&tokens[1..]),
        other => bail!("usage: unknown cli command `{other}`\n{}", usage()),
    }
}

fn parse_read(tokens: &[String]) -> Result<CliCommand> {
    let mut session_id = None;
    let mut pane_id = None;
    let mut index = 0;

    while index < tokens.len() {
        match tokens[index].as_str() {
            "--session" => {
                let value = next_flag_value(tokens, index, "--session")?;
                session_id = Some(parse_uuid(value)?);
                index += 2;
            }
            "--pane" => {
                let value = next_flag_value(tokens, index, "--pane")?;
                pane_id = Some(parse_uuid(value)?);
                index += 2;
            }
            other => bail!("usage: unknown read option `{other}`\n{}", usage()),
        }
    }

    Ok(CliCommand::Read {
        session_id: session_id
            .or_else(session_id_from_env)
            .ok_or_else(|| usage_error("read requires --session <uuid> or AWT_SESSION_ID"))?,
        pane_id: pane_id.ok_or_else(|| usage_error("read requires --pane <uuid>"))?,
    })
}

fn parse_write(tokens: &[String]) -> Result<CliCommand> {
    let mut session_id = None;
    let mut pane_id = None;
    let mut text = None;
    let mut enter = false;
    let mut index = 0;

    while index < tokens.len() {
        match tokens[index].as_str() {
            "--session" => {
                let value = next_flag_value(tokens, index, "--session")?;
                session_id = Some(parse_uuid(value)?);
                index += 2;
            }
            "--pane" => {
                let value = next_flag_value(tokens, index, "--pane")?;
                pane_id = Some(parse_uuid(value)?);
                index += 2;
            }
            "--text" => {
                text = Some(next_flag_value(tokens, index, "--text")?.to_string());
                index += 2;
            }
            "--enter" => {
                enter = true;
                index += 1;
            }
            other => bail!("usage: unknown write option `{other}`\n{}", usage()),
        }
    }

    Ok(CliCommand::Write {
        session_id: session_id
            .or_else(session_id_from_env)
            .ok_or_else(|| usage_error("write requires --session <uuid> or AWT_SESSION_ID"))?,
        pane_id: pane_id.ok_or_else(|| usage_error("write requires --pane <uuid>"))?,
        text: text.ok_or_else(|| usage_error("write requires --text <text>"))?,
        enter,
    })
}

fn parse_optional_session_flag_or_env(tokens: &[String], command: &str) -> Result<Uuid> {
    if tokens.is_empty() {
        return session_id_from_env().ok_or_else(|| {
            usage_error(&format!(
                "{command} requires --session <uuid> or AWT_SESSION_ID"
            ))
        });
    }
    if tokens.len() == 2 && tokens[0] == "--session" {
        return parse_uuid(&tokens[1]);
    }
    bail!("usage: expected --session <uuid>\n{}", usage());
}

fn expect_no_extra(tokens: &[String]) -> Result<()> {
    if tokens.is_empty() {
        Ok(())
    } else {
        bail!("usage: unexpected argument `{}`\n{}", tokens[0], usage())
    }
}

fn next_flag_value<'a>(tokens: &'a [String], index: usize, flag: &str) -> Result<&'a str> {
    tokens
        .get(index + 1)
        .map(String::as_str)
        .ok_or_else(|| usage_error(&format!("{flag} requires a value")))
}

fn usage_error(message: &str) -> anyhow::Error {
    anyhow!("usage: {message}\n{}", usage())
}

fn print_usage(mut writer: impl Write) -> Result<()> {
    writer.write_all(usage().as_bytes())?;
    writer.write_all(b"\n")?;
    Ok(())
}

fn usage() -> &'static str {
    "usage:\n  app.exe cli sessions\n  app.exe cli panes [--session <session-id>]\n  app.exe cli read [--session <session-id>] --pane <pane-id>\n  app.exe cli write [--session <session-id>] --pane <pane-id> --text <text> [--enter]"
}

fn session_id_from_env() -> Option<Uuid> {
    std::env::var("AWT_SESSION_ID")
        .ok()
        .and_then(|value| parse_uuid(&value).ok())
}

fn write_payload(text: String, enter: bool) -> Vec<u8> {
    let mut data = text.into_bytes();
    if enter {
        data.push(b'\r');
    }
    data
}

fn strip_ansi(text: &str) -> Cow<'_, str> {
    let Some(first_escape) = text.as_bytes().iter().position(|byte| *byte == 0x1b) else {
        return Cow::Borrowed(text);
    };

    let mut output = String::with_capacity(text.len());
    output.push_str(&text[..first_escape]);

    let bytes = text.as_bytes();
    let mut index = first_escape;
    while index < bytes.len() {
        if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'[') {
            index += 2;
            while index < bytes.len() {
                let byte = bytes[index];
                index += 1;
                if (0x40..=0x7e).contains(&byte) {
                    break;
                }
            }
        } else {
            let start = index;
            index += 1;
            while index < bytes.len() && bytes[index] != 0x1b {
                index += 1;
            }
            output.push_str(&text[start..index]);
        }
    }

    Cow::Owned(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn parse_read_requires_session_and_pane_id() {
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let parsed = parse_args([
            "cli",
            "read",
            "--session",
            &session_id.to_string(),
            "--pane",
            &pane_id.to_string(),
        ])
        .expect("parse");

        assert_eq!(
            parsed,
            CliCommand::Read {
                session_id,
                pane_id
            }
        );
    }

    #[test]
    fn parse_read_rejects_unscoped_pane_reads() {
        let pane_id = Uuid::new_v4();
        let err = parse_args(["cli", "read", "--pane", &pane_id.to_string()])
            .expect_err("missing session should fail");

        assert!(err.to_string().contains("--session"));
    }

    #[test]
    fn parse_write_accepts_enter_flag() {
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let parsed = parse_args([
            "cli",
            "write",
            "--session",
            &session_id.to_string(),
            "--pane",
            &pane_id.to_string(),
            "--text",
            "pwd",
            "--enter",
        ])
        .expect("parse");

        assert_eq!(
            parsed,
            CliCommand::Write {
                session_id,
                pane_id,
                text: "pwd".to_string(),
                enter: true,
            }
        );
    }

    #[test]
    fn write_enter_appends_carriage_return() {
        assert_eq!(write_payload("pwd".to_string(), true), b"pwd\r");
    }

    #[test]
    fn parse_missing_argument_reports_usage_error() {
        let err = parse_args(["cli", "read"]).expect_err("missing pane should fail");

        assert!(err.to_string().contains("usage:"));
    }

    #[test]
    fn strip_ansi_removes_csi_escape_sequences() {
        assert_eq!(strip_ansi("\x1b[31mred\x1b[0m plain\x1b[2K"), "red plain");
    }

    #[test]
    fn strip_ansi_borrows_plain_text() {
        assert!(matches!(
            strip_ansi("plain text"),
            std::borrow::Cow::Borrowed("plain text")
        ));
    }
}
