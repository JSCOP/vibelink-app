use crate::app::daemon_client::{parse_uuid, DaemonClient};
use crate::app::skills::{
    apply_skill, delete_skill, get_skill, list_skills, SkillApplyInput, SkillScope,
};
use crate::protocol::{ClientToDaemon, ReplyResult, TaskSignal};
use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
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
    TaskDone {
        session_id: Uuid,
        pane_id: Option<Uuid>,
        task_id: String,
        commit_msg: Option<String>,
        result_summary: Option<String>,
    },
    TaskNote {
        session_id: Uuid,
        pane_id: Option<Uuid>,
        task_id: String,
        message: String,
    },
    SkillList {
        session_id: Option<String>,
    },
    SkillShow {
        id: String,
        session_id: Option<String>,
        scope: Option<String>,
    },
    SkillApply {
        id: String,
        name: Option<String>,
        category: Option<String>,
        description: Option<String>,
        content: String,
        scope: Option<String>,
        session_id: Option<String>,
        enabled: Option<bool>,
    },
    SkillDelete {
        id: String,
        session_id: Option<String>,
        scope: Option<String>,
    },
    Help,
}

pub fn run(args: impl IntoIterator<Item = String>) -> Result<()> {
    let command = parse_args(args)?;
    if command == CliCommand::Help {
        print_usage(io::stdout())?;
        return Ok(());
    }
    if is_skill_command(&command) {
        return execute_skill(command);
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
        CliCommand::TaskDone {
            session_id,
            pane_id,
            task_id,
            commit_msg,
            result_summary,
        } => {
            match client.request_reply(|req| ClientToDaemon::TaskEvent {
                req,
                session_id,
                event: TaskSignal::Done {
                    task_id,
                    commit_msg,
                    result_summary,
                    pane_id,
                },
            })? {
                ReplyResult::Ok => {
                    println!("{{\"ok\":true}}");
                    Ok(())
                }
                other => bail!("unexpected daemon response: {other:?}"),
            }
        }
        CliCommand::TaskNote {
            session_id,
            pane_id,
            task_id,
            message,
        } => {
            match client.request_reply(|req| ClientToDaemon::TaskEvent {
                req,
                session_id,
                event: TaskSignal::Note {
                    task_id,
                    message,
                    pane_id,
                },
            })? {
                ReplyResult::Ok => {
                    println!("{{\"ok\":true}}");
                    Ok(())
                }
                other => bail!("unexpected daemon response: {other:?}"),
            }
        }
        CliCommand::SkillList { .. }
        | CliCommand::SkillShow { .. }
        | CliCommand::SkillApply { .. }
        | CliCommand::SkillDelete { .. } => unreachable!("handled before daemon connection"),
        CliCommand::Help => unreachable!("handled before daemon connection"),
    }
}

fn is_skill_command(command: &CliCommand) -> bool {
    matches!(
        command,
        CliCommand::SkillList { .. }
            | CliCommand::SkillShow { .. }
            | CliCommand::SkillApply { .. }
            | CliCommand::SkillDelete { .. }
    )
}

fn execute_skill(command: CliCommand) -> Result<()> {
    match command {
        CliCommand::SkillList { session_id } => print_json(&list_skills(session_id.as_deref())?),
        CliCommand::SkillShow {
            id,
            session_id,
            scope,
        } => {
            let lookup_session_id = skill_lookup_session_id(session_id, scope.as_deref())?;
            let skill = get_skill(
                &id,
                lookup_session_id.as_deref(),
                parse_skill_scope(scope.as_deref())?,
            )?;
            print_json(&skill)
        }
        CliCommand::SkillApply {
            id,
            name,
            category,
            description,
            content,
            scope,
            session_id,
            enabled,
        } => {
            let input = skill_apply_input(
                id,
                name,
                category,
                description,
                content,
                scope,
                session_id,
                enabled,
            )?;
            let skill = apply_skill(input)?;
            print_json(&skill)
        }
        CliCommand::SkillDelete {
            id,
            session_id,
            scope,
        } => {
            let lookup_session_id = skill_lookup_session_id(session_id, scope.as_deref())?;
            delete_skill(
                &id,
                lookup_session_id.as_deref(),
                parse_skill_scope(scope.as_deref())?,
            )?;
            print_json(&serde_json::json!({ "ok": true }))
        }
        CliCommand::Sessions
        | CliCommand::Panes { .. }
        | CliCommand::Read { .. }
        | CliCommand::Write { .. }
        | CliCommand::TaskDone { .. }
        | CliCommand::TaskNote { .. }
        | CliCommand::Help => unreachable!("not a skill command"),
    }
}

