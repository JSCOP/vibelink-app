import { paneDropPositionFromPoint, type PaneDropPosition } from './paneDrag'

export type WindowDropPosition = PaneDropPosition

export const workspaceWindowDragMime = 'application/x-awt-window-id'

export function hasWorkspaceWindowDragPayload(types: readonly string[] | DOMStringList): boolean {
  return Array.from(types).includes(workspaceWindowDragMime)
}

export { paneDropPositionFromPoint as workspaceWindowDropPositionFromPoint }
