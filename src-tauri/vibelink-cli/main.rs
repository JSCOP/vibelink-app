use app_lib::{
    dedicated_cli::{run_with_io, CliError, SocketExecutor},
    mcp,
};

fn main() {
    let mut executor = SocketExecutor;
    let mut mcp = || {
        mcp::run(["mcp".to_string(), "serve".to_string()])
            .map_err(|error| CliError::internal(error.to_string()))
    };
    let exit_code = run_with_io(
        std::env::args().skip(1),
        &mut executor,
        &mut mcp,
        std::io::stdout(),
        std::io::stderr(),
    );
    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}
