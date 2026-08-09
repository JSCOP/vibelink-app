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
    time::{Duration, Instant},
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
pub(super) const MAX_AX_NODES: usize = 5_000;
pub(super) const MAX_AX_NAME_CHARS: usize = 120;
pub(super) const MAX_WAIT_MS: u64 = 60_000;
pub(super) const DEFAULT_CONDITION_WAIT_MS: u64 = 10_000;
pub(super) const DEFAULT_IDLE_QUIET_MS: u64 = 500;
pub(super) const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(100);

// Every element operation runs as a `this`-bound function on a resolved CDP
// remote object, so a snapshot ref and a CSS selector share one execution path
// and no caller string is ever spliced into page script.
pub(super) const ELEMENT_CENTER: &str = "function(){this.scrollIntoView({block:'center',inline:'center'});const r=this.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}}";
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
    pub(super) target_id: String,
    pub(super) url: String,
    pub(super) captured_at_ms: u64,
    pub(super) refs: Vec<SnapshotRef>,
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
            let entry = state
                .refs
                .iter()
                .find(|entry| entry.reference == *reference)
                .with_context(|| {
                    format!(
                        "stale_ref: {reference} does not belong to snapshot {}",
                        state.generation
                    )
                })?;
            let resolved = cdp
                .call(
                    "DOM.resolveNode",
                    json!({ "backendNodeId": entry.backend_node_id }),
                )
                .map_err(|_| {
                    anyhow::anyhow!(
                        "stale_ref: {reference} no longer resolves to a live node; capture a new snapshot"
                    )
                })?;
            resolved
                .pointer("/object/objectId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .context("stale_ref: the resolved node carried no object id")
        }
    }
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
    let value = call_on(cdp, object_id, ELEMENT_CENTER, Vec::new())?;
    let point = (
        value
            .get("x")
            .and_then(Value::as_f64)
            .context("element x missing")?,
        value
            .get("y")
            .and_then(Value::as_f64)
            .context("element y missing")?,
    );
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
        if cdp.evaluate(&expression)? == Value::Bool(true) {
            return Ok(json!({
                "for": condition,
                "waitedMs": started.elapsed().as_millis() as u64,
            }));
        }
        if Instant::now() >= deadline {
            bail!("browser wait for '{condition}' timed out after {timeout_ms}ms");
        }
        thread::sleep(WAIT_POLL_INTERVAL);
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
pub(super) fn compress_ax_tree(tree: &Value, target_id: &str, url: String) -> CompressedSnapshot {
    let empty = Vec::new();
    let nodes = tree
        .get("nodes")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let depths = ax_depths(nodes);
    let mut refs = Vec::new();
    let mut lines = Vec::new();
    let mut truncated = nodes.len() > MAX_AX_NODES;
    for node in nodes.iter().take(MAX_AX_NODES) {
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
        let reference = format!("e{}", refs.len() + 1);
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
    let captured_at_ms = now_ms();
    CompressedSnapshot {
        state: SnapshotState {
            version: 1,
            generation: format!("s{captured_at_ms}"),
            target_id: target_id.to_string(),
            url,
            captured_at_ms,
            refs,
        },
        tree: lines.join("\n"),
        truncated,
    }
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
    let path = snapshot_state_path(artifact_root, &state.target_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec(state)?)?;
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
        bail!("browser snapshot state exceeds the bounded size");
    }
    Ok(serde_json::from_slice::<SnapshotState>(&fs::read(&path)?)
        .ok()
        .filter(|state| state.version == 1))
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
        std::env::temp_dir().join(format!("vibelink-browser-page-{label}-{}", Uuid::new_v4()))
    }

    fn element_command(
        action: BrowserAction,
        options: &[(&'static str, &str)],
    ) -> ActionCommand<BrowserAction> {
        command(
            action,
            options
                .iter()
                .map(|(name, value)| (*name, vec![(*value).to_string()]))
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn element_target_requires_exactly_one_targeting_mode() {
        assert!(
            element_target(&element_command(BrowserAction::Snapshot, &[]))
                .unwrap()
                .is_none()
        );
        assert!(matches!(
            element_target(&element_command(BrowserAction::Click, &[("ref", "e4")])).unwrap(),
            Some(ElementTarget::Ref(reference)) if reference == "e4"
        ));
        assert!(matches!(
            element_target(&element_command(BrowserAction::Click, &[("selector", "#save")]))
                .unwrap(),
            Some(ElementTarget::Selector(selector)) if selector == "#save"
        ));
        assert!(element_target(&element_command(
            BrowserAction::Click,
            &[("ref", "e4"), ("selector", "#save")]
        ))
        .is_err());
        assert!(element_target(&element_command(BrowserAction::Click, &[])).is_err());
    }

    #[test]
    fn snapshot_refs_survive_between_commands() {
        let root = temp_root("snapshot");
        let state = SnapshotState {
            version: 1,
            generation: "s1".to_string(),
            target_id: "TARGET/1".to_string(),
            url: "https://example.test/a".to_string(),
            captured_at_ms: 1,
            refs: vec![SnapshotRef {
                reference: "e1".to_string(),
                backend_node_id: 42,
                role: "button".to_string(),
                name: "Save".to_string(),
            }],
        };
        write_snapshot_state(&root, &state).expect("write snapshot state");
        let restored = read_snapshot_state(&root, "TARGET/1")
            .expect("read snapshot state")
            .expect("snapshot state present");
        assert_eq!(restored.url, state.url);
        assert_eq!(restored.refs[0].backend_node_id, 42);
        assert!(read_snapshot_state(&root, "OTHER").unwrap().is_none());
        assert_eq!(
            snapshot_state_path(&root, "TARGET/1").file_name().unwrap(),
            std::ffi::OsStr::new("TARGET_1.json")
        );
        assert_eq!(
            snapshot_state_path(&root, "../../evil")
                .file_name()
                .unwrap(),
            std::ffi::OsStr::new("______evil.json")
        );
        fs::write(
            snapshot_state_path(&root, "TARGET/1"),
            br#"{"version":9,"generation":"s1","targetId":"TARGET/1","url":"u","capturedAtMs":1,"refs":[]}"#,
        )
        .expect("overwrite snapshot state");
        assert!(read_snapshot_state(&root, "TARGET/1").unwrap().is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ax_tree_compression_emits_actionable_refs() {
        let tree = json!({
            "nodes": [
                { "nodeId": "1", "role": {"value": "RootWebArea"}, "name": {"value": "Doc"}, "backendDOMNodeId": 1 },
                { "nodeId": "2", "parentId": "1", "role": {"value": "generic"}, "backendDOMNodeId": 2 },
                { "nodeId": "3", "parentId": "2", "role": {"value": "button"}, "name": {"value": "  Save\n  now  "}, "backendDOMNodeId": 3 },
                { "nodeId": "4", "parentId": "3", "role": {"value": "textbox"}, "name": {"value": "Email"}, "backendDOMNodeId": 4 },
                { "nodeId": "5", "parentId": "1", "role": {"value": "button"}, "ignored": true, "backendDOMNodeId": 5 },
                { "nodeId": "6", "parentId": "1", "role": {"value": "button"}, "name": {"value": "No node"} },
                { "nodeId": "7", "parentId": "1", "role": {"value": "generic"}, "name": {"value": "Composer"}, "backendDOMNodeId": 7,
                  "properties": [{"name": "editable", "value": {"value": "richtext"}}] },
                { "nodeId": "8", "parentId": "1", "role": {"value": "generic"}, "backendDOMNodeId": 8,
                  "properties": [{"name": "focusable", "value": {"value": true}}] }
            ]
        });
        let snapshot = compress_ax_tree(&tree, "target-1", "https://example.test/".to_string());
        assert_eq!(snapshot.state.refs.len(), 3);
        assert_eq!(snapshot.state.refs[0].reference, "e1");
        assert_eq!(snapshot.state.refs[0].backend_node_id, 3);
        assert_eq!(snapshot.state.refs[0].name, "Save now");
        assert_eq!(snapshot.state.refs[1].role, "textbox");
        assert_eq!(
            snapshot.tree,
            "    e1 button \"Save now\"\n      e2 textbox \"Email\"\n  e3 generic \"Composer\" [editable]"
        );
        assert!(!snapshot.truncated);
    }

    #[test]
    fn wait_conditions_build_bounded_expressions() {
        assert_eq!(
            wait_expression("load", &element_command(BrowserAction::Wait, &[])).unwrap(),
            "document.readyState==='complete'"
        );
        let selector = wait_expression(
            "selector",
            &element_command(BrowserAction::Wait, &[("selector", "#ready")]),
        )
        .unwrap();
        assert!(selector.contains("\"#ready\"") && selector.contains("getBoundingClientRect"));
        assert_eq!(
            wait_expression(
                "url",
                &element_command(BrowserAction::Wait, &[("url", "/done")])
            )
            .unwrap(),
            "location.href.includes(\"/done\")"
        );
        let idle = wait_expression(
            "idle",
            &element_command(BrowserAction::Wait, &[("quiet-ms", "750")]),
        )
        .unwrap();
        assert!(idle.ends_with("(750)") && idle.contains("MutationObserver"));
        assert!(wait_expression("selector", &element_command(BrowserAction::Wait, &[])).is_err());
        assert!(wait_expression("teleport", &element_command(BrowserAction::Wait, &[])).is_err());
    }

    #[test]
    fn ax_names_are_collapsed_and_bounded() {
        assert_eq!(bounded_ax_name("  a \n b  "), "a b");
        assert_eq!(
            bounded_ax_name(&"x".repeat(500)).chars().count(),
            MAX_AX_NAME_CHARS
        );
    }
}
