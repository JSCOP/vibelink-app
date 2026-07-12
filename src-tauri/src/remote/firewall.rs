use anyhow::{anyhow, Context, Result};
use std::process::Command;

pub const RULE_NAME: &str = "VibeLink Remote Access";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn powershell() -> Command {
    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn encoded_command(script: &str) -> String {
    use base64::Engine;
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

/// Ports currently allowed by enabled inbound TCP rules with our display name.
pub fn configured_ports() -> Result<Vec<u16>> {
    let query = format!(
        "(Get-NetFirewallRule -DisplayName '{RULE_NAME}' -ErrorAction SilentlyContinue | Where-Object {{ $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' }} | Get-NetFirewallPortFilter).LocalPort"
    );
    let output = powershell()
        .args(["-Command", &query])
        .output()
        .context("query Windows Firewall rule")?;
    Ok(parse_ports(&String::from_utf8_lossy(&output.stdout)))
}

pub fn is_configured(port: u16) -> Result<bool> {
    Ok(configured_ports()?.contains(&port))
}

/// Replaces the VibeLink inbound allow rule with one for `port`.
/// Triggers a single UAC elevation prompt; fails when the user declines.
pub fn setup(port: u16) -> Result<()> {
    let script = format!(
        "$ErrorActionPreference = 'Stop'\ntry {{\n  Remove-NetFirewallRule -DisplayName '{RULE_NAME}' -ErrorAction SilentlyContinue\n  New-NetFirewallRule -DisplayName '{RULE_NAME}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort {port} -Profile Any | Out-Null\n  exit 0\n}} catch {{ exit 1 }}"
    );
    let encoded = encoded_command(&script);
    let elevate = format!(
        "$ErrorActionPreference = 'Stop'; try {{ $process = Start-Process -FilePath 'powershell' -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand','{encoded}') -Verb RunAs -Wait -PassThru; exit $process.ExitCode }} catch {{ exit 1 }}"
    );
    let status = powershell()
        .args(["-Command", &elevate])
        .status()
        .context("run elevated firewall setup")?;
    if !status.success() {
        return Err(anyhow!(
            "Windows 방화벽 규칙 설정이 취소되었거나 실패했습니다. 관리자 승인이 필요합니다."
        ));
    }
    Ok(())
}

fn parse_ports(text: &str) -> Vec<u16> {
    text.lines()
        .filter_map(|line| line.trim().parse::<u16>().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_numeric_port_lines() {
        assert_eq!(parse_ports("42811\r\nAny\r\n\r\n"), vec![42811]);
        assert_eq!(parse_ports(""), Vec::<u16>::new());
        assert_eq!(parse_ports("42811\n50000\n"), vec![42811, 50000]);
    }

    #[test]
    fn encoded_command_is_utf16le_base64() {
        // "exit 0" in UTF-16LE base64
        assert_eq!(encoded_command("exit 0"), "ZQB4AGkAdAAgADAA");
    }
}
