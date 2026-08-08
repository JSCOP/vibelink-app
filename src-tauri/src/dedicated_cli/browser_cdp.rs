use super::browser_page::{
    call_on, clear_element, compress_ax_tree, current_page_url, element_action, element_center,
    element_id, element_target, resolve_element, wait_for_condition, write_snapshot_state,
    BrowserJpegCaptureOptions, BrowserJpegFrame, BrowserKeyInput, BrowserPageScale,
    BrowserPointerInput, BrowserViewport, MAX_TEXT_INPUT_BYTES, PREPARE_TEXT_INPUT,
    SELECT_ALL_TEXT, SET_CHECKED, SET_NATIVE_VALUE, SET_SELECT_VALUE,
};
use crate::{
    browser::{BrowserDeviceMetrics, BrowserPolicy, BrowserRiskCapability},
    dedicated_cli::{browser_extension, chrome_profile, ActionCommand, BrowserAction},
    runtime_ports,
};
use anyhow::{bail, Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    net::TcpStream,
    path::{Path, PathBuf},
    sync::Arc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tungstenite::{connect, stream::MaybeTlsStream, Message, WebSocket};

const MAX_REGISTRY_BYTES: u64 = 1024 * 1024;
const MAX_TARGET_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_CDP_MESSAGE_BYTES: usize = 80 * 1024 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EVENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_EVENTS: usize = 1024;
pub(super) const MAX_INSPECT_SNAPSHOT_BYTES: usize = 256 * 1024;

pub const MAX_BROWSER_JPEG_BYTES: usize = 60 * 1024;

const MIN_CAPTURE_SCALE: f64 = 0.05;
const MIN_ADAPTIVE_JPEG_QUALITY: u8 = 35;
const MAX_JPEG_CAPTURE_ATTEMPTS: usize = 10;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTab {
    pub id: String,
    pub title: String,
    pub url: String,
    pub workspace_id: String,
}

struct CdpAccessPolicy {
    browser: BrowserPolicy,
    grants: HashSet<BrowserRiskCapability>,
}

impl CdpAccessPolicy {
    fn from_command(command: &ActionCommand<BrowserAction>, artifact_root: &Path) -> Result<Self> {
        let grants = parse_grants(command.arguments.options.get("grant"))?;
        let workspace_roots = command
            .arguments
            .options
            .get("workspace-root")
            .into_iter()
            .flatten()
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        fs::create_dir_all(artifact_root)?;
        let browser = BrowserPolicy::new(
            grants.contains(&BrowserRiskCapability::LocalFiles),
            workspace_roots,
            artifact_root.join("downloads"),
            artifact_root.to_path_buf(),
            MAX_ARTIFACT_BYTES,
        )
        .map_err(anyhow::Error::new)?;
        Ok(Self { browser, grants })
    }

    fn require(&self, capability: BrowserRiskCapability) -> Result<()> {
        self.browser
            .require_capability(&self.grants, capability)
            .map_err(anyhow::Error::new)
    }

    fn upload_files(&self, values: &[String]) -> Result<Vec<PathBuf>> {
        self.require(BrowserRiskCapability::Upload)?;
        if values.is_empty() || values.len() > 32 {
            bail!("--file requires between 1 and 32 workspace files");
        }
        values
            .iter()
            .map(|value| {
                self.browser
                    .workspace_file(
                        Path::new(value),
                        &self.grants,
                        BrowserRiskCapability::Upload,
                    )
                    .map_err(anyhow::Error::new)
            })
            .collect()
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DebugTarget {
    pub(super) id: String,
    pub(super) title: String,
    pub(super) url: String,
    #[serde(rename = "type")]
    pub(super) target_type: String,
    pub(super) web_socket_debugger_url: Option<String>,
    #[serde(skip)]
    pub(super) cdp_port: u16,
    #[serde(skip)]
    pub(super) page_id: Option<String>,
    #[serde(skip)]
    pub(super) profile_id: Option<String>,
    #[serde(skip)]
    pub(super) workspace_id: Option<String>,
    #[serde(skip)]
    pub(super) external: bool,
    /// Set only for a tab reached through the Chrome extension backend, where
    /// there is no debugging port and no websocket URL.
    #[serde(skip)]
    pub(super) extension_tab_id: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserCdpRegistry {
    version: u8,
    main_port: u16,
    profiles: Vec<BrowserCdpProfile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserCdpProfile {
    profile_id: String,
    port: u16,
    pages: Vec<BrowserCdpPage>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserCdpPage {
    page_id: String,
    workspace_id: String,
}

/// Two transports, one command surface. A VibeLink-owned WebView2 page is a
/// loopback CDP websocket; a tab in the user's running Chrome is reached
/// through the extension bridge. Every element action funnels through `call`,
/// so nothing above this type knows which backend it is talking to.
pub(super) enum CdpConnection {
    Socket {
        socket: Box<WebSocket<MaybeTlsStream<TcpStream>>>,
        next_id: u64,
    },
    Extension {
        bridge: Arc<browser_extension::ExtensionBridge>,
        tab_id: i64,
    },
}

impl CdpConnection {
    fn open(target: &DebugTarget) -> Result<Self> {
        let raw = target
            .web_socket_debugger_url
            .as_deref()
            .context("browser target has no CDP websocket")?;
        let parsed = url::Url::parse(raw).context("parse browser CDP websocket URL")?;
        if parsed.scheme() != "ws"
            || !parsed.host_str().is_some_and(is_loopback_host)
            || parsed.port_or_known_default() != Some(target.cdp_port)
            || parsed.username() != ""
            || parsed.password().is_some()
        {
            bail!("browser target exposed an unsafe CDP websocket URL");
        }
        let (socket, _) = connect(raw).context("connect to embedded browser CDP")?;
        match socket.get_ref() {
            MaybeTlsStream::Plain(stream) => {
                stream.set_read_timeout(Some(Duration::from_secs(30)))?
            }
            _ => bail!("browser target exposed a non-plain CDP websocket transport"),
        }
        Ok(Self::Socket {
            socket: Box::new(socket),
            next_id: 1,
        })
    }

    pub(super) fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let (socket, next_id) = match self {
            Self::Extension { bridge, tab_id } => return bridge.send(*tab_id, method, params),
            Self::Socket { socket, next_id } => (socket, next_id),
        };
        let id = *next_id;
        *next_id += 1;
        socket.send(Message::Text(
            serde_json::to_string(&json!({ "id": id, "method": method, "params": params }))?.into(),
        ))?;
        loop {
            let message = socket.read()?;
            let Message::Text(text) = message else {
                continue;
            };
            if text.len() > MAX_CDP_MESSAGE_BYTES {
                bail!("CDP response exceeds the bounded message size");
            }
            let value: Value = serde_json::from_str(text.as_str())?;
            if value.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = value.get("error") {
                bail!("CDP {method} failed: {error}");
            }
            return Ok(value.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    pub(super) fn evaluate(&mut self, expression: &str) -> Result<Value> {
        let result = self.call(
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "awaitPromise": true,
                "returnByValue": true,
                "userGesture": true
            }),
        )?;
        if let Some(exception) = result.get("exceptionDetails") {
            bail!("browser script failed: {exception}");
        }
        Ok(result
            .pointer("/result/value")
            .cloned()
            .unwrap_or(Value::Null))
    }

    fn collect_events(&mut self, duration: Duration) -> Result<Vec<Value>> {
        let socket = match self {
            // The bridge buffers events as the extension forwards them, so the
            // collection window is a plain wait rather than a socket read loop.
            Self::Extension { bridge, tab_id } => {
                thread::sleep(duration);
                return Ok(bridge.drain_events(*tab_id, MAX_EVENTS));
            }
            Self::Socket { socket, .. } => socket,
        };
        if let MaybeTlsStream::Plain(stream) = socket.get_mut() {
            stream.set_read_timeout(Some(Duration::from_millis(100)))?;
        }
        let deadline = Instant::now() + duration;
        let mut events = Vec::new();
        let mut event_bytes = 0usize;
        while Instant::now() < deadline && events.len() < MAX_EVENTS {
            match socket.read() {
                Ok(Message::Text(text)) => {
                    if text.len() > MAX_EVENT_BYTES
                        || event_bytes.saturating_add(text.len()) > MAX_EVENT_BYTES
                    {
                        continue;
                    }
                    let value: Value = serde_json::from_str(text.as_str())?;
                    if value.get("method").is_some() {
                        event_bytes = event_bytes.saturating_add(text.len());
                        events.push(value);
                    }
                }
                Ok(_) => {}
                Err(tungstenite::Error::Io(error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(events)
    }
}

pub fn execute(command: ActionCommand<BrowserAction>, artifact_root: &Path) -> Result<Value> {
    let access = CdpAccessPolicy::from_command(&command, artifact_root)?;
    if let Some(capability) = required_capability(command.action) {
        access.require(capability)?;
    }
    let scoped_workspace = command
        .selectors
        .workspace
        .clone()
        .filter(|value| !value.trim().is_empty());
    let main_port = std::env::var("VIBELINK_BROWSER_CDP_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or_else(runtime_ports::current_main_webview_cdp_port);
    let registry = read_registry(artifact_root)?;
    if matches!(command.action, BrowserAction::Chrome) {
        let mut reserved = vec![main_port];
        if let Some(registry) = &registry {
            reserved.push(registry.main_port);
            reserved.extend(registry.profiles.iter().map(|profile| profile.port));
        }
        return browser_extension::chrome_backend(&command, artifact_root, main_port, &reserved);
    }
    let chrome_profiles = chrome_profile::registered(artifact_root);
    let mut ports = vec![main_port];
    if let Some(registry) = &registry {
        ports.push(registry.main_port);
        ports.extend(registry.profiles.iter().map(|profile| profile.port));
    }
    ports.extend(chrome_profiles.iter().map(|profile| profile.port));
    ports.retain(|port| *port != 0);
    ports.sort_unstable();
    ports.dedup();
    if ports.len() > 257 {
        bail!("browser CDP registry contains too many profile ports");
    }
    let mut targets = Vec::new();
    for port in ports {
        if let Ok(mut discovered) = list_targets(port) {
            targets.append(&mut discovered);
        }
    }
    annotate_targets(&mut targets, registry.as_ref());
    annotate_chrome_targets(&mut targets, &chrome_profiles, scoped_workspace.as_deref());
    if let Ok(bridge) = browser_extension::bridge_for(artifact_root, main_port) {
        if let Ok(tabs) = bridge.list_tabs() {
            targets.extend(
                tabs.into_iter()
                    .map(|tab| browser_extension::extension_target(tab, scoped_workspace.clone())),
            );
        }
    }
    if let Some(workspace_id) = scoped_workspace.as_deref() {
        targets.retain(|target| target.workspace_id.as_deref() == Some(workspace_id));
    }
    if targets.is_empty() {
        bail!(
            "browser CDP is unavailable; start VibeLink desktop or run `vibelink browser chrome`"
        );
    }
    if matches!(command.action, BrowserAction::Tabs) {
        return Ok(json!({ "targets": targets.iter().map(target_json).collect::<Vec<_>>() }));
    }
    if matches!(command.action, BrowserAction::Profiles) {
        let profiles = registry
            .map(|registry| profiles_for_workspace(registry.profiles, scoped_workspace.as_deref()))
            .unwrap_or_default();
        return Ok(json!({ "profiles": profiles, "chromeProfiles": chrome_profiles }));
    }
    let target = select_target(
        &targets,
        command
            .selectors
            .tab
            .as_deref()
            .or(command.selectors.page.as_deref()),
    )?;
    if let Some(workspace_id) = scoped_workspace.as_deref() {
        if target.workspace_id.as_deref() != Some(workspace_id) {
            bail!("browser page belongs to another workspace");
        }
    }
    let mut cdp = match target.extension_tab_id {
        Some(tab_id) => CdpConnection::Extension {
            bridge: browser_extension::bridge_for(artifact_root, main_port)?,
            tab_id,
        },
        None => CdpConnection::open(target)?,
    };
    let object_id = match element_target(&command)? {
        Some(element) => Some(resolve_element(&mut cdp, artifact_root, target, &element)?),
        None => None,
    };

    match command.action {
        BrowserAction::Navigate => {
            let input = option(&command, "url")
                .or_else(|| command.arguments.positionals.first().map(String::as_str))
                .context("--url is required")?;
            let url = access
                .browser
                .normalize_navigation(input)
                .map_err(anyhow::Error::new)?;
            Ok(cdp.call("Page.navigate", json!({ "url": url }))?)
        }
        BrowserAction::Snapshot => {
            cdp.call("Accessibility.enable", json!({}))?;
            let tree = cdp.call("Accessibility.getFullAXTree", json!({}))?;
            let url = current_page_url(&mut cdp)?;
            let snapshot = compress_ax_tree(&tree, &target.id, url.clone());
            write_snapshot_state(artifact_root, &snapshot.state)?;
            Ok(json!({
                "target": target_json(target),
                "generation": snapshot.state.generation,
                "url": url,
                "refs": snapshot.state.refs.len(),
                "truncated": snapshot.truncated,
                "tree": snapshot.tree,
            }))
        }
        BrowserAction::Screenshot | BrowserAction::FullScreenshot => {
            fs::create_dir_all(artifact_root)?;
            let full = matches!(command.action, BrowserAction::FullScreenshot);
            let result = cdp.call(
                "Page.captureScreenshot",
                json!({ "format": "png", "captureBeyondViewport": full, "fromSurface": true }),
            )?;
            let path = artifact_path(artifact_root, "screenshot", "png")?;
            write_base64_artifact(
                &path,
                result
                    .get("data")
                    .and_then(Value::as_str)
                    .context("screenshot data missing")?,
            )?;
            let descriptor = access
                .browser
                .describe_artifact(&path, "image/png", expires_at_ms())
                .map_err(anyhow::Error::new)?;
            Ok(serde_json::to_value(descriptor)?)
        }
        BrowserAction::Pdf => {
            fs::create_dir_all(artifact_root)?;
            let result = cdp.call("Page.printToPDF", json!({ "printBackground": true }))?;
            let path = artifact_path(artifact_root, "page", "pdf")?;
            write_base64_artifact(
                &path,
                result
                    .get("data")
                    .and_then(Value::as_str)
                    .context("PDF data missing")?,
            )?;
            let descriptor = access
                .browser
                .describe_artifact(&path, "application/pdf", expires_at_ms())
                .map_err(anyhow::Error::new)?;
            Ok(serde_json::to_value(descriptor)?)
        }
        BrowserAction::Back | BrowserAction::Forward => {
            let history = cdp.call("Page.getNavigationHistory", json!({}))?;
            let current = history
                .get("currentIndex")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let desired = current
                + if matches!(command.action, BrowserAction::Back) {
                    -1
                } else {
                    1
                };
            let entry = history
                .get("entries")
                .and_then(Value::as_array)
                .and_then(|entries| entries.get(desired.max(0) as usize))
                .context("no navigation history entry")?;
            cdp.call(
                "Page.navigateToHistoryEntry",
                json!({ "entryId": entry.get("id").context("history entry id missing")? }),
            )
        }
        BrowserAction::Reload => cdp.call(
            "Page.reload",
            json!({ "ignoreCache": command.arguments.switches.contains("ignore-cache") }),
        ),
        BrowserAction::Wait => wait_for_condition(&mut cdp, &command),
        BrowserAction::Click | BrowserAction::DoubleClick | BrowserAction::Hover => {
            let point = element_center(&mut cdp, element_id(&object_id)?)?;
            if matches!(command.action, BrowserAction::Hover) {
                cdp.call(
                    "Input.dispatchMouseEvent",
                    json!({ "type": "mouseMoved", "x": point.0, "y": point.1 }),
                )?;
            } else {
                let count = if matches!(command.action, BrowserAction::DoubleClick) {
                    2
                } else {
                    1
                };
                cdp.call("Input.dispatchMouseEvent", json!({ "type": "mousePressed", "x": point.0, "y": point.1, "button": "left", "clickCount": count }))?;
                cdp.call("Input.dispatchMouseEvent", json!({ "type": "mouseReleased", "x": point.0, "y": point.1, "button": "left", "clickCount": count }))?;
            }
            Ok(json!({ "x": point.0, "y": point.1 }))
        }
        BrowserAction::Fill | BrowserAction::Type => {
            let object_id = element_id(&object_id)?;
            let text = option(&command, "text").context("--text is required")?;
            if text.len() > MAX_TEXT_INPUT_BYTES {
                bail!("--text exceeds the bounded browser input size");
            }
            let replace = matches!(command.action, BrowserAction::Fill);
            let mode = call_on(
                &mut cdp,
                object_id,
                PREPARE_TEXT_INPUT,
                vec![json!({ "value": replace })],
            )?;
            match mode.as_str() {
                Some("value") => {
                    let value = call_on(
                        &mut cdp,
                        object_id,
                        SET_NATIVE_VALUE,
                        vec![json!({ "value": text }), json!({ "value": !replace })],
                    )?;
                    Ok(json!({ "mode": "value", "value": value }))
                }
                Some("editable") => {
                    cdp.call("Input.insertText", json!({ "text": text }))?;
                    Ok(json!({ "mode": "editable" }))
                }
                _ => bail!("browser element does not accept text input"),
            }
        }
        BrowserAction::Select => element_action(
            &mut cdp,
            element_id(&object_id)?,
            SET_SELECT_VALUE,
            option(&command, "value"),
        ),
        BrowserAction::Check => element_action(
            &mut cdp,
            element_id(&object_id)?,
            SET_CHECKED,
            Some(option(&command, "value").unwrap_or("true")),
        ),
        BrowserAction::Focus => element_action(
            &mut cdp,
            element_id(&object_id)?,
            "function(){this.focus();return this.ownerDocument.activeElement===this}",
            None,
        ),
        BrowserAction::Clear => clear_element(&mut cdp, element_id(&object_id)?),
        BrowserAction::SelectAll => {
            element_action(&mut cdp, element_id(&object_id)?, SELECT_ALL_TEXT, None)
        }
        BrowserAction::Keypress => {
            let key = option(&command, "key").context("--key is required")?;
            cdp.call(
                "Input.dispatchKeyEvent",
                json!({ "type": "keyDown", "key": key }),
            )?;
            cdp.call(
                "Input.dispatchKeyEvent",
                json!({ "type": "keyUp", "key": key }),
            )
        }
        BrowserAction::Drag => {
            let from = element_center(&mut cdp, element_id(&object_id)?)?;
            let to_x = option(&command, "to-x")
                .context("--to-x is required")?
                .parse::<f64>()?;
            let to_y = option(&command, "to-y")
                .context("--to-y is required")?
                .parse::<f64>()?;
            cdp.call("Input.dispatchMouseEvent", json!({ "type": "mousePressed", "x": from.0, "y": from.1, "button": "left", "buttons": 1 }))?;
            cdp.call("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": to_x, "y": to_y, "button": "left", "buttons": 1 }))?;
            cdp.call(
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseReleased", "x": to_x, "y": to_y, "button": "left" }),
            )
        }
        BrowserAction::Upload => {
            let object_id = element_id(&object_id)?;
            let values = command
                .arguments
                .options
                .get("file")
                .context("--file is required")?;
            let files = access.upload_files(values)?;
            cdp.call(
                "DOM.setFileInputFiles",
                json!({ "objectId": object_id, "files": files }),
            )
        }
        BrowserAction::Scroll => {
            let x = option(&command, "x").unwrap_or("0").parse::<f64>()?;
            let y = option(&command, "y").unwrap_or("0").parse::<f64>()?;
            cdp.call(
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseWheel", "x": 0, "y": 0, "deltaX": x, "deltaY": y }),
            )
        }
        BrowserAction::ScrollIntoView => element_action(
            &mut cdp,
            element_id(&object_id)?,
            "function(){this.scrollIntoView({block:'center',inline:'center'});return true}",
            None,
        ),
        BrowserAction::Find => {
            let text = option(&command, "text").context("--text is required")?;
            cdp.evaluate(&format!("window.find({})", serde_json::to_string(text)?))
        }
        BrowserAction::Get => {
            let property = option(&command, "property").unwrap_or("textContent");
            if !matches!(
                property,
                "textContent"
                    | "value"
                    | "href"
                    | "src"
                    | "checked"
                    | "disabled"
                    | "tagName"
                    | "ariaLabel"
            ) {
                bail!("unsupported safe browser property: {property}");
            }
            element_action(
                &mut cdp,
                element_id(&object_id)?,
                "function(property){return this[property]}",
                Some(property),
            )
        }
        BrowserAction::Is => {
            let state = option(&command, "state").unwrap_or("visible");
            let declaration = match state {
                "visible" => {
                    "function(){const r=this.getBoundingClientRect();return !!(r.width&&r.height)}"
                }
                "enabled" => "function(){return !this.disabled}",
                "checked" => "function(){return !!this.checked}",
                "focused" => "function(){return this.ownerDocument.activeElement===this}",
                _ => bail!("unsupported browser state: {state}"),
            };
            element_action(&mut cdp, element_id(&object_id)?, declaration, None)
        }
        BrowserAction::Mouse => {
            let event_type = option(&command, "type").unwrap_or("mouseMoved");
            if !matches!(
                event_type,
                "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel"
            ) {
                bail!("unsupported mouse event type: {event_type}");
            }
            let x = option(&command, "x")
                .context("--x is required")?
                .parse::<f64>()?;
            let y = option(&command, "y")
                .context("--y is required")?
                .parse::<f64>()?;
            if !x.is_finite() || !y.is_finite() {
                bail!("mouse coordinates must be finite");
            }
            cdp.call("Input.dispatchMouseEvent", json!({ "type": event_type, "x": x, "y": y, "button": option(&command, "button").unwrap_or("none") }))
        }
        BrowserAction::Highlight => element_action(
            &mut cdp,
            element_id(&object_id)?,
            "function(){this.style.outline='3px solid #ff2d55';return true}",
            None,
        ),
        BrowserAction::Download => {
            access.require(BrowserRiskCapability::Download)?;
            let path = access.browser.download_root();
            fs::create_dir_all(path)?;
            let canonical = fs::canonicalize(path)?;
            cdp.call(
                "Browser.setDownloadBehavior",
                json!({ "behavior": "allow", "downloadPath": canonical }),
            )?;
            Ok(json!({ "downloadPath": canonical }))
        }
        BrowserAction::Cookies => {
            access.require(BrowserRiskCapability::Cookies)?;
            cdp.call("Network.getAllCookies", json!({}))
        }
        BrowserAction::Storage => {
            access.require(BrowserRiskCapability::Storage)?;
            cdp.evaluate("({localStorage:{...localStorage},sessionStorage:{...sessionStorage}})")
        }
        BrowserAction::Viewport | BrowserAction::DeviceMode => {
            let metrics = BrowserDeviceMetrics {
                width: option(&command, "width").unwrap_or("1280").parse::<u32>()?,
                height: option(&command, "height").unwrap_or("720").parse::<u32>()?,
                device_scale_factor: option(&command, "scale").unwrap_or("1").parse::<f64>()?,
                mobile: matches!(command.action, BrowserAction::DeviceMode),
            };
            if !metrics.validate() {
                bail!("invalid browser viewport/device metrics");
            }
            cdp.call("Emulation.setDeviceMetricsOverride", json!({ "width": metrics.width, "height": metrics.height, "deviceScaleFactor": metrics.device_scale_factor, "mobile": metrics.mobile }))
        }
        BrowserAction::Console => {
            cdp.call("Runtime.enable", json!({}))?;
            let ms = option(&command, "ms")
                .unwrap_or("1000")
                .parse::<u64>()?
                .min(30_000);
            let events = cdp.collect_events(Duration::from_millis(ms))?;
            Ok(
                json!({ "events": events.into_iter().filter(|event| event.get("method").and_then(Value::as_str) == Some("Runtime.consoleAPICalled")).collect::<Vec<_>>() }),
            )
        }
        BrowserAction::Network => {
            cdp.call("Network.enable", json!({}))?;
            let ms = option(&command, "ms")
                .unwrap_or("1000")
                .parse::<u64>()?
                .min(30_000);
            let events = cdp.collect_events(Duration::from_millis(ms))?;
            Ok(
                json!({ "events": events.into_iter().filter(|event| event.get("method").and_then(Value::as_str).is_some_and(|method| method.starts_with("Network."))).collect::<Vec<_>>() }),
            )
        }
        BrowserAction::Tabs | BrowserAction::Profiles | BrowserAction::Chrome => {
            unreachable!("handled before target selection")
        }
    }
}

fn list_targets(port: u16) -> Result<Vec<DebugTarget>> {
    if port == 0 {
        bail!("invalid embedded browser CDP port");
    }
    let response = ureq::get(&format!("http://127.0.0.1:{port}/json"))
        .timeout(Duration::from_secs(3))
        .call()
        .with_context(|| {
            format!("embedded browser CDP is unavailable on port {port}; start VibeLink desktop")
        })?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_TARGET_RESPONSE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_TARGET_RESPONSE_BYTES {
        bail!("embedded browser target response exceeds the bounded size");
    }
    let targets: Vec<DebugTarget> = serde_json::from_slice(&bytes)?;
    if targets.len() > 512 {
        bail!("embedded browser exposed too many CDP targets");
    }
    Ok(targets
        .into_iter()
        .filter(|target| target.target_type == "page")
        .map(|mut target| {
            target.cdp_port = port;
            target
        })
        .collect())
}

fn read_registry(artifact_root: &Path) -> Result<Option<BrowserCdpRegistry>> {
    let Some(parent) = artifact_root.parent() else {
        return Ok(None);
    };
    read_registry_path(&parent.join("browser").join("cdp-registry.json"))
}

fn read_registry_path(path: &Path) -> Result<Option<BrowserCdpRegistry>> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if metadata.len() > MAX_REGISTRY_BYTES {
        bail!("browser CDP registry exceeds the bounded size");
    }
    let registry: BrowserCdpRegistry = serde_json::from_slice(&fs::read(path)?)?;
    validate_registry(&registry)?;
    Ok(Some(registry))
}

fn validate_registry(registry: &BrowserCdpRegistry) -> Result<()> {
    if registry.version != 2 || registry.main_port == 0 || registry.profiles.len() > 256 {
        bail!("invalid browser CDP registry header");
    }
    let mut profile_ids = HashSet::new();
    let mut ports = HashSet::new();
    let mut page_ids = HashSet::new();
    for profile in &registry.profiles {
        if !valid_registry_id(&profile.profile_id)
            || !profile_ids.insert(profile.profile_id.as_str())
            || profile.port == 0
            || !ports.insert(profile.port)
            || profile.pages.len() > 4_096
        {
            bail!("invalid browser CDP profile registry entry");
        }
        for page in &profile.pages {
            if !valid_registry_id(&page.page_id)
                || !valid_registry_id(&page.workspace_id)
                || !page_ids.insert(page.page_id.as_str())
            {
                bail!("invalid or duplicate browser page registry entry");
            }
        }
    }
    Ok(())
}

fn annotate_targets(targets: &mut [DebugTarget], registry: Option<&BrowserCdpRegistry>) {
    let mut claimed_pages = HashSet::new();
    for target in targets {
        let profile = registry.and_then(|registry| {
            registry
                .profiles
                .iter()
                .find(|profile| profile.port == target.cdp_port)
        });
        target.profile_id = profile.map(|profile| profile.profile_id.clone());
        if let (Some(profile), Ok(mut cdp)) = (profile, CdpConnection::open(target)) {
            if let Ok(Value::String(name)) = cdp.evaluate("window.name") {
                if let Some(page) = registered_page_for_name(profile, &name, &mut claimed_pages) {
                    target.page_id = Some(page.page_id.clone());
                    target.workspace_id = Some(page.workspace_id.clone());
                }
            }
        }
    }
}

/// A copied-profile Chrome is not workspace-scoped either. Stamping the
/// caller's workspace keeps the existing workspace filters honest for embedded
/// pages while leaving that browser reachable.
fn annotate_chrome_targets(
    targets: &mut [DebugTarget],
    profiles: &[chrome_profile::ChromeProfileRecord],
    workspace_id: Option<&str>,
) {
    for target in targets {
        let Some(profile) = profiles
            .iter()
            .find(|profile| profile.port == target.cdp_port)
        else {
            continue;
        };
        target.external = true;
        target.profile_id = Some(profile.profile_id.clone());
        target.workspace_id = workspace_id.map(str::to_string);
    }
}

fn registered_page_for_name<'a>(
    profile: &'a BrowserCdpProfile,
    window_name: &str,
    claimed_pages: &mut HashSet<String>,
) -> Option<&'a BrowserCdpPage> {
    let page_id = window_name.strip_prefix("vibelink-page:")?;
    let page = profile
        .pages
        .iter()
        .find(|known| known.page_id == page_id)?;
    claimed_pages.insert(page_id.to_string()).then_some(page)
}

fn profiles_for_workspace(
    profiles: Vec<BrowserCdpProfile>,
    workspace_id: Option<&str>,
) -> Vec<BrowserCdpProfile> {
    let Some(workspace_id) = workspace_id else {
        return profiles;
    };
    profiles
        .into_iter()
        .filter_map(|mut profile| {
            profile
                .pages
                .retain(|page| page.workspace_id == workspace_id);
            (!profile.pages.is_empty()).then_some(profile)
        })
        .collect()
}

pub fn list_embedded_tabs(
    registry_path: &Path,
    workspace_id: Option<&str>,
) -> Result<Vec<EmbeddedBrowserTab>> {
    if workspace_id.is_some_and(|value| !valid_registry_id(value)) {
        bail!("invalid browser workspace id");
    }
    let registry = read_registry_path(registry_path)?
        .context("embedded browser CDP registry is unavailable")?;
    let targets = registered_targets(&registry)?;
    Ok(project_embedded_tabs(&targets, workspace_id))
}

pub fn capture_jpeg_for_page(
    registry_path: &Path,
    page_id: &str,
    options: BrowserJpegCaptureOptions,
) -> Result<BrowserJpegFrame> {
    if !valid_registry_id(page_id) {
        bail!("invalid browser page id");
    }
    options.validate()?;
    let mut cdp = open_registered_page(registry_path, page_id)?;
    let metrics = cdp.call("Page.getLayoutMetrics", json!({}))?;
    let viewport_width = viewport_dimension(&metrics, "clientWidth")?;
    let viewport_height = viewport_dimension(&metrics, "clientHeight")?;
    let mut quality = options.quality;
    let mut scale = 1.0;

    for attempt in 0..MAX_JPEG_CAPTURE_ATTEMPTS {
        let capture = cdp.call(
            "Page.captureScreenshot",
            json!({
                "format": "jpeg",
                "quality": quality,
                "fromSurface": true,
                "captureBeyondViewport": false,
                "clip": {
                    "x": 0,
                    "y": 0,
                    "width": viewport_width,
                    "height": viewport_height,
                    "scale": scale,
                },
            }),
        )?;
        let encoded = capture
            .get("data")
            .and_then(Value::as_str)
            .context("browser JPEG capture data missing")?;
        if encoded.is_empty() {
            bail!("browser JPEG capture data is empty");
        }
        let mut estimated_bytes = encoded.len().saturating_mul(3).saturating_div(4);
        if estimated_bytes <= MAX_BROWSER_JPEG_BYTES.saturating_add(3) {
            let bytes = base64::engine::general_purpose::STANDARD.decode(encoded)?;
            estimated_bytes = bytes.len();
            if !bytes.is_empty() && bytes.len() <= MAX_BROWSER_JPEG_BYTES {
                return Ok(BrowserJpegFrame {
                    bytes,
                    viewport_width,
                    viewport_height,
                });
            }
        }
        if attempt + 1 == MAX_JPEG_CAPTURE_ATTEMPTS {
            break;
        }

        let ratio =
            (MAX_BROWSER_JPEG_BYTES as f64 / estimated_bytes.max(1) as f64).clamp(0.01, 0.99);
        if quality > MIN_ADAPTIVE_JPEG_QUALITY {
            let suggested = (f64::from(quality) * ratio.sqrt()).floor() as u8;
            quality = suggested.clamp(MIN_ADAPTIVE_JPEG_QUALITY, quality - 1);
        } else if scale > MIN_CAPTURE_SCALE {
            let suggested = (scale * ratio.sqrt() * 0.9).max(MIN_CAPTURE_SCALE);
            scale = if suggested < scale {
                suggested
            } else {
                (scale * 0.75).max(MIN_CAPTURE_SCALE)
            };
        } else {
            break;
        }
    }

    bail!(
        "browser JPEG capture cannot fit the {} byte remote-v2 payload limit",
        MAX_BROWSER_JPEG_BYTES
    )
}

pub fn dispatch_pointer_for_page(
    registry_path: &Path,
    page_id: &str,
    input: BrowserPointerInput,
) -> Result<()> {
    if !valid_registry_id(page_id) {
        bail!("invalid browser page id");
    }
    input.validate()?;
    let mut cdp = open_registered_page(registry_path, page_id)?;
    let metrics = cdp.call("Page.getLayoutMetrics", json!({}))?;
    let width = viewport_dimension(&metrics, "clientWidth")?;
    let height = viewport_dimension(&metrics, "clientHeight")?;
    input.validate_for_viewport(width, height)?;

    match input {
        BrowserPointerInput::Tap { x, y } => {
            cdp.call(
                "Input.dispatchMouseEvent",
                json!({ "type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1 }),
            )?;
            cdp.call(
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": 1 }),
            )?;
        }
        BrowserPointerInput::Drag {
            from_x,
            from_y,
            to_x,
            to_y,
        } => {
            cdp.call(
                "Input.dispatchMouseEvent",
                json!({ "type": "mousePressed", "x": from_x, "y": from_y, "button": "left", "buttons": 1, "clickCount": 1 }),
            )?;
            let move_result = cdp.call(
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseMoved", "x": to_x, "y": to_y, "button": "left", "buttons": 1 }),
            );
            let release_result = cdp.call(
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseReleased", "x": to_x, "y": to_y, "button": "left", "buttons": 0, "clickCount": 1 }),
            );
            move_result?;
            release_result?;
        }
        BrowserPointerInput::Scroll {
            x,
            y,
            delta_x,
            delta_y,
        } => {
            cdp.call(
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseWheel", "x": x, "y": y, "deltaX": delta_x, "deltaY": delta_y }),
            )?;
        }
    }
    Ok(())
}

pub fn dispatch_key_input_for_page(
    registry_path: &Path,
    page_id: &str,
    input: BrowserKeyInput,
) -> Result<()> {
    if !valid_registry_id(page_id) {
        bail!("invalid browser page id");
    }
    input.validate()?;
    let mut cdp = open_registered_page(registry_path, page_id)?;
    match input {
        BrowserKeyInput::Text { text } => {
            cdp.call("Input.insertText", json!({ "text": text }))?;
        }
        BrowserKeyInput::Key { key } => {
            cdp.call(
                "Input.dispatchKeyEvent",
                json!({ "type": "keyDown", "key": key }),
            )?;
            cdp.call(
                "Input.dispatchKeyEvent",
                json!({ "type": "keyUp", "key": key }),
            )?;
        }
    }
    Ok(())
}

pub fn set_viewport_for_page(
    registry_path: &Path,
    page_id: &str,
    viewport: BrowserViewport,
) -> Result<()> {
    if !valid_registry_id(page_id) {
        bail!("invalid browser page id");
    }
    let metrics = viewport.device_metrics()?;
    set_device_metrics_for_page(registry_path, page_id, metrics)
}

/// Sets Chromium's page scale around its own viewport origin. Optional center
/// coordinates are bounded and validated for the wire caller, then intentionally
/// ignored because this CDP primitive has no focal-center argument.
pub fn set_page_scale_for_page(
    registry_path: &Path,
    page_id: &str,
    page_scale: BrowserPageScale,
) -> Result<()> {
    if !valid_registry_id(page_id) {
        bail!("invalid browser page id");
    }
    page_scale.validate()?;
    let mut cdp = open_registered_page(registry_path, page_id)?;
    cdp.call(
        "Emulation.setPageScaleFactor",
        json!({ "pageScaleFactor": page_scale.scale }),
    )?;
    Ok(())
}

fn project_embedded_tabs(
    targets: &[DebugTarget],
    workspace_id: Option<&str>,
) -> Vec<EmbeddedBrowserTab> {
    targets
        .iter()
        .filter_map(|target| {
            let page_id = target.page_id.as_ref()?;
            let target_workspace_id = target.workspace_id.as_ref()?;
            if workspace_id.is_some_and(|expected| expected != target_workspace_id) {
                return None;
            }
            Some(EmbeddedBrowserTab {
                id: page_id.clone(),
                title: target.title.clone(),
                url: target.url.clone(),
                workspace_id: target_workspace_id.clone(),
            })
        })
        .collect()
}

fn registered_targets(registry: &BrowserCdpRegistry) -> Result<Vec<DebugTarget>> {
    let mut targets = Vec::new();
    let mut reachable_port = false;
    let mut ports = registry
        .profiles
        .iter()
        .map(|profile| profile.port)
        .collect::<Vec<_>>();
    ports.sort_unstable();
    ports.dedup();
    for port in ports {
        if let Ok(mut discovered) = list_targets(port) {
            reachable_port = true;
            targets.append(&mut discovered);
        }
    }
    if !registry.profiles.is_empty() && !reachable_port {
        bail!("embedded browser profile CDP is unavailable; start VibeLink desktop");
    }
    annotate_targets(&mut targets, Some(registry));
    Ok(targets)
}

pub(super) fn open_registered_page(registry_path: &Path, page_id: &str) -> Result<CdpConnection> {
    let registry = read_registry_path(registry_path)?
        .context("embedded browser CDP registry is unavailable")?;
    let targets = registered_targets(&registry)?;
    let matches = targets
        .iter()
        .filter(|target| target.page_id.as_deref() == Some(page_id))
        .collect::<Vec<_>>();
    let target = match matches.as_slice() {
        [target] => *target,
        [] => bail!("registered browser page target not found: {page_id}"),
        _ => bail!("duplicate registered browser page target: {page_id}"),
    };
    CdpConnection::open(target)
}

pub fn set_device_metrics_for_page(
    registry_path: &Path,
    page_id: &str,
    metrics: Option<BrowserDeviceMetrics>,
) -> Result<()> {
    if !valid_registry_id(page_id) {
        bail!("invalid browser page id");
    }
    let registry = read_registry_path(registry_path)?
        .context("embedded browser CDP registry is unavailable")?;
    let mut targets = Vec::new();
    for port in registry
        .profiles
        .iter()
        .map(|profile| profile.port)
        .collect::<HashSet<_>>()
    {
        if let Ok(mut discovered) = list_targets(port) {
            targets.append(&mut discovered);
        }
    }
    annotate_targets(&mut targets, Some(&registry));
    let target = select_target(&targets, Some(page_id))?;
    let mut cdp = CdpConnection::open(target)?;
    match metrics {
        Some(metrics) if metrics.validate() => {
            cdp.call(
                "Emulation.setDeviceMetricsOverride",
                json!({
                    "width": metrics.width,
                    "height": metrics.height,
                    "deviceScaleFactor": metrics.device_scale_factor,
                    "mobile": metrics.mobile,
                }),
            )?;
        }
        Some(_) => bail!("invalid browser device metrics"),
        None => {
            cdp.call("Emulation.clearDeviceMetricsOverride", json!({}))?;
        }
    }
    Ok(())
}

pub fn capture_png_for_page(registry_path: &Path, page_id: &str) -> Result<(Vec<u8>, u32, u32)> {
    if !valid_registry_id(page_id) {
        bail!("invalid browser page id");
    }
    let registry = read_registry_path(registry_path)?
        .context("embedded browser CDP registry is unavailable")?;
    let mut targets = Vec::new();
    for port in registry
        .profiles
        .iter()
        .map(|profile| profile.port)
        .collect::<HashSet<_>>()
    {
        if let Ok(mut discovered) = list_targets(port) {
            targets.append(&mut discovered);
        }
    }
    annotate_targets(&mut targets, Some(&registry));
    let target = select_target(&targets, Some(page_id))?;
    let mut cdp = CdpConnection::open(target)?;
    let metrics = cdp.call("Page.getLayoutMetrics", json!({}))?;
    let width = viewport_dimension(&metrics, "clientWidth")?;
    let height = viewport_dimension(&metrics, "clientHeight")?;
    let capture = cdp.call(
        "Page.captureScreenshot",
        json!({ "format": "png", "fromSurface": true, "captureBeyondViewport": false }),
    )?;
    let encoded = capture
        .get("data")
        .and_then(Value::as_str)
        .context("browser capture data missing")?;
    let encoded_limit = MAX_ARTIFACT_BYTES
        .saturating_mul(4)
        .saturating_div(3)
        .saturating_add(8) as usize;
    if encoded.len() > encoded_limit {
        bail!("browser capture exceeds the bounded size");
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded)?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_ARTIFACT_BYTES {
        bail!("browser capture exceeds the bounded size");
    }
    Ok((bytes, width, height))
}

pub fn capture_png_clip_for_page(
    registry_path: &Path,
    page_id: &str,
    bounds: crate::browser::PhysicalBounds,
) -> Result<Vec<u8>> {
    if !bounds.validate() || bounds.width > 10_000 || bounds.height > 10_000 {
        bail!("browser capture clip is out of bounds");
    }
    if !valid_registry_id(page_id) {
        bail!("invalid browser page id");
    }
    let registry = read_registry_path(registry_path)?
        .context("embedded browser CDP registry is unavailable")?;
    let mut targets = Vec::new();
    for port in registry
        .profiles
        .iter()
        .map(|profile| profile.port)
        .collect::<HashSet<_>>()
    {
        if let Ok(mut discovered) = list_targets(port) {
            targets.append(&mut discovered);
        }
    }
    annotate_targets(&mut targets, Some(&registry));
    let target = select_target(&targets, Some(page_id))?;
    let mut cdp = CdpConnection::open(target)?;
    let capture = cdp.call(
        "Page.captureScreenshot",
        json!({
            "format": "png",
            "fromSurface": true,
            "captureBeyondViewport": false,
            "clip": {
                "x": bounds.x,
                "y": bounds.y,
                "width": bounds.width,
                "height": bounds.height,
                "scale": 1,
            },
        }),
    )?;
    let encoded = capture
        .get("data")
        .and_then(Value::as_str)
        .context("browser capture data missing")?;
    let encoded_limit = MAX_ARTIFACT_BYTES
        .saturating_mul(4)
        .saturating_div(3)
        .saturating_add(8) as usize;
    if encoded.len() > encoded_limit {
        bail!("browser capture exceeds the bounded size");
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded)?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_ARTIFACT_BYTES {
        bail!("browser capture exceeds the bounded size");
    }
    Ok(bytes)
}

fn viewport_dimension(metrics: &Value, name: &str) -> Result<u32> {
    let value = metrics
        .pointer(&format!("/cssVisualViewport/{name}"))
        .or_else(|| metrics.pointer(&format!("/cssLayoutViewport/{name}")))
        .and_then(Value::as_f64)
        .context("browser viewport metric missing")?;
    if !value.is_finite() || value <= 0.0 || value > 10_000.0 {
        bail!("browser viewport metric is out of bounds");
    }
    Ok(value.ceil() as u32)
}

fn select_target<'a>(
    targets: &'a [DebugTarget],
    selector: Option<&str>,
) -> Result<&'a DebugTarget> {
    if let Some(selector) = selector {
        let matches = targets
            .iter()
            .filter(|target| {
                target.id == selector
                    || target.page_id.as_deref() == Some(selector)
                    || target.title.eq_ignore_ascii_case(selector)
                    || target.url == selector
            })
            .collect::<Vec<_>>();
        return match matches.as_slice() {
            [target] => Ok(*target),
            [] => bail!("browser target not found: {selector}"),
            _ => bail!("ambiguous browser target: {selector}"),
        };
    }
    let candidates = targets
        .iter()
        .filter(|target| {
            target.page_id.is_some()
                || (!target.url.starts_with("tauri://")
                    && !target.url.contains("tauri.localhost")
                    && !runtime_ports::is_dev_vite_url(&target.url))
        })
        .collect::<Vec<_>>();

    match candidates.as_slice() {
        [target] => Ok(*target),
        [] if targets.len() == 1 => Ok(&targets[0]),
        [] => bail!("no embedded browser target is available"),
        _ => bail!("multiple browser targets are open; specify --tab or --page"),
    }
}

fn target_json(target: &DebugTarget) -> Value {
    json!({
        "id": target.id,
        "pageId": target.page_id,
        "profileId": target.profile_id,
        "workspaceId": target.workspace_id,
        "cdpPort": target.cdp_port,
        "title": target.title,
        "url": target.url,
        "type": target.target_type,
        "external": target.external,
    })
}

pub(super) fn option<'a>(command: &'a ActionCommand<BrowserAction>, name: &str) -> Option<&'a str> {
    command
        .arguments
        .options
        .get(name)
        .and_then(|values| match values.as_slice() {
            [value] => Some(value.as_str()),
            _ => None,
        })
}

fn required_capability(action: BrowserAction) -> Option<BrowserRiskCapability> {
    match action {
        BrowserAction::Cookies | BrowserAction::Chrome => Some(BrowserRiskCapability::Cookies),
        BrowserAction::Storage => Some(BrowserRiskCapability::Storage),
        BrowserAction::Upload => Some(BrowserRiskCapability::Upload),
        BrowserAction::Download => Some(BrowserRiskCapability::Download),
        _ => None,
    }
}

fn parse_grants(values: Option<&Vec<String>>) -> Result<HashSet<BrowserRiskCapability>> {
    let mut grants = HashSet::new();
    for value in values.into_iter().flatten() {
        let capability = match value.as_str() {
            "browser.cookies" => BrowserRiskCapability::Cookies,
            "browser.storage" => BrowserRiskCapability::Storage,
            "browser.upload" => BrowserRiskCapability::Upload,
            "browser.download" => BrowserRiskCapability::Download,
            "browser.evaluate" => BrowserRiskCapability::Evaluate,
            "browser.file" => BrowserRiskCapability::LocalFiles,
            other => bail!("unknown browser risk grant: {other}"),
        };
        grants.insert(capability);
    }
    Ok(grants)
}

pub(super) fn valid_registry_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
}

fn artifact_path(root: &Path, stem: &str, extension: &str) -> Result<PathBuf> {
    if !valid_registry_id(stem) || !valid_registry_id(extension) {
        bail!("invalid browser artifact name");
    }
    fs::create_dir_all(root)?;
    let canonical_root = fs::canonicalize(root)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    for suffix in 0..10_000u32 {
        let name = if suffix == 0 {
            format!("{stem}-{now}.{extension}")
        } else {
            format!("{stem}-{now}-{suffix}.{extension}")
        };
        let path = canonical_root.join(name);
        match fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
        {
            Ok(_) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    bail!("could not reserve a unique browser artifact path")
}

fn write_base64_artifact(path: &Path, data: &str) -> Result<()> {
    let encoded_limit = MAX_ARTIFACT_BYTES
        .saturating_mul(4)
        .saturating_div(3)
        .saturating_add(8) as usize;
    if data.len() > encoded_limit {
        bail!("browser artifact exceeds the bounded size");
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data)?;
    if bytes.len() as u64 > MAX_ARTIFACT_BYTES {
        bail!("browser artifact exceeds the bounded size");
    }
    fs::write(path, bytes)?;
    Ok(())
}

pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn expires_at_ms() -> u64 {
    now_ms().saturating_add(15 * 60 * 1_000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dedicated_cli::browser_page::inspect;
    use crate::dedicated_cli::browser_page::{
        DEFAULT_MOBILE_DEVICE_SCALE_FACTOR, DEFAULT_MOBILE_VIEWPORT_HEIGHT,
        DEFAULT_MOBILE_VIEWPORT_WIDTH, MAX_KEY_INPUT_BYTES, MAX_PAGE_SCALE, MAX_SCROLL_DELTA,
        MIN_PAGE_SCALE,
    };
    use crate::dedicated_cli::{OperationArguments, SelectorSet};
    use std::collections::BTreeMap;
    use uuid::Uuid;

    fn command(
        action: BrowserAction,
        options: impl IntoIterator<Item = (&'static str, Vec<String>)>,
    ) -> ActionCommand<BrowserAction> {
        ActionCommand {
            action,
            selectors: SelectorSet::default(),
            arguments: OperationArguments {
                options: options
                    .into_iter()
                    .map(|(name, values)| (name.to_string(), values))
                    .collect::<BTreeMap<_, _>>(),
                ..OperationArguments::default()
            },
        }
    }

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("vibelink-browser-cdp-{label}-{}", Uuid::new_v4()))
    }

    #[test]
    fn capture_viewport_metrics_are_bounded() {
        let metrics = json!({
            "cssVisualViewport": { "clientWidth": 390.25, "clientHeight": 844.1 }
        });
        assert_eq!(viewport_dimension(&metrics, "clientWidth").unwrap(), 391);
        assert_eq!(viewport_dimension(&metrics, "clientHeight").unwrap(), 845);
        assert!(viewport_dimension(
            &json!({ "cssVisualViewport": { "clientWidth": 10001.0 } }),
            "clientWidth"
        )
        .is_err());
    }

    #[test]
    fn typed_pointer_inputs_reject_hostile_values() {
        BrowserPointerInput::Tap { x: 12.0, y: 34.0 }
            .validate_for_viewport(390, 844)
            .unwrap();
        BrowserPointerInput::Drag {
            from_x: 1.0,
            from_y: 2.0,
            to_x: 389.0,
            to_y: 843.0,
        }
        .validate_for_viewport(390, 844)
        .unwrap();
        BrowserPointerInput::Scroll {
            x: 10.0,
            y: 20.0,
            delta_x: 0.0,
            delta_y: -120.0,
        }
        .validate_for_viewport(390, 844)
        .unwrap();

        for hostile in [
            BrowserPointerInput::Tap {
                x: f64::NAN,
                y: 0.0,
            },
            BrowserPointerInput::Tap { x: -1.0, y: 0.0 },
            BrowserPointerInput::Drag {
                from_x: 0.0,
                from_y: 0.0,
                to_x: f64::INFINITY,
                to_y: 1.0,
            },
            BrowserPointerInput::Scroll {
                x: 0.0,
                y: 0.0,
                delta_x: MAX_SCROLL_DELTA + 1.0,
                delta_y: 0.0,
            },
            BrowserPointerInput::Scroll {
                x: 0.0,
                y: 0.0,
                delta_x: 0.0,
                delta_y: 0.0,
            },
        ] {
            assert!(hostile.validate().is_err());
        }
        assert!(BrowserPointerInput::Tap { x: 390.0, y: 1.0 }
            .validate_for_viewport(390, 844)
            .is_err());
    }

    #[test]
    fn viewport_and_page_scale_validation_is_bounded() {
        assert_eq!(
            BrowserViewport::mobile_default().device_metrics().unwrap(),
            Some(BrowserDeviceMetrics {
                width: DEFAULT_MOBILE_VIEWPORT_WIDTH,
                height: DEFAULT_MOBILE_VIEWPORT_HEIGHT,
                device_scale_factor: DEFAULT_MOBILE_DEVICE_SCALE_FACTOR,
                mobile: true,
            })
        );
        assert_eq!(BrowserViewport::Web.device_metrics().unwrap(), None);
        for hostile in [
            BrowserViewport::Mobile {
                width: 0,
                height: 844,
                device_scale_factor: 1.0,
            },
            BrowserViewport::Mobile {
                width: 390,
                height: 10_001,
                device_scale_factor: 1.0,
            },
            BrowserViewport::Mobile {
                width: 390,
                height: 844,
                device_scale_factor: f64::NAN,
            },
        ] {
            assert!(hostile.device_metrics().is_err());
        }

        for scale in [MIN_PAGE_SCALE, 1.0, MAX_PAGE_SCALE] {
            BrowserPageScale {
                scale,
                center_x: None,
                center_y: None,
            }
            .validate()
            .unwrap();
        }
        BrowserPageScale {
            scale: 2.0,
            center_x: Some(195.0),
            center_y: Some(422.0),
        }
        .validate()
        .unwrap();
        for scale in [f64::NAN, 0.0, MIN_PAGE_SCALE - 0.01, MAX_PAGE_SCALE + 0.01] {
            assert!(BrowserPageScale {
                scale,
                center_x: None,
                center_y: None,
            }
            .validate()
            .is_err());
        }
        assert!(BrowserPageScale {
            scale: 2.0,
            center_x: Some(f64::NAN),
            center_y: Some(1.0),
        }
        .validate()
        .is_err());
        assert!(BrowserPageScale {
            scale: 2.0,
            center_x: Some(1.0),
            center_y: None,
        }
        .validate()
        .is_err());
    }

    #[test]
    fn text_and_key_input_validation_is_bounded() {
        BrowserKeyInput::Text {
            text: "한글 text\n".to_string(),
        }
        .validate()
        .unwrap();
        BrowserKeyInput::Key {
            key: "Enter".to_string(),
        }
        .validate()
        .unwrap();

        for hostile in [
            BrowserKeyInput::Text {
                text: String::new(),
            },
            BrowserKeyInput::Text {
                text: "x".repeat(MAX_TEXT_INPUT_BYTES + 1),
            },
            BrowserKeyInput::Text {
                text: "bad\0text".to_string(),
            },
            BrowserKeyInput::Key {
                key: "\n".to_string(),
            },
            BrowserKeyInput::Key {
                key: "x".repeat(MAX_KEY_INPUT_BYTES + 1),
            },
        ] {
            assert!(hostile.validate().is_err());
        }
    }

    #[test]
    fn capture_options_reject_invalid_quality() {
        BrowserJpegCaptureOptions::default().validate().unwrap();
        BrowserJpegCaptureOptions { quality: 1 }.validate().unwrap();
        BrowserJpegCaptureOptions { quality: 100 }
            .validate()
            .unwrap();
        assert!(BrowserJpegCaptureOptions { quality: 0 }.validate().is_err());
        assert!(BrowserJpegCaptureOptions { quality: 101 }
            .validate()
            .is_err());
    }

    #[test]
    fn public_helpers_validate_before_browser_discovery() {
        let missing_registry = temp_root("typed-validation").join("cdp-registry.json");

        assert!(capture_jpeg_for_page(
            &missing_registry,
            "page-a",
            BrowserJpegCaptureOptions { quality: 0 },
        )
        .unwrap_err()
        .to_string()
        .contains("JPEG quality"));
        assert!(dispatch_pointer_for_page(
            &missing_registry,
            "page-a",
            BrowserPointerInput::Tap {
                x: f64::NAN,
                y: 0.0,
            },
        )
        .unwrap_err()
        .to_string()
        .contains("pointer coordinates"));
        assert!(dispatch_key_input_for_page(
            &missing_registry,
            "page-a",
            BrowserKeyInput::Text {
                text: String::new(),
            },
        )
        .unwrap_err()
        .to_string()
        .contains("text input"));
        assert!(inspect(&missing_registry, "page-a", Some(1.0), None)
            .unwrap_err()
            .to_string()
            .contains("requires both"));
        assert!(
            inspect(&missing_registry, "page-a", Some(10_001.0), Some(0.0))
                .unwrap_err()
                .to_string()
                .contains("out of bounds")
        );
        assert!(set_viewport_for_page(
            &missing_registry,
            "page-a",
            BrowserViewport::Mobile {
                width: 0,
                height: 844,
                device_scale_factor: 1.0,
            },
        )
        .unwrap_err()
        .to_string()
        .contains("mobile browser viewport"));
        assert!(set_page_scale_for_page(
            &missing_registry,
            "page-a",
            BrowserPageScale {
                scale: f64::NAN,
                center_x: None,
                center_y: None,
            },
        )
        .unwrap_err()
        .to_string()
        .contains("page scale"));
    }

    #[test]
    fn tab_projection_uses_only_authoritative_registry_annotations() {
        let targets = vec![
            DebugTarget {
                id: "cdp-a".to_string(),
                title: "First".to_string(),
                url: "https://example.test/first".to_string(),
                target_type: "page".to_string(),
                web_socket_debugger_url: None,
                cdp_port: 9334,
                page_id: Some("page-a".to_string()),
                profile_id: Some("profile-a".to_string()),
                workspace_id: Some("workspace-a".to_string()),
                external: false,
                extension_tab_id: None,
            },
            DebugTarget {
                id: "cdp-b".to_string(),
                title: "Second".to_string(),
                url: "https://example.test/second".to_string(),
                target_type: "page".to_string(),
                web_socket_debugger_url: None,
                cdp_port: 9335,
                page_id: Some("page-b".to_string()),
                profile_id: Some("profile-b".to_string()),
                workspace_id: Some("workspace-b".to_string()),
                external: false,
                extension_tab_id: None,
            },
            DebugTarget {
                id: "unregistered-cdp-target".to_string(),
                title: "Application shell".to_string(),
                url: "tauri://localhost".to_string(),
                target_type: "page".to_string(),
                web_socket_debugger_url: None,
                cdp_port: 9333,
                page_id: None,
                profile_id: None,
                workspace_id: None,
                external: false,
                extension_tab_id: None,
            },
        ];

        assert_eq!(
            project_embedded_tabs(&targets, Some("workspace-a")),
            vec![EmbeddedBrowserTab {
                id: "page-a".to_string(),
                title: "First".to_string(),
                url: "https://example.test/first".to_string(),
                workspace_id: "workspace-a".to_string(),
            }]
        );
        assert_eq!(project_embedded_tabs(&targets, None).len(), 2);
    }
    #[test]
    fn risky_actions_are_denied_before_any_cdp_connection() {
        let root = temp_root("risk");
        for action in [
            BrowserAction::Cookies,
            BrowserAction::Storage,
            BrowserAction::Upload,
            BrowserAction::Download,
        ] {
            let error = execute(command(action, []), &root).unwrap_err();
            assert!(error.to_string().contains("requires explicit browser."));
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn upload_paths_require_a_grant_and_canonical_workspace_containment() {
        let root = temp_root("upload");
        let workspace = root.join("workspace");
        let outside = root.join("outside.txt");
        fs::create_dir_all(&workspace).unwrap();
        let inside = workspace.join("inside.txt");
        fs::write(&inside, b"inside").unwrap();
        fs::write(&outside, b"outside").unwrap();
        let access = CdpAccessPolicy::from_command(
            &command(
                BrowserAction::Upload,
                [
                    ("grant", vec!["browser.upload".to_string()]),
                    (
                        "workspace-root",
                        vec![workspace.to_string_lossy().into_owned()],
                    ),
                ],
            ),
            &root.join("artifacts"),
        )
        .unwrap();
        assert_eq!(
            access
                .upload_files(&[inside.to_string_lossy().into_owned()])
                .unwrap(),
            vec![fs::canonicalize(&inside).unwrap()]
        );
        assert!(access
            .upload_files(&[outside.to_string_lossy().into_owned()])
            .unwrap_err()
            .to_string()
            .contains("outside the explicitly granted workspace roots"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn registry_routes_pages_only_to_their_declared_profile() {
        let first = BrowserCdpProfile {
            profile_id: "profile-a".to_string(),
            port: 9334,
            pages: vec![BrowserCdpPage {
                page_id: "page-a".to_string(),
                workspace_id: "workspace-a".to_string(),
            }],
        };
        let second = BrowserCdpProfile {
            profile_id: "profile-b".to_string(),
            port: 9335,
            pages: vec![BrowserCdpPage {
                page_id: "page-b".to_string(),
                workspace_id: "workspace-b".to_string(),
            }],
        };
        validate_registry(&BrowserCdpRegistry {
            version: 2,
            main_port: 9333,
            profiles: vec![first.clone(), second.clone()],
        })
        .unwrap();
        let mut claimed = HashSet::new();
        assert_eq!(
            registered_page_for_name(&first, "vibelink-page:page-a", &mut claimed)
                .map(|page| (page.page_id.as_str(), page.workspace_id.as_str())),
            Some(("page-a", "workspace-a"))
        );
        assert!(registered_page_for_name(&second, "vibelink-page:page-a", &mut claimed).is_none());
        assert_eq!(
            registered_page_for_name(&second, "vibelink-page:page-b", &mut claimed)
                .map(|page| (page.page_id.as_str(), page.workspace_id.as_str())),
            Some(("page-b", "workspace-b"))
        );
        assert_eq!(
            profiles_for_workspace(vec![first, second], Some("workspace-a"))
                .into_iter()
                .map(|profile| profile.profile_id)
                .collect::<Vec<_>>(),
            vec!["profile-a"]
        );
    }

    #[test]
    fn hostile_registry_and_websocket_inputs_fail_closed() {
        let duplicate = BrowserCdpRegistry {
            version: 2,
            main_port: 9333,
            profiles: vec![
                BrowserCdpProfile {
                    profile_id: "a".to_string(),
                    port: 9334,
                    pages: vec![BrowserCdpPage {
                        page_id: "same".to_string(),
                        workspace_id: "workspace-a".to_string(),
                    }],
                },
                BrowserCdpProfile {
                    profile_id: "b".to_string(),
                    port: 9335,
                    pages: vec![BrowserCdpPage {
                        page_id: "same".to_string(),
                        workspace_id: "workspace-b".to_string(),
                    }],
                },
            ],
        };
        assert!(validate_registry(&duplicate).is_err());
        let target = DebugTarget {
            id: "target".to_string(),
            title: "Hostile".to_string(),
            url: "https://example.test".to_string(),
            target_type: "page".to_string(),
            web_socket_debugger_url: Some("ws://example.test:9334/devtools/page/1".to_string()),
            cdp_port: 9334,
            page_id: None,
            profile_id: None,
            workspace_id: None,
            external: false,
            extension_tab_id: None,
        };
        let error = match CdpConnection::open(&target) {
            Ok(_) => panic!("hostile websocket URL was accepted"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("unsafe CDP websocket URL"));
    }
}
