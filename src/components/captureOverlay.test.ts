import { describe, expect, it } from 'vitest'
import {
  applyCaptureOverlayTransparency,
  captureFileName,
  evenFloor,
  intersectsAnyMonitor,
  isCaptureOverlayLabel,
  monitorAt,
  monitorGapRects,
  placeControlBar,
  toVirtualRect,
} from './captureOverlay'
import type { VirtualScreen } from './captureOverlay'

function styleTarget() {
  const properties: Record<string, string> = {}
  return {
    style: {
      background: '',
      backgroundColor: '',
      minWidth: '',
      setProperty: (property: string, value: string) => { properties[property] = value },
    },
    properties,
  }
}

describe('placeControlBar', () => {
  const screen = { w: 300, h: 200 }
  const barW = 80
  const barH = 40

  it('places the control bar below the selected rect when there is room', () => {
    const point = placeControlBar({ x: 100, y: 20, w: 60, h: 40 }, screen, barW, barH)

    expect(point).toEqual({ x: 90, y: 68 })
    expect(point.y).toBeGreaterThanOrEqual(0)
    expect(point.y + barH).toBeLessThanOrEqual(screen.h)
    expect(point.x).toBeGreaterThanOrEqual(0)
    expect(point.x + barW).toBeLessThanOrEqual(screen.w)
  })

  it('places the control bar above the selected rect when below would overflow', () => {
    const point = placeControlBar({ x: 100, y: 150, w: 60, h: 35 }, screen, barW, barH)

    expect(point).toEqual({ x: 90, y: 102 })
    expect(point.y).toBeGreaterThanOrEqual(0)
    expect(point.y + barH).toBeLessThanOrEqual(screen.h)
    expect(point.x).toBeGreaterThanOrEqual(0)
    expect(point.x + barW).toBeLessThanOrEqual(screen.w)
  })

  it('places the control bar inside the selection top when above would overflow', () => {
    const point = placeControlBar({ x: 70, y: 10, w: 60, h: 105 }, { w: 200, h: 120 }, barW, barH)

    expect(point).toEqual({ x: 60, y: 18 })
    expect(point.y).toBeGreaterThanOrEqual(0)
    expect(point.y + barH).toBeLessThanOrEqual(120)
    expect(point.x).toBeGreaterThanOrEqual(0)
    expect(point.x + barW).toBeLessThanOrEqual(200)
  })

  it('clamps the control bar horizontally at the screen edges', () => {
    const leftPoint = placeControlBar({ x: -20, y: 20, w: 20, h: 30 }, { w: 200, h: 120 }, barW, barH)
    const rightPoint = placeControlBar({ x: 190, y: 20, w: 40, h: 30 }, { w: 200, h: 120 }, barW, barH)

    expect(leftPoint.x).toBe(0)
    expect(rightPoint.x).toBe(120)
    expect(leftPoint.x + barW).toBeLessThanOrEqual(200)
    expect(rightPoint.x + barW).toBeLessThanOrEqual(200)

    expect(leftPoint.y).toBeGreaterThanOrEqual(0)
    expect(rightPoint.y).toBeGreaterThanOrEqual(0)
    expect(leftPoint.y + barH).toBeLessThanOrEqual(120)
    expect(rightPoint.y + barH).toBeLessThanOrEqual(120)
  })
})

describe('evenFloor', () => {
  it('rounds down to the nearest even integer', () => {
    expect(evenFloor(101)).toBe(100)
  })
})

describe('captureFileName', () => {
  it('formats fixed-date image capture names', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5)

    expect(captureFileName('image', d)).toBe('capture-20260102-030405.png')
  })

  it('formats quick capture names as image files', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5)

    expect(captureFileName('quick', d)).toBe('capture-20260102-030405.png')
  })
})

describe('applyCaptureOverlayTransparency', () => {
  it('clears html, body, and root backgrounds for the transparent overlay window', () => {
    const html = styleTarget()
    const body = styleTarget()
    const root = styleTarget()

    applyCaptureOverlayTransparency({
      documentElement: html,
      body,
      getElementById: (id) => id === 'root' ? root : null,
    })

    for (const target of [html, body, root]) {
      expect(target.style.background).toBe('transparent')
      expect(target.style.backgroundColor).toBe('transparent')
      expect(target.style.minWidth).toBe('0')
      expect(target.properties['--vibelink-bg']).toBe('transparent')
    }
  })
})

