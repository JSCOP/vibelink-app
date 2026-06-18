type DockviewLayout = {
  panels?: Record<string, unknown>
}

export function shouldRestoreDockviewLayout(layoutJson: string, paneIds: string[]): boolean {
  if (paneIds.length === 0) return false

  let layout: DockviewLayout
  try {
    layout = JSON.parse(layoutJson) as DockviewLayout
  } catch {
    return false
  }

  const panels = layout.panels
  if (!panels) return false

  for (const paneId of paneIds) {
    if (!Object.prototype.hasOwnProperty.call(panels, paneId)) return false
  }

  return true
}
