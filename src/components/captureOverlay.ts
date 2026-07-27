export type CaptureMode = 'image' | 'quick' | 'video'

type Rect = { x: number; y: number; w: number; h: number }
type ScreenSize = { w: number; h: number }
type Point = { x: number; y: number }
type StylePatchTarget = {
  style: {
    background: string
    backgroundColor: string
    minWidth: string
    setProperty?: (property: string, value: string, priority?: string) => void
  }
}

type CaptureOverlayDocument = {
  documentElement: StylePatchTarget
  body: StylePatchTarget
  getElementById(id: string): StylePatchTarget | null
}

export function applyCaptureOverlayTransparency(doc: CaptureOverlayDocument = document): void {
  for (const element of [doc.documentElement, doc.body, doc.getElementById('root')]) {
    if (!element) continue
    element.style.background = 'transparent'
    element.style.backgroundColor = 'transparent'
    element.style.minWidth = '0'
    element.style.setProperty?.('background', 'transparent', 'important')
    element.style.setProperty?.('background-color', 'transparent', 'important')
    element.style.setProperty?.('background-image', 'none', 'important')
    element.style.setProperty?.('min-width', '0', 'important')
    element.style.setProperty?.('--vibelink-bg', 'transparent')
  }
}

// The native overlay window label carries a per-open generation suffix
// (`capture-overlay-7`) because Tauri never frees a leaked window label, and a
// fixed label permanently breaks capture after one leak. Match the family here.
export function isCaptureOverlayLabel(label: string): boolean {
  if (label === 'capture-overlay') return true
  const generation = label.startsWith('capture-overlay-') ? label.slice('capture-overlay-'.length) : ''
  return generation.length > 0 && /^\d+$/.test(generation)
}

export type MonitorRect = { x: number; y: number; width: number; height: number }
export type VirtualScreen = { bounds: MonitorRect; monitors: MonitorRect[] }


const CONTROL_GAP = 8

export function placeControlBar(rect: Rect, screen: ScreenSize, barW: number, barH: number): Point {
  let y = rect.y + rect.h + CONTROL_GAP
  if (y + barH > screen.h) {
    y = rect.y - barH - CONTROL_GAP
  }
  if (y < 0) {
    y = Math.min(rect.y + CONTROL_GAP, screen.h - barH)
  }

  const centeredX = rect.x + rect.w / 2 - barW / 2
  const maxX = screen.w - barW
  const x = Math.min(Math.max(centeredX, 0), maxX)

  return { x: Math.round(x), y: Math.round(y) }
}

export function evenFloor(n: number): number {
  return Math.floor(n) & ~1
}

export function captureFileName(mode: CaptureMode, d = new Date()): string {
  const year = String(d.getFullYear())
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  const seconds = String(d.getSeconds()).padStart(2, '0')
  const ts = `${year}${month}${day}-${hours}${minutes}${seconds}`
  return mode === 'video' ? `recording-${ts}.mp4` : `capture-${ts}.png`
}

// The overlay spans the whole virtual desktop, whose bounding box is NOT fully
// covered by real displays: a 2560x1440 primary at (0,0) plus a portrait
// 1440x2560 secondary at (-1440,-510) leaves L-shaped gaps. Selecting there
// would capture black, so the overlay paints the gaps opaque and rejects them.
export function monitorGapRects(screen: VirtualScreen, step = 8): MonitorRect[] {
  const { bounds, monitors } = screen
  if (monitors.length === 0) return []
  const gaps: MonitorRect[] = []
  for (let y = bounds.y; y < bounds.y + bounds.height; y += step) {
    const rowHeight = Math.min(step, bounds.y + bounds.height - y)
    let runStart: number | null = null
    for (let x = bounds.x; x < bounds.x + bounds.width; x += step) {
      const columnWidth = Math.min(step, bounds.x + bounds.width - x)
      const covered = isCoveredByMonitor(screen, x, y) && isCoveredByMonitor(screen, x + columnWidth - 1, y + rowHeight - 1)
      if (!covered && runStart === null) runStart = x
      if (covered && runStart !== null) {
        gaps.push({ x: runStart, y, width: x - runStart, height: rowHeight })
        runStart = null
      }
    }
    if (runStart !== null) {
      gaps.push({ x: runStart, y, width: bounds.x + bounds.width - runStart, height: rowHeight })
    }
  }
  return gaps
}

export function isCoveredByMonitor(screen: VirtualScreen, x: number, y: number): boolean {
  return screen.monitors.some((monitor) =>
    x >= monitor.x && x < monitor.x + monitor.width && y >= monitor.y && y < monitor.y + monitor.height,
  )
}

// A selection is capturable only when its area actually overlaps a display.
// A rect lying entirely in a gap would produce a fully transparent image.
export function intersectsAnyMonitor(screen: VirtualScreen, rect: Rect): boolean {
  return screen.monitors.some((monitor) =>
    rect.x < monitor.x + monitor.width &&
    rect.x + rect.w > monitor.x &&
    rect.y < monitor.y + monitor.height &&
    rect.y + rect.h > monitor.y,
  )
}

// Overlay-local CSS pixels -> virtual-desktop physical pixels. The overlay
// window's origin IS the virtual-screen origin, which is negative whenever a
// monitor sits left of / above the primary one.
export function toVirtualRect(rect: Rect, bounds: MonitorRect, dpr: number): MonitorRect {
  const x = Math.round(rect.x * dpr) + bounds.x
  const y = Math.round(rect.y * dpr) + bounds.y
  return { x, y, width: Math.round(rect.w * dpr), height: Math.round(rect.h * dpr) }
}

export function monitorAt(screen: VirtualScreen, x: number, y: number): MonitorRect | null {
  return screen.monitors.find((monitor) =>
    x >= monitor.x && x < monitor.x + monitor.width && y >= monitor.y && y < monitor.y + monitor.height,
  ) ?? null
}
