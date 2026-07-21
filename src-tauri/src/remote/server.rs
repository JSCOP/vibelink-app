use super::v2::{secure::DeviceIdentity, wire::OperationReplayWindow};
use super::{
    bridge,
    config::RemoteConfig,
    devices::{DevicePublic, DeviceStore, PairingInfo},
    identity::RemoteIdentity,
    protocol::ServerMessage,
};
use anyhow::{anyhow, Context, Result};
use crossbeam_channel::Sender;
use local_ip_address::list_afinet_netifas;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, TcpListener},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, RwLock,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tungstenite::Message;
use uuid::Uuid;

const MAX_CLIENTS: usize = 8;

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
    pub cols: u16,
    pub rows: u16,
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

pub(crate) struct RemoteShared {
    pub devices: Mutex<DeviceStore>,
    pub appearance: RwLock<Value>,
    pub workspace_order: RwLock<Vec<String>>,
    pub workspace_alerts: RwLock<HashMap<String, usize>>,
    pub client_senders: Mutex<HashMap<Uuid, Sender<Message>>>,
    pub client_close_requests: Mutex<HashMap<Uuid, Arc<AtomicBool>>>,
    pub client_devices: Mutex<HashMap<Uuid, String>>,
    pub v2_clients: Mutex<HashSet<Uuid>>,
    pub v2_operation_ids: Mutex<HashMap<String, OperationReplayWindow>>,
    pub v2_identity: Arc<DeviceIdentity>,
    active_clients: Arc<ActiveClientCapacity>,
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
        let identity = RemoteIdentity::load_or_generate(&remote_dir)?;
        let devices = DeviceStore::load(devices_path.clone())?;
        let v2_identity = Arc::new(DeviceIdentity::load_or_create(&format!(
            "desktop-{}",
            std::env::var("VIBELINK_APP_FLAVOR").unwrap_or_else(|_| "prod".to_string()),
        ))?);
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

    pub fn start_if_enabled(&self) -> Result<()> {
        if self.config.lock().expect("remote config mutex").enabled {
            self.start()?;
        }
        Ok(())
    }

