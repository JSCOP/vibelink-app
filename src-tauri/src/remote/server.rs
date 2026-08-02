use super::v2::{
    generated::{AppearanceChangedEvent, AppearanceProjection, CursorStyle, TerminalTheme},
    secure::DeviceIdentity,
    wire::OperationReplayWindow,
};
use super::{
    bridge,
    config::RemoteConfig,
    devices::{DevicePublic, DeviceStore, PairingInfo},
    firewall,
    identity::RemoteIdentity,
    protocol::ServerMessage,
};
use crate::app::authorization::{
    AuthorizationDenied, AuthorizationSnapshot, AuthorizationState, Capability,
};
use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use crossbeam_channel::Sender;
use local_ip_address::list_afinet_netifas;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    net::{IpAddr, TcpListener},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, RwLock, RwLockReadGuard,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tungstenite::Message;
use uuid::Uuid;

const MAX_CLIENTS: usize = 8;

const REMOTE_AUTOSTART_ENV: &str = "VIBELINK_REMOTE_AUTOSTART";

fn should_autostart(enabled: bool, debug_build: bool, env_value: Option<&str>) -> bool {
    enabled && (!debug_build || env_value == Some("1"))
}

#[derive(Debug)]
struct LanFirewallNotConfirmed {
    port: u16,
    detail: String,
}

impl std::fmt::Display for LanFirewallNotConfirmed {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "LAN/VPN remote access requires Windows Firewall rule '{}' for TCP port {} on all network profiles: {}",
            firewall::rule_name(),
            self.port,
            self.detail
        )
    }
}

impl std::error::Error for LanFirewallNotConfirmed {}