fn print_json<T: Serialize + ?Sized>(value: &T) -> Result<()> {
    serde_json::to_writer_pretty(io::stdout(), value)?;
    println!();
    Ok(())
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
        "task" => parse_task(&tokens[1..]),
        "skill" => parse_skill(&tokens[1..]),
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

fn parse_task(tokens: &[String]) -> Result<CliCommand> {
    let Some(command) = tokens.first().map(String::as_str) else {
        return Err(usage_error("task requires done or note"));
    };
    match command {
        "done" => parse_task_done(&tokens[1..]),
        "note" => parse_task_note(&tokens[1..]),
        other => bail!("usage: unknown task command `{other}`\n{}", usage()),
    }
}

fn parse_task_done(tokens: &[String]) -> Result<CliCommand> {
    let mut session_id = None;
    let mut pane_id = None;
    let mut task_id = None;
    let mut commit_msg = None;
    let mut result_summary = None;
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
            "--task" => {
                task_id = Some(next_flag_value(tokens, index, "--task")?.to_string());
                index += 2;
            }
            "--commit-msg" => {
                commit_msg = Some(next_flag_value(tokens, index, "--commit-msg")?.to_string());
                index += 2;
            }
            "--result-summary" => {
                result_summary =
                    Some(next_flag_value(tokens, index, "--result-summary")?.to_string());
                index += 2;
            }
            other => bail!("usage: unknown task done option `{other}`\n{}", usage()),
        }
    }

    Ok(CliCommand::TaskDone {
        session_id: session_id
            .or_else(session_id_from_env)
            .ok_or_else(|| usage_error("task done requires --session <uuid> or AWT_SESSION_ID"))?,
        pane_id: pane_id.or_else(pane_id_from_env),
        task_id: task_id.ok_or_else(|| usage_error("task done requires --task <id>"))?,
        commit_msg,
        result_summary,
    })
}

fn parse_task_note(tokens: &[String]) -> Result<CliCommand> {
    let mut session_id = None;
    let mut pane_id = None;
    let mut task_id = None;
    let mut message = None;
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
            "--task" => {
                task_id = Some(next_flag_value(tokens, index, "--task")?.to_string());
                index += 2;
            }
            "--message" => {
                message = Some(next_flag_value(tokens, index, "--message")?.to_string());
                index += 2;
            }
            other => bail!("usage: unknown task note option `{other}`\n{}", usage()),
        }
    }

    Ok(CliCommand::TaskNote {
        session_id: session_id
            .or_else(session_id_from_env)
            .ok_or_else(|| usage_error("task note requires --session <uuid> or AWT_SESSION_ID"))?,
        pane_id: pane_id.or_else(pane_id_from_env),
        task_id: task_id.ok_or_else(|| usage_error("task note requires --task <id>"))?,
        message: message.ok_or_else(|| usage_error("task note requires --message <text>"))?,
    })
}

fn parse_skill(tokens: &[String]) -> Result<CliCommand> {
    let Some(command) = tokens.first().map(String::as_str) else {
        return Err(usage_error("skill requires list, show, apply, or delete"));
    };
    match command {
        "list" => parse_skill_list(&tokens[1..]),
        "show" | "get" => parse_skill_show(&tokens[1..]),
        "apply" => parse_skill_apply(&tokens[1..]),
        "delete" | "rm" => parse_skill_delete(&tokens[1..]),
        other => bail!("usage: unknown skill command `{other}`\n{}", usage()),
    }
}

