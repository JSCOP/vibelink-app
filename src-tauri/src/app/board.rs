use anyhow::Result;
use std::path::PathBuf;

#[tauri::command]
pub async fn board_read(session_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || board_read_native(&session_id))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn board_write(session_id: String, json: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || board_write_native(&session_id, &json))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

pub fn board_read_native(session_id: &str) -> Result<String> {
    let path = board_path(session_id)?;
    match std::fs::read_to_string(path) {
        Ok(contents) => Ok(contents),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok("{}".to_string()),
        Err(err) => Err(err.into()),
    }
}

pub fn board_write_native(session_id: &str, json: &str) -> Result<()> {
    let path = board_path(session_id)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

pub fn board_path(session_id: &str) -> Result<PathBuf> {
    Ok(crate::daemon::paths::daemon_paths()?
        .data_dir
        .join("kanban")
        .join(format!("{}.json", sanitize_session_id(session_id))))
}

fn sanitize_session_id(session_id: &str) -> String {
    session_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect::<String>()
}

fn to_string(err: impl std::fmt::Display) -> String {
    err.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn board_read_write_round_trips_json() {
        let session_id = format!("board-test-{}", uuid::Uuid::new_v4());
        board_write_native(&session_id, "{\"tasks\":{}}").expect("write board");
        assert_eq!(
            board_read_native(&session_id).expect("read board"),
            "{\"tasks\":{}}"
        );
        let path = board_path(&session_id).expect("path");
        std::fs::remove_file(path).expect("cleanup board");
    }
}