fn ensure_lan_firewall_with(
    lan_enabled: bool,
    port: u16,
    configured: impl FnOnce(u16) -> Result<bool>,
) -> Result<()> {
    if !lan_enabled {
        return Ok(());
    }
    match configured(port) {
        Ok(true) => Ok(()),
        Ok(false) => Err(LanFirewallNotConfirmed {
            port,
            detail: "the matching rule is not configured".to_string(),
        }
        .into()),
        Err(error) => Err(LanFirewallNotConfirmed {
            port,
            detail: format!("rule status could not be confirmed: {error}"),
        }
        .into()),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub fingerprint: String,
    pub lan_enabled: bool,
    pub hosts: Vec<String>,
    pub devices: Vec<DevicePublic>,
    pub v2_fingerprint: String,
    pub re_pair_required: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingPayload {
    pub code: String,
    pub expires_at: i64,
    pub qr_payload: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaneLeaseStatus {
    pub session_id: String,
    pub pane_id: String,
    pub device_id: String,
    pub cols: u16,
    pub rows: u16,
    pub expires_at: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaneLeaseEvent {
    pub session_id: String,
    pub pane_id: String,
    pub leased: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cols: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<u16>,
}

struct Runtime {
    shutdown: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

struct ActiveClientCapacity {
    active: AtomicUsize,
    limit: usize,
}

impl ActiveClientCapacity {
    fn new(limit: usize) -> Self {
        Self {
            active: AtomicUsize::new(0),
            limit,
        }
    }

    fn try_reserve(self: &Arc<Self>) -> Option<ActiveClientPermit> {
        self.active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                if active < self.limit {
                    Some(active + 1)
                } else {
                    None
                }
            })
            .ok()
            .map(|_| ActiveClientPermit {
                capacity: Arc::clone(self),
            })
    }
}

struct ActiveClientPermit {
    capacity: Arc<ActiveClientCapacity>,
}

impl Drop for ActiveClientPermit {
    fn drop(&mut self) {
        let previous = self.capacity.active.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "active client permit count underflow");
    }
}

#[derive(Clone, Debug)]
pub(crate) enum RemotePush {
    WebSocket(Message),
    AppearanceChanged(AppearanceChangedEvent),
}

fn default_appearance_projection() -> AppearanceProjection {
    AppearanceProjection {
        alarm_highlight_color: "#7ee787".to_string(),
        cursor_style: CursorStyle::Bar,
        cursor_width: 1.0,
        font_family: "Cascadia Mono".to_string(),
        font_size: 11.0,
        font_weight: "400".to_string(),
        font_weight_bold: "700".to_string(),
        reviewed_pane_highlight_color: "#58a6ff".to_string(),
        scrollback: 5_000,
        selected_pane_highlight_color: "#ff9f1a".to_string(),
        terminal: TerminalTheme {
            background: "#0b0f14".to_string(),
            black: "#0b0f14".to_string(),
            blue: "#79c0ff".to_string(),
            bright_black: "#5c6773".to_string(),
            bright_blue: "#9ecbff".to_string(),
            bright_cyan: "#9af0f5".to_string(),
            bright_green: "#9ff5b7".to_string(),
            bright_magenta: "#e2c5ff".to_string(),
            bright_red: "#ff8f8f".to_string(),
            bright_white: "#ffffff".to_string(),
            bright_yellow: "#f7dc84".to_string(),
            cursor: "#7ee787".to_string(),
            cursor_accent: "#0b0f14".to_string(),
            cyan: "#76e3ea".to_string(),
            foreground: "#d6deeb".to_string(),
            green: "#7ee787".to_string(),
            magenta: "#d2a8ff".to_string(),
            red: "#ff6b6b".to_string(),
            selection_background: "#264f78".to_string(),
            white: "#d6deeb".to_string(),
            yellow: "#f2cc60".to_string(),
        },
        theme_id: "abyss".to_string(),
        theme_name: "Abyss".to_string(),
        ui_vars: BTreeMap::from([
            ("--vibelink-terminal-bg".to_string(), "#0b0f14".to_string()),
            ("--vibelink-terminal-fg".to_string(), "#d6deeb".to_string()),
            ("--vibelink-bg".to_string(), "#0d0f12".to_string()),
        ]),
    }
}

pub(crate) fn legacy_appearance_payload(
    appearance: &AppearanceProjection,
    workspace_alerts: &HashMap<String, usize>,
) -> Value {
    let mut payload = serde_json::to_value(appearance).expect("serialize appearance projection");
    payload
        .as_object_mut()
        .expect("appearance projection must serialize as an object")
        .insert(
            "workspaceAlerts".to_string(),
            serde_json::to_value(workspace_alerts).expect("serialize workspace alerts"),
        );
    payload
}

pub(crate) struct RemoteShared {
    pub devices: Mutex<DeviceStore>,
    pub appearance: RwLock<AppearanceProjection>,
    pub appearance_generation: AtomicU64,
    pub workspace_order: RwLock<Vec<String>>,
    pub workspace_alerts: RwLock<HashMap<String, usize>>,
    pub authorization: RwLock<AuthorizationSnapshot>,
    pub client_senders: Mutex<HashMap<Uuid, Sender<RemotePush>>>,
    pub client_close_requests: Mutex<HashMap<Uuid, Arc<AtomicBool>>>,
    pub client_devices: Mutex<HashMap<Uuid, String>>,
    pub v2_clients: Mutex<HashSet<Uuid>>,
    pub v2_operation_ids: Mutex<HashMap<String, OperationReplayWindow>>,
    pub v2_identity: Arc<DeviceIdentity>,
    active_clients: Arc<ActiveClientCapacity>,
}

impl RemoteShared {
    pub fn authorization_guard(
        &self,
        capability: Capability,
    ) -> std::result::Result<RwLockReadGuard<'_, AuthorizationSnapshot>, AuthorizationDenied> {
        let snapshot = self
            .authorization
            .read()
            .expect("remote authorization lock");
        snapshot.authorize(capability, Utc::now())?;
        Ok(snapshot)
    }

    pub fn authorize(
        &self,
        capability: Capability,
    ) -> std::result::Result<(), AuthorizationDenied> {
        self.authorization_guard(capability).map(drop)
    }

    pub fn disconnect_clients(&self, device_id: Option<&str>) -> Vec<Uuid> {
        let client_keys = self
            .client_devices
            .lock()
            .expect("remote client devices mutex")
            .iter()
            .filter_map(|(client_key, active_device_id)| {
                device_id
                    .is_none_or(|expected| active_device_id == expected)
                    .then_some(*client_key)
            })
            .collect::<Vec<_>>();
        let close_requests = self
            .client_close_requests
            .lock()
            .expect("remote client close requests mutex");
        let senders = self.client_senders.lock().expect("remote clients mutex");
        for client_key in &client_keys {
            if let Some(close_requested) = close_requests.get(client_key) {
                close_requested.store(true, Ordering::Release);
            }
            if let Some(sender) = senders.get(client_key) {
                let _ = sender.try_send(RemotePush::WebSocket(Message::Close(None)));
            }
        }
        client_keys
    }
}

pub struct RemoteServer {
    config_path: PathBuf,
    config: Mutex<RemoteConfig>,
    identity: RwLock<RemoteIdentity>,
    runtime: Mutex<Option<Runtime>>,
    pub(crate) shared: Arc<RemoteShared>,
}

impl RemoteServer {
    pub fn new(data_dir: PathBuf) -> Result<Self> {
        let remote_dir = data_dir.join("remote");
        std::fs::create_dir_all(&remote_dir)?;
        let config_path = remote_dir.join("config.json");
        let devices_path = remote_dir.join("devices.json");
        let config = RemoteConfig::load(&config_path)?;
        let mut identity = RemoteIdentity::load_or_generate(&remote_dir)?;
        let mut devices = DeviceStore::load(devices_path)?;
        if identity.generated_on_load() && !devices.is_empty() && !identity.requires_device_reset()
        {
            identity.mark_device_reset_required()?;
        }
        if identity.requires_device_reset() {
            devices.reset_for_identity_change()?;
            identity.acknowledge_device_reset()?;
        }
        let v2_identity = Arc::new(DeviceIdentity::load_or_create(&format!(
            "desktop-{}",
            std::env::var("VIBELINK_APP_FLAVOR").unwrap_or_else(|_| "prod".to_string()),
        ))?);
        let authorization = locked_authorization_snapshot();
        Ok(Self {
            config_path,
            config: Mutex::new(config),
            identity: RwLock::new(identity),
            runtime: Mutex::new(None),
            shared: Arc::new(RemoteShared {
                devices: Mutex::new(devices),
                appearance: RwLock::new(default_appearance_projection()),
                appearance_generation: AtomicU64::new(0),
                workspace_order: RwLock::new(Vec::new()),
                workspace_alerts: RwLock::new(HashMap::new()),
                authorization: RwLock::new(authorization),
                client_senders: Mutex::new(HashMap::new()),
                client_close_requests: Mutex::new(HashMap::new()),
                client_devices: Mutex::new(HashMap::new()),
                v2_clients: Mutex::new(HashSet::new()),
                v2_operation_ids: Mutex::new(HashMap::new()),
                v2_identity,
                active_clients: Arc::new(ActiveClientCapacity::new(MAX_CLIENTS)),
            }),
        })
    }

    pub fn update_authorization(&self, snapshot: AuthorizationSnapshot) -> Result<()> {
        *self
            .shared
            .authorization
            .write()
            .expect("remote authorization lock") = snapshot;
        if self.shared.authorize(Capability::RemoteConnect).is_ok() {
            self.start_if_enabled()
        } else {
            let _ = self.shared.disconnect_clients(None);
            self.stop();
            Ok(())
        }
    }

    pub fn start_if_enabled(&self) -> Result<()> {
        let env_value = std::env::var(REMOTE_AUTOSTART_ENV).ok();
        self.start_if_enabled_for(cfg!(debug_assertions), env_value.as_deref())
    }

    fn start_if_enabled_for(&self, debug_build: bool, env_value: Option<&str>) -> Result<()> {
        let config = self.config.lock().expect("remote config mutex").clone();
        if !should_autostart(config.enabled, debug_build, env_value) {
            return Ok(());
        }
        if let Err(denied) = self.shared.authorize(Capability::RemoteConnect) {
            tracing::warn!(
                code = denied.code.as_str(),
                "remote autostart deferred until desktop authorization is available"
            );
            return Ok(());
        }
        match self.start() {
            Err(error) if error.downcast_ref::<LanFirewallNotConfirmed>().is_some() => {
                tracing::warn!(
                    ?error,
                    port = config.port,
                    rule_name = firewall::rule_name(),
                    "remote LAN autostart skipped until its firewall rule is approved"
                );
                Ok(())
            }
            result => result,
        }
    }

    pub fn start(&self) -> Result<()> {
        self.shared
            .authorize(Capability::RemoteConnect)
            .map_err(authorization_error)?;
        self.reap_finished_runtime();
        let mut runtime = self.runtime.lock().expect("remote runtime mutex");
        if runtime.is_some() {
            return Ok(());
        }
        let config = self.config.lock().expect("remote config mutex").clone();
        let port = config.port;
        ensure_lan_firewall_with(config.lan_enabled, port, firewall::is_configured)?;
        let bind_host = if config.lan_enabled {
            "0.0.0.0"
        } else {
            "127.0.0.1"
        };
        let listener = TcpListener::bind((bind_host, port))
            .with_context(|| format!("bind remote access host {bind_host} port {port}"))?;
        listener.set_nonblocking(true)?;
        let tls_config = self
            .identity
            .read()
            .expect("remote identity lock")
            .server_config()?;
        let shutdown = Arc::new(AtomicBool::new(false));
        let thread_shutdown = Arc::clone(&shutdown);
        let shared = Arc::clone(&self.shared);
        let handle = thread::Builder::new().name("vibelink-remote-accept".to_string()).spawn(move || {
            while !thread_shutdown.load(Ordering::Acquire) {
                if let Err(denied) = shared.authorize(Capability::RemoteConnect) {
                    tracing::warn!(code = denied.code.as_str(), "stopping stale or unentitled remote listener");
                    let _ = shared.disconnect_clients(None);
                    thread_shutdown.store(true, Ordering::Release);
                    break;
                }
                match listener.accept() {
                    Ok((stream, address)) => {
                        let Some(client_permit) = shared.active_clients.try_reserve() else {
                            tracing::warn!(%address, "rejecting remote client: capacity reached");
                            continue;
                        };
                        let connection_shared = Arc::clone(&shared);
                        let connection_tls = Arc::clone(&tls_config);
                        if let Err(error) = thread::Builder::new()
                            .name("vibelink-remote-client".to_string())
                            .spawn(move || {
                                let _client_permit = client_permit;
                                if let Err(error) = bridge::handle_connection(
                                    stream,
                                    connection_tls,
                                    Arc::clone(&connection_shared),
                                ) {
                                    tracing::warn!(?error, %address, "remote client disconnected");
                                    #[cfg(debug_assertions)]
                                    eprintln!("remote client {address} disconnected: {error:#}");
                                }
                            })
                        {
                            tracing::warn!(?error, %address, "failed to spawn remote client thread");
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(30)),
                    Err(error) => { tracing::warn!(?error, "remote accept failed"); thread::sleep(Duration::from_millis(100)); }
                }
            }
        })?;
        *runtime = Some(Runtime { shutdown, handle });
        Ok(())
    }

    pub fn stop(&self) {
        let runtime = self.runtime.lock().expect("remote runtime mutex").take();
        if let Some(runtime) = runtime.as_ref() {
            runtime.shutdown.store(true, Ordering::Release);
        }
        {
            let close_requests = self
                .shared
                .client_close_requests
                .lock()
                .expect("remote client close requests mutex");
            for close_requested in close_requests.values() {
                close_requested.store(true, Ordering::Release);
            }
        }
        let senders: Vec<_> = self
            .shared
            .client_senders
            .lock()
            .expect("remote clients mutex")
            .values()
            .cloned()
            .collect();
        for sender in senders {
            let _ = sender.try_send(RemotePush::WebSocket(Message::Close(None)));
        }
        if let Some(runtime) = runtime {
            let _ = runtime.handle.join();
        } else {
            let _ = self.shared.disconnect_clients(None);
        }
        self.wait_for_authenticated_clients();
    }

    fn reap_finished_runtime(&self) {
        let finished = self
            .runtime
            .lock()
            .expect("remote runtime mutex")
            .as_ref()
            .is_some_and(|runtime| runtime.handle.is_finished());
        if finished {
            if let Some(runtime) = self.runtime.lock().expect("remote runtime mutex").take() {
                let _ = runtime.handle.join();
            }
        }
    }

    fn wait_for_authenticated_clients(&self) {
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while !self
            .shared
            .client_senders
            .lock()
            .expect("remote clients mutex")
            .is_empty()
            && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_for_clients(&self, client_keys: &[Uuid]) {
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while self
            .shared
            .client_senders
            .lock()
            .expect("remote clients mutex")
            .keys()
            .any(|client_key| client_keys.contains(client_key))
            && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn status(&self) -> RemoteStatus {
        let config = self.config.lock().expect("remote config mutex").clone();
        let devices = self.shared.devices.lock().expect("remote devices mutex");
        let re_pair_required = devices.re_pair_required();
        let devices = devices.list_public();
        RemoteStatus {
            enabled: config.enabled,
            running: self
                .runtime
                .lock()
                .expect("remote runtime mutex")
                .as_ref()
                .is_some_and(|runtime| !runtime.handle.is_finished()),
            port: config.port,
            lan_enabled: config.lan_enabled,
            fingerprint: self
                .identity
                .read()
                .expect("remote identity lock")
                .fingerprint(),
            hosts: if config.lan_enabled {
                local_hosts()
            } else {
                vec!["127.0.0.1".to_string()]
            },
            devices,
            v2_fingerprint: self.shared.v2_identity.fingerprint(),
            re_pair_required,
        }
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<RemoteStatus> {
        if enabled {
            self.start()?;
        } else {
            self.stop();
        }
        let mut config = self.config.lock().expect("remote config mutex");
        config.enabled = enabled;
        config.save(&self.config_path)?;
        drop(config);
        Ok(self.status())
    }

    pub fn set_port(&self, port: u16) -> Result<RemoteStatus> {
        if port < 1024 {
            return Err(anyhow!("remote port must be between 1024 and 65535"));
        }
        let was_running = self.runtime.lock().expect("remote runtime mutex").is_some();
        if was_running {
            self.stop();
        }
        {
            let mut config = self.config.lock().expect("remote config mutex");
            config.port = port;
            config.save(&self.config_path)?;
        }
        if was_running {
            self.start()?;
        }
        Ok(self.status())
    }
    pub fn set_lan_enabled(&self, lan_enabled: bool) -> Result<RemoteStatus> {
        let was_running = self.runtime.lock().expect("remote runtime mutex").is_some();
        if was_running {
            self.stop();
        }
        {
            let mut config = self.config.lock().expect("remote config mutex");
            config.lan_enabled = lan_enabled;
            config.save(&self.config_path)?;
        }
        if was_running {
            self.start()?;
        }
        Ok(self.status())
    }

    fn pairing_v1_qr_payload(status: &RemoteStatus, code: &str) -> Result<String> {
        Ok(serde_json::to_string(&serde_json::json!({
            "v": 1,
            "name": desktop_name(),
            "hosts": status.hosts,
            "port": status.port,
            "fp": status.fingerprint,
            "code": code,
        }))?)
    }

    pub fn create_pairing(&self) -> Result<PairingPayload> {
        let _authorization = self
            .shared
            .authorization_guard(Capability::RemoteConnect)
            .map_err(authorization_error)?;
        let status = self.status();
        if !status.running || !status.lan_enabled {
            return Err(anyhow!(
                "LAN/VPN remote access must be explicitly enabled before pairing"
            ));
        }
        let PairingInfo { code, expires_at } = self
            .shared
            .devices
            .lock()
            .expect("remote devices mutex")
            .create_pairing_code();
        let qr_payload = Self::pairing_v1_qr_payload(&status, &code)?;
        Ok(PairingPayload {
            code,
            expires_at,
            qr_payload,
        })
    }

    pub fn create_pairing_v2(&self) -> Result<PairingPayload> {
        let _authorization = self
            .shared
            .authorization_guard(Capability::RemoteConnect)
            .map_err(authorization_error)?;
        let status = self.status();
        if !status.running || !status.lan_enabled {
            return Err(anyhow!(
                "LAN/VPN remote access must be explicitly enabled before pairing"
            ));
        }
        let PairingInfo { code, expires_at } = self
            .shared
            .devices
            .lock()
            .expect("remote devices mutex")
            .create_pairing_code();
        let qr_payload = serde_json::to_string(&serde_json::json!({
            "v": 2,
            "name": desktop_name(),
            "direct": {
                "hosts": status.hosts,
                "port": status.port,
                "tlsFingerprint": status.fingerprint,
            },
            "noiseFingerprint": status.v2_fingerprint,
            "code": code,
            "expiresAt": expires_at,
            "contractSha256": super::v2::CONTRACT_SHA256,
        }))?;
        Ok(PairingPayload {
            code,
            expires_at,
            qr_payload,
        })
    }

    pub fn revoke_device(&self, device_id: &str) -> Result<()> {
        self.shared
            .devices
            .lock()
            .expect("remote devices mutex")
            .revoke(device_id)?;
        self.shared
            .v2_operation_ids
            .lock()
            .expect("remote v2 replay mutex")
            .remove(device_id);
        self.close_device_connections(device_id);
        Ok(())
    }

    pub fn update_device_grants(&self, device_id: &str, grants: Vec<String>) -> Result<u64> {
        let epoch = self
            .shared
            .devices
            .lock()
            .expect("remote devices mutex")
            .update_grants(device_id, grants)?;
        self.close_device_connections(device_id);
        Ok(epoch)
    }

    fn close_device_connections(&self, device_id: &str) {
        let client_keys = self.shared.disconnect_clients(Some(device_id));
        self.wait_for_clients(&client_keys);
    }

    pub fn regenerate_identity(&self) -> Result<RemoteStatus> {
        let was_running = self.runtime.lock().expect("remote runtime mutex").is_some();
        if was_running {
            self.stop();
        }
        self.shared
            .devices
            .lock()
            .expect("remote devices mutex")
            .reset_for_identity_change()?;
        self.identity
            .write()
            .expect("remote identity lock")
            .regenerate()?;
        if was_running {
            self.start()?;
        }
        Ok(self.status())
    }

    pub fn set_appearance(
        &self,
        appearance: Value,
        workspace_order: Vec<String>,
        workspace_alerts: HashMap<String, usize>,
    ) {
        let appearance = match serde_json::from_value::<AppearanceProjection>(appearance) {
            Ok(appearance) => appearance,
            Err(error) => {
                tracing::warn!(
                    ?error,
                    "rejected non-canonical remote appearance projection"
                );
                return;
            }
        };
        let legacy_payload = legacy_appearance_payload(&appearance, &workspace_alerts);
        *self
            .shared
            .appearance
            .write()
            .expect("remote appearance lock") = appearance.clone();
        *self
            .shared
            .workspace_order
            .write()
            .expect("remote workspace order lock") = workspace_order;
        *self
            .shared
            .workspace_alerts
            .write()
            .expect("remote workspace alerts lock") = workspace_alerts;
        let view_generation = self
            .shared
            .appearance_generation
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |generation| {
                generation.checked_add(1)
            })
            .expect("remote appearance generation exhausted")
            + 1;
        let legacy_message = serde_json::to_string(&ServerMessage::Appearance {
            payload: legacy_payload,
        })
        .expect("serialize legacy appearance");
        let v2_event = AppearanceChangedEvent {
            appearance,
            view_generation,
        };
        let v2_clients = self
            .shared
            .v2_clients
            .lock()
            .expect("remote v2 clients mutex")
            .clone();
        let senders = self
            .shared
            .client_senders
            .lock()
            .expect("remote clients mutex")
            .iter()
            .map(|(client_key, sender)| (*client_key, sender.clone()))
            .collect::<Vec<_>>();
        for (client_key, sender) in senders {
            let push = if v2_clients.contains(&client_key) {
                RemotePush::AppearanceChanged(v2_event.clone())
            } else {
                RemotePush::WebSocket(Message::Text(legacy_message.clone().into()))
            };
            let _ = sender.try_send(push);
        }
    }
}

impl Drop for RemoteServer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn locked_authorization_snapshot() -> AuthorizationSnapshot {
    let now = Utc::now();
    AuthorizationSnapshot {
        state: AuthorizationState::Unlicensed,
        entitled: false,
        observed_at: now,
        lease_until: now,
        offline_grace_until: None,
        policy_epoch: 0,
    }
}

fn authorization_error(denied: AuthorizationDenied) -> anyhow::Error {
    anyhow!(denied.code.as_str())
}

pub(crate) fn desktop_name() -> String {
    sysinfo::System::host_name()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "VibeLink Desktop".to_string())
}

pub(crate) fn local_hosts() -> Vec<String> {
    let mut hosts: Vec<_> = list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(_, ip)| match ip {
            IpAddr::V4(value) if !value.is_loopback() && !value.is_link_local() => {
                Some(value.to_string())
            }
            _ => None,
        })
        .collect();
    hosts.sort();
    hosts.dedup();
    hosts
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration as ChronoDuration;
    use std::net::TcpStream;

    fn snapshot(entitled: bool, lease_until: chrono::DateTime<Utc>) -> AuthorizationSnapshot {
        AuthorizationSnapshot {
            state: if entitled {
                AuthorizationState::ValidOnline
            } else {
                AuthorizationState::TrialExpired
            },
            entitled,
            observed_at: Utc::now(),
            lease_until,
            offline_grace_until: None,
            policy_epoch: 7,
        }
    }

    fn temp_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("vibelink-remote-{label}-{}", Uuid::new_v4()))
    }

    fn available_port() -> u16 {
        let probe = TcpListener::bind(("127.0.0.1", 0)).expect("reserve test port");
        probe.local_addr().expect("probe address").port()
    }

    #[test]
    fn unentitled_and_stale_snapshots_cannot_start_or_pair() {
        let directory = temp_directory("authorization-denied");
        let port = available_port();
        let server = RemoteServer::new(directory.clone()).expect("create remote server");
        server.set_port(port).expect("set remote port");
        assert_eq!(
            server
                .start()
                .expect_err("unentitled start must fail")
                .to_string(),
            "ENTITLEMENT_REQUIRED"
        );
        assert_eq!(
            server
                .create_pairing()
                .expect_err("unentitled pairing must fail")
                .to_string(),
            "ENTITLEMENT_REQUIRED"
        );
        assert!(TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            Duration::from_millis(100),
        )
        .is_err());

        server
            .update_authorization(snapshot(true, Utc::now() - ChronoDuration::milliseconds(1)))
            .expect("store stale authorization");
        assert_eq!(
            server
                .start()
                .expect_err("stale start must fail")
                .to_string(),
            "AUTHORIZATION_STALE"
        );
        assert_eq!(
            server
                .create_pairing()
                .expect_err("stale pairing must fail")
                .to_string(),
            "AUTHORIZATION_STALE"
        );
        assert!(!server.status().running);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn release_autostart_waits_for_authorization_instead_of_failing_daemon_startup() {
        let directory = temp_directory("locked-autostart");
        let remote_dir = directory.join("remote");
        std::fs::create_dir_all(&remote_dir).expect("create remote directory");
        let port = available_port();
        RemoteConfig {
            enabled: true,
            port,
            lan_enabled: false,
        }
        .save(&remote_dir.join("config.json"))
        .expect("persist enabled remote config");

        let server = RemoteServer::new(directory.clone()).expect("create locked remote server");
        server
            .start_if_enabled_for(false, None)
            .expect("locked release autostart is deferred");
        assert!(!server.status().running);

        *server
            .shared
            .authorization
            .write()
            .expect("remote authorization lock") =
            snapshot(true, Utc::now() + ChronoDuration::minutes(1));
        server
            .start_if_enabled_for(false, None)
            .expect("authorized release autostart starts listener");
        assert!(server.status().running);

        server.stop();
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn listener_self_stops_when_authorization_expires() {
        let directory = temp_directory("stale-listener");
        let server = RemoteServer::new(directory.clone()).expect("create remote server");
        server
            .update_authorization(snapshot(
                true,
                Utc::now() + ChronoDuration::milliseconds(150),
            ))
            .expect("authorize remote briefly");
        server.set_port(available_port()).expect("set remote port");
        server.set_enabled(true).expect("enable remote listener");

        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while server.status().running && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }

        assert!(!server.status().running);
        assert_eq!(
            server
                .start()
                .expect_err("expired lease must not restart")
                .to_string(),
            "AUTHORIZATION_STALE"
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn server_binds_configured_port_and_preserves_protocol_v1_pairing() {
        let directory = temp_directory("server");
        let port = available_port();
        let server = RemoteServer::new(directory.clone()).expect("create remote server");
        server
            .update_authorization(snapshot(true, Utc::now() + ChronoDuration::minutes(1)))
            .expect("authorize remote");
        server.set_port(port).expect("set remote port");
        server.start().expect("start remote server");
        assert!(server.status().running);
        assert!(!server.status().lan_enabled);
        assert_eq!(server.status().hosts, vec!["127.0.0.1"]);
        TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            Duration::from_secs(1),
        )
        .expect("connect remote listener");

        // Loopback-only Remote never pairs: LAN/VPN must be enabled behind the
        // firewall approval first.
        assert_eq!(
            server
                .create_pairing()
                .expect_err("loopback-only remote must refuse pairing")
                .to_string(),
            "LAN/VPN remote access must be explicitly enabled before pairing"
        );

        // The protocol-v1 QR shape is still what a LAN-enabled desktop emits.
        let payload: Value = serde_json::from_str(
            &RemoteServer::pairing_v1_qr_payload(&server.status(), "PAIRCODE")
                .expect("build v1 QR payload"),
        )
        .expect("parse QR payload");
        assert_eq!(payload["v"], 1);
        assert_eq!(payload["code"], "PAIRCODE");
        assert_eq!(payload["port"], port);

        server.stop();
        assert!(!server.status().running);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn revoking_device_closes_registered_v2_connection_within_deadline() {
        let directory =
            std::env::temp_dir().join(format!("vibelink-remote-revoke-{}", Uuid::new_v4()));
        let server = RemoteServer::new(directory.clone()).expect("create remote server");
        let (device_id, client_key) = {
            let mut devices = server.shared.devices.lock().expect("remote devices mutex");
            let pairing = devices.create_pairing_code();
            let (record, _) = devices
                .consume_pairing(&pairing.code, "Phone")
                .expect("pair device");
            (record.id, Uuid::new_v4())
        };
        let (sender, receiver) = crossbeam_channel::bounded(1);
        server
            .shared
            .client_senders
            .lock()
            .expect("remote clients mutex")
            .insert(client_key, sender);
        server
            .shared
            .client_devices
            .lock()
            .expect("remote client devices mutex")
            .insert(client_key, device_id.clone());
        server
            .shared
            .v2_clients
            .lock()
            .expect("remote v2 clients mutex")
            .insert(client_key);

        let started = std::time::Instant::now();
        server.revoke_device(&device_id).expect("revoke device");

        assert!(matches!(
            receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("close frame"),
            RemotePush::WebSocket(Message::Close(_))
        ));
        assert!(started.elapsed() < Duration::from_secs(5));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn grant_change_rotates_epoch_and_closes_active_v2_connection() {
        let directory =
            std::env::temp_dir().join(format!("vibelink-remote-grants-{}", Uuid::new_v4()));
        let server = RemoteServer::new(directory.clone()).expect("create remote server");
        let device_id = {
            let mut devices = server.shared.devices.lock().expect("remote devices mutex");
            let pairing = devices.create_pairing_code();
            devices
                .consume_v2_pairing(&pairing.code, "Phone", "noise-fingerprint")
                .expect("pair v2 device")
                .id
        };
        let client_key = Uuid::new_v4();
        let (sender, receiver) = crossbeam_channel::bounded(1);
        server
            .shared
            .client_senders
            .lock()
            .expect("remote clients mutex")
            .insert(client_key, sender);
        server
            .shared
            .client_devices
            .lock()
            .expect("remote client devices mutex")
            .insert(client_key, device_id.clone());
        server
            .shared
            .v2_clients
            .lock()
            .expect("remote v2 clients mutex")
            .insert(client_key);

        let epoch = server
            .update_device_grants(&device_id, vec!["terminal.view".to_string()])
            .unwrap();

        assert_eq!(epoch, 2);
        assert!(matches!(
            receiver.recv_timeout(Duration::from_secs(1)).unwrap(),
            RemotePush::WebSocket(Message::Close(_))
        ));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn default_appearance_is_a_canonical_projection() {
        let directory = std::env::temp_dir().join(format!(
            "vibelink-remote-default-appearance-{}",
            Uuid::new_v4()
        ));
        let server = RemoteServer::new(directory.clone()).expect("create remote server");
        let appearance = server
            .shared
            .appearance
            .read()
            .expect("remote appearance lock")
            .clone();
        let serialized = serde_json::to_value(&appearance).expect("serialize default appearance");

        assert_eq!(
            serde_json::from_value::<AppearanceProjection>(serialized).unwrap(),
            appearance
        );
        assert_eq!(appearance.theme_id, "abyss");
        assert_eq!(appearance.scrollback, 5_000);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn appearance_pushes_legacy_alerts_and_canonical_monotonic_v2_events() {
        let directory =
            std::env::temp_dir().join(format!("vibelink-remote-appearance-{}", Uuid::new_v4()));
        let server = RemoteServer::new(directory.clone()).expect("create remote server");
        let v1_key = Uuid::new_v4();
        let v2_key = Uuid::new_v4();
        let (v1_sender, v1_receiver) = crossbeam_channel::bounded(4);
        let (v2_sender, v2_receiver) = crossbeam_channel::bounded(4);
        {
            let mut senders = server
                .shared
                .client_senders
                .lock()
                .expect("remote clients mutex");
            senders.insert(v1_key, v1_sender);
            senders.insert(v2_key, v2_sender);
        }
        server
            .shared
            .v2_clients
            .lock()
            .expect("remote v2 clients mutex")
            .insert(v2_key);
        let mut appearance = server
            .shared
            .appearance
            .read()
            .expect("remote appearance lock")
            .clone();
        appearance.theme_name = "Updated Abyss".to_string();
        let alerts = HashMap::from([("workspace-a".to_string(), 2_usize)]);

        server.set_appearance(
            serde_json::to_value(&appearance).unwrap(),
            Vec::new(),
            alerts.clone(),
        );

        let RemotePush::WebSocket(Message::Text(legacy)) =
            v1_receiver.recv_timeout(Duration::from_secs(1)).unwrap()
        else {
            panic!("v1 client did not receive a plaintext appearance message");
        };
        let legacy: Value = serde_json::from_str(legacy.as_ref()).unwrap();
        assert_eq!(legacy["type"], "appearance");
        assert_eq!(legacy["payload"]["workspaceAlerts"]["workspace-a"], 2);
        assert_eq!(legacy["payload"]["themeName"], "Updated Abyss");

        let RemotePush::AppearanceChanged(first) =
            v2_receiver.recv_timeout(Duration::from_secs(1)).unwrap()
        else {
            panic!("v2 client did not receive a canonical appearance event");
        };
        assert_eq!(first.view_generation, 1);
        assert_eq!(first.appearance, appearance);
        let mut forbidden = serde_json::to_value(&first.appearance).unwrap();
        forbidden.as_object_mut().unwrap().insert(
            "workspaceAlerts".to_string(),
            serde_json::to_value(&alerts).unwrap(),
        );
        assert!(serde_json::from_value::<AppearanceProjection>(forbidden).is_err());

        server.set_appearance(
            serde_json::to_value(&appearance).unwrap(),
            Vec::new(),
            HashMap::new(),
        );
        let RemotePush::AppearanceChanged(second) =
            v2_receiver.recv_timeout(Duration::from_secs(1)).unwrap()
        else {
            panic!("v2 client did not receive the second appearance event");
        };
        assert_eq!(second.view_generation, 2);
        let RemotePush::WebSocket(Message::Text(legacy)) =
            v1_receiver.recv_timeout(Duration::from_secs(1)).unwrap()
        else {
            panic!("v1 client did not receive the second appearance message");
        };
        let legacy: Value = serde_json::from_str(legacy.as_ref()).unwrap();
        assert_eq!(legacy["payload"]["workspaceAlerts"], serde_json::json!({}));

        server.set_appearance(
            serde_json::json!({ "themeId": "invalid", "workspaceAlerts": {} }),
            Vec::new(),
            HashMap::new(),
        );
        assert_eq!(
            server.shared.appearance_generation.load(Ordering::Acquire),
            2
        );
        assert!(v1_receiver.try_recv().is_err());
        assert!(v2_receiver.try_recv().is_err());
        let _ = std::fs::remove_dir_all(directory);
    }
}
