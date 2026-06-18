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
        pane_id: Uuid,
    },
    Write {
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
        CliCommand::Read { pane_id } => {
            match client.request_reply(|req| ClientToDaemon::GetScrollback { req, pane_id })? {
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
            pane_id,
            text,
            enter,
        } => {
            let mut data = text.into_bytes();
            if enter {
                data.push(b'\n');
            }
            client.send(ClientToDaemon::WritePane { pane_id, data })?;
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
            let session_id = parse_required_uuid_flag(&tokens[1..], "--session")?;
            Ok(CliCommand::Panes { session_id })
        }
        "read" => {
            let pane_id = parse_required_uuid_flag(&tokens[1..], "--pane")?;
            Ok(CliCommand::Read { pane_id })
        }
        "write" => parse_write(&tokens[1..]),
        other => bail!("usage: unknown cli command `{other}`\n{}", usage()),
    }
}

fn parse_write(tokens: &[String]) -> Result<CliCommand> {
    let mut pane_id = None;
    let mut text = None;
    let mut enter = false;
    let mut index = 0;

    while index < tokens.len() {
        match tokens[index].as_str() {
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
        pane_id: pane_id.ok_or_else(|| usage_error("write requires --pane <uuid>"))?,
        text: text.ok_or_else(|| usage_error("write requires --text <text>"))?,
        enter,
    })
}

fn parse_required_uuid_flag(tokens: &[String], flag: &str) -> Result<Uuid> {
    if tokens.len() != 2 || tokens[0] != flag {
        bail!("usage: expected {flag} <uuid>\n{}", usage());
    }
    parse_uuid(&tokens[1])
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
    "usage:\n  app.exe cli sessions\n  app.exe cli panes --session <session-id>\n  app.exe cli read --pane <pane-id>\n  app.exe cli write --pane <pane-id> --text <text> [--enter]"
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
    fn parse_read_requires_pane_id() {
        let pane_id = Uuid::new_v4();
        let parsed = parse_args(["cli", "read", "--pane", &pane_id.to_string()]).expect("parse");

        assert_eq!(parsed, CliCommand::Read { pane_id });
    }

    #[test]
    fn parse_write_accepts_enter_flag() {
        let pane_id = Uuid::new_v4();
        let parsed = parse_args([
            "cli",
            "write",
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
                pane_id,
                text: "pwd".to_string(),
                enter: true,
            }
        );
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
