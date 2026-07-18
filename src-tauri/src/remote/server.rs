use super::{
    bridge,
    config::RemoteConfig,
    devices::{DevicePublic, DeviceStore, PairingInfo},
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
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    net::{IpAddr, Shutdown, TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, RwLock, RwLockReadGuard,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tungstenite::Message;
use uuid::Uuid;

const MAX_CLIENTS: usize = 8;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub fingerprint: String,
    pub hosts: Vec<String>,
    pub devices: Vec<DevicePublic>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingPayload {
    pub code: String,
    pub expires_at: i64,
    pub qr_payload: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaneLeaseStatus {
    pub session_id: String,
    pub pane_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
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

#[derive(Clone, Debug)]
pub(crate) struct PaneLease {
    pub session_id: Uuid,
    pub owner: Uuid,
    pub original_cols: u16,
    pub original_rows: u16,
    pub target_cols: u16,
    pub target_rows: u16,
}

impl PaneLease {
    pub fn status(&self, pane_id: Uuid) -> RemotePaneLeaseStatus {
        RemotePaneLeaseStatus {
            session_id: self.session_id.to_string(),
            pane_id: pane_id.to_string(),
            cols: self.target_cols,
            rows: self.target_rows,
        }
    }
}

struct Runtime {
    shutdown: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

pub(crate) struct ActiveRemoteClient {
    pub device_id: String,
    pub sender: Sender<Message>,
    pub cancelled: Arc<AtomicBool>,
    pub socket: Option<TcpStream>,
}

pub(crate) struct RemoteShared {
    pub devices: Mutex<DeviceStore>,
    pub appearance: RwLock<Value>,
    pub workspace_order: RwLock<Vec<String>>,
    pub workspace_alerts: RwLock<HashMap<String, usize>>,
    pub authorization: RwLock<AuthorizationSnapshot>,
    pub client_senders: Mutex<HashMap<Uuid, ActiveRemoteClient>>,
    pub pane_leases: Mutex<HashMap<Uuid, PaneLease>>,
    pane_lease_notifier: Arc<dyn Fn(RemotePaneLeaseEvent) + Send + Sync>,
    pub active_clients: AtomicUsize,
}

impl RemoteShared {
    pub fn notify_pane_lease(&self, event: RemotePaneLeaseEvent) {
        (self.pane_lease_notifier)(event);
    }

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
        let clients = self.client_senders.lock().expect("remote clients mutex");
        let mut disconnected = Vec::new();
        for (client_key, client) in clients.iter() {
            if device_id.is_some_and(|expected| client.device_id != expected) {
                continue;
            }
            client.cancelled.store(true, Ordering::Release);
            let _ = client.sender.try_send(Message::Close(None));
            if let Some(socket) = &client.socket {
                let _ = socket.shutdown(Shutdown::Both);
            }
            disconnected.push(*client_key);
        }
        disconnected
    }

    fn release_abandoned_leases(&self) {
        self.release_client_leases(None);
    }

    fn release_leases_for_clients(&self, owners: &[Uuid]) {
        self.release_client_leases(Some(owners));
    }

    fn release_client_leases(&self, owners: Option<&[Uuid]>) {
        let released = {
            let mut leases = self.pane_leases.lock().expect("remote pane leases mutex");
            let mut released = Vec::new();
            leases.retain(|pane_id, lease| {
                if owners.is_none_or(|owners| owners.contains(&lease.owner)) {
                    released.push(RemotePaneLeaseEvent {
                        session_id: lease.session_id.to_string(),
                        pane_id: pane_id.to_string(),
                        leased: false,
                        cols: None,
                        rows: None,
                    });
                    false
                } else {
                    true
                }
            });
            released
        };
        for event in released {
            self.notify_pane_lease(event);
        }
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
        Self::new_with_pane_lease_notifier(data_dir, |_| {})
    }

    pub fn new_with_pane_lease_notifier<F>(data_dir: PathBuf, notifier: F) -> Result<Self>
    where
        F: Fn(RemotePaneLeaseEvent) + Send + Sync + 'static,
    {
        let remote_dir = data_dir.join("remote");
        std::fs::create_dir_all(&remote_dir)?;
        let config_path = remote_dir.join("config.json");
        let devices_path = remote_dir.join("devices.json");
        let config = RemoteConfig::load(&config_path)?;
        let identity = RemoteIdentity::load_or_generate(&remote_dir)?;
        let devices = DeviceStore::load(devices_path.clone())?;
        let authorization = locked_authorization_snapshot();
        Ok(Self {
            config_path,
            config: Mutex::new(config),
            identity: RwLock::new(identity),
            runtime: Mutex::new(None),
            shared: Arc::new(RemoteShared {
                devices: Mutex::new(devices),
                appearance: RwLock::new(Value::Object(Default::default())),
                workspace_order: RwLock::new(Vec::new()),
                workspace_alerts: RwLock::new(HashMap::new()),
                authorization: RwLock::new(authorization),
                client_senders: Mutex::new(HashMap::new()),
                pane_leases: Mutex::new(HashMap::new()),
                pane_lease_notifier: Arc::new(notifier),
                active_clients: AtomicUsize::new(0),
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
            self.shared.release_abandoned_leases();
            self.stop();
            Ok(())
        }
    }

    pub fn start_if_enabled(&self) -> Result<()> {
        if self.config.lock().expect("remote config mutex").enabled {
            self.start()?;
        }
        Ok(())
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
        let port = self.config.lock().expect("remote config mutex").port;
        let listener = TcpListener::bind(("0.0.0.0", port))
            .with_context(|| format!("bind remote access port {port}"))?;
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
                    shared.release_abandoned_leases();
                    thread_shutdown.store(true, Ordering::Release);
                    break;
                }
                match listener.accept() {
                    Ok((stream, address)) => {
                        if shared.active_clients.load(Ordering::Acquire) >= MAX_CLIENTS {
                            tracing::warn!(%address, "rejecting remote client: capacity reached");
                            continue;
                        }
                        let connection_shared = Arc::clone(&shared);
                        let connection_tls = Arc::clone(&tls_config);
                        let _ = thread::Builder::new().name("vibelink-remote-client".to_string()).spawn(move || {
                            connection_shared.active_clients.fetch_add(1, Ordering::AcqRel);
                            if let Err(error) = bridge::handle_connection(stream, connection_tls, Arc::clone(&connection_shared)) {
                                tracing::warn!(?error, %address, "remote client disconnected");
                            }
                            connection_shared.active_clients.fetch_sub(1, Ordering::AcqRel);
                        });
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
        if let Some(runtime) = runtime {
            runtime.shutdown.store(true, Ordering::Release);
            let _ = self.shared.disconnect_clients(None);
            let _ = runtime.handle.join();
        } else {
            let _ = self.shared.disconnect_clients(None);
        }
        self.wait_for_authenticated_clients();
        self.shared.release_abandoned_leases();
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
        RemoteStatus {
            enabled: config.enabled,
            running: self
                .runtime
                .lock()
                .expect("remote runtime mutex")
                .as_ref()
                .is_some_and(|runtime| !runtime.handle.is_finished()),
            port: config.port,
            fingerprint: self
                .identity
                .read()
                .expect("remote identity lock")
                .fingerprint(),
            hosts: local_hosts(),
            devices: self
                .shared
                .devices
                .lock()
                .expect("remote devices mutex")
                .list_public(),
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

    pub fn create_pairing(&self) -> Result<PairingPayload> {
        let _authorization = self
            .shared
            .authorization_guard(Capability::RemoteConnect)
            .map_err(authorization_error)?;
        let PairingInfo { code, expires_at } = self
            .shared
            .devices
            .lock()
            .expect("remote devices mutex")
            .create_pairing_code();
        let status = self.status();
        let desktop_name = desktop_name();
        let qr_payload = serde_json::to_string(&serde_json::json!({
            "v": 1, "name": desktop_name, "hosts": status.hosts, "port": status.port,
            "fp": status.fingerprint, "code": code,
        }))?;
        Ok(PairingPayload {
            code,
            expires_at,
            qr_payload,
        })
    }

    pub fn revoke_device(&self, device_id: &str) -> Result<()> {
        let mut devices = self.shared.devices.lock().expect("remote devices mutex");
        devices.revoke(device_id)?;
        let clients = self.shared.disconnect_clients(Some(device_id));
        drop(devices);
        self.wait_for_clients(&clients);
        self.shared.release_leases_for_clients(&clients);
        Ok(())
    }

    pub fn regenerate_identity(&self) -> Result<RemoteStatus> {
        let was_running = self.runtime.lock().expect("remote runtime mutex").is_some();
        if was_running {
            self.stop();
        }
        self.identity
            .write()
            .expect("remote identity lock")
            .regenerate()?;
        self.shared
            .devices
            .lock()
            .expect("remote devices mutex")
            .revoke_all()?;
        if was_running {
            self.start()?;
        }
        Ok(self.status())
    }

    pub fn pane_lease(&self, pane_id: &str) -> Result<Option<RemotePaneLeaseStatus>> {
        let pane_id = Uuid::parse_str(pane_id).context("parse pane lease id")?;
        Ok(self
            .shared
            .pane_leases
            .lock()
            .expect("remote pane leases mutex")
            .get(&pane_id)
            .map(|lease| lease.status(pane_id)))
    }

    pub fn set_appearance(
        &self,
        appearance: Value,
        workspace_order: Vec<String>,
        workspace_alerts: HashMap<String, usize>,
    ) {
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
        let message = serde_json::to_string(&ServerMessage::Appearance {
            payload: appearance,
        })
        .expect("serialize appearance");
        let senders: Vec<_> = self
            .shared
            .client_senders
            .lock()
            .expect("remote clients mutex")
            .values()
            .map(|client| client.sender.clone())
            .collect();
        for sender in senders {
            let _ = sender.try_send(Message::Text(message.clone().into()));
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
    use crossbeam_channel::bounded;
    use std::{io::Read, net::TcpStream, sync::atomic::AtomicBool};

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
    fn listener_self_stops_and_releases_leases_when_authorization_expires() {
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
        let pane_id = Uuid::new_v4();
        server
            .shared
            .pane_leases
            .lock()
            .expect("remote leases")
            .insert(
                pane_id,
                PaneLease {
                    session_id: Uuid::new_v4(),
                    owner: Uuid::new_v4(),
                    original_cols: 100,
                    original_rows: 40,
                    target_cols: 48,
                    target_rows: 32,
                },
            );

        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while server.status().running && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }

        assert!(!server.status().running);
        assert!(server
            .shared
            .pane_leases
            .lock()
            .expect("remote leases")
            .is_empty());
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
        TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            Duration::from_secs(1),
        )
        .expect("connect remote listener");
        let pairing = server.create_pairing().expect("create pairing");
        let payload: Value = serde_json::from_str(&pairing.qr_payload).expect("parse QR payload");
        assert_eq!(payload["v"], 1);
        assert_eq!(payload["code"], pairing.code);
        server.stop();
        assert!(!server.status().running);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn authorization_revocation_stops_listener_disconnects_clients_and_releases_leases() {
        let directory = temp_directory("revocation");
        let events = Arc::new(Mutex::new(Vec::new()));
        let event_sink = Arc::clone(&events);
        let server = RemoteServer::new_with_pane_lease_notifier(directory.clone(), move |event| {
            event_sink.lock().expect("lease events").push(event);
        })
        .expect("create remote server");
        server
            .update_authorization(snapshot(true, Utc::now() + ChronoDuration::minutes(1)))
            .expect("authorize remote");
        server.set_port(available_port()).expect("set remote port");
        server.set_enabled(true).expect("enable remote listener");

        let client_key = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let cancelled = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = bounded(1);
        server
            .shared
            .client_senders
            .lock()
            .expect("remote clients")
            .insert(
                client_key,
                ActiveRemoteClient {
                    device_id: "device-1".to_string(),
                    sender,
                    cancelled: Arc::clone(&cancelled),
                    socket: None,
                },
            );
        server
            .shared
            .pane_leases
            .lock()
            .expect("remote leases")
            .insert(
                pane_id,
                PaneLease {
                    session_id,
                    owner: client_key,
                    original_cols: 100,
                    original_rows: 40,
                    target_cols: 48,
                    target_rows: 32,
                },
            );
        let cleanup_shared = Arc::clone(&server.shared);
        let cleanup_cancelled = Arc::clone(&cancelled);
        let cleanup = thread::spawn(move || {
            while !cleanup_cancelled.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(1));
            }
            cleanup_shared
                .client_senders
                .lock()
                .expect("remote clients")
                .remove(&client_key);
        });

        server
            .update_authorization(snapshot(false, Utc::now()))
            .expect("revoke remote authorization");
        cleanup.join().expect("client cleanup");

        assert!(cancelled.load(Ordering::Acquire));
        assert!(matches!(receiver.try_recv(), Ok(Message::Close(_))));
        assert!(!server.status().running);
        assert!(server.status().enabled);
        assert!(server
            .shared
            .pane_leases
            .lock()
            .expect("remote leases")
            .is_empty());
        assert_eq!(
            events.lock().expect("lease events").as_slice(),
            &[RemotePaneLeaseEvent {
                session_id: session_id.to_string(),
                pane_id: pane_id.to_string(),
                leased: false,
                cols: None,
                rows: None,
            }]
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn device_revocation_cancels_only_matching_client_and_releases_its_lease() {
        let directory = temp_directory("device-revocation");
        let server = RemoteServer::new(directory.clone()).expect("create remote server");
        server
            .update_authorization(snapshot(true, Utc::now() + ChronoDuration::minutes(1)))
            .expect("authorize remote");

        let target_key = Uuid::new_v4();
        let other_key = Uuid::new_v4();
        let target_pane = Uuid::new_v4();
        let other_pane = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let target_cancelled = Arc::new(AtomicBool::new(false));
        let other_cancelled = Arc::new(AtomicBool::new(false));
        let (target_sender, target_receiver) = bounded(1);
        let (other_sender, other_receiver) = bounded(1);
        let socket_listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind socket pair");
        let mut target_peer =
            TcpStream::connect(socket_listener.local_addr().expect("socket pair address"))
                .expect("connect socket pair");
        let (target_socket, _) = socket_listener.accept().expect("accept socket pair");
        {
            let mut clients = server.shared.client_senders.lock().expect("remote clients");
            clients.insert(
                target_key,
                ActiveRemoteClient {
                    device_id: "target-device".to_string(),
                    sender: target_sender,
                    cancelled: Arc::clone(&target_cancelled),
                    socket: Some(target_socket),
                },
            );
            clients.insert(
                other_key,
                ActiveRemoteClient {
                    device_id: "other-device".to_string(),
                    sender: other_sender,
                    cancelled: Arc::clone(&other_cancelled),
                    socket: None,
                },
            );
        }
        {
            let mut leases = server.shared.pane_leases.lock().expect("remote leases");
            for (pane_id, owner) in [(target_pane, target_key), (other_pane, other_key)] {
                leases.insert(
                    pane_id,
                    PaneLease {
                        session_id,
                        owner,
                        original_cols: 100,
                        original_rows: 40,
                        target_cols: 48,
                        target_rows: 32,
                    },
                );
            }
        }
        let cleanup_shared = Arc::clone(&server.shared);
        let cleanup_cancelled = Arc::clone(&target_cancelled);
        let cleanup = thread::spawn(move || {
            while !cleanup_cancelled.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(1));
            }
            cleanup_shared
                .client_senders
                .lock()
                .expect("remote clients")
                .remove(&target_key);
        });

        server
            .revoke_device("target-device")
            .expect("revoke target device");
        cleanup.join().expect("target cleanup");

        target_peer
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set revoked socket timeout");
        let mut byte = [0_u8; 1];
        let result = target_peer.read(&mut byte);
        assert!(
            matches!(result, Ok(0))
                || result.as_ref().err().is_some_and(|error| {
                    matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionReset
                            | std::io::ErrorKind::ConnectionAborted
                            | std::io::ErrorKind::BrokenPipe
                            | std::io::ErrorKind::NotConnected
                    )
                }),
            "revoked socket remained readable: {result:?}"
        );
        assert!(target_cancelled.load(Ordering::Acquire));
        assert!(!other_cancelled.load(Ordering::Acquire));
        assert!(matches!(target_receiver.try_recv(), Ok(Message::Close(_))));
        assert!(other_receiver.is_empty());
        let leases = server.shared.pane_leases.lock().expect("remote leases");
        assert!(!leases.contains_key(&target_pane));
        assert!(leases.contains_key(&other_pane));
        drop(leases);
        server
            .shared
            .client_senders
            .lock()
            .expect("remote clients")
            .remove(&other_key);
        server.shared.release_abandoned_leases();
        let _ = std::fs::remove_dir_all(directory);
    }
}
