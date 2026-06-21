import { invoke } from '@tauri-apps/api/core'
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { emit } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { captureFileName, evenFloor, placeControlBar } from './captureOverlay'

type CaptureMode = 'image' | 'video'

type CaptureConfig = {
  mode: CaptureMode
  dir: string
  ffmpeg: string
}

declare global {
  interface Window {
    __AWT_CAPTURE__?: Partial<CaptureConfig>
  }
}

type CaptureRect = {
  x: number
  y: number
  w: number
  h: number
}

type Point = {
  x: number
  y: number
}

const SELECT_BAR_WIDTH = 286
const SELECT_BAR_HEIGHT = 44
const RECORDING_BAR_WIDTH = 220
const RECORDING_BAR_HEIGHT = 44
const MIN_REGION_SIZE = 2
const accent = '#38bdf8'

const baseButtonStyle: CSSProperties = {
  height: 30,
  border: '1px solid rgba(148, 163, 184, 0.45)',
  borderRadius: 8,
  background: 'rgba(15, 23, 42, 0.9)',
  color: '#e5edf7',
  cursor: 'pointer',
  font: '12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  padding: '0 12px',
}

const primaryButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  borderColor: 'rgba(56, 189, 248, 0.85)',
  background: 'rgba(8, 145, 178, 0.95)',
  color: '#ffffff',
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max)
}

function normalizeRect(a: Point, b: Point): CaptureRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
}

function pointFromEvent(event: ReactPointerEvent<HTMLElement>): Point {
  return {
    x: clamp(event.clientX, 0, window.innerWidth),
    y: clamp(event.clientY, 0, window.innerHeight),
  }
}

function isUsableRect(rect: CaptureRect | null): rect is CaptureRect {
  return Boolean(rect && rect.w >= MIN_REGION_SIZE && rect.h >= MIN_REGION_SIZE)
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Capture failed'
}

function physicalSizeLabel(rect: CaptureRect): string {
  const dpr = window.devicePixelRatio || 1
  return `${Math.round(rect.w * dpr)}x${Math.round(rect.h * dpr)}`
}

