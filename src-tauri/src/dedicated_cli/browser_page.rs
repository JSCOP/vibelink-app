//! Page interaction for the `vibelink browser` command surface: typed pointer,
//! key, viewport, and scale inputs, snapshot-scoped element refs, and the
//! conditional waits that make those actions deterministic.
//!
//! `browser_cdp` owns target discovery, the CDP registry, connections, and
//! artifacts. This module owns what happens once a page has been reached.

use super::browser_cdp::{
    now_ms, open_registered_page, option, CdpConnection, DebugTarget, MAX_INSPECT_SNAPSHOT_BYTES,
};
use crate::browser::BrowserDeviceMetrics;
use crate::dedicated_cli::{ActionCommand, BrowserAction};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant, UNIX_EPOCH},
};

pub const DEFAULT_MOBILE_VIEWPORT_WIDTH: u32 = 390;
pub const DEFAULT_MOBILE_VIEWPORT_HEIGHT: u32 = 844;
pub const DEFAULT_MOBILE_DEVICE_SCALE_FACTOR: f64 = 3.0;

pub(super) const MAX_POINTER_COORDINATE: f64 = 10_000.0;
pub(super) const MAX_SCROLL_DELTA: f64 = 10_000.0;
pub(super) const MAX_TEXT_INPUT_BYTES: usize = 16 * 1024;
pub(super) const MAX_KEY_INPUT_BYTES: usize = 64;
pub(super) const MIN_PAGE_SCALE: f64 = 0.25;
pub(super) const MAX_PAGE_SCALE: f64 = 5.0;

pub(super) const MAX_SNAPSHOT_STATE_BYTES: u64 = 4 * 1024 * 1024;
pub(super) const MAX_SNAPSHOT_REFS: usize = 2_000;
pub(super) const MAX_SNAPSHOT_STATE_FILES: usize = 256;
pub(super) const MAX_AX_NODES: usize = 5_000;
pub(super) const MAX_AX_NAME_CHARS: usize = 120;
pub(super) const MAX_WAIT_MS: u64 = 60_000;
pub(super) const DEFAULT_CONDITION_WAIT_MS: u64 = 10_000;
pub(super) const DEFAULT_IDLE_QUIET_MS: u64 = 500;
pub(super) const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(100);

// Every element operation runs as a `this`-bound function on a resolved CDP
// remote object, so a snapshot ref and a CSS selector share one execution path
// and no caller string is ever spliced into page script.
pub(super) const ELEMENT_IS_LIVE: &str =
    "function(){return !!this.isConnected&&this.ownerDocument===document}";
