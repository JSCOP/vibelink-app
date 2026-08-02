use crate::daemon::paths::{app_flavor, daemon_paths};
use directories::BaseDirs;
use serde_json::Value;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const CURRENT_LOG_LIMIT: u64 = 2 * 1024 * 1024;
const ROTATED_LOG_LIMIT: u64 = 1024 * 1024;

#[tauri::command]
pub fn export_diagnostics(destination: String) -> Result<String, String> {
    let paths = daemon_paths().map_err(|error| error.to_string())?;
    let home = BaseDirs::new()
        .map(|dirs| dirs.home_dir().to_string_lossy().into_owned())
        .unwrap_or_default();
    let file = File::create(&destination).map_err(|error| error.to_string())?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let os = sysinfo::System::long_os_version()
        .or_else(sysinfo::System::name)
        .unwrap_or_else(|| "unknown".to_string());
    let metadata = format!(
        "version={}\nflavor={}\ntimestamp={}\nos={}\ndaemon_pid_file={}\n",
        env!("CARGO_PKG_VERSION"),
        app_flavor(),
        chrono::Utc::now().to_rfc3339(),
        os,
        paths.pid.exists(),
    );
    write_text(&mut zip, "metadata.txt", &metadata, &home, options)?;

    if paths.log.exists() {
        let log = read_tail(&paths.log, CURRENT_LOG_LIMIT)?;
        write_text(&mut zip, "daemon.log", &log, &home, options)?;
    } else {
        write_text(&mut zip, "daemon.log", "", &home, options)?;
    }

    let rotated_log = paths.log.with_extension("log.1");
    if rotated_log.exists() {
        let log = read_tail(&rotated_log, ROTATED_LOG_LIMIT)?;
        write_text(&mut zip, "daemon.log.1", &log, &home, options)?;
    }

    let (workspace_count, pane_count) = session_counts(&paths.sessions);
    let summary = format!("workspace_count={workspace_count}\npane_count={pane_count}\n");
    write_text(&mut zip, "summary.txt", &summary, &home, options)?;

    zip.finish().map_err(|error| error.to_string())?;
    Ok(destination)
}

fn write_text(
    zip: &mut ZipWriter<File>,
    name: &str,
    text: &str,
    home: &str,
    options: SimpleFileOptions,
) -> Result<(), String> {
    zip.start_file(name, options)
        .map_err(|error| error.to_string())?;
    zip.write_all(redact(text, home).as_bytes())
        .map_err(|error| error.to_string())
}

fn redact(text: &str, home: &str) -> String {
    if home.is_empty() {
        return text.to_string();
    }
    let redacted = text.replace(home, "%USERPROFILE%");
    let slash_home = home.replace('\\', "/");
    if slash_home == home {
        redacted
    } else {
        redacted.replace(&slash_home, "%USERPROFILE%")
    }
}

fn read_tail(path: &Path, limit: u64) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(limit)))
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity(length.min(limit) as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn session_counts(path: &Path) -> (usize, usize) {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return (0, 0);
    };
    let Ok(value) = serde_json::from_str::<Value>(&contents) else {
        return (0, 0);
    };
    let sessions = value
        .get("sessions")
        .and_then(Value::as_array)
        .or_else(|| value.as_array());
    let Some(sessions) = sessions else {
        return (0, 0);
    };
    let pane_count = sessions
        .iter()
        .filter_map(|session| session.get("panes").and_then(Value::as_array))
        .map(Vec::len)
        .sum();
    (sessions.len(), pane_count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_profile_paths_and_counts_only_sessions_and_panes() {
        let home = r"C:\Users\person";
        assert_eq!(
            redact(r"C:\Users\person\repo C:/Users/person/other", home,),
            "%USERPROFILE%\\repo %USERPROFILE%/other",
        );

        let path = std::env::temp_dir().join(format!(
            "vibelink-diagnostics-sessions-{}.json",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            r#"{"sessions":[{"workspaceFolder":"secret","panes":[{},{}]},{"panes":[]}]}"#,
        )
        .expect("write sessions fixture");
        assert_eq!(session_counts(&path), (2, 2));
        let _ = std::fs::remove_file(path);
    }
}