fn parse_skill_list(tokens: &[String]) -> Result<CliCommand> {
    let mut session_id = None;
    let mut index = 0;
    while index < tokens.len() {
        match tokens[index].as_str() {
            "--session" => {
                let value = next_flag_value(tokens, index, "--session")?;
                parse_uuid(value)?;
                session_id = Some(value.to_string());
                index += 2;
            }
            other => bail!("usage: unknown skill list option `{other}`\n{}", usage()),
        }
    }

    Ok(CliCommand::SkillList {
        session_id: session_id.or_else(skill_session_id_from_env),
    })
}

fn parse_skill_show(tokens: &[String]) -> Result<CliCommand> {
    let (id, scope, session_id) = parse_skill_lookup_options(tokens, "show")?;
    Ok(CliCommand::SkillShow {
        id,
        session_id,
        scope,
    })
}

fn parse_skill_delete(tokens: &[String]) -> Result<CliCommand> {
    let (id, scope, session_id) = parse_skill_lookup_options(tokens, "delete")?;
    Ok(CliCommand::SkillDelete {
        id,
        session_id,
        scope,
    })
}

fn parse_skill_lookup_options(
    tokens: &[String],
    command: &str,
) -> Result<(String, Option<String>, Option<String>)> {
    let mut id = None;
    let mut scope = None;
    let mut session_id = None;
    let mut index = 0;

    while index < tokens.len() {
        match tokens[index].as_str() {
            "--id" => {
                id = Some(next_flag_value(tokens, index, "--id")?.to_string());
                index += 2;
            }
            "--scope" => {
                scope = Some(normalize_skill_scope(next_flag_value(
                    tokens, index, "--scope",
                )?)?);
                index += 2;
            }
            "--session" => {
                let value = next_flag_value(tokens, index, "--session")?;
                parse_uuid(value)?;
                session_id = Some(value.to_string());
                index += 2;
            }
            value if !value.starts_with('-') && id.is_none() => {
                id = Some(value.to_string());
                index += 1;
            }
            other => bail!(
                "usage: unknown skill {command} option `{other}`\n{}",
                usage()
            ),
        }
    }

    let session_id = if scope.as_deref() == Some("global") {
        None
    } else {
        session_id.or_else(skill_session_id_from_env)
    };

    Ok((required_skill_id(id, command)?, scope, session_id))
}

fn parse_skill_apply(tokens: &[String]) -> Result<CliCommand> {
    let mut id = None;
    let mut name = None;
    let mut category = None;
    let mut description = None;
    let mut content = None;
    let mut scope = None;
    let mut session_id = None;
    let mut enabled = None;
    let mut index = 0;

    while index < tokens.len() {
        match tokens[index].as_str() {
            "--id" => {
                id = Some(next_flag_value(tokens, index, "--id")?.to_string());
                index += 2;
            }
            "--name" => {
                name = Some(next_flag_value(tokens, index, "--name")?.to_string());
                index += 2;
            }
            "--category" => {
                category = Some(next_flag_value(tokens, index, "--category")?.to_string());
                index += 2;
            }
            "--description" => {
                description = Some(next_flag_value(tokens, index, "--description")?.to_string());
                index += 2;
            }
            "--content" | "--markdown" => {
                content = Some(next_flag_value(tokens, index, tokens[index].as_str())?.to_string());
                index += 2;
            }
            "--scope" => {
                scope = Some(normalize_skill_scope(next_flag_value(
                    tokens, index, "--scope",
                )?)?);
                index += 2;
            }
            "--session" => {
                let value = next_flag_value(tokens, index, "--session")?;
                parse_uuid(value)?;
                session_id = Some(value.to_string());
                index += 2;
            }
            "--enabled" => {
                enabled = Some(parse_bool(
                    next_flag_value(tokens, index, "--enabled")?,
                    "--enabled",
                )?);
                index += 2;
            }
            other => bail!("usage: unknown skill apply option `{other}`\n{}", usage()),
        }
    }

    Ok(CliCommand::SkillApply {
        id: required_skill_id(id, "apply")?,
        name: clean_optional_text(name),
        category: clean_optional_text(category),
        description: clean_optional_text(description),
        content: content.ok_or_else(|| usage_error("skill apply requires --content <markdown>"))?,
        scope,
        session_id: session_id.or_else(skill_session_id_from_env),
        enabled,
    })
}

