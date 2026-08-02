use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

const LATENCY_BUDGET: Duration = Duration::from_millis(500);

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "vibelink-ssh-spike-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        fs::create_dir_all(&path).expect("create spike temp directory");
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn required_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set for the ignored SSH spike"))
}

fn ssh_options(known_hosts: &Path, strict: &str) -> Vec<String> {
    vec![
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ConnectTimeout=10".into(),
        "-o".into(),
        "ConnectionAttempts=1".into(),
        "-o".into(),
        "GlobalKnownHostsFile=NUL".into(),
        "-o".into(),
        format!("UserKnownHostsFile={}", known_hosts.display()),
        "-o".into(),
        format!("StrictHostKeyChecking={strict}"),
    ]
}

fn run_ssh(target: &str, known_hosts: &Path, command: &str) -> std::process::Output {
    Command::new("ssh.exe")
        .args(ssh_options(known_hosts, "accept-new"))
        .arg(target)
        .arg(command)
        .output()
        .expect("run Windows OpenSSH client")
}

fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn assert_success(operation: &str, output: &std::process::Output) {
    assert!(
        output.status.success(),
        "{operation} failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
}

fn assert_latency(operation: &str, elapsed: Duration) {
    println!("SPIKE {operation}_ms={}", elapsed.as_millis());
    assert!(
        elapsed < LATENCY_BUDGET,
        "{operation} took {} ms; budget is under {} ms",
        elapsed.as_millis(),
        LATENCY_BUDGET.as_millis()
    );
}

#[test]
#[ignore = "requires VIBELINK_SSH_SPIKE_TARGET and VIBELINK_SSH_SPIKE_REPO"]
fn ssh_execution_host_contract() {
    let target = required_env("VIBELINK_SSH_SPIKE_TARGET");
    let repository = required_env("VIBELINK_SSH_SPIKE_REPO");
    assert!(
        !target.chars().any(char::is_whitespace),
        "target must be user@host"
    );
    assert!(
        repository.starts_with('/'),
        "remote repository must be an absolute POSIX path"
    );
    assert!(
        !repository
            .chars()
            .any(|character| matches!(character, '\n' | '\r' | '"')),
        "remote repository contains unsupported characters"
    );

    let temp = TempDir::new();
    let known_hosts = temp.0.join("known_hosts");
    let local_payload = temp.0.join("payload.bin");
    let downloaded_payload = temp.0.join("downloaded.bin");
    let batch = temp.0.join("sftp.batch");
    let remote_payload = format!(
        "{repository}/.vibelink-ssh-spike-{}.bin",
        std::process::id()
    );
    let payload: Vec<u8> = (0..4096).map(|index| (index % 251) as u8).collect();
    fs::write(&local_payload, &payload).expect("write local payload");
    fs::write(
        &batch,
        format!(
            "put \"{}\" \"{}\"\nget \"{}\" \"{}\"\nrm \"{}\"\n",
            local_payload.display().to_string().replace('\\', "/"),
            remote_payload,
            remote_payload,
            downloaded_payload.display().to_string().replace('\\', "/"),
            remote_payload,
        ),
    )
    .expect("write sftp batch");

    let started = Instant::now();
    let transfer = Command::new("sftp.exe")
        .args(ssh_options(&known_hosts, "accept-new"))
        .arg("-b")
        .arg(&batch)
        .arg(&target)
        .output()
        .expect("run Windows OpenSSH sftp client");
    let write_read_latency = started.elapsed();
    assert_success("write/read", &transfer);
    assert_eq!(
        fs::read(&downloaded_payload).expect("read downloaded payload"),
        payload
    );
    assert_latency("write_read", write_read_latency);

    let started = Instant::now();
    let interactive = Command::new("ssh.exe")
        .args(ssh_options(&known_hosts, "accept-new"))
        .arg("-tt")
        .arg(&target)
        .arg("printf '__VIBELINK_SSH_INTERACTIVE__\\n'")
        .output()
        .expect("run interactive SSH command");
    let interactive_latency = started.elapsed();
    assert_success("interactive command", &interactive);
    assert!(String::from_utf8_lossy(&interactive.stdout).contains("__VIBELINK_SSH_INTERACTIVE__"));
    assert_latency("interactive", interactive_latency);

    let started = Instant::now();
    let git = run_ssh(
        &target,
        &known_hosts,
        &format!(
            "cd -- {} && git status --porcelain && printf '__VIBELINK_HEAD__=' && git rev-parse HEAD",
            posix_quote(&repository)
        ),
    );
    let git_latency = started.elapsed();
    assert_success("remote git", &git);
    let git_output = String::from_utf8_lossy(&git.stdout);
    let head = git_output
        .split("__VIBELINK_HEAD__=")
        .nth(1)
        .map(str::trim)
        .expect("git output includes HEAD marker");
    assert!(
        head.len() >= 40
            && head
                .chars()
                .take(40)
                .all(|character| character.is_ascii_hexdigit())
    );
    assert_latency("git", git_latency);

    let mut interrupted = Command::new("ssh.exe")
        .args(ssh_options(&known_hosts, "accept-new"))
        .arg(&target)
        .arg("printf '__VIBELINK_CONNECTED__\\n'; sleep 30")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("start interruptible SSH session");
    let stdout = interrupted
        .stdout
        .take()
        .expect("capture interruptible SSH stdout");
    let (connected_tx, connected_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = BufReader::new(stdout).read_line(&mut line);
        let _ = connected_tx.send(line);
    });
    let connected = connected_rx
        .recv_timeout(Duration::from_secs(15))
        .expect("SSH session did not connect before timeout");
    assert!(connected.contains("__VIBELINK_CONNECTED__"));
    let started = Instant::now();
    interrupted.kill().expect("kill owned SSH client");
    interrupted.wait().expect("reap owned SSH client");
    let reconnect = run_ssh(
        &target,
        &known_hosts,
        "printf '__VIBELINK_RECONNECTED__\\n'",
    );
    let reconnect_latency = started.elapsed();
    assert_success("reconnect", &reconnect);
    assert!(String::from_utf8_lossy(&reconnect.stdout).contains("__VIBELINK_RECONNECTED__"));
    assert_latency("reconnect", reconnect_latency);

    let fake_key = temp.0.join("fake-host-key");
    let keygen = Command::new("ssh-keygen.exe")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(&fake_key)
        .output()
        .expect("run Windows OpenSSH keygen");
    assert_success("fake host-key generation", &keygen);
    let public_key =
        fs::read_to_string(fake_key.with_extension("pub")).expect("read fake public key");
    let mut public_parts = public_key.split_whitespace();
    let algorithm = public_parts.next().expect("fake key algorithm");
    let key = public_parts.next().expect("fake key body");
    let host = target.rsplit('@').next().expect("target host");
    let wrong_known_hosts = temp.0.join("wrong_known_hosts");
    fs::write(&wrong_known_hosts, format!("{host} {algorithm} {key}\n"))
        .expect("write wrong known_hosts");

    let started = Instant::now();
    let mismatch = Command::new("ssh.exe")
        .args(ssh_options(&wrong_known_hosts, "yes"))
        .arg(&target)
        .arg("true")
        .output()
        .expect("run changed host-key check");
    let mismatch_latency = started.elapsed();
    assert!(!mismatch.status.success(), "changed host key was accepted");
    let mismatch_error = String::from_utf8_lossy(&mismatch.stderr).to_ascii_lowercase();
    assert!(
        mismatch_error.contains("host key verification failed")
            || mismatch_error.contains("remote host identification has changed")
            || mismatch_error.contains("offending"),
        "changed host-key failure was not explicit"
    );
    assert_latency("host_key_refusal", mismatch_latency);
}