function useElapsedTimer(phase: 'select' | 'recording', setElapsed: (value: number | ((value: number) => number)) => void) {
  useEffect(() => {
    if (phase !== 'recording') return undefined
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [phase, setElapsed])
}

function useViewportSize() {
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))

  useEffect(() => {
    const update = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  return viewport
}

function RecordingControls({ elapsed, error, onStop }: { elapsed: number; error: string; onStop: () => void }) {
  return (
    <div style={recordingShellStyle} onPointerDown={(event) => event.stopPropagation()}>
      <span style={timerStyle}>{formatElapsed(elapsed)}</span>
      <button type="button" style={primaryButtonStyle} onClick={onStop}>Stop</button>
      {error ? <span style={recordingErrorStyle}>{error}</span> : null}
    </div>
  )
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
}

export default function CaptureOverlay() {
  const cfg = window.__AWT_CAPTURE__ ?? { mode: 'image', dir: '', ffmpeg: '' }
  const mode: CaptureMode = cfg.mode === 'video' ? 'video' : 'image'
  const [phase, setPhase] = useState<'select' | 'recording'>('select')
  const [rect, setRect] = useState<CaptureRect | null>(null)
  const [error, setError] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const viewport = useViewportSize()
  const dragStartRef = useRef<Point | null>(null)
  const pointerIdRef = useRef<number | null>(null)
  const selectedRect = isUsableRect(rect) ? rect : null

  useElapsedTimer(phase, setElapsed)

  const closeOverlay = useCallback(() => {
    void (async () => {
      const win = getCurrentWindow()
      if (phase === 'recording') {
        try {
          const path = await invoke<string>('stop_video_capture')
          await emit('capture://saved', { mode: 'video', path })
        } catch (stopError) {
          void stopError
        }
      }
      await win.close()
    })()
  }, [phase])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeOverlay()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeOverlay])

  const selectFullScreen = useCallback(() => {
    setError('')
    setRect({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight })
  }, [])

  const requireRect = useCallback(() => {
    if (selectedRect) return selectedRect
    setError('Select a region first.')
    return null
  }, [selectedRect])

  const captureImage = useCallback(async () => {
    const targetRect = requireRect()
    if (!targetRect) return

    setError('')
    const win = getCurrentWindow()
    try {
      const pos = await win.outerPosition()
      const dpr = window.devicePixelRatio || 1
      const path = await invoke<string>('capture_region_image', {
        dir: cfg.dir,
        fileName: captureFileName('image'),
        monitorX: pos.x,
        monitorY: pos.y,
        x: Math.round(targetRect.x * dpr),
        y: Math.round(targetRect.y * dpr),
        w: Math.round(targetRect.w * dpr),
        h: Math.round(targetRect.h * dpr),
      })
      await emit('capture://saved', { mode: 'image', path })
      await win.close()
    } catch (captureError) {
      setError(formatError(captureError))
    }
  }, [cfg.dir, requireRect])

  const startVideo = useCallback(async () => {
    const targetRect = requireRect()
    if (!targetRect) return

    setError('')
    const win = getCurrentWindow()
    let originalPosition: PhysicalPosition | null = null
    let originalSize: PhysicalSize | null = null

    try {
      originalPosition = await win.outerPosition()
      originalSize = await win.innerSize()
      const dpr = window.devicePixelRatio || 1
      const offsetX = originalPosition.x + Math.round(targetRect.x * dpr)
      const offsetY = originalPosition.y + Math.round(targetRect.y * dpr)
      const w = evenFloor(targetRect.w * dpr)
      const h = evenFloor(targetRect.h * dpr)
      const bar = placeControlBar(targetRect, { w: viewport.w, h: viewport.h }, RECORDING_BAR_WIDTH, RECORDING_BAR_HEIGHT)

      await win.setSize(new PhysicalSize(Math.round(RECORDING_BAR_WIDTH * dpr), Math.round(RECORDING_BAR_HEIGHT * dpr)))
      await win.setPosition(new PhysicalPosition(Math.round(originalPosition.x + bar.x * dpr), Math.round(originalPosition.y + bar.y * dpr)))
      await invoke<string>('start_video_capture', {
        dir: cfg.dir,
        fileName: captureFileName('video'),
        ffmpegPath: cfg.ffmpeg,
        offsetX,
        offsetY,
        w,
        h,
      })
      setElapsed(0)
      setPhase('recording')
    } catch (startError) {
      if (originalPosition && originalSize) await Promise.allSettled([win.setPosition(originalPosition), win.setSize(originalSize)])
      setError(formatError(startError))
      setPhase('select')
    }
  }, [cfg.dir, cfg.ffmpeg, requireRect, viewport.h, viewport.w])

  const stopVideo = useCallback(async () => {
    setError('')
    const win = getCurrentWindow()
    try {
      const path = await invoke<string>('stop_video_capture')
      await emit('capture://saved', { mode: 'video', path })
      await win.close()
    } catch (stopError) {
      setError(formatError(stopError))
    }
  }, [])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (phase !== 'select' || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = pointFromEvent(event)
    pointerIdRef.current = event.pointerId
    dragStartRef.current = point
    setError('')
    setRect({ x: point.x, y: point.y, w: 0, h: 0 })
  }, [phase])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (phase !== 'select' || pointerIdRef.current !== event.pointerId || !dragStartRef.current) return
    event.preventDefault()
    setRect(normalizeRect(dragStartRef.current, pointFromEvent(event)))
  }, [phase])

  const finishPointerDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (phase !== 'select' || pointerIdRef.current !== event.pointerId) return
    event.preventDefault()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (dragStartRef.current) setRect(normalizeRect(dragStartRef.current, pointFromEvent(event)))
    pointerIdRef.current = null
    dragStartRef.current = null
  }, [phase])

  const barPosition = useMemo(() => {
    if (!selectedRect) return null
    return placeControlBar(selectedRect, viewport, SELECT_BAR_WIDTH, SELECT_BAR_HEIGHT)
  }, [selectedRect, viewport])

  if (phase === 'recording') {
    return (
      <div style={recordingRootStyle} onContextMenu={(event) => { event.preventDefault(); closeOverlay() }}>
        <RecordingControls elapsed={elapsed} error={error} onStop={() => void stopVideo()} />
      </div>
    )
  }

  return (
    <div
      style={rootStyle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishPointerDrag}
      onPointerCancel={finishPointerDrag}
      onContextMenu={(event) => { event.preventDefault(); closeOverlay() }}
    >
      {rect ? <SelectionMasks rect={rect} viewport={viewport} /> : <div style={fullDimStyle} />}
      {selectedRect ? <SelectionOutline rect={selectedRect} /> : null}
      {barPosition && selectedRect ? (
        <div style={{ ...selectBarStyle, left: barPosition.x, top: barPosition.y }} onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" style={primaryButtonStyle} onClick={() => { void (mode === 'image' ? captureImage() : startVideo()) }}>
            {mode === 'image' ? 'Capture' : 'Start'}
          </button>
          <button type="button" style={baseButtonStyle} onClick={selectFullScreen}>Full screen</button>
          <button type="button" style={baseButtonStyle} onClick={closeOverlay}>Cancel</button>
        </div>
      ) : (
        <div style={emptyStateStyle} onPointerDown={(event) => event.stopPropagation()}>
          <span style={hintStyle}>Drag to select a region</span>
          <button type="button" style={baseButtonStyle} onClick={selectFullScreen}>Full screen</button>
          <button type="button" style={baseButtonStyle} onClick={closeOverlay}>Cancel</button>
        </div>
      )}
      {error ? <div style={errorStyle}>{error}</div> : null}
    </div>
  )
}

