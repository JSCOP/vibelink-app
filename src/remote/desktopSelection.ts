export type DesktopSelectionPayload = {
  workspaceId: string | null
  paneId: string | null
}

export function desktopSelectionPayload(
  workspaceId: string | undefined,
  paneId: string | undefined,
): DesktopSelectionPayload {
  if (!workspaceId) return { workspaceId: null, paneId: null }
  return { workspaceId, paneId: paneId ?? null }
}
