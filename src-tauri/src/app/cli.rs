use crate::dedicated_cli::{
    parse_args, CliError, ControlExecutor, Flavor, Invocation, SocketExecutor,
};
use serde_json::Value;

#[tauri::command]
pub async fn cli_request(args: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let invocation = parse_app_invocation(args).map_err(to_string)?;
        let mut executor = SocketExecutor;
        executor.execute(invocation).map_err(to_string)
    })
    .await
    .map_err(to_string)?
}

fn parse_app_invocation(args: Vec<String>) -> Result<Invocation, CliError> {
    let mut invocation = parse_args(args)?;
    invocation.flavor = Some(Flavor::parse(crate::daemon::paths::app_flavor())?);
    Ok(invocation)
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_app_cli_requests_stay_on_the_running_app_flavor() {
        let invocation =
            parse_app_invocation(vec!["--flavor".into(), "prod".into(), "status".into()])
                .expect("parse in-app invocation");

        assert_eq!(invocation.flavor, Some(Flavor::Dev));
    }
}