function SelectionMasks({ rect, viewport }: { rect: CaptureRect; viewport: { w: number; h: number } }) {
  const right = Math.max(0, viewport.w - rect.x - rect.w)
  const bottom = Math.max(0, viewport.h - rect.y - rect.h)

  return (
    <>
      <div style={{ ...maskStyle, left: 0, top: 0, width: viewport.w, height: rect.y }} />
      <div style={{ ...maskStyle, left: 0, top: rect.y, width: rect.x, height: rect.h }} />
      <div style={{ ...maskStyle, right: 0, top: rect.y, width: right, height: rect.h }} />
      <div style={{ ...maskStyle, left: 0, bottom: 0, width: viewport.w, height: bottom }} />
    </>
  )
}

function SelectionOutline({ rect }: { rect: CaptureRect }) {
  return (
    <>
      <div style={{ ...outlineStyle, left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />
      <div style={{ ...labelStyle, left: rect.x + 8, top: Math.max(8, rect.y + 8) }}>{physicalSizeLabel(rect)}</div>
    </>
  )
}

const rootStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  overflow: 'hidden',
  cursor: 'crosshair',
  userSelect: 'none',
  background: 'transparent',
  color: '#e5edf7',
  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
}

const recordingRootStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  overflow: 'hidden',
  userSelect: 'none',
  background: 'rgba(15, 23, 42, 0.96)',
  color: '#e5edf7',
  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
}

const maskStyle: CSSProperties = {
  position: 'absolute',
  background: 'rgba(0, 0, 0, 0.35)',
  pointerEvents: 'none',
}

const fullDimStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.28)',
  pointerEvents: 'none',
}

const outlineStyle: CSSProperties = {
  position: 'absolute',
  boxSizing: 'border-box',
  border: `1px solid ${accent}`,
  boxShadow: `0 0 0 1px rgba(15, 23, 42, 0.65), 0 0 18px rgba(56, 189, 248, 0.45)`,
  pointerEvents: 'none',
}

const labelStyle: CSSProperties = {
  position: 'absolute',
  padding: '3px 7px',
  borderRadius: 999,
  background: 'rgba(15, 23, 42, 0.92)',
  border: '1px solid rgba(56, 189, 248, 0.65)',
  color: '#e0f2fe',
  fontSize: 12,
  lineHeight: 1.2,
  pointerEvents: 'none',
}

const selectBarStyle: CSSProperties = {
  position: 'absolute',
  zIndex: 3,
  width: SELECT_BAR_WIDTH,
  height: SELECT_BAR_HEIGHT,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  borderRadius: 12,
  border: '1px solid rgba(148, 163, 184, 0.4)',
  background: 'rgba(15, 23, 42, 0.94)',
  boxShadow: '0 18px 55px rgba(0, 0, 0, 0.35)',
  cursor: 'default',
}

const emptyStateStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: 28,
  transform: 'translateX(-50%)',
  zIndex: 3,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  borderRadius: 12,
  border: '1px solid rgba(148, 163, 184, 0.4)',
  background: 'rgba(15, 23, 42, 0.94)',
  boxShadow: '0 18px 55px rgba(0, 0, 0, 0.35)',
  cursor: 'default',
}

const hintStyle: CSSProperties = {
  color: '#cbd5e1',
  fontSize: 12,
  padding: '0 6px',
  whiteSpace: 'nowrap',
}

const errorStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: 24,
  transform: 'translateX(-50%)',
  zIndex: 4,
  maxWidth: 'min(680px, calc(100vw - 48px))',
  padding: '8px 12px',
  borderRadius: 10,
  border: '1px solid rgba(248, 113, 113, 0.55)',
  background: 'rgba(127, 29, 29, 0.92)',
  color: '#fee2e2',
  fontSize: 12,
  boxShadow: '0 16px 45px rgba(0, 0, 0, 0.35)',
}

const recordingShellStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  cursor: 'default',
}

const timerStyle: CSSProperties = {
  minWidth: 44,
  color: '#e0f2fe',
  fontVariantNumeric: 'tabular-nums',
  fontSize: 13,
}

const recordingErrorStyle: CSSProperties = {
  position: 'absolute',
  left: 8,
  right: 8,
  bottom: 2,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: '#fecaca',
  fontSize: 10,
}