describe('isCaptureOverlayLabel', () => {
  it('renders the overlay for every generation-suffixed native window label', () => {
    expect(isCaptureOverlayLabel('capture-overlay')).toBe(true)
    expect(isCaptureOverlayLabel('capture-overlay-1')).toBe(true)
    expect(isCaptureOverlayLabel('capture-overlay-42')).toBe(true)
  })

  it('renders the workspace app for every other window label', () => {
    expect(isCaptureOverlayLabel('main')).toBe(false)
    expect(isCaptureOverlayLabel('capture-overlay-')).toBe(false)
    expect(isCaptureOverlayLabel('capture-overlay-a')).toBe(false)
    expect(isCaptureOverlayLabel('xcapture-overlay-1')).toBe(false)
  })
})

// The real layout this was built against: a 2560x1440 primary at the origin and
// a portrait 1440x2560 secondary placed left of and above it. The bounding box
// is 4000x2560 with L-shaped areas no display covers.
const dualScreen: VirtualScreen = {
  bounds: { x: -1440, y: -510, width: 4000, height: 2560 },
  monitors: [
    { x: 0, y: 0, width: 2560, height: 1440 },
    { x: -1440, y: -510, width: 1440, height: 2560 },
  ],
}

describe('virtual screen geometry', () => {
  it('accepts a region that spans both monitors', () => {
    expect(intersectsAnyMonitor(dualScreen, { x: -200, y: 100, w: 600, h: 400 })).toBe(true)
  })

  it('accepts a region entirely on the secondary monitor at negative coordinates', () => {
    expect(intersectsAnyMonitor(dualScreen, { x: -1400, y: -400, w: 300, h: 300 })).toBe(true)
  })

  it('rejects a region lying only in an uncovered gap so capture never returns blank pixels', () => {
    // Right of the portrait monitor's bottom half, below the primary monitor.
    expect(intersectsAnyMonitor(dualScreen, { x: 200, y: 1600, w: 400, h: 300 })).toBe(false)
    // Above the primary monitor, right of the portrait monitor.
    expect(intersectsAnyMonitor(dualScreen, { x: 300, y: -500, w: 400, h: 200 })).toBe(false)
  })

  it('treats edge adjacency as non-overlapping', () => {
    expect(intersectsAnyMonitor(dualScreen, { x: 2560, y: 0, w: 100, h: 100 })).toBe(false)
    expect(intersectsAnyMonitor(dualScreen, { x: 2460, y: 0, w: 100, h: 100 })).toBe(true)
  })

  it('reports gap rectangles for the uncovered corners and none for a single full-cover monitor', () => {
    expect(monitorGapRects(dualScreen).length).toBeGreaterThan(0)
    const single: VirtualScreen = {
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      monitors: [{ x: 0, y: 0, width: 1920, height: 1080 }],
    }
    expect(monitorGapRects(single)).toEqual([])
  })

  it('resolves the monitor under a virtual-desktop point', () => {
    expect(monitorAt(dualScreen, 10, 10)).toEqual(dualScreen.monitors[0])
    expect(monitorAt(dualScreen, -700, 1000)).toEqual(dualScreen.monitors[1])
    expect(monitorAt(dualScreen, 400, 1800)).toBeNull()
  })

  it('offsets overlay-local pixels by the virtual origin so negative monitors resolve', () => {
    // Overlay origin IS the virtual origin, so local (0,0) maps to (-1440,-510).
    expect(toVirtualRect({ x: 0, y: 0, w: 100, h: 50 }, dualScreen.bounds, 1)).toEqual({
      x: -1440, y: -510, width: 100, height: 50,
    })
    // 1440 local px right of the origin is the primary monitor's left edge.
    expect(toVirtualRect({ x: 1440, y: 510, w: 200, h: 200 }, dualScreen.bounds, 1)).toEqual({
      x: 0, y: 0, width: 200, height: 200,
    })
  })

  it('scales local CSS pixels by the device pixel ratio before offsetting', () => {
    expect(toVirtualRect({ x: 10, y: 20, w: 30, h: 40 }, { x: -100, y: -50, width: 800, height: 600 }, 2)).toEqual({
      x: -80, y: -10, width: 60, height: 80,
    })
  })
})
