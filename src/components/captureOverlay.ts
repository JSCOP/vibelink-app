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
