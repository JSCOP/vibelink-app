use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    net::TcpStream,
    time::{Duration, Instant},
};
use tungstenite::{
    client::IntoClientRequest,
    http::{header::SEC_WEBSOCKET_PROTOCOL, HeaderValue},
    stream::MaybeTlsStream,
    WebSocket,
};
use url::Url;
use zeroize::Zeroizing;

use super::SUBPROTOCOL;

const HOST_SECRET_HEADER: &str = "x-vibelink-host-secret";
const SECRET_BYTES: usize = 32;
const ROUTING_ID_BYTES: usize = 18;

const RELAY_FAILURE_THRESHOLD: u8 = 3;
const RELAY_COOLDOWN: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionPath {
    Direct,
    Relay,
}

pub struct RelayCircuitBreaker {
    failures: u8,
    open_until: Option<Instant>,
    threshold: u8,
    cooldown: Duration,
}

impl Default for RelayCircuitBreaker {
    fn default() -> Self {
        Self {
            failures: 0,
            open_until: None,
            threshold: RELAY_FAILURE_THRESHOLD,
            cooldown: RELAY_COOLDOWN,
        }
    }
}

impl RelayCircuitBreaker {
    pub fn can_attempt(&mut self, now: Instant) -> bool {
        match self.open_until {
            Some(until) if now < until => false,
            Some(_) => {
                self.failures = 0;
                self.open_until = None;
                true
            }
            None => true,
        }
    }

    pub fn record_success(&mut self) {
        self.failures = 0;
        self.open_until = None;
    }

    pub fn record_failure(&mut self, now: Instant) {
        self.failures = self.failures.saturating_add(1);
        if self.failures >= self.threshold {
            self.open_until = now.checked_add(self.cooldown);
        }
    }

    pub fn is_open(&self, now: Instant) -> bool {
        self.open_until.is_some_and(|until| now < until)
    }
}