    pub fn start(&self) -> Result<()> {
        let mut runtime = self.runtime.lock().expect("remote runtime mutex");
        if runtime.is_some() {
            return Ok(());
        }
        let config = self.config.lock().expect("remote config mutex").clone();
        let port = config.port;
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
            let _ = sender.try_send(Message::Close(None));
        }
        if let Some(runtime) = runtime {
            let _ = runtime.handle.join();
        }
    }

    pub fn status(&self) -> RemoteStatus {
        let config = self.config.lock().expect("remote config mutex").clone();
        RemoteStatus {
            enabled: config.enabled,
            running: self.runtime.lock().expect("remote runtime mutex").is_some(),
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
            devices: self
                .shared
                .devices
                .lock()
                .expect("remote devices mutex")
                .list_public(),
            v2_fingerprint: self.shared.v2_identity.fingerprint(),
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

    pub fn create_pairing(&self) -> Result<PairingPayload> {
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

    pub fn create_pairing_v2(&self) -> Result<PairingPayload> {
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
        let client_keys = self
            .shared
            .client_devices
            .lock()
            .expect("remote client devices mutex")
            .iter()
            .filter_map(|(client_key, active_device_id)| {
                (active_device_id == device_id).then_some(*client_key)
            })
            .collect::<Vec<_>>();
        {
            let close_requests = self
                .shared
                .client_close_requests
                .lock()
                .expect("remote client close requests mutex");
            for client_key in &client_keys {
                if let Some(close_requested) = close_requests.get(client_key) {
                    close_requested.store(true, Ordering::Release);
                }
            }
        }
        let senders = {
            let senders = self
                .shared
                .client_senders
                .lock()
                .expect("remote clients mutex");
            client_keys
                .iter()
                .filter_map(|client_key| senders.get(client_key).cloned())
                .collect::<Vec<_>>()
        };
        for sender in senders {
            let _ = sender.try_send(Message::Close(None));
        }
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
        let v2_clients = self
            .shared
            .v2_clients
            .lock()
            .expect("remote v2 clients mutex")
            .clone();
        let senders: Vec<_> = self
            .shared
            .client_senders
            .lock()
            .expect("remote clients mutex")
            .iter()
            .filter_map(|(client_key, sender)| {
                (!v2_clients.contains(client_key)).then_some(sender.clone())
            })
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
    use std::{
        net::TcpStream,
        sync::{mpsc, Barrier},
    };

    #[test]
    fn active_client_capacity_is_atomic_under_contention() {
        let capacity = Arc::new(ActiveClientCapacity::new(MAX_CLIENTS));
        let contender_count = MAX_CLIENTS * 4;
        let start = Arc::new(Barrier::new(contender_count + 1));
        let release = Arc::new(Barrier::new(contender_count + 1));
        let (sender, receiver) = mpsc::channel();
        let mut threads = Vec::with_capacity(contender_count);

        for _ in 0..contender_count {
            let capacity = Arc::clone(&capacity);
            let start = Arc::clone(&start);
            let release = Arc::clone(&release);
            let sender = sender.clone();
            threads.push(thread::spawn(move || {
                start.wait();
                let permit = capacity.try_reserve();
                sender.send(permit.is_some()).expect("report reservation");
                release.wait();
                drop(permit);
            }));
        }
        drop(sender);

        start.wait();
        let reservation_count = (0..contender_count)
            .filter(|_| receiver.recv().expect("reservation result"))
            .count();
        let next_reservation_failed = capacity.try_reserve().is_none();

        release.wait();
        for thread in threads {
            thread.join().expect("reservation thread");
        }

        assert_eq!(reservation_count, MAX_CLIENTS);
        assert!(next_reservation_failed);
    }

    #[test]
    fn dropping_active_client_permit_restores_capacity() {
        let capacity = Arc::new(ActiveClientCapacity::new(1));
        let permit = capacity.try_reserve().expect("reserve client slot");

        assert!(capacity.try_reserve().is_none());
        drop(permit);
        assert!(capacity.try_reserve().is_some());
    }

    #[test]
    fn stop_signals_close_request_when_push_queue_is_full() {
        let directory =
            std::env::temp_dir().join(format!("vibelink-remote-stop-{}", Uuid::new_v4()));
        let server = RemoteServer::new(directory.clone()).expect("create remote server");
        let client_key = Uuid::new_v4();
        let close_requested = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = crossbeam_channel::bounded(1);
        sender
            .try_send(Message::Ping(Vec::new().into()))
            .expect("fill client push queue");
        server
            .shared
            .client_senders
            .lock()
            .expect("remote clients mutex")
            .insert(client_key, sender);
        server
            .shared
            .client_close_requests
            .lock()
            .expect("remote client close requests mutex")
            .insert(client_key, Arc::clone(&close_requested));

        server.stop();

        assert!(close_requested.load(Ordering::Acquire));
        assert!(matches!(receiver.try_recv().unwrap(), Message::Ping(_)));
        assert!(receiver.try_recv().is_err());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn device_close_signals_request_when_push_queue_is_full() {
        let directory =
            std::env::temp_dir().join(format!("vibelink-remote-close-{}", Uuid::new_v4()));
        let server = RemoteServer::new(directory.clone()).expect("create remote server");
        let client_key = Uuid::new_v4();
        let close_requested = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = crossbeam_channel::bounded(1);
        sender
            .try_send(Message::Ping(Vec::new().into()))
            .expect("fill client push queue");
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
            .insert(client_key, "device-a".to_string());
        server
            .shared
            .client_close_requests
            .lock()
            .expect("remote client close requests mutex")
            .insert(client_key, Arc::clone(&close_requested));

        server.close_device_connections("device-a");

        assert!(close_requested.load(Ordering::Acquire));
        assert!(matches!(receiver.try_recv().unwrap(), Message::Ping(_)));
        assert!(receiver.try_recv().is_err());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn server_binds_configured_port_and_reports_running() {
        let directory =
            std::env::temp_dir().join(format!("vibelink-remote-server-{}", Uuid::new_v4()));
        let probe = TcpListener::bind(("127.0.0.1", 0)).expect("reserve test port");
        let port = probe.local_addr().expect("probe address").port();
        drop(probe);
        let server = RemoteServer::new(directory.clone()).expect("create remote server");
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
            Message::Close(_)
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
            Message::Close(_)
        ));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn plaintext_v1_pushes_are_never_sent_to_v2_connections() {
        let directory =
            std::env::temp_dir().join(format!("vibelink-remote-encryption-{}", Uuid::new_v4()));
        let server = RemoteServer::new(directory.clone()).expect("create remote server");
        let v1_key = Uuid::new_v4();
        let v2_key = Uuid::new_v4();
        let (v1_sender, v1_receiver) = crossbeam_channel::bounded(1);
        let (v2_sender, v2_receiver) = crossbeam_channel::bounded(1);
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

        server.set_appearance(
            serde_json::json!({"theme": "dark"}),
            Vec::new(),
            HashMap::new(),
        );

        assert!(matches!(
            v1_receiver.recv_timeout(Duration::from_secs(1)).unwrap(),
            Message::Text(_)
        ));
        assert!(v2_receiver.try_recv().is_err());
        let _ = std::fs::remove_dir_all(directory);
    }
}
