import { describe, expect, it } from 'vitest'
import { applyCaptureOverlayTransparency, captureFileName, evenFloor, placeControlBar } from './captureOverlay'

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
      expect(target.properties['--awt-bg']).toBe('transparent')
    }
  })
})
