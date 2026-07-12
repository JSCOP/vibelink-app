use crate::protocol::PaneMeta;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub fn pane_order(layout_json: Option<&str>, panes: &[PaneMeta]) -> Vec<Uuid> {
    let fallback: Vec<_> = panes.iter().map(|pane| pane.id).collect();
    let Some(raw) = layout_json else { return fallback };
    let Some(layout) = terminal_layout(raw) else { return fallback };
    let Some(panels) = layout.get("panels").and_then(Value::as_object) else { return fallback };
    let mut panel_to_pane = HashMap::new();
    for (panel_id, panel) in panels {
        let pane_id = panel
            .get("params")
            .and_then(|params| params.get("paneId"))
            .and_then(Value::as_str)
            .or_else(|| panel.get("paneId").and_then(Value::as_str))
            .or_else(|| Uuid::parse_str(panel_id).ok().map(|_| panel_id.as_str()));
        if let Some(pane_id) = pane_id.and_then(|value| Uuid::parse_str(value).ok()) {
            panel_to_pane.insert(panel_id.clone(), pane_id);
        }
    }
    let Some(root) = layout.pointer("/grid/root") else { return fallback };
    let mut view_ids = Vec::new();
    traverse(root, &mut view_ids);
    let live: HashSet<_> = fallback.iter().copied().collect();
    let mut ordered = Vec::new();
    for view_id in view_ids {
        if let Some(pane_id) = panel_to_pane.get(&view_id).copied() {
            if live.contains(&pane_id) && !ordered.contains(&pane_id) {
                ordered.push(pane_id);
            }
        }
    }
    if ordered.len() == fallback.len() { ordered } else { fallback }
}

fn terminal_layout(raw: &str) -> Option<Value> {
    let state: Value = serde_json::from_str(raw).ok()?;
    let terminal_page = state
        .get("pages")
        .and_then(Value::as_array)
        .and_then(|pages| pages.iter().find(|page| page.get("id").and_then(Value::as_str) == Some("terminal")))?;
    let page_layout_raw = terminal_page.get("layoutJson")?.as_str()?;
    let page_layout: Value = serde_json::from_str(page_layout_raw).ok()?;
    page_layout.get("vibelinkTerminalLayout").cloned().or(Some(page_layout))
}

fn traverse(node: &Value, output: &mut Vec<String>) {
    match node.get("type").and_then(Value::as_str) {
        Some("branch") => {
            if let Some(children) = node.get("data").and_then(Value::as_array) {
                for child in children { traverse(child, output); }
            }
        }
        Some("leaf") => {
            if let Some(views) = node.get("data").and_then(|data| data.get("views")).and_then(Value::as_array) {
                output.extend(views.iter().filter_map(Value::as_str).map(str::to_string));
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{PaneConfig, PaneMeta};

    fn pane(id: Uuid) -> PaneMeta {
        PaneMeta { id, config: PaneConfig { pane_id: id, shell: None, args: vec![], cwd: None, env: vec![], title: None, icon: None, profile_id: None, role: None, cols: 80, rows: 24 }, alive: true }
    }

    #[test]
    fn terminal_dockview_depth_first_order_maps_panel_params() {
        let a = Uuid::new_v4(); let b = Uuid::new_v4(); let c = Uuid::new_v4();
        let terminal_layout = serde_json::json!({
            "panels": {
                "panel-b": {"params": {"paneId": b.to_string()}},
                "panel-a": {"params": {"paneId": a.to_string()}},
                "panel-c": {"params": {"paneId": c.to_string()}}
            },
            "grid": {"root": {"type":"branch","data":[
                {"type":"leaf","data":{"views":["panel-b"]}},
                {"type":"branch","data":[
                    {"type":"leaf","data":{"views":["panel-a"]}},
                    {"type":"leaf","data":{"views":["panel-c"]}}
                ]}
            ]}}
        });
        let page_layout = serde_json::json!({"vibelinkTerminalLayout": terminal_layout});
        let state = serde_json::json!({"version":2,"activePageId":"terminal","pages":[{"id":"terminal","layoutJson":page_layout.to_string()}]});
        assert_eq!(pane_order(Some(&state.to_string()), &[pane(a), pane(b), pane(c)]), vec![b, a, c]);
    }

    #[test]
    fn invalid_or_unmatched_layout_falls_back_to_insertion_order() {
        let a = Uuid::new_v4(); let b = Uuid::new_v4();
        let panes = vec![pane(a), pane(b)];
        assert_eq!(pane_order(Some("not json"), &panes), vec![a, b]);
    }
}
