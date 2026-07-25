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