pub(super) const ELEMENT_CENTER: &str = "function(){if(!this.isConnected||this.ownerDocument!==document)return {live:false};this.scrollIntoView({block:'center',inline:'center'});const r=this.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;const root=this.getRootNode(),hit=(root.elementFromPoint?root:document).elementFromPoint(x,y);return {live:true,x,y,width:r.width,height:r.height,hit:!!hit&&(hit===this||this.contains(hit))}}";
// Classifies the text-input surface AND leaves the selection where the caller
// needs it. A React controlled input reverts a plain `value` assignment and a
// `contenteditable` host has no `value` at all, so the two need different
// commit paths and the element decides which one, never the user.
pub(super) const PREPARE_TEXT_INPUT: &str = "function(replace){this.focus();const tag=this.tagName;if(tag==='INPUT'||tag==='TEXTAREA')return 'value';if(this.isContentEditable){const s=(this.ownerDocument.defaultView||window).getSelection();s.selectAllChildren(this);if(!replace)s.collapseToEnd();return 'editable'}return 'unsupported'}";
pub(super) const SET_NATIVE_VALUE: &str = "function(text,append){const proto=this.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value').set;setter.call(this,append?(this.value||'')+text:text);this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return this.value}";
pub(super) const SET_SELECT_VALUE: &str = "function(value){const setter=this.tagName==='SELECT'?Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set:null;if(setter)setter.call(this,value);else this.value=value;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return this.value}";
pub(super) const SET_CHECKED: &str = "function(value){const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'checked').set;setter.call(this,value==='true');this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return this.checked}";
pub(super) const SELECT_ALL_TEXT: &str = "function(){this.focus();if(typeof this.select==='function'){this.select();return true}(this.ownerDocument.defaultView||window).getSelection().selectAllChildren(this);return true}";
// Quiet detection installs one page-side observer pair on first poll and then
// only reports how long the page has been still, so repeated polling stays a
// single boolean read.
pub(super) const IDLE_PROBE: &str = "(quiet=>{const k='__vibelinkWaitIdle';let s=window[k];if(!s){s=window[k]={at:Date.now()};const touch=()=>{s.at=Date.now()};new MutationObserver(touch).observe(document,{subtree:true,childList:true,attributes:true,characterData:true});try{new PerformanceObserver(touch).observe({type:'resource',buffered:false})}catch(e){}}return document.readyState==='complete'&&Date.now()-s.at>=quiet})";
// A pointer the user can follow while an agent drives their browser. Without
// it a remotely controlled page moves on its own with no indication of what was
// touched. Purely decorative: `pointer-events:none`, aria-hidden, and it
// removes itself once the agent stops acting.
pub(super) const CURSOR_OVERLAY: &str = "((x,y,click)=>{const id='__vibelinkCursor';let el=document.getElementById(id);const host=document.body||document.documentElement;if(!host)return false;if(!el){el=document.createElement('div');el.id=id;el.setAttribute('aria-hidden','true');el.style.cssText='position:fixed;left:0;top:0;width:22px;height:22px;margin:-3px 0 0 -3px;z-index:2147483647;pointer-events:none;transition:transform .18s cubic-bezier(.22,.61,.36,1);will-change:transform;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))';el.innerHTML='<svg width=\"22\" height=\"22\" viewBox=\"0 0 22 22\"><path d=\"M3 2l14 7-6 1.6L8.6 17z\" fill=\"#ff2d55\" stroke=\"#fff\" stroke-width=\"1.4\" stroke-linejoin=\"round\"/></svg>';host.appendChild(el)}el.style.transform='translate('+x+'px,'+y+'px)';clearTimeout(el.__vibelinkIdle);el.__vibelinkIdle=setTimeout(()=>el.remove(),5000);if(click){const ring=document.createElement('div');ring.setAttribute('aria-hidden','true');ring.style.cssText='position:fixed;left:'+x+'px;top:'+y+'px;width:16px;height:16px;margin:-8px 0 0 -8px;border:2px solid #ff2d55;border-radius:50%;z-index:2147483646;pointer-events:none;opacity:.9;transition:transform .4s ease-out,opacity .4s ease-out';host.appendChild(ring);requestAnimationFrame(()=>{ring.style.transform='scale(2.6)';ring.style.opacity='0'});setTimeout(()=>ring.remove(),450)}return true})";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserJpegCaptureOptions {
    pub quality: u8,
}

impl Default for BrowserJpegCaptureOptions {
    fn default() -> Self {
        Self { quality: 80 }
    }
}

