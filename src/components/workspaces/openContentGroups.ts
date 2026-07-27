import type { OpenContentItem } from '../../layout/openContentRegistry'

export type OpenContentGroup =
  | { kind: 'item'; item: OpenContentItem }
  | { kind: 'terminalGroup'; window: OpenContentItem; panes: OpenContentItem[] }

export function groupOpenContentItems(items: readonly OpenContentItem[]): OpenContentGroup[] {
  const panesByParent = new Map<string, OpenContentItem[]>()
  for (const item of items) {
    if (!item.parentPanelId) continue
    const panes = panesByParent.get(item.parentPanelId) ?? []
    panes.push(item)
    panesByParent.set(item.parentPanelId, panes)
  }

  const groups: OpenContentGroup[] = []
  for (const item of items) {
    if (item.parentPanelId) continue
    if (item.kind === 'terminalWindow') groups.push({ kind: 'terminalGroup', window: item, panes: panesByParent.get(item.panelId) ?? [] })
    else groups.push({ kind: 'item', item })
  }
  return groups
}
