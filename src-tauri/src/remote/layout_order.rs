use crate::protocol::PaneMeta;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneLayoutPosition {
    pub group_id: String,
    pub group_order: u32,
    pub tab_order: u32,
    pub order: u32,
}

/// Return terminal panes in one-tree v3 Dockview reading order. Persisted UI
/// state is only authoritative when it describes every live daemon pane once;
/// any legacy, malformed, duplicate, stale, or incomplete state falls back to
/// explicit unavailable group metadata and daemon insertion order.
pub fn pane_layout_positions(
    layout_json: Option<&str>,
    panes: &[PaneMeta],
) -> HashMap<Uuid, PaneLayoutPosition> {
    let fallback = fallback_positions(panes);
    let Some(raw) = layout_json else {
        return fallback;
    };
    parse_v3_positions(raw, panes).unwrap_or(fallback)
}

pub fn pane_order(layout_json: Option<&str>, panes: &[PaneMeta]) -> Vec<Uuid> {
    let positions = pane_layout_positions(layout_json, panes);
    let mut ordered = panes.iter().map(|pane| pane.id).collect::<Vec<_>>();
    ordered.sort_by_key(|pane_id| positions.get(pane_id).map(|position| position.order));
    ordered
}

fn fallback_positions(panes: &[PaneMeta]) -> HashMap<Uuid, PaneLayoutPosition> {
    panes
        .iter()
        .enumerate()
        .map(|(index, pane)| {
            let order = u32::try_from(index).unwrap_or(u32::MAX);
            (
                pane.id,
                PaneLayoutPosition {
                    group_id: String::new(),
                    group_order: order,
                    tab_order: 0,
                    order,
                },
            )
        })
        .collect()
}

fn parse_v3_positions(raw: &str, panes: &[PaneMeta]) -> Option<HashMap<Uuid, PaneLayoutPosition>> {
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
        let panel = panel.as_object()?;
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

    let mut groups = Vec::new();
    traverse_groups(root, &mut groups)?;
    let mut seen_groups = HashSet::new();
    let mut seen_views = HashSet::new();
    let mut positions = HashMap::new();
    let mut global_order = 0_u32;
    for (group_index, group) in groups.into_iter().enumerate() {
        if !seen_groups.insert(group.id) {
            return None;
        }
        let group_order = u32::try_from(group_index).ok()?;
        for (tab_index, view_id) in group.views.iter().enumerate() {
            if !seen_views.insert(*view_id) || !panels.contains_key(*view_id) {
                return None;
            }
            let Some(pane_id) = terminal_panels.get(view_id).copied() else {
                continue;
            };
            let tab_order = u32::try_from(tab_index).ok()?;
            if positions
                .insert(
                    pane_id,
                    PaneLayoutPosition {
                        group_id: group.id.to_string(),
                        group_order,
                        tab_order,
                        order: global_order,
                    },
                )
                .is_some()
            {
                return None;
            }
            global_order = global_order.checked_add(1)?;
        }
    }

    let live = panes.iter().map(|pane| pane.id).collect::<HashSet<_>>();
    if live.len() != panes.len() || positions.keys().copied().collect::<HashSet<_>>() != live {
        return None;
    }
    if terminal_panels.len() != live.len() {
        return None;
    }
    Some(positions)
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
    if params.len() != exact_keys.len()
        || params.keys().any(|key| !exact_keys.contains(key.as_str()))
    {
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

struct DockGroup<'a> {
    id: &'a str,
    views: Vec<&'a str>,
}

fn traverse_groups<'a>(node: &'a Value, output: &mut Vec<DockGroup<'a>>) -> Option<()> {
    match node.get("type")?.as_str()? {
        "branch" => {
            let children = node.get("data")?.as_array()?;
            if children.is_empty() {
                return None;
            }
            for child in children {
                traverse_groups(child, output)?;
            }
            Some(())
        }
        "leaf" => {
            let data = node.get("data")?.as_object()?;
            let id = non_empty_string(data.get("id")?)?;
            let views = data.get("views")?.as_array()?;
            if views.is_empty() {
                return None;
            }
            let views = views
                .iter()
                .map(Value::as_str)
                .collect::<Option<Vec<_>>>()?;
            output.push(DockGroup { id, views });
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
                restore_on_start: false,
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
    fn mixed_dockview_projects_real_group_tab_and_global_order() {
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
                {"type":"leaf","data":{"id":"group-b","views":["content:explorer:explorer", b_id]}},
                {"type":"branch","data":[
                    {"type":"leaf","data":{"id":"group-a","views":[a_id]}},
                    {"type":"leaf","data":{"id":"group-c","views":[c_id]}}
                ]}
            ]}),
        );
        let positions = pane_layout_positions(Some(&layout), &[pane(a), pane(b), pane(c)]);
        assert_eq!(
            positions.get(&b),
            Some(&PaneLayoutPosition {
                group_id: "group-b".into(),
                group_order: 0,
                tab_order: 1,
                order: 0,
            })
        );
        assert_eq!(positions.get(&a).unwrap().group_order, 1);
        assert_eq!(positions.get(&a).unwrap().tab_order, 0);
        assert_eq!(positions.get(&a).unwrap().order, 1);
        assert_eq!(positions.get(&c).unwrap().group_order, 2);
        assert_eq!(positions.get(&c).unwrap().order, 2);
        assert_eq!(
            pane_order(Some(&layout), &[pane(a), pane(b), pane(c)]),
            vec![b, a, c]
        );
    }

    #[test]
    fn invalid_or_incomplete_layout_uses_explicit_unavailable_fallback() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let a_id = format!("content:terminal:{a}");
        let incomplete = v3(
            serde_json::json!({(a_id.clone()):terminal_panel(a)}),
            serde_json::json!({"type":"leaf","data":{"id":"fabricated-ui-group","views":[a_id]}}),
        );
        for raw in [
            Some(incomplete.as_str()),
            Some(r#"{"version":2,"pages":[]}"#),
            None,
        ] {
            let positions = pane_layout_positions(raw, &[pane(a), pane(b)]);
            assert_eq!(
                positions.get(&a),
                Some(&PaneLayoutPosition {
                    group_id: String::new(),
                    group_order: 0,
                    tab_order: 0,
                    order: 0,
                })
            );
            assert_eq!(positions.get(&b).unwrap().group_id, "");
            assert_eq!(positions.get(&b).unwrap().group_order, 1);
            assert_eq!(positions.get(&b).unwrap().tab_order, 0);
            assert_eq!(positions.get(&b).unwrap().order, 1);
        }
    }

    #[test]
    fn duplicate_group_or_view_falls_back() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let a_id = format!("content:terminal:{a}");
        let b_id = format!("content:terminal:{b}");
        let duplicate = v3(
            serde_json::json!({(a_id.clone()):terminal_panel(a),(b_id.clone()):terminal_panel(b)}),
            serde_json::json!({"type":"branch","data":[
                {"type":"leaf","data":{"id":"same","views":[a_id]}},
                {"type":"leaf","data":{"id":"same","views":[b_id]}}
            ]}),
        );
        let positions = pane_layout_positions(Some(&duplicate), &[pane(a), pane(b)]);
        assert!(positions
            .values()
            .all(|position| position.group_id.is_empty()));
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
            serde_json::json!({"type":"leaf","data":{"id":"group","views":[b_id,a_id]}}),
        );
        assert_eq!(pane_order(Some(&layout), &[pane(a), pane(b)]), vec![a, b]);
    }
}