impl BrowserJpegCaptureOptions {
    pub(super) fn validate(self) -> Result<()> {
        if !(1..=100).contains(&self.quality) {
            bail!("browser JPEG quality must be between 1 and 100");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserJpegFrame {
    pub bytes: Vec<u8>,
    pub viewport_width: u32,
    pub viewport_height: u32,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInspectSnapshot {
    pub snapshot_json: String,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum BrowserPointerInput {
    Tap {
        x: f64,
        y: f64,
    },
    Drag {
        from_x: f64,
        from_y: f64,
        to_x: f64,
        to_y: f64,
    },
    Scroll {
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
    },
}

impl BrowserPointerInput {
    pub(super) fn validate(self) -> Result<()> {
        let valid_coordinate =
            |value: f64| value.is_finite() && (0.0..=MAX_POINTER_COORDINATE).contains(&value);
        let valid_delta = |value: f64| value.is_finite() && value.abs() <= MAX_SCROLL_DELTA;
        match self {
            Self::Tap { x, y } => {
                if !valid_coordinate(x) || !valid_coordinate(y) {
                    bail!("browser pointer coordinates are out of bounds");
                }
            }
            Self::Drag {
                from_x,
                from_y,
                to_x,
                to_y,
            } => {
                if !valid_coordinate(from_x)
                    || !valid_coordinate(from_y)
                    || !valid_coordinate(to_x)
                    || !valid_coordinate(to_y)
                {
                    bail!("browser pointer coordinates are out of bounds");
                }
            }
            Self::Scroll {
                x,
                y,
                delta_x,
                delta_y,
            } => {
                if !valid_coordinate(x)
                    || !valid_coordinate(y)
                    || !valid_delta(delta_x)
                    || !valid_delta(delta_y)
                    || (delta_x == 0.0 && delta_y == 0.0)
                {
                    bail!("browser scroll input is out of bounds");
                }
            }
        }
        Ok(())
    }

    pub(super) fn validate_for_viewport(self, width: u32, height: u32) -> Result<()> {
        self.validate()?;
        let contains = |x: f64, y: f64| x < f64::from(width) && y < f64::from(height);
        let inside = match self {
            Self::Tap { x, y } | Self::Scroll { x, y, .. } => contains(x, y),
            Self::Drag {
                from_x,
                from_y,
                to_x,
                to_y,
            } => contains(from_x, from_y) && contains(to_x, to_y),
        };
        if !inside {
            bail!("browser pointer coordinates exceed the CSS viewport");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum BrowserKeyInput {
    Text { text: String },
    Key { key: String },
}

impl BrowserKeyInput {
    pub(super) fn validate(&self) -> Result<()> {
        match self {
            Self::Text { text } => {
                if text.is_empty()
                    || text.len() > MAX_TEXT_INPUT_BYTES
                    || text.chars().any(|character| character == '\0')
                {
                    bail!("browser text input is empty or exceeds the bounded size");
                }
            }
            Self::Key { key } => {
                if key.is_empty()
                    || key.len() > MAX_KEY_INPUT_BYTES
                    || key.chars().any(char::is_control)
                {
                    bail!("browser key input is invalid or exceeds the bounded size");
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
pub enum BrowserViewport {
    Web,
    Mobile {
        width: u32,
        height: u32,
        device_scale_factor: f64,
    },
}

impl BrowserViewport {
    /// The same bounded 390x844 CSS-pixel, 3x-density phone projection used by
    /// the embedded browser UI. Pointer mapping remains in CSS viewport units.
    pub fn mobile_default() -> Self {
        Self::Mobile {
            width: DEFAULT_MOBILE_VIEWPORT_WIDTH,
            height: DEFAULT_MOBILE_VIEWPORT_HEIGHT,
            device_scale_factor: DEFAULT_MOBILE_DEVICE_SCALE_FACTOR,
        }
    }

    pub(super) fn device_metrics(self) -> Result<Option<BrowserDeviceMetrics>> {
        match self {
            Self::Web => Ok(None),
            Self::Mobile {
                width,
                height,
                device_scale_factor,
            } => {
                let metrics = BrowserDeviceMetrics {
                    width,
                    height,
                    device_scale_factor,
                    mobile: true,
                };
                if !metrics.validate() {
                    bail!("invalid mobile browser viewport");
                }
                Ok(Some(metrics))
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserPageScale {
    pub scale: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center_y: Option<f64>,
}

impl BrowserPageScale {
    pub(crate) fn validate(self) -> Result<()> {
        if !self.scale.is_finite() || !(MIN_PAGE_SCALE..=MAX_PAGE_SCALE).contains(&self.scale) {
            bail!("browser page scale must be finite and between 0.25 and 5");
        }
        match (self.center_x, self.center_y) {
            (None, None) => {}
            (Some(x), Some(y))
                if x.is_finite()
                    && y.is_finite()
                    && (0.0..=MAX_POINTER_COORDINATE).contains(&x)
                    && (0.0..=MAX_POINTER_COORDINATE).contains(&y) => {}
            (Some(_), Some(_)) => bail!("browser page scale center is out of bounds"),
            _ => bail!("browser page scale center requires both centerX and centerY"),
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SnapshotRef {
    #[serde(rename = "ref")]
    pub(super) reference: String,
    pub(super) backend_node_id: u64,
    pub(super) role: String,
    pub(super) name: String,
}

/// One snapshot generation, persisted per page target. The CLI is a one-shot
/// process, so refs only survive between commands if the generation does.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SnapshotState {
    pub(super) version: u8,
    pub(super) generation: String,
    #[serde(default = "first_snapshot_ref")]
    pub(super) next_ref: u64,
    pub(super) target_id: String,
    pub(super) url: String,
    pub(super) captured_at_ms: u64,
    pub(super) refs: Vec<SnapshotRef>,
}

fn first_snapshot_ref() -> u64 {
    1
}

pub(super) struct CompressedSnapshot {
    pub(super) state: SnapshotState,
    pub(super) tree: String,
    pub(super) truncated: bool,
}

pub fn inspect(
    registry_path: &Path,
    page_id: &str,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<BrowserInspectSnapshot> {
    let point = match (x, y) {
        (None, None) => None,
        (Some(x), Some(y))
            if x.is_finite()
                && y.is_finite()
                && (0.0..=MAX_POINTER_COORDINATE).contains(&x)
                && (0.0..=MAX_POINTER_COORDINATE).contains(&y) =>
        {
            Some((x, y))
        }
        (Some(_), Some(_)) => bail!("browser inspect coordinates are out of bounds"),
        _ => bail!("browser inspect requires both x and y"),
    };
    let mut cdp = open_registered_page(registry_path, page_id)?;
    let snapshot = if let Some((x, y)) = point {
        cdp.call("DOM.enable", json!({}))?;
        cdp.call("Accessibility.enable", json!({}))?;
        let location = cdp.call(
            "DOM.getNodeForLocation",
            json!({
                "x": x,
                "y": y,
                "includeUserAgentShadowDOM": true,
                "ignorePointerEventsNone": false,
            }),
        )?;
        let backend_node_id = location
            .get("backendNodeId")
            .and_then(Value::as_u64)
            .context("browser inspect target has no backend node id")?;
        let dom = cdp.call(
            "DOM.describeNode",
            json!({ "backendNodeId": backend_node_id, "depth": 2, "pierce": true }),
        )?;
        let accessibility = cdp.call(
            "Accessibility.getPartialAXTree",
            json!({ "backendNodeId": backend_node_id, "fetchRelatives": true }),
        )?;
        json!({ "point": { "x": x, "y": y }, "dom": dom, "accessibility": accessibility })
    } else {
        cdp.call("Accessibility.enable", json!({}))?;
        cdp.call("Accessibility.getFullAXTree", json!({}))?
    };
    bounded_snapshot_json(snapshot)
}

pub(super) fn bounded_snapshot_json(mut snapshot: Value) -> Result<BrowserInspectSnapshot> {
    let mut truncated = false;
    if let Some(nodes) = inspect_nodes_mut(&mut snapshot) {
        if nodes.len() > MAX_AX_NODES {
            nodes.truncate(MAX_AX_NODES);
            truncated = true;
        }
    }
    loop {
        let snapshot_json = serde_json::to_string(&snapshot)?;
        if snapshot_json.len() <= MAX_INSPECT_SNAPSHOT_BYTES {
            return Ok(BrowserInspectSnapshot {
                snapshot_json,
                truncated,
            });
        }
        let Some(nodes) = inspect_nodes_mut(&mut snapshot) else {
            bail!("browser inspect snapshot exceeds the bounded size");
        };
        if nodes.is_empty() {
            bail!("browser inspect snapshot metadata exceeds the bounded size");
        }
        truncated = true;
        let keep = nodes.len().saturating_mul(3) / 4;
        nodes.truncate(keep);
    }
}

pub(super) fn inspect_nodes_mut(snapshot: &mut Value) -> Option<&mut Vec<Value>> {
    if snapshot.get("nodes").and_then(Value::as_array).is_some() {
        return snapshot.get_mut("nodes").and_then(Value::as_array_mut);
    }
    snapshot
        .get_mut("accessibility")
        .and_then(|value| value.get_mut("nodes"))
        .and_then(Value::as_array_mut)
}

pub(super) enum ElementTarget {
    Selector(String),
    Ref(String),
}

pub(super) fn action_takes_element(action: BrowserAction) -> bool {
    matches!(
        action,
        BrowserAction::Click
            | BrowserAction::DoubleClick
            | BrowserAction::Hover
            | BrowserAction::Fill
            | BrowserAction::Type
            | BrowserAction::Select
            | BrowserAction::Check
            | BrowserAction::Focus
            | BrowserAction::Clear
            | BrowserAction::SelectAll
            | BrowserAction::Drag
            | BrowserAction::Upload
            | BrowserAction::ScrollIntoView
            | BrowserAction::Get
            | BrowserAction::Is
            | BrowserAction::Highlight
    )
}

pub(super) fn element_target(
    command: &ActionCommand<BrowserAction>,
) -> Result<Option<ElementTarget>> {
    if !action_takes_element(command.action) {
        return Ok(None);
    }
    match (option(command, "ref"), option(command, "selector")) {
        (Some(_), Some(_)) => bail!("invalid element target: pass --ref or --selector, not both"),
        (Some(reference), None) => Ok(Some(ElementTarget::Ref(reference.to_string()))),
        (None, Some(selector)) => Ok(Some(ElementTarget::Selector(selector.to_string()))),
        (None, None) => bail!("--ref or --selector is required"),
    }
}

pub(super) fn element_id(object_id: &Option<String>) -> Result<&str> {
    object_id
        .as_deref()
        .context("--ref or --selector is required")
}

/// Resolves either targeting mode to one CDP remote object id. A ref is bound
/// to the snapshot generation that issued it: a navigation, an unknown entry,
/// or a detached backend node all fail as `stale_ref` instead of silently
/// acting on whatever now occupies that position.
pub(super) fn resolve_element(
    cdp: &mut CdpConnection,
    artifact_root: &Path,
    target: &DebugTarget,
    element: &ElementTarget,
) -> Result<String> {
    match element {
        ElementTarget::Selector(selector) => {
            let result = cdp.call(
                "Runtime.evaluate",
                json!({
                    "expression": format!("document.querySelector({})", serde_json::to_string(selector)?),
                    "returnByValue": false,
                }),
            )?;
            if let Some(exception) = result.get("exceptionDetails") {
                bail!("invalid browser selector {selector}: {exception}");
            }
            result
                .pointer("/result/objectId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .with_context(|| format!("browser element not found for selector: {selector}"))
        }
        ElementTarget::Ref(reference) => {
            let state = read_snapshot_state(artifact_root, &target.id)?.context(
                "stale_ref: this page has no snapshot generation yet; capture a snapshot first",
            )?;
            let current = current_page_url(cdp)?;
            if state.url != current {
                bail!(
                    "stale_ref: the page navigated since snapshot {}; capture a new snapshot",
                    state.generation
                );
            }
            let entry = snapshot_ref(&state, reference)?;
            let resolved = match cdp.call(
                "DOM.resolveNode",
                json!({ "backendNodeId": entry.backend_node_id }),
            ) {
                Ok(resolved) => resolved,
                Err(error) if is_stale_node_error(&error) => bail!(
                    "stale_ref: {reference} no longer resolves to a live node; capture a new snapshot"
                ),
                Err(error) => return Err(error.context("resolve browser snapshot node")),
            };
            let object_id = resolved
                .pointer("/object/objectId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .context("stale_ref: the resolved node carried no object id")?;
            let live = match call_on(cdp, &object_id, ELEMENT_IS_LIVE, Vec::new()) {
                Ok(live) => live,
                Err(error) if is_stale_node_error(&error) => bail!(
                    "stale_ref: {reference} detached after resolution; capture a new snapshot"
                ),
                Err(error) => return Err(error),
            };
            if live != Value::Bool(true) {
                bail!("stale_ref: {reference} is detached from the current document; capture a new snapshot");
            }
            Ok(object_id)
        }
    }
}

fn snapshot_ref<'a>(state: &'a SnapshotState, reference: &str) -> Result<&'a SnapshotRef> {
    state
        .refs
        .iter()
        .find(|entry| entry.reference == reference)
        .with_context(|| {
            format!(
                "stale_ref: {reference} does not belong to snapshot {}",
                state.generation
            )
        })
}

fn is_stale_node_error(error: &anyhow::Error) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    [
        "could not find node with given id",
        "no node with given id",
        "no node with given backend",
        "node with given id does not belong to the document",
        "could not find object with given id",
        "cannot find object with id",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

pub(super) fn call_on(
    cdp: &mut CdpConnection,
    object_id: &str,
    declaration: &str,
    arguments: Vec<Value>,
) -> Result<Value> {
    let result = cdp.call(
        "Runtime.callFunctionOn",
        json!({
            "objectId": object_id,
            "functionDeclaration": declaration,
            "arguments": arguments,
            "returnByValue": true,
            "awaitPromise": true,
            "userGesture": true,
        }),
    )?;
    if let Some(exception) = result.get("exceptionDetails") {
        bail!("browser element script failed: {exception}");
    }
    Ok(result
        .pointer("/result/value")
        .cloned()
        .unwrap_or(Value::Null))
}

pub(super) fn element_action(
    cdp: &mut CdpConnection,
    object_id: &str,
    declaration: &str,
    value: Option<&str>,
) -> Result<Value> {
    let arguments = value
        .map(|value| vec![json!({ "value": value })])
        .unwrap_or_default();
    call_on(cdp, object_id, declaration, arguments)
}

/// Best effort by design: a page that refuses the overlay (CSP, a detached
/// document, an about: page) must never fail the action the user asked for.
pub(super) fn show_cursor(cdp: &mut CdpConnection, x: f64, y: f64, click: bool) {
    let _ = cdp.call(
        "Runtime.evaluate",
        json!({
            "expression": format!("{CURSOR_OVERLAY}({x},{y},{click})"),
            "returnByValue": true,
        }),
    );
}

pub(super) fn element_center(cdp: &mut CdpConnection, object_id: &str) -> Result<(f64, f64)> {
    let value = match call_on(cdp, object_id, ELEMENT_CENTER, Vec::new()) {
        Ok(value) => value,
        Err(error) if is_stale_node_error(&error) => {
            bail!("stale_ref: browser element detached before pointer dispatch")
        }
        Err(error) => return Err(error),
    };
    let point = (
        value.get("x").and_then(Value::as_f64).unwrap_or(f64::NAN),
        value.get("y").and_then(Value::as_f64).unwrap_or(f64::NAN),
    );
    let width = value.get("width").and_then(Value::as_f64).unwrap_or(0.0);
    let height = value.get("height").and_then(Value::as_f64).unwrap_or(0.0);
    if value.get("live").and_then(Value::as_bool) != Some(true)
        || value.get("hit").and_then(Value::as_bool) != Some(true)
        || !point.0.is_finite()
        || !point.1.is_finite()
        || width <= 0.0
        || height <= 0.0
    {
        bail!("stale_ref: browser element is detached, has no visible bounds, or is obscured at its center")
    }
    show_cursor(cdp, point.0, point.1, false);
    Ok(point)
}

pub(super) fn clear_element(cdp: &mut CdpConnection, object_id: &str) -> Result<Value> {
    let mode = call_on(
        cdp,
        object_id,
        PREPARE_TEXT_INPUT,
        vec![json!({ "value": true })],
    )?;
    match mode.as_str() {
        Some("value") => {
            let value = call_on(
                cdp,
                object_id,
                SET_NATIVE_VALUE,
                vec![json!({ "value": "" }), json!({ "value": false })],
            )?;
            Ok(json!({ "mode": "value", "value": value }))
        }
        Some("editable") => {
            for phase in ["keyDown", "keyUp"] {
                cdp.call(
                    "Input.dispatchKeyEvent",
                    json!({
                        "type": phase,
                        "key": "Delete",
                        "code": "Delete",
                        "windowsVirtualKeyCode": 46,
                        "nativeVirtualKeyCode": 46,
                    }),
                )?;
            }
            Ok(json!({ "mode": "editable" }))
        }
        _ => bail!("browser element does not accept text input"),
    }
}

pub(super) fn current_page_url(cdp: &mut CdpConnection) -> Result<String> {
    Ok(cdp
        .evaluate("location.href")?
        .as_str()
        .unwrap_or_default()
        .to_string())
}

/// Waits for an observable page condition. `sleep` keeps the historical fixed
/// interval; every other condition polls a single boolean expression so a fast
/// page returns immediately and a stuck one fails at a bounded deadline.
pub(super) fn wait_for_condition(
    cdp: &mut CdpConnection,
    command: &ActionCommand<BrowserAction>,
) -> Result<Value> {
    let condition = option(command, "for").unwrap_or("sleep");
    let requested = option(command, "ms")
        .map(str::parse::<u64>)
        .transpose()
        .context("--ms must be an unsigned integer")?;
    if condition == "sleep" {
        let milliseconds = requested.unwrap_or(1_000).min(MAX_WAIT_MS);
        thread::sleep(Duration::from_millis(milliseconds));
        return Ok(json!({ "for": "sleep", "waitedMs": milliseconds }));
    }
    let timeout_ms = requested
        .unwrap_or(DEFAULT_CONDITION_WAIT_MS)
        .min(MAX_WAIT_MS);
    let expression = wait_expression(condition, command)?;
    let started = Instant::now();
    let deadline = started + Duration::from_millis(timeout_ms);
    loop {
        let now = Instant::now();
        if now >= deadline {
            bail!("browser wait for '{condition}' timed out after {timeout_ms}ms");
        }
        let result =
            cdp.evaluate_with_timeout(&expression, deadline.saturating_duration_since(now));
        let finished = Instant::now();
        match result {
            Ok(Value::Bool(true)) if finished <= deadline => {
                return Ok(json!({
                    "for": condition,
                    "waitedMs": started.elapsed().as_millis() as u64,
                }));
            }
            Ok(_) if finished >= deadline => {
                bail!("browser wait for '{condition}' timed out after {timeout_ms}ms");
            }
            Ok(_) => {}
            Err(_) if finished >= deadline => {
                bail!("browser wait for '{condition}' timed out after {timeout_ms}ms");
            }
            Err(error) => return Err(error),
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            bail!("browser wait for '{condition}' timed out after {timeout_ms}ms");
        }
        thread::sleep(WAIT_POLL_INTERVAL.min(remaining));
    }
}

pub(super) fn wait_expression(
    condition: &str,
    command: &ActionCommand<BrowserAction>,
) -> Result<String> {
    let selector = || -> Result<String> {
        Ok(serde_json::to_string(
            option(command, "selector").context("--selector is required")?,
        )?)
    };
    Ok(match condition {
        "selector" => format!(
            "(()=>{{const e=document.querySelector({});if(!e)return false;const r=e.getBoundingClientRect();return !!(r.width&&r.height)}})()",
            selector()?
        ),
        "no-selector" => format!(
            "(()=>{{const e=document.querySelector({});if(!e)return true;const r=e.getBoundingClientRect();return !(r.width&&r.height)}})()",
            selector()?
        ),
        "load" => "document.readyState==='complete'".to_string(),
        "url" => format!(
            "location.href.includes({})",
            serde_json::to_string(option(command, "url").context("--url is required")?)?
        ),
        "idle" => {
            let quiet = option(command, "quiet-ms")
                .map(str::parse::<u64>)
                .transpose()
                .context("--quiet-ms must be an unsigned integer")?
                .unwrap_or(DEFAULT_IDLE_QUIET_MS)
                .clamp(50, MAX_WAIT_MS);
            format!("{IDLE_PROBE}({quiet})")
        }
        other => bail!("unsupported wait condition: {other}"),
    })
}

/// Turns the raw accessibility tree into indented `eN role "name"` lines plus
/// the ref table that backs them. The raw tree is large and not directly
/// actionable; this is what an agent can read and act on in one step.
pub(super) fn next_snapshot_ref(state: Option<&SnapshotState>) -> u64 {
    let Some(state) = state else {
        return first_snapshot_ref();
    };
    let refs_next = state
        .refs
        .iter()
        .filter_map(|entry| entry.reference.strip_prefix('e')?.parse::<u64>().ok())
        .max()
        .map(|value| value.saturating_add(1))
        .unwrap_or_else(first_snapshot_ref);
    state.next_ref.max(refs_next).max(first_snapshot_ref())
}

/// Roles an agent can actually act on. Measured on a real YouTube page, only
/// 37% of 646 refs were actionable and 251 were bare `StaticText`, so a caller
/// that just needs somewhere to click pays for two thirds it cannot use.
/// `interactive_only` drops the rest; the default stays full because reading
/// page content is the other half of what snapshots are for.
pub(super) const INTERACTIVE_AX_ROLES: &[&str] = &[
    "button",
    "checkbox",
    "combobox",
    "link",
    "listbox",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "textbox",
    "treeitem",
];

pub(super) fn compress_ax_tree(
    tree: &Value,
    target_id: &str,
    url: String,
    first_ref: u64,
    interactive_only: bool,
) -> Result<CompressedSnapshot> {
    let nodes = tree
        .get("nodes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let bounded_nodes = &nodes[..nodes.len().min(MAX_AX_NODES)];
    let depths = ax_depths(bounded_nodes);
    let mut refs = Vec::new();
    let mut lines = Vec::new();
    let mut truncated = nodes.len() > bounded_nodes.len();
    let first_ref = first_ref.max(first_snapshot_ref());
    for node in bounded_nodes {
        if node
            .get("ignored")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        let role = node
            .pointer("/role/value")
            .and_then(Value::as_str)
            .unwrap_or_default();
        // Layout-only roles are dropped, except an editable host: a
        // `contenteditable` composer reports role `generic` and is exactly the
        // element an agent must be able to address. The document root is never
        // an action target.
        let editable = ax_flag(node, "editable");
        if role.is_empty()
            || role == "RootWebArea"
            || (!editable && matches!(role, "none" | "presentation" | "generic" | "InlineTextBox"))
        {
            continue;
        }
        if interactive_only && !editable && !INTERACTIVE_AX_ROLES.contains(&role) {
            continue;
        }
        let Some(backend_node_id) = node.get("backendDOMNodeId").and_then(Value::as_u64) else {
            continue;
        };
        if refs.len() >= MAX_SNAPSHOT_REFS {
            truncated = true;
            break;
        }
        let name = bounded_ax_name(
            node.pointer("/name/value")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        let ref_index = first_ref
            .checked_add(refs.len() as u64)
            .context("browser snapshot ref counter is exhausted")?;
        let reference = format!("e{ref_index}");
        let depth = node
            .get("nodeId")
            .and_then(Value::as_str)
            .and_then(|id| depths.get(id))
            .copied()
            .unwrap_or(0);
        lines.push(format!(
            "{}{reference} {role}{}{}",
            "  ".repeat(depth.min(24)),
            if name.is_empty() {
                String::new()
            } else {
                format!(" {name:?}")
            },
            if editable { " [editable]" } else { "" }
        ));
        refs.push(SnapshotRef {
            reference,
            backend_node_id,
            role: role.to_string(),
            name,
        });
    }
    let next_ref = first_ref
        .checked_add(refs.len() as u64)
        .context("browser snapshot ref counter is exhausted")?;
    let captured_at_ms = now_ms();
    Ok(CompressedSnapshot {
        state: SnapshotState {
            version: 1,
            generation: format!("s{captured_at_ms}"),
            next_ref,
            target_id: target_id.to_string(),
            url,
            captured_at_ms,
            refs,
        },
        tree: lines.join("\n"),
        truncated,
    })
}

fn ax_flag(node: &Value, name: &str) -> bool {
    node.get("properties")
        .and_then(Value::as_array)
        .is_some_and(|properties| {
            properties.iter().any(|property| {
                property.get("name").and_then(Value::as_str) == Some(name)
                    && !matches!(
                        property.pointer("/value/value"),
                        None | Some(Value::Bool(false)) | Some(Value::Null)
                    )
            })
        })
}

pub(super) fn ax_depths(nodes: &[Value]) -> HashMap<&str, usize> {
    let mut parents = HashMap::new();
    for node in nodes {
        if let (Some(id), Some(parent)) = (
            node.get("nodeId").and_then(Value::as_str),
            node.get("parentId").and_then(Value::as_str),
        ) {
            parents.insert(id, parent);
        }
    }
    let mut depths = HashMap::with_capacity(nodes.len());
    for node in nodes {
        let Some(id) = node.get("nodeId").and_then(Value::as_str) else {
            continue;
        };
        let mut depth = 0usize;
        let mut cursor = id;
        while let Some(parent) = parents.get(cursor) {
            depth += 1;
            if depth > 64 {
                break;
            }
            cursor = parent;
        }
        depths.insert(id, depth);
    }
    depths
}

pub(super) fn bounded_ax_name(name: &str) -> String {
    let collapsed = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > MAX_AX_NAME_CHARS {
        return collapsed.chars().take(MAX_AX_NAME_CHARS).collect();
    }
    collapsed
}

pub(super) fn snapshot_state_path(artifact_root: &Path, target_id: &str) -> PathBuf {
    let mut stem = target_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(96)
        .collect::<String>();
    if stem.is_empty() {
        stem.push('_');
    }
    artifact_root.join("snapshots").join(format!("{stem}.json"))
}

pub(super) fn write_snapshot_state(artifact_root: &Path, state: &SnapshotState) -> Result<()> {
    let bytes = serde_json::to_vec(state)?;
    if bytes.len() as u64 > MAX_SNAPSHOT_STATE_BYTES {
        bail!("browser snapshot state exceeds the bounded size");
    }
    let path = snapshot_state_path(artifact_root, &state.target_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, bytes)?;
    if let Some(parent) = path.parent() {
        prune_snapshot_states(parent, &path)?;
    }
    Ok(())
}

fn prune_snapshot_states(directory: &Path, current: &Path) -> Result<()> {
    let mut states = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let metadata = entry.metadata()?;
        if !metadata.is_file() {
            continue;
        }
        if path != current && metadata.len() > MAX_SNAPSHOT_STATE_BYTES {
            fs::remove_file(path)?;
            continue;
        }
        states.push((
            path == current,
            metadata.modified().unwrap_or(UNIX_EPOCH),
            path,
        ));
    }
    if states.len() <= MAX_SNAPSHOT_STATE_FILES {
        return Ok(());
    }
    states.sort_by_key(|(is_current, modified, _)| (*is_current, *modified));
    let remove = states.len() - MAX_SNAPSHOT_STATE_FILES;
    for (_, _, path) in states.into_iter().take(remove) {
        fs::remove_file(path)?;
    }
    Ok(())
}

pub(super) fn read_snapshot_state(
    artifact_root: &Path,
    target_id: &str,
) -> Result<Option<SnapshotState>> {
    let path = snapshot_state_path(artifact_root, target_id);
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if metadata.len() > MAX_SNAPSHOT_STATE_BYTES {
        fs::remove_file(path).context("remove oversized browser snapshot state")?;
        return Ok(None);
    }
    let state = serde_json::from_slice::<SnapshotState>(&fs::read(&path)?)
        .context("parse browser snapshot state")?;
    Ok((state.version == 1).then_some(state))
}

#[cfg(test)]
#[path = "browser_page_tests.rs"]
mod tests;
