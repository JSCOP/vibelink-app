use super::*;

/// The only two ways a local IPC client can be refused admission. This is
/// process-local socket security, not licensing: VibeLink is free, but a
/// stranger still must not drive this daemon.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum AdmissionError {
    AuthRequired,
    ProtocolMismatch,
}

impl AdmissionError {
    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::AuthRequired => DAEMON_AUTH_REQUIRED,
            Self::ProtocolMismatch => DAEMON_PROTOCOL_MISMATCH,
        }
    }
}

fn send_admission_error<S: Write>(stream: &mut S, code: AdmissionError) {
    let _ = write_frame(
        stream,
        &DaemonToClient::Error {
            req: None,
            message: code.as_str().to_string(),
        },
    );
}

pub(super) fn authenticate_connection<S: Read + Write>(
    stream: &mut S,
    boot_id: Uuid,
    secret: &[u8; 32],
) -> std::result::Result<AuthenticatedClient, AdmissionError> {
    let (client_id, client_kind) = match read_frame::<_, ClientToDaemon>(stream) {
        Ok(ClientToDaemon::Hello {
            protocol_version,
            client_id,
            client_kind,
        }) if protocol_version == DAEMON_PROTOCOL_VERSION => (client_id, client_kind),
        Ok(ClientToDaemon::Hello { .. }) => {
            send_admission_error(stream, AdmissionError::ProtocolMismatch);
            return Err(AdmissionError::ProtocolMismatch);
        }
        Ok(_) | Err(_) => {
            send_admission_error(stream, AdmissionError::AuthRequired);
            return Err(AdmissionError::AuthRequired);
        }
    };

    let mut nonce = [0_u8; 32];
    OsRng.fill_bytes(&mut nonce);
    let mut pending = PendingChallenge {
        boot_id,
        nonce,
        client_id,
        client_kind,
        expires_at: Instant::now() + AUTH_CHALLENGE_TTL,
        consumed: false,
    };
    write_frame(
        stream,
        &DaemonToClient::Challenge {
            protocol_version: DAEMON_PROTOCOL_VERSION,
            boot_id,
            nonce,
            expires_at_unix_ms: unix_time_millis() + AUTH_CHALLENGE_TTL.as_millis() as i64,
        },
    )
    .map_err(|_| AdmissionError::AuthRequired)?;

    let (authenticate_client_id, proof) = match read_frame::<_, ClientToDaemon>(stream) {
        Ok(ClientToDaemon::Authenticate { client_id, proof }) => (client_id, proof),
        Ok(_) | Err(_) => {
            send_admission_error(stream, AdmissionError::AuthRequired);
            return Err(AdmissionError::AuthRequired);
        }
    };
    if let Err(code) = pending.verify(secret, authenticate_client_id, &proof, Instant::now()) {
        send_admission_error(stream, code);
        return Err(code);
    }

    write_frame(stream, &DaemonToClient::Authenticated)
        .map_err(|_| AdmissionError::AuthRequired)?;
    Ok(AuthenticatedClient {
        client_id,
        client_kind,
    })
}

fn unix_time_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
