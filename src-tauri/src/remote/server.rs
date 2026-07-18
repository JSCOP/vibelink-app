use super::{bridge, config::RemoteConfig, devices::{DevicePublic, DeviceStore, PairingInfo}, identity::RemoteIdentity, protocol::ServerMessage};
use anyhow::{anyhow, Context, Result};
use crossbeam_channel::Sender;
use local_ip_address::list_afinet_netifas;
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashMap, net::{IpAddr, TcpListener}, path::PathBuf, sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Arc, Mutex, RwLock}, thread::{self, JoinHandle}, time::Duration};
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

struct Runtime {
    shutdown: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}


pub(crate) struct RemoteShared {
    pub devices: Mutex<DeviceStore>,
    pub appearance: RwLock<Value>,
    pub workspace_order: RwLock<Vec<String>>,
    pub workspace_alerts: RwLock<HashMap<String, usize>>,
    pub client_senders: Mutex<HashMap<Uuid, Sender<Message>>>,
    pub active_clients: AtomicUsize,
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
                active_clients: AtomicUsize::new(0),
            }),
        })
    }

    pub fn start_if_enabled(&self) -> Result<()> {
        if self.config.lock().expect("remote config mutex").enabled { self.start()?; }
        Ok(())
    }

    pub fn start(&self) -> Result<()> {
        let mut runtime = self.runtime.lock().expect("remote runtime mutex");
        if runtime.is_some() { return Ok(()); }
        let port = self.config.lock().expect("remote config mutex").port;
        let listener = TcpListener::bind(("0.0.0.0", port)).with_context(|| format!("bind remote access port {port}"))?;
        listener.set_nonblocking(true)?;
        let tls_config = self.identity.read().expect("remote identity lock").server_config()?;
        let shutdown = Arc::new(AtomicBool::new(false));
        let thread_shutdown = Arc::clone(&shutdown);
        let shared = Arc::clone(&self.shared);
        let handle = thread::Builder::new().name("vibelink-remote-accept".to_string()).spawn(move || {
            while !thread_shutdown.load(Ordering::Acquire) {
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
            let senders: Vec<_> = self.shared.client_senders.lock().expect("remote clients mutex").values().cloned().collect();
            for sender in senders { let _ = sender.try_send(Message::Close(None)); }
            let _ = runtime.handle.join();
        }
    }

    pub fn status(&self) -> RemoteStatus {
        let config = self.config.lock().expect("remote config mutex").clone();
        RemoteStatus {
            enabled: config.enabled,
            running: self.runtime.lock().expect("remote runtime mutex").is_some(),
            port: config.port,
            fingerprint: self.identity.read().expect("remote identity lock").fingerprint(),
            hosts: local_hosts(),
            devices: self.shared.devices.lock().expect("remote devices mutex").list_public(),
        }
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<RemoteStatus> {
        if enabled { self.start()?; } else { self.stop(); }
        let mut config = self.config.lock().expect("remote config mutex");
        config.enabled = enabled;
        config.save(&self.config_path)?;
        drop(config);
        Ok(self.status())
    }

    pub fn set_port(&self, port: u16) -> Result<RemoteStatus> {
        if port < 1024 { return Err(anyhow!("remote port must be between 1024 and 65535")); }
        let was_running = self.runtime.lock().expect("remote runtime mutex").is_some();
        if was_running { self.stop(); }
        {
            let mut config = self.config.lock().expect("remote config mutex");
            config.port = port;
            config.save(&self.config_path)?;
        }
        if was_running { self.start()?; }
        Ok(self.status())
    }

    pub fn create_pairing(&self) -> Result<PairingPayload> {
        let PairingInfo { code, expires_at } = self.shared.devices.lock().expect("remote devices mutex").create_pairing_code();
        let status = self.status();
        let desktop_name = desktop_name();
        let qr_payload = serde_json::to_string(&serde_json::json!({
            "v": 1, "name": desktop_name, "hosts": status.hosts, "port": status.port,
            "fp": status.fingerprint, "code": code,
        }))?;
        Ok(PairingPayload { code, expires_at, qr_payload })
    }

    pub fn revoke_device(&self, device_id: &str) -> Result<()> {
        self.shared.devices.lock().expect("remote devices mutex").revoke(device_id)
    }

    pub fn regenerate_identity(&self) -> Result<RemoteStatus> {
        let was_running = self.runtime.lock().expect("remote runtime mutex").is_some();
        if was_running { self.stop(); }
        self.identity.write().expect("remote identity lock").regenerate()?;
        self.shared.devices.lock().expect("remote devices mutex").revoke_all()?;
        if was_running { self.start()?; }
        Ok(self.status())
    }

    pub fn set_appearance(&self, appearance: Value, workspace_order: Vec<String>, workspace_alerts: HashMap<String, usize>) {
        *self.shared.appearance.write().expect("remote appearance lock") = appearance.clone();
        *self.shared.workspace_order.write().expect("remote workspace order lock") = workspace_order;
        *self.shared.workspace_alerts.write().expect("remote workspace alerts lock") = workspace_alerts;
        let message = serde_json::to_string(&ServerMessage::Appearance { payload: appearance }).expect("serialize appearance");
        let senders: Vec<_> = self.shared.client_senders.lock().expect("remote clients mutex").values().cloned().collect();
        for sender in senders { let _ = sender.try_send(Message::Text(message.clone().into())); }
    }
}

impl Drop for RemoteServer { fn drop(&mut self) { self.stop(); } }

pub(crate) fn desktop_name() -> String {
    sysinfo::System::host_name().filter(|name| !name.trim().is_empty()).unwrap_or_else(|| "VibeLink Desktop".to_string())
}

pub(crate) fn local_hosts() -> Vec<String> {
    let mut hosts: Vec<_> = list_afinet_netifas().unwrap_or_default().into_iter().filter_map(|(_, ip)| match ip {
        IpAddr::V4(value) if !value.is_loopback() && !value.is_link_local() => Some(value.to_string()),
        _ => None,
    }).collect();
    hosts.sort();
    hosts.dedup();
    hosts
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpStream;

    #[test]
    fn server_binds_configured_port_and_reports_running() {
        let directory = std::env::temp_dir().join(format!("vibelink-remote-server-{}", Uuid::new_v4()));
        let probe = TcpListener::bind(("127.0.0.1", 0)).expect("reserve test port");
        let port = probe.local_addr().expect("probe address").port();
        drop(probe);
        let server = RemoteServer::new(directory.clone()).expect("create remote server");
        server.set_port(port).expect("set remote port");
        server.start().expect("start remote server");
        assert!(server.status().running);
        TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().unwrap(), Duration::from_secs(1)).expect("connect remote listener");
        server.stop();
        assert!(!server.status().running);
        let _ = std::fs::remove_dir_all(directory);
    }
}
