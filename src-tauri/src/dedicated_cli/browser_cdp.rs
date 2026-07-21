use crate::{
    browser::{BrowserDeviceMetrics, BrowserPolicy, BrowserRiskCapability},
    dedicated_cli::{ActionCommand, BrowserAction},
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
struct DebugTarget {
    id: String,
    title: String,
    url: String,
    #[serde(rename = "type")]
    target_type: String,
    web_socket_debugger_url: Option<String>,
    #[serde(skip)]
    cdp_port: u16,
    #[serde(skip)]
    page_id: Option<String>,
    #[serde(skip)]
    profile_id: Option<String>,
    #[serde(skip)]
    workspace_id: Option<String>,
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
struct CdpConnection {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    next_id: u64,
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
        Ok(Self { socket, next_id: 1 })
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.socket.send(Message::Text(
            serde_json::to_string(&json!({ "id": id, "method": method, "params": params }))?.into(),
        ))?;
        loop {
            let message = self.socket.read()?;
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

    fn evaluate(&mut self, expression: &str) -> Result<Value> {
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
        if let MaybeTlsStream::Plain(stream) = self.socket.get_mut() {
            stream.set_read_timeout(Some(Duration::from_millis(100)))?;
        }
        let deadline = Instant::now() + duration;
        let mut events = Vec::new();
        let mut event_bytes = 0usize;
        while Instant::now() < deadline && events.len() < MAX_EVENTS {
            match self.socket.read() {
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
        .unwrap_or(9333);
    let registry = read_registry(artifact_root)?;
    let mut ports = vec![main_port];
    if let Some(registry) = &registry {
        ports.push(registry.main_port);
        ports.extend(registry.profiles.iter().map(|profile| profile.port));
    }
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
    if let Some(workspace_id) = scoped_workspace.as_deref() {
        targets.retain(|target| target.workspace_id.as_deref() == Some(workspace_id));
    }
    if targets.is_empty() {
        bail!("embedded browser CDP is unavailable; start VibeLink desktop");
    }
    if matches!(command.action, BrowserAction::Tabs) {
        return Ok(json!({ "targets": targets.iter().map(target_json).collect::<Vec<_>>() }));
    }
    if matches!(command.action, BrowserAction::Profiles) {
        let profiles = registry
            .map(|registry| profiles_for_workspace(registry.profiles, scoped_workspace.as_deref()))
            .unwrap_or_default();
        return Ok(json!({ "profiles": profiles }));
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
    let mut cdp = CdpConnection::open(target)?;
    let selector = option(&command, "selector");

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
            let mut tree = cdp.call("Accessibility.getFullAXTree", json!({}))?;
            let truncated = tree
                .get("nodes")
                .and_then(Value::as_array)
                .is_some_and(|nodes| nodes.len() > 5_000);
            if let Some(nodes) = tree.get_mut("nodes").and_then(Value::as_array_mut) {
                nodes.truncate(5_000);
            }
            Ok(json!({ "target": target_json(target), "tree": tree, "truncated": truncated }))
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
            let current = history.get("currentIndex").and_then(Value::as_i64).unwrap_or(0);
            let desired = current + if matches!(command.action, BrowserAction::Back) { -1 } else { 1 };
            let entry = history.get("entries").and_then(Value::as_array)
                .and_then(|entries| entries.get(desired.max(0) as usize))
                .context("no navigation history entry")?;
            cdp.call("Page.navigateToHistoryEntry", json!({ "entryId": entry.get("id").context("history entry id missing")? }))
        }
        BrowserAction::Reload => cdp.call("Page.reload", json!({ "ignoreCache": command.arguments.switches.contains("ignore-cache") })),
        BrowserAction::Wait => {
            let milliseconds = option(&command, "ms").unwrap_or("1000").parse::<u64>().context("--ms must be an unsigned integer")?;
            thread::sleep(Duration::from_millis(milliseconds.min(60_000)));
            Ok(json!({ "waitedMs": milliseconds.min(60_000) }))
        }
        BrowserAction::Click | BrowserAction::DoubleClick | BrowserAction::Hover => {
            let point = element_center(&mut cdp, selector.context("--selector is required")?)?;
            if matches!(command.action, BrowserAction::Hover) {
                cdp.call("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": point.0, "y": point.1 }))?;
            } else {
                let count = if matches!(command.action, BrowserAction::DoubleClick) { 2 } else { 1 };
                cdp.call("Input.dispatchMouseEvent", json!({ "type": "mousePressed", "x": point.0, "y": point.1, "button": "left", "clickCount": count }))?;
                cdp.call("Input.dispatchMouseEvent", json!({ "type": "mouseReleased", "x": point.0, "y": point.1, "button": "left", "clickCount": count }))?;
            }
            Ok(json!({ "x": point.0, "y": point.1 }))
        }
        BrowserAction::Fill | BrowserAction::Type => {
            let selector = selector.context("--selector is required")?;
            let text = option(&command, "text").context("--text is required")?;
            let script = format!(
                "(()=>{{const e=document.querySelector({});if(!e)throw new Error('element not found');e.focus();{}e.dispatchEvent(new Event('input',{{bubbles:true}}));e.dispatchEvent(new Event('change',{{bubbles:true}}));return true}})()",
                serde_json::to_string(selector)?,
                if matches!(command.action, BrowserAction::Fill) {
                    format!("e.value={};", serde_json::to_string(text)?)
                } else {
                    format!("e.value=(e.value||'')+{};", serde_json::to_string(text)?)
                }
            );
            cdp.evaluate(&script)
        }
        BrowserAction::Select => dom_action(&mut cdp, selector, "const v=VALUE;e.value=v;e.dispatchEvent(new Event('change',{bubbles:true}));return e.value", option(&command, "value")),
        BrowserAction::Check => dom_action(&mut cdp, selector, "e.checked=VALUE==='true';e.dispatchEvent(new Event('change',{bubbles:true}));return e.checked", Some(option(&command, "value").unwrap_or("true"))),
        BrowserAction::Focus => dom_action(&mut cdp, selector, "e.focus();return true", None),
        BrowserAction::Clear => dom_action(&mut cdp, selector, "e.value='';e.dispatchEvent(new Event('input',{bubbles:true}));return true", None),
        BrowserAction::SelectAll => dom_action(&mut cdp, selector, "e.focus();e.select();return true", None),
        BrowserAction::Keypress => {
            let key = option(&command, "key").context("--key is required")?;
            cdp.call("Input.dispatchKeyEvent", json!({ "type": "keyDown", "key": key }))?;
            cdp.call("Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": key }))
        }
        BrowserAction::Drag => {
            let from = element_center(&mut cdp, selector.context("--selector is required")?)?;
            let to_x = option(&command, "to-x").context("--to-x is required")?.parse::<f64>()?;
            let to_y = option(&command, "to-y").context("--to-y is required")?.parse::<f64>()?;
            cdp.call("Input.dispatchMouseEvent", json!({ "type": "mousePressed", "x": from.0, "y": from.1, "button": "left", "buttons": 1 }))?;
            cdp.call("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": to_x, "y": to_y, "button": "left", "buttons": 1 }))?;
            cdp.call("Input.dispatchMouseEvent", json!({ "type": "mouseReleased", "x": to_x, "y": to_y, "button": "left" }))
        }
        BrowserAction::Upload => {
            let selector = selector.context("--selector is required")?;
            let values = command
                .arguments
                .options
                .get("file")
                .context("--file is required")?;
            let files = access.upload_files(values)?;
            let document = cdp.call("DOM.getDocument", json!({ "depth": 0 }))?;
            let node_id = document
                .pointer("/root/nodeId")
                .and_then(Value::as_u64)
                .context("DOM root missing")?;
            let queried = cdp.call(
                "DOM.querySelector",
                json!({ "nodeId": node_id, "selector": selector }),
            )?;
            let file_node = queried
                .get("nodeId")
                .and_then(Value::as_u64)
                .filter(|id| *id != 0)
                .context("file input not found")?;
            cdp.call(
                "DOM.setFileInputFiles",
                json!({ "nodeId": file_node, "files": files }),
            )
        }
        BrowserAction::Scroll => {
            let x = option(&command, "x").unwrap_or("0").parse::<f64>()?;
            let y = option(&command, "y").unwrap_or("0").parse::<f64>()?;
            cdp.call("Input.dispatchMouseEvent", json!({ "type": "mouseWheel", "x": 0, "y": 0, "deltaX": x, "deltaY": y }))
        }
        BrowserAction::ScrollIntoView => dom_action(&mut cdp, selector, "e.scrollIntoView({block:'center',inline:'center'});return true", None),
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
            dom_action(
                &mut cdp,
                selector,
                &format!("return e[{}]", serde_json::to_string(property)?),
                None,
            )
        }
        BrowserAction::Is => {
            let state = option(&command, "state").unwrap_or("visible");
            let body = match state {
                "visible" => "const r=e.getBoundingClientRect();return !!(r.width&&r.height)",
                "enabled" => "return !e.disabled",
                "checked" => "return !!e.checked",
                "focused" => "return document.activeElement===e",
                _ => bail!("unsupported browser state: {state}"),
            };
            dom_action(&mut cdp, selector, body, None)
        }
        BrowserAction::Mouse => {
            let event_type = option(&command, "type").unwrap_or("mouseMoved");
            if !matches!(
                event_type,
                "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel"
            ) {
                bail!("unsupported mouse event type: {event_type}");
            }
            let x = option(&command, "x").context("--x is required")?.parse::<f64>()?;
            let y = option(&command, "y").context("--y is required")?.parse::<f64>()?;
            if !x.is_finite() || !y.is_finite() {
                bail!("mouse coordinates must be finite");
            }
            cdp.call("Input.dispatchMouseEvent", json!({ "type": event_type, "x": x, "y": y, "button": option(&command, "button").unwrap_or("none") }))
        }
        BrowserAction::Highlight => dom_action(&mut cdp, selector, "e.style.outline='3px solid #ff2d55';return true", None),
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
            let ms = option(&command, "ms").unwrap_or("1000").parse::<u64>()?.min(30_000);
            let events = cdp.collect_events(Duration::from_millis(ms))?;
            Ok(json!({ "events": events.into_iter().filter(|event| event.get("method").and_then(Value::as_str) == Some("Runtime.consoleAPICalled")).collect::<Vec<_>>() }))
        }
        BrowserAction::Network => {
            cdp.call("Network.enable", json!({}))?;
            let ms = option(&command, "ms").unwrap_or("1000").parse::<u64>()?.min(30_000);
            let events = cdp.collect_events(Duration::from_millis(ms))?;
            Ok(json!({ "events": events.into_iter().filter(|event| event.get("method").and_then(Value::as_str).is_some_and(|method| method.starts_with("Network."))).collect::<Vec<_>>() }))
        }
        BrowserAction::Tabs | BrowserAction::Profiles => unreachable!("handled before target selection"),
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
                    && !target.url.contains("localhost:1420"))
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
    })
}

