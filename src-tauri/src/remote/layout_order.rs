use crate::protocol::PaneMeta;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

/// Return terminal panes in one-tree v3 Dockview reading order. Persisted UI
/// state is only authoritative when it describes every live daemon pane once;
/// any legacy, malformed, duplicate, stale, or incomplete state falls back to
/// the daemon's insertion order.
pub fn pane_order(layout_json: Option<&str>, panes: &[PaneMeta]) -> Vec<Uuid> {
    let fallback: Vec<_> = panes.iter().map(|pane| pane.id).collect();
    let Some(raw) = layout_json else {
        return fallback;
    };
    parse_v3_order(raw, &fallback).unwrap_or(fallback)
}

fn parse_v3_order(raw: &str, live_panes: &[Uuid]) -> Option<Vec<Uuid>> {
    let envelope: Value = serde_json::from_str(raw).ok()?;
    if envelope.get("version").and_then(Value::as_u64) != Some(3) {
        return None;
    }
    let dockview = envelope.get("dockview")?.as_object()?;
    let panels = dockview.get("panels")?.as_object()?;
    let root = dockview.get("grid")?.get("root")?;

    let mut terminal_panels = HashMap::new();
    let mut terminal_panes = HashSet::new();
    for (panel_id, panel) in panels {
        let Some(panel) = panel.as_object() else {
            return None;
        };
        let content_component = panel.get("contentComponent").and_then(Value::as_str);
        let params_kind = panel
            .get("params")
            .and_then(Value::as_object)
            .and_then(|params| params.get("kind"))
            .and_then(Value::as_str);
        if content_component != Some("terminal") && params_kind != Some("terminal") {
            continue;
        }
        let pane_id = exact_terminal_pane_id(panel_id, panel)?;
        if !terminal_panes.insert(pane_id) {
            return None;
        }
        terminal_panels.insert(panel_id.as_str(), pane_id);
    }

    let mut view_ids = Vec::new();
    traverse_views(root, &mut view_ids)?;
    let mut seen_views = HashSet::new();
    let mut ordered = Vec::new();
    let mut ordered_panes = HashSet::new();
    for view_id in view_ids {
        if !seen_views.insert(view_id) || !panels.contains_key(view_id) {
            return None;
        }
        let Some(pane_id) = terminal_panels.get(view_id).copied() else {
            continue;
        };
        if !ordered_panes.insert(pane_id) {
            return None;
        }
        ordered.push(pane_id);
    }

    let live: HashSet<_> = live_panes.iter().copied().collect();
    if live.len() != live_panes.len()
        || ordered_panes != live
        || terminal_panes.len() != live.len()
    {
        return None;
    }
    Some(ordered)
}

fn exact_terminal_pane_id(panel_id: &str, panel: &Map<String, Value>) -> Option<Uuid> {
    if panel.get("contentComponent").and_then(Value::as_str) != Some("terminal")
        || panel.get("tabComponent").and_then(Value::as_str) != Some("workspaceContentTab")
        || panel.get("renderer").and_then(Value::as_str) != Some("always")
    {
        return None;
    }
    let params = panel.get("params")?.as_object()?;
    let exact_keys: HashSet<_> = ["schema", "kind", "instanceId", "title", "icon", "paneId"]
        .into_iter()
        .collect();
    if params.len() != exact_keys.len() || params.keys().any(|key| !exact_keys.contains(key.as_str())) {
        return None;
    }
    if params.get("schema").and_then(Value::as_u64) != Some(1)
        || params.get("kind").and_then(Value::as_str) != Some("terminal")
    {
        return None;
    }
    let instance_id = non_empty_string(params.get("instanceId")?)?;
    let pane_id_raw = non_empty_string(params.get("paneId")?)?;
    non_empty_string(params.get("title")?)?;
    non_empty_string(params.get("icon")?)?;
    if instance_id != pane_id_raw || panel_id != format!("content:terminal:{instance_id}") {
        return None;
    }
    Uuid::parse_str(pane_id_raw).ok()
}