fn required_skill_id(id: Option<String>, command: &str) -> Result<String> {
    let id = id.ok_or_else(|| usage_error(&format!("skill {command} requires --id <id>")))?;
    let id = id.trim();
    if id.is_empty() {
        bail!("usage: skill id must not be empty\n{}", usage());
    }
    Ok(id.to_string())
}

fn normalize_skill_scope(scope: &str) -> Result<String> {
    match scope.trim().to_ascii_lowercase().as_str() {
        "global" => Ok("global".to_string()),
        "workspace" => Ok("workspace".to_string()),
        other => bail!(
            "usage: skill scope must be `global` or `workspace`, got `{other}`\n{}",
            usage()
        ),
    }
}

fn parse_skill_scope(scope: Option<&str>) -> Result<Option<SkillScope>> {
    scope
        .map(|scope| match normalize_skill_scope(scope)?.as_str() {
            "global" => Ok(SkillScope::Global),
            "workspace" => Ok(SkillScope::Workspace),
            _ => unreachable!("normalized skill scope"),
        })
        .transpose()
}

fn skill_lookup_session_id(
    session_id: Option<String>,
    scope: Option<&str>,
) -> Result<Option<String>> {
    if scope == Some("global") {
        return Ok(None);
    }
    if scope == Some("workspace") && session_id.is_none() {
        bail!(
            "usage: workspace skills require --session <uuid> or AWT_SESSION_ID\n{}",
            usage()
        );
    }
    Ok(session_id)
}

fn skill_apply_input(
    id: String,
    name: Option<String>,
    category: Option<String>,
    description: Option<String>,
    content: String,
    scope: Option<String>,
    session_id: Option<String>,
    enabled: Option<bool>,
) -> Result<SkillApplyInput> {
    let scope = scope.unwrap_or_else(|| {
        if session_id.is_some() {
            "workspace".to_string()
        } else {
            "global".to_string()
        }
    });
    let scope = parse_skill_scope(Some(&scope))?.expect("skill scope is set");
    let session_id = if scope == SkillScope::Workspace {
        session_id.ok_or_else(|| {
            usage_error("workspace skills require --session <uuid> or AWT_SESSION_ID")
        })?
    } else {
        String::new()
    };

    Ok(SkillApplyInput {
        id: id.clone(),
        name: Some(name.unwrap_or(id)),
        category: Some(category.unwrap_or_else(|| "Custom".to_string())),
        description: Some(description.unwrap_or_default()),
        content,
        scope,
        session_id: if scope == SkillScope::Workspace {
            Some(session_id)
        } else {
            None
        },
        enabled: Some(enabled.unwrap_or(true)),
    })
}

fn clean_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn parse_bool(value: &str, flag: &str) -> Result<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" => Ok(true),
        "false" | "0" | "no" => Ok(false),
        other => bail!(
            "usage: {flag} expects true or false, got `{other}`\n{}",
            usage()
        ),
    }
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
    "usage:\n  app.exe cli sessions\n  app.exe cli panes [--session <session-id>]\n  app.exe cli read [--session <session-id>] --pane <pane-id>\n  app.exe cli write [--session <session-id>] --pane <pane-id> --text <text> [--enter]\n  app.exe cli task done --task <id> [--session <session-id>] [--pane <pane-id>] [--commit-msg <msg>] [--result-summary <text>]\n  app.exe cli task note --task <id> --message <text> [--session <session-id>] [--pane <pane-id>]\n  app.exe cli skill list [--session <session-id>]\n  app.exe cli skill show --id <id> [--scope global|workspace] [--session <session-id>]\n  app.exe cli skill apply --id <id> --content <markdown> [--name <name>] [--category <category>] [--description <text>] [--scope global|workspace] [--session <session-id>] [--enabled true|false]\n  app.exe cli skill delete --id <id> [--scope global|workspace] [--session <session-id>]"
}

