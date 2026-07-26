use anyhow::{anyhow, Context, Result};
use std::process::Command;

const RELEASE_RULE_NAME: &str = "VibeLink Remote Access";
const DEBUG_RULE_NAME: &str = "VibeLink Dev Remote Access";

fn rule_name_for(debug_build: bool) -> &'static str {
    if debug_build {
        DEBUG_RULE_NAME
    } else {
        RELEASE_RULE_NAME
    }
}

pub fn rule_name() -> &'static str {
    rule_name_for(cfg!(debug_assertions))
}

pub fn validate_port(port: u16) -> Result<u16> {
    if port < 1024 {
        return Err(anyhow!("remote port must be between 1024 and 65535"));
    }
    Ok(port)
}

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

fn configured_ports_script(rule_name: &str) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'; Get-NetFirewallRule -DisplayName '{rule_name}' -ErrorAction SilentlyContinue | Where-Object {{ $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' -and $_.Profile -eq 'Private' }} | Get-NetFirewallPortFilter | Where-Object {{ $_.Protocol -eq 'TCP' }} | ForEach-Object {{ $_.LocalPort }}"
    )
}

fn setup_script(rule_name: &str, port: u16) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'\ntry {{\n  Remove-NetFirewallRule -DisplayName '{rule_name}' -ErrorAction SilentlyContinue\n  New-NetFirewallRule -DisplayName '{rule_name}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort {port} -Profile Private | Out-Null\n  exit 0\n}} catch {{ exit 1 }}"
    )
}

fn elevation_script(encoded: &str) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'; try {{ $process = Start-Process -FilePath 'powershell' -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand','{encoded}') -Verb RunAs -Wait -PassThru; exit $process.ExitCode }} catch {{ exit 1 }}"
    )
}

/// Ports currently allowed by enabled inbound TCP rules with our display name.
pub fn configured_ports() -> Result<Vec<u16>> {
    let query = configured_ports_script(rule_name());
    let output = powershell()
        .args(["-Command", &query])
        .output()
        .context("query Windows Firewall rule")?;
    if !output.status.success() {
        return Err(anyhow!("query Windows Firewall rule failed"));
    }
    Ok(parse_ports(&String::from_utf8_lossy(&output.stdout)))
}

pub fn is_configured(port: u16) -> Result<bool> {
    let port = validate_port(port)?;
    Ok(configured_ports()?.contains(&port))
}

/// Replaces the VibeLink inbound allow rule with one for `port`.
/// Triggers a single UAC elevation prompt; fails when the user declines.
pub fn setup(port: u16) -> Result<()> {
    let port = validate_port(port)?;
    let script = setup_script(rule_name(), port);
    let encoded = encoded_command(&script);
    let elevate = elevation_script(&encoded);
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
    fn rule_names_are_flavor_specific_and_stable() {
        assert_eq!(rule_name_for(false), "VibeLink Remote Access");
        assert_eq!(rule_name_for(true), "VibeLink Dev Remote Access");
        assert_eq!(rule_name(), rule_name_for(cfg!(debug_assertions)));
    }

    #[test]
    fn status_query_requires_private_inbound_tcp_allow_rule() {
        let query = configured_ports_script(DEBUG_RULE_NAME);

        assert!(query.contains("-DisplayName 'VibeLink Dev Remote Access'"));
        assert!(query.contains("$_.Enabled -eq 'True'"));
        assert!(query.contains("$_.Direction -eq 'Inbound'"));
        assert!(query.contains("$_.Action -eq 'Allow'"));
        assert!(query.contains("$_.Profile -eq 'Private'"));
        assert!(query.contains("$_.Protocol -eq 'TCP'"));
    }

    #[test]
    fn setup_replaces_only_the_flavor_rule_with_a_private_port_rule() {
        let script = setup_script(RELEASE_RULE_NAME, 42_811);

        assert!(script.contains("Remove-NetFirewallRule -DisplayName 'VibeLink Remote Access'"));
        assert!(script.contains("New-NetFirewallRule -DisplayName 'VibeLink Remote Access'"));
        assert!(script.contains("-Protocol TCP -LocalPort 42811 -Profile Private"));
        assert!(!script.contains("-Profile Any"));
    }

    #[test]
    fn rejects_privileged_firewall_ports() {
        assert!(validate_port(1023).is_err());
        assert_eq!(validate_port(1024).unwrap(), 1024);
        assert_eq!(validate_port(u16::MAX).unwrap(), u16::MAX);
    }

    #[test]
    fn parses_only_numeric_port_lines() {
        assert_eq!(parse_ports("42811\r\nAny\r\n\r\n"), vec![42811]);
        assert_eq!(parse_ports(""), Vec::<u16>::new());
        assert_eq!(parse_ports("42811\n50000\n"), vec![42811, 50000]);
    }

    #[test]
    fn encoded_command_is_utf16le_base64() {
        assert_eq!(encoded_command("exit 0"), "ZQB4AGkAdAAgADAA");
    }
}