pub fn connect_direct_first<T, D, R>(
    mut direct: D,
    mut relay: R,
    breaker: &mut RelayCircuitBreaker,
    now: Instant,
) -> Result<(T, ConnectionPath)>
where
    D: FnMut() -> Result<T>,
    R: FnMut() -> Result<T>,
{
    match direct() {
        Ok(connection) => Ok((connection, ConnectionPath::Direct)),
        Err(direct_error) if !breaker.can_attempt(now) => {
            bail!("relay_unavailable: relay circuit is open after direct failure: {direct_error}")
        }
        Err(direct_error) => match relay() {
            Ok(connection) => {
                breaker.record_success();
                Ok((connection, ConnectionPath::Relay))
            }
            Err(relay_error) => {
                breaker.record_failure(now);
                bail!(
                    "relay_unavailable: direct connection failed ({direct_error}); relay failed ({relay_error})"
                )
            }
        },
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayInvite {
    pub relay_origin: String,
    pub host_id: String,
    pub invite_id: String,
    pub invite_secret: String,
    pub resume_id: String,
    pub resume_secret: String,
    pub expires_at: i64,
}

pub struct RelayClient {
    relay_origin: Url,
    host_id: String,
    host_secret: Zeroizing<String>,
}

impl RelayClient {
    pub fn new(relay_origin: &str, host_id: String, host_secret: String) -> Result<Self> {
        Self::new_with_policy(relay_origin, host_id, host_secret, false)
    }

    pub fn new_with_policy(
        relay_origin: &str,
        host_id: String,
        host_secret: String,
        allow_insecure_local: bool,
    ) -> Result<Self> {
        let relay_origin = Url::parse(relay_origin).context("parse relay origin")?;
        let secure = matches!(relay_origin.scheme(), "https" | "wss");
        let local = relay_origin
            .host_str()
            .is_some_and(|host| matches!(host, "127.0.0.1" | "localhost" | "::1"));
        if !(secure || allow_insecure_local && local) {
            bail!("remote-v2 relay requires HTTPS/WSS");
        }
        if relay_origin.host_str().is_none()
            || relay_origin.username() != ""
            || relay_origin.password().is_some()
            || relay_origin.query().is_some()
            || relay_origin.fragment().is_some()
        {
            bail!("invalid remote-v2 relay origin");
        }
        validate_routing_value(&host_id, 22, "host id")?;
        if host_secret.len() < 32 || host_secret.len() > 256 {
            bail!("invalid remote-v2 host secret");
        }
        Ok(Self {
            relay_origin,
            host_id,
            host_secret: Zeroizing::new(host_secret),
        })
    }

    pub fn claim_host(&self) -> Result<()> {
        let response = ureq::put(&self.http_url("")?)
            .set(HOST_SECRET_HEADER, self.host_secret.as_str())
            .call()
            .context("claim remote-v2 relay host")?;
        if response.status() != 200 {
            bail!("relay host claim failed with status {}", response.status());
        }
        Ok(())
    }

    pub fn create_invite(&self, expires_at: i64) -> Result<RelayInvite> {
        let invite = RelayInvite {
            relay_origin: self.relay_origin.as_str().trim_end_matches('/').to_string(),
            host_id: self.host_id.clone(),
            invite_id: random_token(ROUTING_ID_BYTES),
            invite_secret: random_token(SECRET_BYTES),
            resume_id: random_token(ROUTING_ID_BYTES),
            resume_secret: random_token(SECRET_BYTES),
            expires_at,
        };
        let response = ureq::post(&self.http_url("invites")?)
            .set(HOST_SECRET_HEADER, self.host_secret.as_str())
            .send_json(serde_json::json!({
                "inviteId": invite.invite_id,
                "inviteSecret": invite.invite_secret,
                "resumeId": invite.resume_id,
                "resumeSecret": invite.resume_secret,
                "expiresAt": invite.expires_at,
            }))
            .context("register remote-v2 relay invite")?;
        if response.status() != 201 {
            bail!(
                "relay invite registration failed with status {}",
                response.status()
            );
        }
        Ok(invite)
    }

    pub fn revoke_device(&self, resume_id: &str) -> Result<()> {
        validate_routing_value(resume_id, 16, "resume id")?;
        let response = ureq::delete(&self.http_url(&format!("devices/{resume_id}"))?)
            .set(HOST_SECRET_HEADER, self.host_secret.as_str())
            .call()
            .context("revoke remote-v2 relay device")?;
        if response.status() != 200 {
            bail!(
                "relay device revocation failed with status {}",
                response.status()
            );
        }
        Ok(())
    }

    pub fn connect_desktop(&self) -> Result<WebSocket<MaybeTlsStream<TcpStream>>> {
        let mut request = self
            .websocket_url("desktop")?
            .as_str()
            .into_client_request()
            .context("build relay websocket request")?;
        request.headers_mut().insert(
            HOST_SECRET_HEADER,
            HeaderValue::from_str(self.host_secret.as_str()).context("host secret header")?,
        );
        request.headers_mut().insert(
            SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static(SUBPROTOCOL),
        );
        let (socket, response) =
            tungstenite::connect(request).context("connect remote-v2 relay")?;
        let negotiated = response
            .headers()
            .get(SEC_WEBSOCKET_PROTOCOL)
            .and_then(|value| value.to_str().ok());
        if negotiated != Some(SUBPROTOCOL) {
            bail!("relay did not negotiate {SUBPROTOCOL}");
        }
        Ok(socket)
    }

    fn http_url(&self, suffix: &str) -> Result<String> {
        let mut url = self.relay_origin.clone();
        match url.scheme() {
            "wss" => url.set_scheme("https").expect("known scheme"),
            "ws" => url.set_scheme("http").expect("known scheme"),
            "https" | "http" => {}
            _ => bail!("unsupported relay scheme"),
        }
        url.set_path(&format!(
            "/v2/hosts/{}{}",
            self.host_id,
            if suffix.is_empty() {
                String::new()
            } else {
                format!("/{suffix}")
            }
        ));
        Ok(url.to_string())
    }

    fn websocket_url(&self, suffix: &str) -> Result<Url> {
        let mut url = self.relay_origin.clone();
        match url.scheme() {
            "https" => url.set_scheme("wss").expect("known scheme"),
            "http" => url.set_scheme("ws").expect("known scheme"),
            "wss" | "ws" => {}
            _ => bail!("unsupported relay scheme"),
        }
        url.set_path(&format!("/v2/hosts/{}/{suffix}", self.host_id));
        Ok(url)
    }
}

fn random_token(bytes: usize) -> String {
    let mut value = vec![0; bytes];
    OsRng.fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

fn validate_routing_value(value: &str, minimum: usize, label: &str) -> Result<()> {
    if value.len() < minimum
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        bail!("invalid remote-v2 {label}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_relay_requires_secure_transport() {
        assert!(RelayClient::new(
            "http://relay.example.com",
            "K7n7rDg5Qv2z1Hn0tYx_Ab".to_string(),
            "a".repeat(32),
        )
        .is_err());
        assert!(RelayClient::new_with_policy(
            "http://127.0.0.1:8787",
            "K7n7rDg5Qv2z1Hn0tYx_Ab".to_string(),
            "a".repeat(32),
            true,
        )
        .is_ok());
    }

    #[test]
    fn invite_contains_distinct_high_entropy_routing_credentials() {
        let client = RelayClient::new(
            "https://relay.example.com",
            "K7n7rDg5Qv2z1Hn0tYx_Ab".to_string(),
            "a".repeat(32),
        )
        .expect("relay client");
        let invite_id = random_token(ROUTING_ID_BYTES);
        let invite_secret = random_token(SECRET_BYTES);
        let resume_id = random_token(ROUTING_ID_BYTES);
        let resume_secret = random_token(SECRET_BYTES);
        for value in [&invite_id, &invite_secret, &resume_id, &resume_secret] {
            assert!(value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')));
        }
        assert_ne!(invite_id, resume_id);
        assert_ne!(invite_secret, resume_secret);
        assert!(client
            .http_url("invites")
            .expect("invite url")
            .ends_with("/invites"));
    }

    #[test]
    fn direct_is_preferred_and_relay_is_only_fallback() {
        let mut breaker = RelayCircuitBreaker::default();
        let mut relay_called = false;
        let (value, path) = connect_direct_first(
            || Ok::<_, anyhow::Error>("direct"),
            || {
                relay_called = true;
                Ok("relay")
            },
            &mut breaker,
            Instant::now(),
        )
        .unwrap();
        assert_eq!(value, "direct");
        assert_eq!(path, ConnectionPath::Direct);
        assert!(!relay_called);

        let (value, path) = connect_direct_first(
            || anyhow::bail!("direct unavailable"),
            || Ok("relay"),
            &mut breaker,
            Instant::now(),
        )
        .unwrap();
        assert_eq!(value, "relay");
        assert_eq!(path, ConnectionPath::Relay);
    }

    #[test]
    fn relay_failures_open_a_bounded_circuit() {
        let mut breaker = RelayCircuitBreaker::default();
        let now = Instant::now();
        for _ in 0..RELAY_FAILURE_THRESHOLD {
            assert!(connect_direct_first::<(), _, _>(
                || anyhow::bail!("direct unavailable"),
                || anyhow::bail!("relay unavailable"),
                &mut breaker,
                now,
            )
            .is_err());
        }
        assert!(breaker.is_open(now));
        let mut relay_called = false;
        assert!(connect_direct_first::<(), _, _>(
            || anyhow::bail!("direct unavailable"),
            || {
                relay_called = true;
                anyhow::bail!("relay unavailable")
            },
            &mut breaker,
            now,
        )
        .is_err());
        assert!(!relay_called);
        assert!(breaker.can_attempt(now + RELAY_COOLDOWN));
    }
}
