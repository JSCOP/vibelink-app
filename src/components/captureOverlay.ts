type CaptureMode = 'image' | 'video'

type Rect = { x: number; y: number; w: number; h: number }
type ScreenSize = { w: number; h: number }
type Point = { x: number; y: number }
type StylePatchTarget = {
  style: {
    background: string
    backgroundColor: string
    minWidth: string
    setProperty?: (property: string, value: string) => void
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
    element.style.setProperty?.('--awt-bg', 'transparent')
  }
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
  return mode === 'image' ? `capture-${ts}.png` : `recording-${ts}.mp4`
}
