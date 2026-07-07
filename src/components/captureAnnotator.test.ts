import { describe, expect, it } from 'vitest'
import { addStroke, mapCssPointToImagePoint, normalizeRectFromDrag, scaledImageDisplaySize, undoStroke, type AnnotationStroke } from './captureAnnotator'

describe('capture annotator stroke stack', () => {
  it('adds strokes without mutating the existing stack and undoes the newest stroke', () => {
    const first: AnnotationStroke = { kind: 'brush', color: '#ef4444', width: 4, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }
    const second: AnnotationStroke = { kind: 'rect', color: '#facc15', width: 6, rect: { x: 5, y: 6, width: 7, height: 8 } }
    const original = [first]

    const added = addStroke(original, second)
    const undone = undoStroke(added)

    expect(original).toEqual([first])
    expect(added).toEqual([first, second])
    expect(undone).toEqual([first])
    expect(undoStroke([])).toEqual([])
  })
})

describe('normalizeRectFromDrag', () => {
  it('normalizes a drag from bottom-right to top-left into a positive hollow rectangle box', () => {
    expect(normalizeRectFromDrag({ x: 120, y: 80 }, { x: 20, y: 10 })).toEqual({
      x: 20,
      y: 10,
      width: 100,
      height: 70,
    })
  })
})

describe('scaledImageDisplaySize', () => {
  it('uses one no-upscale scale factor to preserve image aspect ratio', () => {
    expect(scaledImageDisplaySize({ width: 1600, height: 900 }, { width: 800, height: 800 })).toEqual({ width: 800, height: 450 })
    expect(scaledImageDisplaySize({ width: 320, height: 200 }, { width: 1200, height: 900 })).toEqual({ width: 320, height: 200 })
  })
})

describe('mapCssPointToImagePoint', () => {
  it('maps displayed CSS pixels back into original image pixels with one shared scale', () => {
    const mapped = mapCssPointToImagePoint(
      { x: 250, y: 162.5 },
      { left: 50, top: 50, width: 800, height: 450 },
      { width: 1600, height: 900 },
    )

    expect(mapped).toEqual({ x: 400, y: 225 })
  })

  it('clamps pointer coordinates to the image bounds', () => {
    expect(mapCssPointToImagePoint(
      { x: -20, y: 600 },
      { left: 10, top: 20, width: 100, height: 100 },
      { width: 300, height: 200 },
    )).toEqual({ x: 0, y: 200 })
  })
})