fn option<'a>(command: &'a ActionCommand<BrowserAction>, name: &str) -> Option<&'a str> {
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
        BrowserAction::Cookies => Some(BrowserRiskCapability::Cookies),
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

fn valid_registry_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
}

fn element_center(cdp: &mut CdpConnection, selector: &str) -> Result<(f64, f64)> {
    let value = cdp.evaluate(&format!(
        "(()=>{{const e=document.querySelector({});if(!e)throw new Error('element not found');e.scrollIntoView({{block:'center',inline:'center'}});const r=e.getBoundingClientRect();return {{x:r.left+r.width/2,y:r.top+r.height/2}}}})()",
        serde_json::to_string(selector)?
    ))?;
    Ok((
        value
            .get("x")
            .and_then(Value::as_f64)
            .context("element x missing")?,
        value
            .get("y")
            .and_then(Value::as_f64)
            .context("element y missing")?,
    ))
}

fn dom_action(
    cdp: &mut CdpConnection,
    selector: Option<&str>,
    body: &str,
    value: Option<&str>,
) -> Result<Value> {
    let selector = selector.context("--selector is required")?;
    let body = body.replace("VALUE", &serde_json::to_string(value.unwrap_or(""))?);
    cdp.evaluate(&format!("(()=>{{const e=document.querySelector({});if(!e)throw new Error('element not found');{}}})()", serde_json::to_string(selector)?, body))
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

fn expires_at_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
        .saturating_add(15 * 60 * 1_000)
}

#[cfg(test)]
mod tests {
    use super::*;
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
        };
        let error = match CdpConnection::open(&target) {
            Ok(_) => panic!("hostile websocket URL was accepted"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("unsafe CDP websocket URL"));
    }
}