fn session_id_from_env() -> Option<Uuid> {
    std::env::var("AWT_SESSION_ID")
        .ok()
        .and_then(|value| parse_uuid(&value).ok())
}

fn pane_id_from_env() -> Option<Uuid> {
    std::env::var("AWT_PANE_ID")
        .ok()
        .and_then(|value| parse_uuid(&value).ok())
}

fn skill_session_id_from_env() -> Option<String> {
    session_id_from_env().map(|session_id| session_id.to_string())
}

pub(crate) fn write_payload(text: String, enter: bool) -> Vec<u8> {
    let mut data = text.into_bytes();
    if enter {
        data.push(b'\r');
    }
    data
}

pub(crate) fn strip_ansi(text: &str) -> Cow<'_, str> {
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
    fn parse_task_done_accepts_optional_pane_and_commit_message() {
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let parsed = parse_args([
            "cli",
            "task",
            "done",
            "--session",
            &session_id.to_string(),
            "--pane",
            &pane_id.to_string(),
            "--task",
            "task-1",
            "--commit-msg",
            "finished",
            "--result-summary",
            "responded with greeting",
        ])
        .expect("parse");

        assert_eq!(
            parsed,
            CliCommand::TaskDone {
                session_id,
                pane_id: Some(pane_id),
                task_id: "task-1".to_string(),
                commit_msg: Some("finished".to_string()),
                result_summary: Some("responded with greeting".to_string()),
            }
        );
    }

    #[test]
    fn parse_task_note_requires_message() {
        let session_id = Uuid::new_v4();
        let err = parse_args([
            "cli",
            "task",
            "note",
            "--session",
            &session_id.to_string(),
            "--task",
            "task-1",
        ])
        .expect_err("missing message should fail");

        assert!(err.to_string().contains("--message"));
    }

    #[test]
    fn parse_skill_apply_accepts_metadata_scope_and_enabled() {
        let session_id = Uuid::new_v4();
        let parsed = parse_args([
            "cli",
            "skill",
            "apply",
            "--id",
            "rust-helper",
            "--name",
            "Rust Helper",
            "--category",
            "Coding",
            "--description",
            "Use Rust carefully",
            "--content",
            "# Rust\nDo work",
            "--scope",
            "workspace",
            "--session",
            &session_id.to_string(),
            "--enabled",
            "false",
        ])
        .expect("parse");

        assert_eq!(
            parsed,
            CliCommand::SkillApply {
                id: "rust-helper".to_string(),
                name: Some("Rust Helper".to_string()),
                category: Some("Coding".to_string()),
                description: Some("Use Rust carefully".to_string()),
                content: "# Rust\nDo work".to_string(),
                scope: Some("workspace".to_string()),
                session_id: Some(session_id.to_string()),
                enabled: Some(false),
            }
        );
    }

    #[test]
    fn parse_skill_show_accepts_positional_id_and_global_scope() {
        let parsed = parse_args(["cli", "skill", "show", "rust-helper", "--scope", "global"])
            .expect("parse");

        assert_eq!(
            parsed,
            CliCommand::SkillShow {
                id: "rust-helper".to_string(),
                session_id: None,
                scope: Some("global".to_string()),
            }
        );
    }

    #[test]
    fn skill_apply_input_defaults_global_without_session() {
        let input = skill_apply_input(
            "demo".to_string(),
            None,
            None,
            None,
            "# Demo".to_string(),
            None,
            None,
            None,
        )
        .expect("input");

        assert_eq!(input.id, "demo");
        assert_eq!(input.name, Some("demo".to_string()));
        assert_eq!(input.category, Some("Custom".to_string()));
        assert_eq!(input.scope, SkillScope::Global);
        assert_eq!(input.session_id, None);
        assert_eq!(input.enabled, Some(true));
    }

    #[test]
    fn parse_skill_apply_requires_content() {
        let err = parse_args(["cli", "skill", "apply", "--id", "demo"])
            .expect_err("missing content should fail");

        assert!(err.to_string().contains("--content"));
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
