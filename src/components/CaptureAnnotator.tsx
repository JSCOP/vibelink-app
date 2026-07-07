import { invoke } from '@tauri-apps/api/core'
import { Brush, Check, Copy, RotateCcw, Square, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { addStroke, mapCssPointToImagePoint, normalizeRectFromDrag, scaledImageDisplaySize, undoStroke, type AnnotationPoint, type AnnotationStroke, type ImageSize } from './captureAnnotator'

type CaptureAnnotatorProps = {
  captureDir: string
  imagePath: string
  onClose: () => void
}

type Tool = 'brush' | 'rect'
type CopyState = 'idle' | 'copying' | 'copied'
type DragState = {
  pointerId: number
  start: AnnotationPoint
  tool: Tool
}

const COLORS = [
  { label: 'Red', value: '#ef4444' },
  { label: 'Yellow', value: '#facc15' },
  { label: 'Green', value: '#22c55e' },
  { label: 'Blue', value: '#38bdf8' },
  { label: 'White', value: '#ffffff' },
] as const
const STROKE_WIDTHS = [2, 4, 6] as const

export function CaptureAnnotator({ captureDir, imagePath, onClose }: CaptureAnnotatorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const baseImageRef = useRef<HTMLImageElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const draftRef = useRef<AnnotationStroke | null>(null)
  const copyResetTimerRef = useRef<number | null>(null)
  const [imageSize, setImageSize] = useState<ImageSize | null>(null)
  const [strokes, setStrokes] = useState<AnnotationStroke[]>([])
  const [draftStroke, setDraftStroke] = useState<AnnotationStroke | null>(null)
  const [tool, setTool] = useState<Tool>('brush')
  const [color, setColor] = useState<string>(COLORS[0].value)
  const [strokeWidth, setStrokeWidth] = useState<number>(4)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const viewport = useViewportSize()
  const fileName = imagePath.split(/[\\/]/).pop() || imagePath

  const setDraft = useCallback((stroke: AnnotationStroke | null) => {
    draftRef.current = stroke
    setDraftStroke(stroke)
  }, [])

  useEffect(() => {
    // The component is keyed by imagePath, so initial state is already fresh
    // for each capture; this effect only loads the image.
    let cancelled = false
    let objectUrl = ''

    void (async () => {
      const response = await invoke<number[] | ArrayBuffer | Uint8Array>('read_capture_file', { dir: captureDir, path: imagePath })
      if (cancelled) return
      const source = response instanceof Uint8Array
        ? response
        : response instanceof ArrayBuffer
          ? new Uint8Array(response)
          : new Uint8Array(response)
      const bytes = new Uint8Array(new ArrayBuffer(source.byteLength))
      bytes.set(source)
      const blob = new Blob([bytes], { type: 'image/png' })
      objectUrl = URL.createObjectURL(blob)
      const image = new Image()
      image.src = objectUrl
      await image.decode()
      if (cancelled) return
      baseImageRef.current = image
      setImageSize({ width: image.naturalWidth, height: image.naturalHeight })
      setLoading(false)
    })().catch((caught) => {
      if (cancelled) return
      setError(formatError(caught, 'Could not load capture'))
      setLoading(false)
    })

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [captureDir, imagePath])

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const image = baseImageRef.current
    if (!canvas || !image || !imageSize) return
    canvas.width = imageSize.width
    canvas.height = imageSize.height
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, imageSize.width, imageSize.height)
    context.drawImage(image, 0, 0, imageSize.width, imageSize.height)
    for (const stroke of strokes) drawAnnotationStroke(context, stroke)
    if (draftStroke) drawAnnotationStroke(context, draftStroke)
  }, [draftStroke, imageSize, strokes])

  const displaySize = useMemo(() => {
    if (!imageSize) return null
    const maxWidth = Math.max(280, viewport.width - 96)
    const maxHeight = Math.max(220, viewport.height - 260)
    return scaledImageDisplaySize(imageSize, { width: maxWidth, height: maxHeight })
  }, [imageSize, viewport.height, viewport.width])

  const pointFromEvent = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas || !imageSize) return null
    const bounds = canvas.getBoundingClientRect()
    return mapCssPointToImagePoint(
      { x: event.clientX, y: event.clientY },
      { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
      imageSize,
    )
  }, [imageSize])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = pointFromEvent(event)
    if (!point) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, start: point, tool }
    setError('')
    if (tool === 'brush') {
      setDraft({ kind: 'brush', color, width: strokeWidth, points: [point] })
    } else {
      setDraft({ kind: 'rect', color, width: strokeWidth, rect: normalizeRectFromDrag(point, point) })
    }
  }, [color, pointFromEvent, setDraft, strokeWidth, tool])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const point = pointFromEvent(event)
    if (!point) return
    const current = draftRef.current
    if (drag.tool === 'brush') {
      if (!current || current.kind !== 'brush') return
      setDraft({ ...current, points: appendPoint(current.points, point) })
    } else {
      setDraft({ kind: 'rect', color, width: strokeWidth, rect: normalizeRectFromDrag(drag.start, point) })
    }
  }, [color, pointFromEvent, setDraft, strokeWidth])

  const finishPointerStroke = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const point = pointFromEvent(event)
    let completed = draftRef.current
    if (point && completed?.kind === 'brush') {
      completed = { ...completed, points: appendPoint(completed.points, point) }
    } else if (point && completed?.kind === 'rect') {
      completed = { ...completed, rect: normalizeRectFromDrag(drag.start, point) }
    }

    if (completed?.kind === 'brush' && completed.points.length > 1) {
      setStrokes((current) => addStroke(current, completed))
    } else if (completed?.kind === 'rect' && completed.rect.width > 0 && completed.rect.height > 0) {
      setStrokes((current) => addStroke(current, completed))
    }

    dragRef.current = null
    setDraft(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [pointFromEvent, setDraft])

  const cancelPointerStroke = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null
      setDraft(null)
    }
  }, [setDraft])

  const clearAnnotations = useCallback(() => {
    setStrokes([])
    setDraft(null)
    setError('')
  }, [setDraft])

  const copyAnnotatedImage = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !imageSize || copyState === 'copying') return
    setCopyState('copying')
    setError('')
    canvas.toBlob((blob) => {
      if (!blob) {
        setError('Could not export annotated image')
        setCopyState('idle')
        return
      }
      void (async () => {
        const buffer = await blob.arrayBuffer()
        await invoke('clipboard_write_image', { pngBytes: Array.from(new Uint8Array(buffer)) })
        setCopyState('copied')
        if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current)
        copyResetTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1200)
      })().catch((caught) => {
        setError(formatError(caught, 'Could not copy annotated image'))
        setCopyState('idle')
      })
    }, 'image/png')
  }, [copyState, imageSize])

  return (
    <div className="capture-annotator-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="capture-annotator-dialog" role="dialog" aria-modal="true" aria-labelledby="capture-annotator-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="capture-annotator-header">
          <div>
            <p className="settings-eyebrow">Screenshot annotation</p>
            <h2 id="capture-annotator-title">Mark up capture</h2>
            <span>{fileName}</span>
          </div>
          <button type="button" className="settings-close" title="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </header>

        <div className="capture-annotator-toolbar" aria-label="Annotation tools">
          <div className="capture-annotator-tool-group" role="group" aria-label="Tool">
            <button type="button" className="capture-annotator-tool" aria-pressed={tool === 'brush'} onClick={() => setTool('brush')}>
              <Brush size={14} /> Brush
            </button>
            <button type="button" className="capture-annotator-tool" aria-pressed={tool === 'rect'} onClick={() => setTool('rect')}>
              <Square size={14} /> Rectangle
            </button>
          </div>
          <div className="capture-annotator-tool-group" role="group" aria-label="Color">
            {COLORS.map((swatch) => (
              <button
                key={swatch.value}
                type="button"
                className="capture-annotator-swatch"
                style={{ '--capture-swatch': swatch.value } as CSSProperties}
                aria-label={swatch.label}
                aria-pressed={color === swatch.value}
                onClick={() => setColor(swatch.value)}
              />
            ))}
          </div>
          <div className="capture-annotator-tool-group" role="group" aria-label="Stroke width">
            {STROKE_WIDTHS.map((width) => (
              <button key={width} type="button" className="capture-annotator-tool" aria-pressed={strokeWidth === width} onClick={() => setStrokeWidth(width)}>
                {width}px
              </button>
            ))}
          </div>
          <div className="capture-annotator-tool-group capture-annotator-history" role="group" aria-label="History">
            <button type="button" className="secondary-action" disabled={strokes.length === 0} onClick={() => setStrokes((current) => undoStroke(current))}>
              <RotateCcw size={14} /> Undo
            </button>
            <button type="button" className="secondary-action" disabled={strokes.length === 0 && !draftStroke} onClick={clearAnnotations}>
              <Trash2 size={14} /> Clear
            </button>
          </div>
        </div>

        <div className="capture-annotator-canvas-shell">
          {imageSize && displaySize ? (
            <canvas
              ref={canvasRef}
              className="capture-annotator-canvas"
              width={imageSize.width}
              height={imageSize.height}
              style={{ width: displaySize.width, height: displaySize.height }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={finishPointerStroke}
              onPointerCancel={cancelPointerStroke}
            />
          ) : (
            <div className="capture-annotator-empty">{loading ? 'Loading capture…' : error || 'No capture loaded'}</div>
          )}
        </div>

        <footer className="capture-annotator-footer">
          <span className={error ? 'capture-annotator-error' : 'capture-annotator-status'}>
            {error || (copyState === 'copied' ? 'Annotated image copied to clipboard.' : 'Draw with brush or hollow rectangles, then copy to paste elsewhere.')}
          </span>
          <div className="capture-annotator-actions">
            <button type="button" className="secondary-action" onClick={onClose}>Close</button>
            <button type="button" className="primary-action" disabled={!imageSize || copyState === 'copying'} onClick={copyAnnotatedImage}>
              {copyState === 'copied' ? <Check size={14} /> : <Copy size={14} />}
              {copyState === 'copying' ? 'Copying…' : copyState === 'copied' ? 'Copied' : 'Copy'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}

function appendPoint(points: readonly AnnotationPoint[], point: AnnotationPoint): AnnotationPoint[] {
  const last = points[points.length - 1]
  if (last && last.x === point.x && last.y === point.y) return [...points]
  return [...points, point]
}

function drawAnnotationStroke(context: CanvasRenderingContext2D, stroke: AnnotationStroke): void {
  context.save()
  context.strokeStyle = stroke.color
  context.lineWidth = stroke.width
  context.lineCap = 'round'
  context.lineJoin = 'round'
  if (stroke.kind === 'brush') {
    context.beginPath()
    const [first, ...rest] = stroke.points
    if (first) {
      context.moveTo(first.x, first.y)
      for (const point of rest) context.lineTo(point.x, point.y)
      context.stroke()
    }
  } else {
    context.strokeRect(stroke.rect.x, stroke.rect.y, stroke.rect.width, stroke.rect.height)
  }
  context.restore()
}

function formatError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return fallback
}

function useViewportSize() {
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))

  useEffect(() => {
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  return viewport
}
