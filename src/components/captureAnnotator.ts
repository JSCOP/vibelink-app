export type AnnotationPoint = {
  x: number
  y: number
}

export type AnnotationRect = {
  x: number
  y: number
  width: number
  height: number
}

export type BrushStroke = {
  kind: 'brush'
  color: string
  width: number
  points: AnnotationPoint[]
}

export type RectStroke = {
  kind: 'rect'
  color: string
  width: number
  rect: AnnotationRect
}

export type AnnotationStroke = BrushStroke | RectStroke

export type CssBox = {
  left: number
  top: number
  width: number
  height: number
}

export type ImageSize = {
  width: number
  height: number
}

export function scaledImageDisplaySize(imageSize: ImageSize, maxViewport: ImageSize): ImageSize {
  if (imageSize.width <= 0 || imageSize.height <= 0 || maxViewport.width <= 0 || maxViewport.height <= 0) {
    return { width: 0, height: 0 }
  }

  const scale = Math.min(maxViewport.width / imageSize.width, maxViewport.height / imageSize.height, 1)
  return {
    width: imageSize.width * scale,
    height: imageSize.height * scale,
  }
}

export function addStroke(strokes: readonly AnnotationStroke[], stroke: AnnotationStroke): AnnotationStroke[] {
  return [...strokes, stroke]
}

export function undoStroke(strokes: readonly AnnotationStroke[]): AnnotationStroke[] {
  return strokes.slice(0, Math.max(0, strokes.length - 1))
}

export function normalizeRectFromDrag(start: AnnotationPoint, end: AnnotationPoint): AnnotationRect {
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  return {
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}

export function mapCssPointToImagePoint(point: AnnotationPoint, cssBox: CssBox, imageSize: ImageSize): AnnotationPoint {
  if (cssBox.width <= 0 || cssBox.height <= 0 || imageSize.width <= 0 || imageSize.height <= 0) {
    return { x: 0, y: 0 }
  }

  const scale = cssBox.width / imageSize.width
  if (scale <= 0) return { x: 0, y: 0 }
  return {
    x: clamp((point.x - cssBox.left) / scale, 0, imageSize.width),
    y: clamp((point.y - cssBox.top) / scale, 0, imageSize.height),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
