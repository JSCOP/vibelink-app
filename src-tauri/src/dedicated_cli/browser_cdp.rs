use super::browser_page::{
    call_on, clear_element, compress_ax_tree, current_page_url, element_action, element_center,
    element_id, element_target, next_snapshot_ref, read_snapshot_state, resolve_element, show_cursor,
    wait_for_condition, write_snapshot_state, BrowserJpegCaptureOptions, BrowserJpegFrame,
    BrowserKeyInput, BrowserPageScale, BrowserPointerInput, BrowserViewport, MAX_TEXT_INPUT_BYTES,
    PREPARE_TEXT_INPUT, SELECT_ALL_TEXT, SET_CHECKED, SET_NATIVE_VALUE, SET_SELECT_VALUE,
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
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tungstenite::{connect, stream::MaybeTlsStream, Message, WebSocket};

#[cfg(test)]
use std::collections::VecDeque;

const MAX_REGISTRY_BYTES: u64 = 1024 * 1024;
const MAX_TARGET_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_CDP_MESSAGE_BYTES: usize = 80 * 1024 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EVENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_EVENTS: usize = 1024;
const DEFAULT_CDP_TIMEOUT: Duration = Duration::from_secs(30);
pub(super) const MAX_INSPECT_SNAPSHOT_BYTES: usize = 256 * 1024;

pub const MAX_BROWSER_JPEG_BYTES: usize = 60 * 1024;

const MIN_CAPTURE_SCALE: f64 = 0.05;
const MIN_ADAPTIVE_JPEG_QUALITY: u8 = 35;
const MAX_JPEG_CAPTURE_ATTEMPTS: usize = 10;

// Snapshot files are process-global; serialize their read/increment/write step.
static SNAPSHOT_STATE_LOCK: Mutex<()> = Mutex::new(());

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
    #[cfg(test)]
    Scripted {
        calls: Arc<Mutex<Vec<(String, Value)>>>,
        responses: VecDeque<std::result::Result<Value, String>>,
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
                stream.set_read_timeout(Some(DEFAULT_CDP_TIMEOUT))?;
                stream.set_write_timeout(Some(DEFAULT_CDP_TIMEOUT))?;
            }
            _ => bail!("browser target exposed a non-plain CDP websocket transport"),
        }
        Ok(Self::Socket {
            socket: Box::new(socket),
            next_id: 1,
        })
    }

    pub(super) fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.call_inner(method, params, None)
    }

    pub(super) fn call_with_timeout(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value> {
        if timeout.is_zero() {
            bail!("CDP call deadline elapsed");
        }
        self.call_inner(method, params, Some(timeout))
    }

    fn call_inner(
        &mut self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<Value> {
        match self {
            Self::Extension { bridge, tab_id } => match timeout {
                Some(timeout) => bridge.send_with_timeout(*tab_id, method, params, timeout),
                None => bridge.send(*tab_id, method, params),
            },
            Self::Socket { socket, next_id } => call_socket(
                socket.as_mut(),
                next_id,
                method,
                params,
                timeout.unwrap_or(DEFAULT_CDP_TIMEOUT),
            ),
            #[cfg(test)]
            Self::Scripted { calls, responses } => {
                calls
                    .lock()
                    .expect("scripted CDP calls")
                    .push((method.to_string(), params));
                responses
                    .pop_front()
                    .context("scripted CDP response missing")?
                    .map_err(anyhow::Error::msg)
            }
        }
    }

    pub(super) fn evaluate(&mut self, expression: &str) -> Result<Value> {
        let result = self.call("Runtime.evaluate", evaluate_params(expression))?;
        evaluated_value(result)
    }

    pub(super) fn evaluate_with_timeout(
        &mut self,
        expression: &str,
        timeout: Duration,
    ) -> Result<Value> {
        let result = self.call_with_timeout(
            "Runtime.evaluate",
            evaluate_params(expression),
            timeout,
        )?;
        evaluated_value(result)
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
            #[cfg(test)]
            Self::Scripted { .. } => {
                thread::sleep(duration);
                return Ok(Vec::new());
            }
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

    #[cfg(test)]
    pub(super) fn scripted(
        responses: Vec<std::result::Result<Value, String>>,
    ) -> (Self, Arc<Mutex<Vec<(String, Value)>>>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        (
            Self::Scripted {
                calls: Arc::clone(&calls),
                responses: responses.into_iter().collect(),
            },
            calls,
        )
    }
}

fn call_socket(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    next_id: &mut u64,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value> {
    let deadline = Instant::now() + timeout;
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => stream.set_write_timeout(Some(timeout))?,
        _ => bail!("browser target exposed a non-plain CDP websocket transport"),
    }
    let id = *next_id;
    *next_id = (*next_id)
        .checked_add(1)
        .context("CDP request id exhausted")?;
    socket.send(Message::Text(
        serde_json::to_string(&json!({ "id": id, "method": method, "params": params }))?.into(),
    ))?;
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .with_context(|| format!("CDP {method} timed out"))?;
        if let MaybeTlsStream::Plain(stream) = socket.get_mut() {
            stream.set_read_timeout(Some(remaining))?;
        }
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

fn evaluate_params(expression: &str) -> Value {
    json!({
        "expression": expression,
        "awaitPromise": true,
        "returnByValue": true,
        "userGesture": true
    })
}

fn evaluated_value(result: Value) -> Result<Value> {
    if let Some(exception) = result.get("exceptionDetails") {
        bail!("browser script failed: {exception}");
    }
    Ok(result
        .pointer("/result/value")
        .cloned()
        .unwrap_or(Value::Null))
}

pub fn execute(command: ActionCommand<BrowserAction>, artifact_root: &Path) -> Result<Value> {
    let access = CdpAccessPolicy::from_command(&command, artifact_root)?;
    if let Some(capability) = required_capability(&command) {
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
    let bridge = browser_extension::bridge_for(artifact_root, main_port).ok();
    if let Some(bridge) = &bridge {
        if let Ok(tabs) = bridge.list_tabs() {
            targets.extend(
                tabs.into_iter()
                    .map(|tab| browser_extension::extension_target(tab, scoped_workspace.clone())),
            );
        }
    }
    // Before the empty-target bail: opening the first tab is exactly what a
    // caller does when nothing is open yet.
    if matches!(command.action, BrowserAction::NewTab) {
        return open_new_tab(&command, bridge.as_ref(), artifact_root, scoped_workspace);
    }
    if let Some(workspace_id) = scoped_workspace.as_deref() {
        targets.retain(|target| target.workspace_id.as_deref() == Some(workspace_id));
    }
    if targets.is_empty() {
        // "Start VibeLink desktop" sends the caller in a circle when it already
        // runs, so name whichever real cause applies.
        if let Some(status) = bridge
            .map(|bridge| bridge.status())
            .filter(|s| !s.connected)
        {
            if let Some(refused) = status.rejected_extension_id {
                bail!("no browser tab is available: extension {refused} was refused because this daemon is bound to {}. Run `vibelink browser chrome --unpair` to bind the new one", status.trusted_extension_id.unwrap_or_default());
            }
            let data_root = artifact_root.parent().unwrap_or(artifact_root);
            bail!("no browser tab is available: the VibeLink extension is not connected. Install it from the Chrome Web Store, or load {} once via chrome://extensions with Developer mode on, and keep Chrome running", browser_extension::install_directory(data_root).display());
        }
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
            let _state_guard = SNAPSHOT_STATE_LOCK
                .lock()
                .expect("browser snapshot state mutex");
            let previous = read_snapshot_state(artifact_root, &target.id)?;
            let snapshot = compress_ax_tree(
                &tree,
                &target.id,
                url.clone(),
                next_snapshot_ref(previous.as_ref()),
            )?;
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
            let input = BrowserPointerInput::Tap {
                x: point.0,
                y: point.1,
            };
            validate_pointer_input(&mut cdp, input)?;
            if matches!(command.action, BrowserAction::Hover) {
                cdp.call(
                    "Input.dispatchMouseEvent",
                    json!({ "type": "mouseMoved", "x": point.0, "y": point.1, "button": "none", "buttons": 0 }),
                )?;
            } else {
                show_cursor(&mut cdp, point.0, point.1, true);
                dispatch_click(
                    &mut cdp,
                    point.0,
                    point.1,
                    if matches!(command.action, BrowserAction::DoubleClick) {
                        2
                    } else {
                        1
                    },
                )?;
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
            dispatch_key(&mut cdp, key)?;
            Ok(Value::Null)
        }
        BrowserAction::Drag => {
            let from = element_center(&mut cdp, element_id(&object_id)?)?;
            let to_x = option(&command, "to-x")
                .context("--to-x is required")?
                .parse::<f64>()?;
            let to_y = option(&command, "to-y")
                .context("--to-y is required")?
                .parse::<f64>()?;
            let input = BrowserPointerInput::Drag {
                from_x: from.0,
                from_y: from.1,
                to_x,
                to_y,
            };
            validate_pointer_input(&mut cdp, input)?;
            show_cursor(&mut cdp, from.0, from.1, true);
            let result = dispatch_drag(&mut cdp, from.0, from.1, to_x, to_y);
            show_cursor(&mut cdp, to_x, to_y, false);
            result?;
            Ok(Value::Null)
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
            show_cursor(&mut cdp, x, y, event_type == "mousePressed");
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
        BrowserAction::Tabs
        | BrowserAction::Profiles
        | BrowserAction::Chrome
        | BrowserAction::NewTab => {
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

fn validate_pointer_input(cdp: &mut CdpConnection, input: BrowserPointerInput) -> Result<()> {
    input.validate()?;
    let metrics = cdp.call("Page.getLayoutMetrics", json!({}))?;
    let width = viewport_dimension(&metrics, "clientWidth")?;
    let height = viewport_dimension(&metrics, "clientHeight")?;
    input.validate_for_viewport(width, height)
}

fn dispatch_pointer_input(cdp: &mut CdpConnection, input: BrowserPointerInput) -> Result<()> {
    validate_pointer_input(cdp, input)?;
    match input {
        BrowserPointerInput::Tap { x, y } => dispatch_click(cdp, x, y, 1),
        BrowserPointerInput::Drag {
            from_x,
            from_y,
            to_x,
            to_y,
        } => dispatch_drag(cdp, from_x, from_y, to_x, to_y),
        BrowserPointerInput::Scroll {
            x,
            y,
            delta_x,
            delta_y,
        } => {
            cdp.call(
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseWheel", "x": x, "y": y, "button": "none", "buttons": 0, "deltaX": delta_x, "deltaY": delta_y }),
            )?;
            Ok(())
        }
    }
}

fn dispatch_click(
    cdp: &mut CdpConnection,
    x: f64,
    y: f64,
    click_count: u8,
) -> Result<()> {
    for count in 1..=click_count {
        let press_result = cdp.call(
            "Input.dispatchMouseEvent",
            json!({ "type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": count }),
        );
        let release_result = cdp.call(
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": count }),
        );
        press_result?;
        release_result?;
    }
    Ok(())
}

fn dispatch_drag(
    cdp: &mut CdpConnection,
    from_x: f64,
    from_y: f64,
    to_x: f64,
    to_y: f64,
) -> Result<()> {
    let press_result = cdp.call(
        "Input.dispatchMouseEvent",
        json!({ "type": "mousePressed", "x": from_x, "y": from_y, "button": "left", "buttons": 1, "clickCount": 1 }),
    );
    let move_result = cdp.call(
        "Input.dispatchMouseEvent",
        json!({ "type": "mouseMoved", "x": to_x, "y": to_y, "button": "left", "buttons": 1 }),
    );
    let release_result = cdp.call(
        "Input.dispatchMouseEvent",
        json!({ "type": "mouseReleased", "x": to_x, "y": to_y, "button": "left", "buttons": 0, "clickCount": 1 }),
    );
    press_result?;
    move_result?;
    release_result?;
    Ok(())
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
    dispatch_pointer_input(&mut cdp, input)
}

const CDP_MODIFIER_ALT: u8 = 1;
const CDP_MODIFIER_CONTROL: u8 = 2;
const CDP_MODIFIER_META: u8 = 4;
const CDP_MODIFIER_SHIFT: u8 = 8;

struct CdpKeyDefinition {
    key: String,
    code: String,
    virtual_key_code: u32,
    modifiers: u8,
}

fn dispatch_key(cdp: &mut CdpConnection, input: &str) -> Result<()> {
    let Some(key) = resolve_key_definition(input)? else {
        cdp.call("Input.insertText", json!({ "text": input }))?;
        return Ok(());
    };
    let event = |kind: &str| {
        json!({
            "type": kind,
            "key": &key.key,
            "code": &key.code,
            "windowsVirtualKeyCode": key.virtual_key_code,
            "nativeVirtualKeyCode": key.virtual_key_code,
            "modifiers": key.modifiers,
        })
    };
    let down_result = cdp.call("Input.dispatchKeyEvent", event("rawKeyDown"));
    let up_result = cdp.call("Input.dispatchKeyEvent", event("keyUp"));
    down_result?;
    up_result?;
    Ok(())
}

fn resolve_key_definition(input: &str) -> Result<Option<CdpKeyDefinition>> {
    if input.chars().count() == 1 {
        return Ok(None);
    }
    let mut parts = input.split('+').collect::<Vec<_>>();
    let name = parts.pop().unwrap_or_default();
    if name.is_empty() {
        bail!("browser key chord has no key");
    }
    let mut modifiers = 0;
    for modifier in parts {
        modifiers |= match modifier.to_ascii_lowercase().as_str() {
            "alt" | "option" => CDP_MODIFIER_ALT,
            "control" | "ctrl" => CDP_MODIFIER_CONTROL,
            "command" | "cmd" | "meta" | "win" | "windows" => CDP_MODIFIER_META,
            "shift" => CDP_MODIFIER_SHIFT,
            _ => bail!("unsupported browser key modifier: {modifier}"),
        };
    }
    let normalized = name.to_ascii_lowercase();
    let (key, code, virtual_key_code, own_modifier) = if let Some(definition) =
        named_key_definition(&normalized)
    {
        let (key, code, virtual_key_code, own_modifier) = definition;
        (
            key.to_string(),
            code.to_string(),
            virtual_key_code,
            own_modifier,
        )
    } else if let Some(number) = normalized
        .strip_prefix('f')
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|number| (1..=24).contains(number))
    {
        let key = format!("F{number}");
        (key.clone(), key, 111 + number, 0)
    } else if name.chars().count() == 1 {
        ascii_key_definition(name.chars().next().unwrap(), modifiers)
            .context("unsupported browser key chord")?
    } else {
        bail!("unsupported browser key: {name}");
    };
    Ok(Some(CdpKeyDefinition {
        key,
        code,
        virtual_key_code,
        modifiers: modifiers | own_modifier,
    }))
}

fn named_key_definition(name: &str) -> Option<(&'static str, &'static str, u32, u8)> {
    Some(match name {
        "enter" | "return" => ("Enter", "Enter", 13, 0),
        "tab" => ("Tab", "Tab", 9, 0),
        "escape" | "esc" => ("Escape", "Escape", 27, 0),
        "backspace" => ("Backspace", "Backspace", 8, 0),
        "delete" | "del" => ("Delete", "Delete", 46, 0),
        "insert" => ("Insert", "Insert", 45, 0),
        "home" => ("Home", "Home", 36, 0),
        "end" => ("End", "End", 35, 0),
        "pageup" => ("PageUp", "PageUp", 33, 0),
        "pagedown" => ("PageDown", "PageDown", 34, 0),
        "arrowleft" | "left" => ("ArrowLeft", "ArrowLeft", 37, 0),
        "arrowup" | "up" => ("ArrowUp", "ArrowUp", 38, 0),
        "arrowright" | "right" => ("ArrowRight", "ArrowRight", 39, 0),
        "arrowdown" | "down" => ("ArrowDown", "ArrowDown", 40, 0),
        "space" => (" ", "Space", 32, 0),
        "control" | "ctrl" => ("Control", "ControlLeft", 17, CDP_MODIFIER_CONTROL),
        "shift" => ("Shift", "ShiftLeft", 16, CDP_MODIFIER_SHIFT),
        "alt" | "option" => ("Alt", "AltLeft", 18, CDP_MODIFIER_ALT),
        "command" | "cmd" | "meta" | "win" | "windows" => {
            ("Meta", "MetaLeft", 91, CDP_MODIFIER_META)
        }
        _ => return None,
    })
}

fn ascii_key_definition(
    value: char,
    modifiers: u8,
) -> Option<(String, String, u32, u8)> {
    let value = value.to_ascii_lowercase();
    if value.is_ascii_alphabetic() {
        let key = if modifiers & CDP_MODIFIER_SHIFT != 0 {
            value.to_ascii_uppercase()
        } else {
            value
        };
        return Some((
            key.to_string(),
            format!("Key{}", value.to_ascii_uppercase()),
            value.to_ascii_uppercase() as u32,
            0,
        ));
    }
    if value.is_ascii_digit() {
        return Some((
            value.to_string(),
            format!("Digit{value}"),
            value as u32,
            0,
        ));
    }
    let (code, virtual_key_code) = match value {
        '-' => ("Minus", 189),
        '=' => ("Equal", 187),
        '[' => ("BracketLeft", 219),
        ']' => ("BracketRight", 221),
        '\\' => ("Backslash", 220),
        ';' => ("Semicolon", 186),
        '\'' => ("Quote", 222),
        ',' => ("Comma", 188),
        '.' => ("Period", 190),
        '/' => ("Slash", 191),
        '`' => ("Backquote", 192),
        _ => return None,
    };
    Some((
        value.to_string(),
        code.to_string(),
        virtual_key_code,
        0,
    ))
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
        BrowserKeyInput::Key { key } => dispatch_key(&mut cdp, &key)?,
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

/// `chrome` reports bridge status and lists tabs, which needs no cookie access;
/// only its profile-copy/install/unpair switches touch the signed-in profile.
/// Gating the report itself just taught agents to pass the grant reflexively.
fn required_capability(command: &ActionCommand<BrowserAction>) -> Option<BrowserRiskCapability> {
    match command.action {
        BrowserAction::Chrome => command
            .arguments
            .switches
            .iter()
            .any(|switch| matches!(switch.as_str(), "install" | "unpair" | "copy-profile"))
            .then_some(BrowserRiskCapability::Cookies),
        BrowserAction::Cookies => Some(BrowserRiskCapability::Cookies),
        BrowserAction::Storage => Some(BrowserRiskCapability::Storage),
        BrowserAction::Upload => Some(BrowserRiskCapability::Upload),
        BrowserAction::Download => Some(BrowserRiskCapability::Download),
        _ => None,
    }
}

/// Opening a tab is the extension backend's job: VibeLink's own in-pane pages
/// are created by the desktop, not the CLI. Without this an agent that wants a
/// fresh page has to either hijack a tab the user is using or shell out to
/// `chrome.exe`, which leaves the tab outside VibeLink's target list entirely.
fn open_new_tab(
    command: &ActionCommand<BrowserAction>,
    bridge: Option<&Arc<browser_extension::ExtensionBridge>>,
    artifact_root: &Path,
    scoped_workspace: Option<String>,
) -> Result<Value> {
    let url = option(command, "url")
        .or_else(|| command.arguments.positionals.first().map(String::as_str))
        .unwrap_or("about:blank");
    let Some(bridge) = bridge.filter(|bridge| bridge.status().connected) else {
        let data_root = artifact_root.parent().unwrap_or(artifact_root);
        bail!(
            "cannot open a tab: the VibeLink extension is not connected. Install it from the Chrome Web Store, or load {} once via chrome://extensions with Developer mode on, and keep Chrome running",
            browser_extension::install_directory(data_root).display()
        );
    };
    let tab = bridge.new_tab(url)?;
    if let Some(title) = option(command, "session-title") {
        // Best effort: the tab exists and is usable even when Chrome refuses to
        // group it, so a naming failure must not lose the target we just made.
        let _ = bridge.name_session(
            tab.tab_id,
            title,
            option(command, "session-color").unwrap_or("blue"),
        );
    }
    let target = browser_extension::extension_target(tab, scoped_workspace);
    Ok(json!({ "target": target_json(&target) }))
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
#[path = "browser_cdp_tests.rs"]
mod tests;
