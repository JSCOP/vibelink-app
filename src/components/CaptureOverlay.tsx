import { invoke } from '@tauri-apps/api/core'
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { emit, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { captureFileName, evenFloor, intersectsAnyMonitor, monitorAt, monitorGapRects, placeControlBar, toVirtualRect } from './captureOverlay'
import type { VirtualScreen } from './captureOverlay'

type CaptureMode = 'image' | 'quick' | 'video'

type CaptureConfig = {
  mode: CaptureMode
  dir: string
  ffmpeg: string
  screen: VirtualScreen
}

declare global {
  interface Window {
    __VIBELINK_CAPTURE__?: Partial<CaptureConfig>
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
// The capture overlay runs in a transparent utility window before app theme tokens are available.
const overlayPalette = {
  accent: '#38bdf8',
  buttonBorder: 'rgba(148, 163, 184, 0.45)',
  buttonBorderSoft: 'rgba(148, 163, 184, 0.4)',
  buttonBackground: 'rgba(15, 23, 42, 0.9)',
  chromeBackground: 'rgba(15, 23, 42, 0.94)',
  recordingBackground: 'rgba(15, 23, 42, 0.96)',
  text: '#e5edf7',
  textMuted: '#cbd5e1',
  textInfo: '#e0f2fe',
  textOnAccent: '#ffffff',
  primaryBorder: 'rgba(56, 189, 248, 0.85)',
  primaryBackground: 'rgba(8, 145, 178, 0.95)',
  mask: 'rgba(0, 0, 0, 0.35)',
  dim: 'rgba(0, 0, 0, 0.28)',
  // Opaque, not dimmed: the virtual-desktop bounding box includes areas no
  // display covers, and capturing there would yield blank pixels.
  gap: 'rgba(2, 6, 16, 0.97)',
  shadow: 'rgba(0, 0, 0, 0.35)',
  outlineRing: 'rgba(15, 23, 42, 0.65)',
  outlineShadow: 'rgba(56, 189, 248, 0.45)',
  accentBorder: 'rgba(56, 189, 248, 0.65)',
  dangerBorder: 'rgba(248, 113, 113, 0.55)',
  dangerBackground: 'rgba(127, 29, 29, 0.92)',
  dangerText: '#fee2e2',
  dangerTextSoft: '#fecaca',
} as const

const baseButtonStyle: CSSProperties = {
  height: 30,
  border: `1px solid ${overlayPalette.buttonBorder}`,
  borderRadius: 8,
  background: overlayPalette.buttonBackground,
  color: overlayPalette.text,
  cursor: 'pointer',
  font: '12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  padding: '0 12px',
}

const primaryButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  borderColor: overlayPalette.primaryBorder,
  background: overlayPalette.primaryBackground,
  color: overlayPalette.textOnAccent,
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
  const cfg = window.__VIBELINK_CAPTURE__ ?? { mode: 'image', dir: '', ffmpeg: '' }
  // A single-monitor fallback keeps the overlay usable if the native payload is
  // ever missing; every capture path below works in virtual-screen coordinates.
  // The native payload is injected once before load, so a stable identity here
  // keeps every capture callback from being rebuilt on each render.
  const screen: VirtualScreen = useMemo(() => cfg.screen ?? {
    bounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
    monitors: [{ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }],
  }, [cfg.screen])
  const mode: CaptureMode = cfg.mode === 'video' || cfg.mode === 'quick' ? cfg.mode : 'image'
  const [phase, setPhase] = useState<'select' | 'recording'>('select')
  const [rect, setRect] = useState<CaptureRect | null>(null)
  const [error, setError] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const viewport = useViewportSize()
  const dragStartRef = useRef<Point | null>(null)
  const pointerIdRef = useRef<number | null>(null)
  // Last pointer position in overlay-local CSS pixels, so "Full screen" can
  // resolve which display the user is on without an extra native round trip.
  const hoverPointRef = useRef<Point | null>(null)
  const captureInProgressRef = useRef(false)
  const localStopInProgressRef = useRef(false)
  const selectedRect = isUsableRect(rect) ? rect : null

  useElapsedTimer(phase, setElapsed)

  const closeOverlay = useCallback(() => {
    void (async () => {
      const win = getCurrentWindow()
      if (phase === 'recording') {
        localStopInProgressRef.current = true
        try {
          const path = await invoke<string>('stop_video_capture')
          await emit('capture://saved', { mode: 'video', path })
        } catch (stopError) {
          localStopInProgressRef.current = false
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

  useEffect(() => {
    if (phase !== 'recording') return undefined
    const unlisten = listen('capture://recording-stopped', () => {
      if (localStopInProgressRef.current) return
      void getCurrentWindow().close()
    })
    return () => { void unlisten.then((dispose) => dispose()) }
  }, [phase])

  // "Full screen" means the display under the pointer, not the whole virtual
  // desktop: that bounding box includes uncovered gaps and, on mixed layouts,
  // is far larger than anything the user wants in one image.
  const selectFullScreen = useCallback(() => {
    setError('')
    const dpr = window.devicePixelRatio || 1
    const point = hoverPointRef.current
    const virtualPoint = point
      ? { x: Math.round(point.x * dpr) + screen.bounds.x, y: Math.round(point.y * dpr) + screen.bounds.y }
      : null
    const monitor = (virtualPoint && monitorAt(screen, virtualPoint.x, virtualPoint.y)) ?? screen.monitors[0]
    if (!monitor) {
      setRect({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight })
      return
    }
    setRect({
      x: (monitor.x - screen.bounds.x) / dpr,
      y: (monitor.y - screen.bounds.y) / dpr,
      w: monitor.width / dpr,
      h: monitor.height / dpr,
    })
  }, [screen])

  const requireRect = useCallback(() => {
    if (selectedRect) return selectedRect
    setError('Select a region first.')
    return null
  }, [selectedRect])

  const captureImageRect = useCallback(async (targetRect: CaptureRect, savedMode: 'image' | 'quick') => {
    if (!isUsableRect(targetRect)) {
      setError('Select a region first.')
      return
    }
    if (captureInProgressRef.current) return

    const dpr = window.devicePixelRatio || 1
    const virtualRect = toVirtualRect(targetRect, screen.bounds, dpr)
    if (!intersectsAnyMonitor(screen, { x: virtualRect.x, y: virtualRect.y, w: virtualRect.width, h: virtualRect.height })) {
      setError('That area is outside every display.')
      return
    }

    captureInProgressRef.current = true
    setError('')
    const win = getCurrentWindow()
    try {
      const path = await invoke<string>('capture_region_image', {
        dir: cfg.dir,
        fileName: captureFileName(savedMode),
        x: virtualRect.x,
        y: virtualRect.y,
        w: virtualRect.width,
        h: virtualRect.height,
      })
      await emit('capture://saved', { mode: savedMode, path })
      await win.close()
    } catch (captureError) {
      captureInProgressRef.current = false
      setError(formatError(captureError))
    }
  }, [cfg.dir, screen])

  const captureImage = useCallback(async () => {
    const targetRect = requireRect()
    if (!targetRect) return
    await captureImageRect(targetRect, 'image')
  }, [captureImageRect, requireRect])

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
      // gdigrab offsets are virtual-desktop coordinates and accept negatives,
      // so a region on a monitor left of / above the primary one records fine.
      const virtualRect = toVirtualRect(targetRect, screen.bounds, dpr)
      if (!intersectsAnyMonitor(screen, { x: virtualRect.x, y: virtualRect.y, w: virtualRect.width, h: virtualRect.height })) {
        setError('That area is outside every display.')
        return
      }
      const w = evenFloor(virtualRect.width)
      const h = evenFloor(virtualRect.height)
      const bar = placeControlBar(targetRect, { w: viewport.w, h: viewport.h }, RECORDING_BAR_WIDTH, RECORDING_BAR_HEIGHT)

      await win.setSize(new PhysicalSize(Math.round(RECORDING_BAR_WIDTH * dpr), Math.round(RECORDING_BAR_HEIGHT * dpr)))
      await win.setPosition(new PhysicalPosition(Math.round(originalPosition.x + bar.x * dpr), Math.round(originalPosition.y + bar.y * dpr)))
      await invoke<string>('start_video_capture', {
        dir: cfg.dir,
        fileName: captureFileName('video'),
        ffmpegPath: cfg.ffmpeg,
        offsetX: virtualRect.x,
        offsetY: virtualRect.y,
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
  }, [cfg.dir, cfg.ffmpeg, requireRect, screen, viewport.h, viewport.w])

  const stopVideo = useCallback(async () => {
    setError('')
    const win = getCurrentWindow()
    try {
      localStopInProgressRef.current = true
      const path = await invoke<string>('stop_video_capture')
      await emit('capture://saved', { mode: 'video', path })
      await win.close()
    } catch (stopError) {
      localStopInProgressRef.current = false
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
    hoverPointRef.current = pointFromEvent(event)
    if (phase !== 'select' || pointerIdRef.current !== event.pointerId || !dragStartRef.current) return
    event.preventDefault()
    setRect(normalizeRect(dragStartRef.current, pointFromEvent(event)))
  }, [phase])

  const finishPointerDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (phase !== 'select' || pointerIdRef.current !== event.pointerId) return
    event.preventDefault()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const completedRect = dragStartRef.current ? normalizeRect(dragStartRef.current, pointFromEvent(event)) : null
    if (completedRect) setRect(completedRect)
    pointerIdRef.current = null
    dragStartRef.current = null
    if (mode === 'quick' && completedRect && event.type === 'pointerup') {
      void captureImageRect(completedRect, 'quick')
    }
  }, [captureImageRect, mode, phase])

  const barPosition = useMemo(() => {
    if (!selectedRect || mode === 'quick') return null
    return placeControlBar(selectedRect, viewport, SELECT_BAR_WIDTH, SELECT_BAR_HEIGHT)
  }, [mode, selectedRect, viewport])

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
      <MonitorGaps screen={screen} />
      {selectedRect ? <SelectionOutline rect={selectedRect} /> : null}
      {mode !== 'quick' && barPosition && selectedRect ? (
        <div style={{ ...selectBarStyle, left: barPosition.x, top: barPosition.y }} onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" style={primaryButtonStyle} onClick={() => { void (mode === 'video' ? startVideo() : captureImage()) }}>
            {mode === 'video' ? 'Start' : 'Capture'}
          </button>
          <button type="button" style={baseButtonStyle} onClick={selectFullScreen}>Full screen</button>
          <button type="button" style={baseButtonStyle} onClick={closeOverlay}>Cancel</button>
        </div>
      ) : (
        <div style={emptyStateStyle} onPointerDown={(event) => event.stopPropagation()}>
          <span style={hintStyle}>{mode === 'quick' ? 'Drag to quick capture a region' : 'Drag to select a region'}</span>
          {mode === 'quick' ? null : <button type="button" style={baseButtonStyle} onClick={selectFullScreen}>Full screen</button>}
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

// Areas of the virtual-desktop bounding box that no display covers. They are
// painted OPAQUE (not dimmed) so it is obvious nothing can be captured there;
// `intersectsAnyMonitor` rejects a selection that lands entirely inside them.
function MonitorGaps({ screen }: { screen: VirtualScreen }) {
  const dpr = window.devicePixelRatio || 1
  const gaps = useMemo(() => monitorGapRects(screen), [screen])
  if (gaps.length === 0) return null
  return (
    <>
      {gaps.map((gap) => (
        <div
          key={`${gap.x}:${gap.y}:${gap.width}:${gap.height}`}
          style={{
            ...gapStyle,
            left: (gap.x - screen.bounds.x) / dpr,
            top: (gap.y - screen.bounds.y) / dpr,
            width: gap.width / dpr,
            height: gap.height / dpr,
          }}
        />
      ))}
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
  color: overlayPalette.text,
  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
}

const recordingRootStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  overflow: 'hidden',
  userSelect: 'none',
  background: overlayPalette.recordingBackground,
  color: overlayPalette.text,
  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
}

const maskStyle: CSSProperties = {
  position: 'absolute',
  background: overlayPalette.mask,
  pointerEvents: 'none',
}

const fullDimStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: overlayPalette.dim,
  pointerEvents: 'none',
}

const gapStyle: CSSProperties = {
  position: 'absolute',
  background: overlayPalette.gap,
  pointerEvents: 'none',
}

const outlineStyle: CSSProperties = {
  position: 'absolute',
  boxSizing: 'border-box',
  border: `1px solid ${overlayPalette.accent}`,
  boxShadow: `0 0 0 1px ${overlayPalette.outlineRing}, 0 0 18px ${overlayPalette.outlineShadow}`,
  pointerEvents: 'none',
}

const labelStyle: CSSProperties = {
  position: 'absolute',
  padding: '3px 7px',
  borderRadius: 999,
  background: overlayPalette.chromeBackground,
  border: `1px solid ${overlayPalette.accentBorder}`,
  color: overlayPalette.textInfo,
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
  border: `1px solid ${overlayPalette.buttonBorderSoft}`,
  background: overlayPalette.chromeBackground,
  boxShadow: `0 18px 55px ${overlayPalette.shadow}`,
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
  border: `1px solid ${overlayPalette.buttonBorderSoft}`,
  background: overlayPalette.chromeBackground,
  boxShadow: `0 18px 55px ${overlayPalette.shadow}`,
  cursor: 'default',
}

const hintStyle: CSSProperties = {
  color: overlayPalette.textMuted,
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
  border: `1px solid ${overlayPalette.dangerBorder}`,
  background: overlayPalette.dangerBackground,
  color: overlayPalette.dangerText,
  fontSize: 12,
  boxShadow: `0 16px 45px ${overlayPalette.shadow}`,
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
  color: overlayPalette.textInfo,
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
  color: overlayPalette.dangerTextSoft,
  fontSize: 10,
}
