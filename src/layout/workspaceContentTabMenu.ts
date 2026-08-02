import type {
  GetTabContextMenuItemsParams,
  ReactContextMenuItemConfig,
} from 'dockview-react'
import type { WorkspaceContentActions } from './contentActions'
import { isStructuralWorkspaceContentKind, parseWorkspaceContentParams } from './workspaceContentModel'

export function buildWorkspaceContentTabContextMenu(
  params: GetTabContextMenuItemsParams,
  actions: WorkspaceContentActions,
): ReactContextMenuItemConfig[] {
  const content = parseWorkspaceContentParams(params.panel.params)
  if (content && isStructuralWorkspaceContentKind(content.kind)) return []
  if (content?.kind === 'workspaceWindow') {
    return [{ label: 'Reset workspace layout', action: () => { void actions.resetLayout() } }]
  }
  if (content?.kind === 'terminalWindow') {
    return [
      { label: 'New terminal in this window', action: () => { void actions.openContent({ kind: 'terminal', windowId: content.instanceId }) } },
      { label: 'Arrange panes', action: () => { void actions.arrangeTerminals(null, content.instanceId) } },
      { label: 'Clear panes', action: () => { void actions.clearTerminals(content.instanceId) } },
      { label: content.titlesHidden ? 'Show pane titles' : 'Hide pane titles', action: () => actions.toggleTerminalWindowTitles(content.instanceId) },
      { label: 'Maximize / restore content', action: () => actions.toggleMaximizeContent(params.panel.id) },
      { label: 'Close terminal window', action: () => { void actions.requestCloseContent(params.panel.id) } },
    ]
  }
  const groupId = params.group.id
  const items: ReactContextMenuItemConfig[] = [
    { label: 'New terminal in this group', action: () => { void actions.openContent({ kind: 'terminal', targetGroupId: groupId }) } },
  ]
  if (content?.kind === 'terminal') {
    items.push(
      { label: 'Split terminal right', action: () => { void actions.splitTerminal(content.paneId, 'right') } },
      { label: 'Split terminal below', action: () => { void actions.splitTerminal(content.paneId, 'below') } },
    )
  }
  items.push(
    { label: 'Maximize / restore content', action: () => actions.toggleMaximizeContent(params.panel.id) },
    { label: content?.kind === 'terminal' ? 'Close terminal' : 'Close content', action: () => { void actions.requestCloseContent(params.panel.id) } },
  )
  return items
}