fn non_empty_string(value: &Value) -> Option<&str> {
    let value = value.as_str()?;
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

fn traverse_views<'a>(node: &'a Value, output: &mut Vec<&'a str>) -> Option<()> {
    match node.get("type")?.as_str()? {
        "branch" => {
            let children = node.get("data")?.as_array()?;
            if children.is_empty() {
                return None;
            }
            for child in children {
                traverse_views(child, output)?;
            }
            Some(())
        }
        "leaf" => {
            let views = node.get("data")?.get("views")?.as_array()?;
            if views.is_empty() {
                return None;
            }
            for view in views {
                output.push(view.as_str()?);
            }
            Some(())
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{PaneConfig, PaneMeta};

    fn pane(id: Uuid) -> PaneMeta {
        PaneMeta {
            id,
            config: PaneConfig {
                pane_id: id,
                shell: None,
                args: vec![],
                cwd: None,
                env: vec![],
                title: None,
                icon: None,
                profile_id: None,
                role: None,
                cols: 80,
                rows: 24,
            },
            alive: true,
        }
    }

    fn terminal_panel(id: Uuid) -> Value {
        serde_json::json!({
            "contentComponent": "terminal",
            "tabComponent": "workspaceContentTab",
            "renderer": "always",
            "params": {
                "schema": 1,
                "kind": "terminal",
                "instanceId": id.to_string(),
                "title": "Shell",
                "icon": "terminal",
                "paneId": id.to_string()
            }
        })
    }

    fn v3(panels: Value, root: Value) -> String {
        serde_json::json!({
            "version": 3,
            "dockview": {"panels": panels, "grid": {"root": root}}
        })
        .to_string()
    }

    #[test]
    fn mixed_dockview_uses_depth_first_leaf_and_views_order() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();
        let a_id = format!("content:terminal:{a}");
        let b_id = format!("content:terminal:{b}");
        let c_id = format!("content:terminal:{c}");
        let layout = v3(
            serde_json::json!({
                (a_id.clone()): terminal_panel(a),
                (b_id.clone()): terminal_panel(b),
                (c_id.clone()): terminal_panel(c),
                "content:explorer:explorer": {
                    "contentComponent":"explorer",
                    "params":{"schema":1,"kind":"explorer","instanceId":"explorer","title":"Explorer","icon":"folder-tree"}
                }
            }),
            serde_json::json!({"type":"branch","data":[
                {"type":"leaf","data":{"views":["content:explorer:explorer", b_id]}},
                {"type":"branch","data":[
                    {"type":"leaf","data":{"views":[a_id]}},
                    {"type":"leaf","data":{"views":[c_id]}}
                ]}
            ]}),
        );
        assert_eq!(pane_order(Some(&layout), &[pane(a), pane(b), pane(c)]), vec![b, a, c]);
    }

    #[test]
    fn legacy_v2_falls_back_to_daemon_insertion_order() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let legacy = serde_json::json!({"version":2,"pages":[]}).to_string();
        assert_eq!(pane_order(Some(&legacy), &[pane(a), pane(b)]), vec![a, b]);
    }

    #[test]
    fn duplicate_terminal_view_falls_back() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let a_id = format!("content:terminal:{a}");
        let b_id = format!("content:terminal:{b}");
        let layout = v3(
            serde_json::json!({(a_id.clone()):terminal_panel(a),(b_id.clone()):terminal_panel(b)}),
            serde_json::json!({"type":"leaf","data":{"views":[b_id.clone(),b_id,a_id]}}),
        );
        assert_eq!(pane_order(Some(&layout), &[pane(a), pane(b)]), vec![a, b]);
    }

    #[test]
    fn incomplete_terminal_coverage_falls_back() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let a_id = format!("content:terminal:{a}");
        let layout = v3(
            serde_json::json!({(a_id.clone()):terminal_panel(a)}),
            serde_json::json!({"type":"leaf","data":{"views":[a_id]}}),
        );
        assert_eq!(pane_order(Some(&layout), &[pane(a), pane(b)]), vec![a, b]);
    }

    #[test]
    fn non_exact_terminal_params_fall_back() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let a_id = format!("content:terminal:{a}");
        let b_id = format!("content:terminal:{b}");
        let mut panel = terminal_panel(a);
        panel["params"]["extra"] = Value::Bool(true);
        let layout = v3(
            serde_json::json!({(a_id.clone()):panel,(b_id.clone()):terminal_panel(b)}),
            serde_json::json!({"type":"leaf","data":{"views":[b_id,a_id]}}),
        );
        assert_eq!(pane_order(Some(&layout), &[pane(a), pane(b)]), vec![a, b]);
    }
}
