import './BrowserPanel.css'
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ChangeEvent, FocusEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ArrowLeft, ArrowRight, Crosshair, Ellipsis, ExternalLink, Import, Loader2, MessageSquarePlus, PenTool, RotateCw, SquareCode } from 'lucide-react'
// Explicit extension: `captureAnnotator.ts` (the stroke model) sits beside this
// component, and a bare specifier resolves to it on case-insensitive Windows.
import { CaptureAnnotator } from '../components/CaptureAnnotator.tsx'
import { BrowserAddressBar } from './BrowserAddressBar'
import { formatBrowserAnnotation } from './agentContext'
import { activeSurfaceVisible, browserPanelReducer, createBrowserPanelState, type BrowserGrabIntent } from './state'
import { recordBrowserVisit, recordBrowserVisitTitle } from './browserUrlHistory'
import type {
  BrowserAnnotation,
  BrowserCertificatePrompt,
  BrowserContentController,
  BrowserContentState,
  BrowserCookieImportSource,
  BrowserDialogPrompt,
  BrowserDeviceMetrics,
  BrowserLifecycleEvent,
  BrowserPage,
  BrowserPermissionPrompt,
  PhysicalBounds,
} from './types'

type BrowserPanelProps = {
  controller: BrowserContentController
  initialState: BrowserContentState
  captureDir?: string
  active: boolean
  focused: boolean
  workspaceVisible: boolean
  nativeSurfacesSuspended?: boolean
  onStateChange?: (state: BrowserContentState) => void
  onError?: (error: string) => void
  onTitleChange?: (title: string) => void
}

const devicePresets: Record<string, BrowserDeviceMetrics | null> = {
  desktop: null,
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
}

// Frames to keep re-measuring AFTER the host first becomes measurable, so the
// final settled geometry wins over a transitional one.
const POST_ACTIVATION_MEASURE_FRAMES = 8
// Hard ceiling on the wait for Dockview's render overlay to become visible
// (~2s at 60fps). Bounded so a panel that never becomes measurable — collapsed
// group, zero-size grid — cannot leave a permanent rAF loop running.
const POST_ACTIVATION_MEASURE_ATTEMPTS = 120
const IMPORT_HINT_HIDDEN_KEY = 'vibelink.browser.importHintHidden'

function importHintHidden(profileId: string): boolean {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(IMPORT_HINT_HIDDEN_KEY) ?? '[]')
    return Array.isArray(value) && value.includes(profileId)
  } catch {
    return false
  }
}

function hideImportHint(profileId: string): void {
  let hidden: string[] = []
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(IMPORT_HINT_HIDDEN_KEY) ?? '[]')
    if (Array.isArray(value)) hidden = value.filter((item): item is string => typeof item === 'string')
  } catch {
    // Replace malformed persisted state below.
  }
  if (hidden.includes(profileId)) return
  try {
    window.localStorage.setItem(IMPORT_HINT_HIDDEN_KEY, JSON.stringify([...hidden, profileId]))
  } catch {
    // The hint still hides for this session when storage is unavailable.
  }
}

function externalBrowserUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

function scheduleFrame(callback: FrameRequestCallback): number {
  if (typeof window.requestAnimationFrame === 'function') return window.requestAnimationFrame(callback)
  return window.setTimeout(() => callback(window.performance.now()), 16)
}

function cancelFrame(handle: number): void {
  if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(handle)
  else window.clearTimeout(handle)
}

function sameBounds(left: PhysicalBounds | null, right: PhysicalBounds | null): boolean {
  return left === right || (left !== null && right !== null
    && left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
    && left.scaleFactorMilli === right.scaleFactorMilli)
}

function lifecycleDetail(event: BrowserLifecycleEvent): Record<string, unknown> | null {
  if (!event.detail) return null
  try {
    const value: unknown = JSON.parse(event.detail)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function permissionPrompt(event: BrowserLifecycleEvent): BrowserPermissionPrompt | null {
  if (event.kind !== 'permission_requested') return null
  const detail = lifecycleDetail(event)
  if (typeof detail?.requestId !== 'string' || typeof detail.permission !== 'string') return null
  return { id: detail.requestId, pageId: event.pageId, origin: event.url ?? '', permission: detail.permission }
}

function certificatePrompt(event: BrowserLifecycleEvent): BrowserCertificatePrompt | null {
  if (event.kind !== 'certificate_error') return null
  const detail = lifecycleDetail(event)
  if (typeof detail?.requestId !== 'string' || typeof detail.errorCode !== 'string') return null
  return { id: detail.requestId, pageId: event.pageId, origin: event.url ?? '', errorCode: detail.errorCode }
}

function dialogPrompt(event: BrowserLifecycleEvent): BrowserDialogPrompt | null {
  if (event.kind !== 'dialog_requested') return null
  const detail = lifecycleDetail(event)
  const kind = detail?.kind
  if (typeof detail?.requestId !== 'string'
    || typeof detail.message !== 'string'
    || !['alert', 'confirm', 'prompt', 'before_unload'].includes(String(kind))) return null
  return {
    id: detail.requestId,
    pageId: event.pageId,
    origin: event.url ?? '',
    kind: kind as BrowserDialogPrompt['kind'],
    message: detail.message,
    defaultText: typeof detail.defaultText === 'string' ? detail.defaultText : null,
  }
}

// WebView2 raises one `PermissionRequested` PER FRAME, so a page whose iframes
// all ask for the same capability (Naver sign-in asks every login frame for
// `sensors`) produced a stack of identical, indistinguishable cards. Show ONE
// card per (permission, origin) — that is the whole decision the user can make
// — while keeping every underlying request id so the single click resolves all
// of them. Dropping a request instead would orphan its native deferral and
// hang that frame forever.
function groupPermissionPrompts(queue: BrowserPermissionPrompt[]): Array<{ key: string; permission: string; origin: string; requestIds: string[] }> {
  const groups = new Map<string, { key: string; permission: string; origin: string; requestIds: string[] }>()
  for (const request of queue) {
    const key = `${request.permission}\u0000${request.origin}`
    const existing = groups.get(key)
    if (existing) existing.requestIds.push(request.id)
    else groups.set(key, { key, permission: request.permission, origin: request.origin, requestIds: [request.id] })
  }
  return [...groups.values()]
}

// Raw WebView2 capability ids ("sensors", "midi_system_exclusive") are not
// answerable by a user. State what the page is actually asking for.
const permissionLabels: Record<string, string> = {
  microphone: 'Use your microphone',
  camera: 'Use your camera',
  geolocation: 'Know your location',
  notifications: 'Show notifications',
  clipboard_read: 'Read your clipboard',
  midi_system_exclusive: 'Use MIDI devices',
  window_management: 'Manage windows across your displays',
}

export function BrowserPanel({
  controller,
  initialState,
  captureDir = '',
  active,
  focused,
  workspaceVisible,
  nativeSurfacesSuspended = false,
  onStateChange,
  onError,
  onTitleChange,
}: BrowserPanelProps) {
  const [state, dispatch] = useReducer(browserPanelReducer, initialState, createBrowserPanelState)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [addressSuggestionsOpen, setAddressSuggestionsOpen] = useState(false)
  const [cookieImportOpen, setCookieImportOpen] = useState(false)
  const [cookieEndpoint, setCookieEndpoint] = useState('http://127.0.0.1:9222')
  const [cookieSource, setCookieSource] = useState<BrowserCookieImportSource | null>(null)
  const [cookieOrigins, setCookieOrigins] = useState<string[]>([])
  const [cookieConsent, setCookieConsent] = useState(false)
  const [cookieImportStatus, setCookieImportStatus] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [navigationActionPending, setNavigationActionPending] = useState(false)
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  const [importHintVisible, setImportHintVisible] = useState(() => !importHintHidden(initialState.profile.id))
  const [annotatingCapturePath, setAnnotatingCapturePath] = useState<string | null>(null)
  const [capturePending, setCapturePending] = useState(false)
  const addressInput = useRef<HTMLInputElement>(null)
  const surfaceHost = useRef<HTMLDivElement>(null)
  const surfaceEpoch = useRef(0)
  const activationRaf = useRef<number | null>(null)
  const resizeRaf = useRef<number | null>(null)
  const mounted = useRef(true)
  const navigationActionPendingRef = useRef(false)
  const authoritativeGeneration = useRef(initialState.page.navigationGeneration)
  const latestBounds = useRef<PhysicalBounds | null>(state.surfaceBounds)
  const lastPublishedSurface = useRef<{ bounds: PhysicalBounds | null; visible: boolean; focused: boolean } | null>(null)
  const page = state.page
  const externalUrl = useMemo(() => externalBrowserUrl(page.url), [page.url])
  const pageTitleRef = useRef(page.title)
  pageTitleRef.current = page.title
  useEffect(() => {
    recordBrowserVisitTitle(page.url, page.title)
  }, [page.url, page.title])
  const pendingPromptCount: number = state.permissionQueue.length + state.certificateQueue.length + state.dialogQueue.length
  const permissionGroups = useMemo(() => groupPermissionPrompts(state.permissionQueue), [state.permissionQueue])
  const navigationBlocked = navigationActionPending || page.loadState === 'loading'
  // Annotation no longer hides the native page: the annotation UI is an in-page
  // popover injected into the WebView itself, so the page must stay visible.
  const domSurfaceBlocker = addressSuggestionsOpen || overflowOpen || cookieImportOpen || annotatingCapturePath !== null || pendingPromptCount > 0
  const panelVisible = active
    && workspaceVisible
    && !nativeSurfacesSuspended
    && activeSurfaceVisible(state)
    && !domSurfaceBlocker
  const panelVisibleRef = useRef(false)
  const focusedRef = useRef(false)
  // A native child WebView2 owns the real Win32 keyboard focus while it is
  // focused, and there is no "unfocus" call — so DOM focus landing on this
  // panel's own chrome (address bar, buttons) does NOT take keystrokes back
  // from the page. The address bar then looked focused and silently swallowed
  // every character. Track chrome focus explicitly and publish `focused:false`
  // so the native side hands the focus HWND back to the host webview.
  const chromeFocused = useRef(false)
  const [chromeHasFocus, setChromeHasFocus] = useState(false)
  const nativeFocusWanted = focused && !chromeHasFocus && page.url !== 'about:blank'

  // These refs MUST be updated before any other layout effect runs.
  // `publishSurface` reads `panelVisibleRef`/`focusedRef` rather than the
  // render-scope values, and React runs layout effects in declaration order —
  // so a sync effect declared above this one would publish using the PREVIOUS
  // pass's visibility. That is exactly how an activated browser panel kept
  // sending `visible: false`: the page was loaded and the host was measurable,
  // but the native child was told to stay hidden, leaving a blank pane.
  useLayoutEffect(() => {
    panelVisibleRef.current = panelVisible
    focusedRef.current = nativeFocusWanted
  }, [nativeFocusWanted, panelVisible])

  useEffect(() => onStateChange?.(state), [onStateChange, state])
  useEffect(() => onTitleChange?.(page.title || 'Browser'), [onTitleChange, page.title])

  const reportError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    setOperationError(message)
    onError?.(message)
  }, [onError])

  const measureSurface = useCallback((): PhysicalBounds | null => {
    const element = surfaceHost.current
    if (!element || !element.isConnected || element.getClientRects().length === 0) return null
    const hostStyle = window.getComputedStyle(element)
    if (hostStyle.display === 'none' || hostStyle.visibility === 'hidden') return null
    const rectangle = element.getBoundingClientRect()
    if (![rectangle.left, rectangle.top, rectangle.right, rectangle.bottom, rectangle.width, rectangle.height].every(Number.isFinite)
      || rectangle.width <= 0
      || rectangle.height <= 0) return null

    let left = Math.max(0, rectangle.left)
    let top = Math.max(0, rectangle.top)
    let right = Math.min(window.innerWidth, rectangle.right)
    let bottom = Math.min(window.innerHeight, rectangle.bottom)
    for (let ancestor = element.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
      const style = window.getComputedStyle(ancestor)
      if (style.display === 'none' || style.visibility === 'hidden') return null
      const clipsX = style.overflowX !== 'visible'
      const clipsY = style.overflowY !== 'visible'
      if (!clipsX && !clipsY) continue
      const clip = ancestor.getBoundingClientRect()
      if (clipsX) {
        left = Math.max(left, clip.left)
        right = Math.min(right, clip.right)
      }
      if (clipsY) {
        top = Math.max(top, clip.top)
        bottom = Math.min(bottom, clip.bottom)
      }
    }
    if (right <= left || bottom <= top) return null

    const scale = window.devicePixelRatio || 1
    const x = Math.ceil(left * scale)
    const y = Math.ceil(top * scale)
    const physicalRight = Math.floor(right * scale)
    const physicalBottom = Math.floor(bottom * scale)
    if (physicalRight <= x || physicalBottom <= y) return null
    return {
      x,
      y,
      width: physicalRight - x,
      height: physicalBottom - y,
      scaleFactorMilli: Math.max(1, Math.round(scale * 1000)),
    }
  }, [])

  const publishSurface = useCallback((bounds: PhysicalBounds | null, epoch: number, force = false): Promise<void> => {
    if (!mounted.current || epoch !== surfaceEpoch.current) return Promise.resolve()
    const visible = panelVisibleRef.current && bounds !== null
    const next = { bounds, visible, focused: visible && focusedRef.current }
    const boundsChanged = !sameBounds(latestBounds.current, bounds)
    latestBounds.current = bounds
    if (boundsChanged) dispatch({ type: 'surfaceBoundsChanged', bounds })
    const previous = lastPublishedSurface.current
    if (!force && previous
      && sameBounds(previous.bounds, next.bounds)
      && previous.visible === next.visible
      && previous.focused === next.focused) return Promise.resolve()
    lastPublishedSurface.current = next
    return controller.setSurfaceState(page.id, next)
      .then(() => {
        if (mounted.current && epoch === surfaceEpoch.current) dispatch({ type: 'surfaceVisibilityChanged', visible })
      })
      .catch((error) => {
        if (epoch === surfaceEpoch.current) lastPublishedSurface.current = null
        if (mounted.current && epoch === surfaceEpoch.current) reportError(error)
        throw error
      })
  }, [controller, page.id, reportError])

  // Dockview re-shows a hidden content panel by flipping `visibility` on its
  // render overlay, and that overlay is repositioned/unhidden over the FOLLOWING
  // frames — the same settle lag the terminal overlays have. `measureSurface`
  // correctly refuses to measure a `visibility: hidden` ancestor and returns
  // null, so a fixed-length activation burst could spend every one of its
  // frames on a still-hidden overlay, publish `null` each time, and give up.
  // The native child then stayed hidden behind this panel's own opaque host:
  // the page was loaded (CDP reported the real title) but the user saw a blank
  // pane until some unrelated event happened to re-measure.
  //
  // Keep retrying until the host is actually measurable, then publish that
  // geometry plus a short tail of frames to catch the final settle position.
  useLayoutEffect(() => {
    const epoch = ++surfaceEpoch.current
    if (activationRaf.current !== null) cancelFrame(activationRaf.current)
    void publishSurface(null, epoch, true).catch(() => undefined)
    if (!panelVisible) return
    let attempts = 0
    let framesAfterFirstMeasurement = 0
    const measureFrame = () => {
      if (!mounted.current || epoch !== surfaceEpoch.current) return
      const bounds = measureSurface()
      // `force` because the bounds after a hide/show round-trip are usually
      // identical to the last published ones, and the equality guard would
      // otherwise skip the very update that makes the page visible again.
      if (bounds) void publishSurface(bounds, epoch, true).catch(() => undefined)
      attempts += 1
      if (bounds) framesAfterFirstMeasurement += 1
      const settled = framesAfterFirstMeasurement >= POST_ACTIVATION_MEASURE_FRAMES
      if (!settled && attempts < POST_ACTIVATION_MEASURE_ATTEMPTS) activationRaf.current = scheduleFrame(measureFrame)
    }
    activationRaf.current = scheduleFrame(measureFrame)
    return () => {
      if (activationRaf.current !== null) cancelFrame(activationRaf.current)
      activationRaf.current = null
    }
  }, [measureSurface, panelVisible, publishSurface])

  useEffect(() => {
    const element = surfaceHost.current
    if (!element) return
    const scheduleMeasurement = () => {
      if (resizeRaf.current !== null) cancelFrame(resizeRaf.current)
      const epoch = surfaceEpoch.current
      // A native child is not clipped by DOM ancestors. Hide it synchronously in the
      // serialized surface queue before accepting any geometry that may have moved.
      void publishSurface(null, epoch, true).catch(() => undefined)
      resizeRaf.current = scheduleFrame(() => {
        resizeRaf.current = null
        if (!mounted.current || epoch !== surfaceEpoch.current) return
        void publishSurface(panelVisibleRef.current ? measureSurface() : null, epoch).catch(() => undefined)
      })
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasurement)
    for (let target: Element | null = element; observer && target && target !== document.body; target = target.parentElement) observer.observe(target)
    const mutationObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(scheduleMeasurement)
    for (let target = element.parentElement; mutationObserver && target && target !== document.body; target = target.parentElement) {
      mutationObserver.observe(target, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'] })
    }
    window.addEventListener('resize', scheduleMeasurement)
    window.addEventListener('scroll', scheduleMeasurement, true)
    return () => {
      observer?.disconnect()
      mutationObserver?.disconnect()
      window.removeEventListener('resize', scheduleMeasurement)
      window.removeEventListener('scroll', scheduleMeasurement, true)
      if (resizeRaf.current !== null) cancelFrame(resizeRaf.current)
      resizeRaf.current = null
    }
  }, [measureSurface, publishSurface])

  useEffect(() => {
    const epoch = surfaceEpoch.current
    void publishSurface(latestBounds.current, epoch, true).catch(() => undefined)
  }, [nativeFocusWanted, page.url, publishSurface])

  useEffect(() => {
    if (!active || !workspaceVisible || nativeSurfacesSuspended || page.url !== 'about:blank') return
    const frame = scheduleFrame(() => {
      addressInput.current?.focus()
      addressInput.current?.select()
    })
    return () => cancelFrame(frame)
  }, [active, nativeSurfacesSuspended, page.id, page.navigationGeneration, page.url, workspaceVisible])

  // `mounted` gates every surface publish, so it MUST be re-armed on mount, not
  // only cleared on unmount. React StrictMode mounts, runs cleanup, then mounts
  // again with the SAME refs; a cleanup-only effect therefore latched
  // `mounted.current = false` forever and `publishSurface` silently returned on
  // its first line for the rest of the panel's life. The native page then never
  // received a `visible: true` surface and the user saw a permanently blank
  // pane over a page that had actually loaded.
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      surfaceEpoch.current += 1
      if (activationRaf.current !== null) cancelFrame(activationRaf.current)
      if (resizeRaf.current !== null) cancelFrame(resizeRaf.current)
      void controller.setSurfaceState(page.id, { bounds: null, visible: false, focused: false }).catch(() => undefined)
    }
  }, [controller, page.id])

  // Chrome focus is what decides whether the native child keeps the Win32
  // focus HWND. `onPointerDownCapture` matters as much as `onFocusCapture`:
  // clicking a toolbar button that never takes DOM focus must still pull the
  // keyboard back, otherwise the next keystroke goes to the page.
  const handleChromeFocus = useCallback(() => {
    chromeFocused.current = true
    setChromeHasFocus(true)
  }, [])

  // A blur inside the toolbar that lands on another toolbar control is not a
  // release; only a blur whose target leaves the chrome hands the page back.
  const handleChromeBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    chromeFocused.current = false
    setChromeHasFocus(false)
  }, [])

  useEffect(() => {
    if (!state.designMode) return
    const disarm = () => {
      void controller.setDesignMode(page.id, false)
        .then(() => dispatch({ type: 'designModeChanged', enabled: false }))
        .catch(reportError)
    }
    if (!active || !focused || !workspaceVisible) {
      disarm()
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      disarm()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, controller, focused, page.id, reportError, state.designMode, workspaceVisible])

  useEffect(() => {
    if (!copyNotice) return
    const timer = window.setTimeout(() => setCopyNotice(null), 2200)
    return () => window.clearTimeout(timer)
  }, [copyNotice])

  // Clipboard copy MUST go through the native command. The in-app browser hands
  // the OS keyboard focus to a native child WebView2, and
  // `navigator.clipboard.writeText` throws "Document is not focused" from a
  // host document that does not hold Win32 focus — exactly the state the user
  // is in while annotating a live page.
  const copyAnnotation = useCallback(async (annotation: BrowserAnnotation) => {
    const text = formatBrowserAnnotation(annotation)
    try {
      await invoke('clipboard_write_text', { text })
    } catch {
      await navigator.clipboard.writeText(text)
    }
    if (mounted.current) setCopyNotice('Annotation copied to the clipboard.')
  }, [])

  // WebView2 denies every `window.open`/`target="_blank"` popup, and until now
  // the denial was terminal: the click emitted `popup_requested` and nothing
  // else happened. Real sites route ordinary links that way (naver.com's 메일,
  // 카페, 뉴스 shortcuts are all `target="_blank"`), so those buttons looked
  // completely dead. Adopt the blocked target into THIS pane instead — the
  // single-pane browser has no tab strip to hand it to.
  const adoptBlockedPopup = useCallback((url: string) => {
    const target = url.trim()
    if (!target || !/^https?:/i.test(target)) return
    navigationActionPendingRef.current = true
    setNavigationActionPending(true)
    void controller.navigate(page.id, target)
      .then((result) => {
        if (!mounted.current) return
        if (result.navigationGeneration > authoritativeGeneration.current) {
          authoritativeGeneration.current = result.navigationGeneration
          dispatch({ type: 'navigationStarted', input: result.url, generation: result.navigationGeneration })
          dispatch({ type: 'navigationCommitted', url: result.url, generation: result.navigationGeneration })
        }
      })
      .catch((error) => {
        navigationActionPendingRef.current = false
        setNavigationActionPending(false)
        if (mounted.current) reportError(error)
      })
  }, [controller, page.id, reportError])

  useEffect(() => {
    if (!controller.subscribeLifecycle) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    void controller.subscribeLifecycle((event) => {
      if (cancelled) return
      if (event.pageId !== page.id || event.navigationGeneration < authoritativeGeneration.current) return
      authoritativeGeneration.current = Math.max(authoritativeGeneration.current, event.navigationGeneration)
      dispatch({ type: 'lifecycleReceived', event })
      // Commit carries the authoritative URL; `pageTitleRef` still holds the
      // page the user just left, so the title is corrected by the effect below.
      if (event.kind === 'navigation_committed' && event.url) recordBrowserVisit(event.url, '')
      const permission = permissionPrompt(event)
      if (permission) dispatch({ type: 'permissionQueued', request: permission })
      const certificate = certificatePrompt(event)
      if (certificate) dispatch({ type: 'certificateQueued', request: certificate })
      const dialog = dialogPrompt(event)
      if (dialog) dispatch({ type: 'dialogQueued', request: dialog })
      if (event.kind === 'popup_requested' && event.url) adoptBlockedPopup(event.url)
      if (event.kind === 'navigation_finished' || event.kind === 'navigation_failed') {
        navigationActionPendingRef.current = false
        setNavigationActionPending(false)
      }
    })
      .then((stop) => {
        if (cancelled) stop()
        else unsubscribe = stop
      })
      .catch(reportError)
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [adoptBlockedPopup, controller, page.id, reportError])

  useEffect(() => {
    if (!controller.subscribeDesignGrabs) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    void controller.subscribeDesignGrabs((grab) => {
      if (grab.pageId !== page.id || grab.navigationGeneration !== page.navigationGeneration) return
      const comment = grab.comment ?? ''
      void controller.createAnnotation(page.id, grab, comment)
        .then((annotation) => {
          if (cancelled) return
          if (state.grabIntent === 'annotate') {
            dispatch({ type: 'annotationCreated', annotation })
            return
          }
          return copyAnnotation(annotation)
        })
        .catch(reportError)
        .finally(() => {
          if (cancelled) return
          dispatch({ type: 'designModeChanged', enabled: false })
          void controller.setDesignMode(page.id, false).catch(reportError)
        })
    }).then((stop) => {
      if (cancelled) stop()
      else unsubscribe = stop
    }).catch(reportError)
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [controller, copyAnnotation, page.id, page.navigationGeneration, reportError, state.grabIntent])

  const profileLabel = useMemo(() => {
    if (state.profile.kind === 'workspace') return 'Workspace'
    if (state.profile.kind === 'imported') return 'Imported'
    if (state.profile.kind === 'incognito') return 'Private'
    return 'Persistent'
  }, [state.profile.kind])

  const navigateTo = (input: string) => {
    const normalized = input.trim()
    if (!normalized || navigationActionPendingRef.current || page.loadState === 'loading') return
    navigationActionPendingRef.current = true
    setNavigationActionPending(true)
    void (state.designMode ? controller.setDesignMode(page.id, false) : Promise.resolve())
      .then(() => controller.navigate(page.id, normalized))
      .then((result) => {
        if (result.navigationGeneration > authoritativeGeneration.current) {
          authoritativeGeneration.current = result.navigationGeneration
          dispatch({ type: 'navigationStarted', input: normalized, generation: result.navigationGeneration })
          dispatch({ type: 'navigationCommitted', url: result.url, generation: result.navigationGeneration })
        }
      })
      .catch((error) => {
        navigationActionPendingRef.current = false
        setNavigationActionPending(false)
        reportError(error)
      })
  }

  const startGrabIntent = (intent: BrowserGrabIntent) => {
    const enabled = !state.designMode || state.grabIntent !== intent
    void controller.setDesignMode(page.id, enabled)
      .then(() => {
        dispatch({ type: 'grabIntentChanged', intent })
        dispatch({ type: 'designModeChanged', enabled })
        if (enabled) dispatch({ type: 'annotationCleared' })
      })
      .catch(reportError)
  }

  const reloadPage = () => {
    if (page.loadState === 'loading') {
      void controller.reload(page.id).catch(reportError)
      return
    }
    runPageNavigation(() => controller.reload(page.id))
  }

  const openMarkup = () => {
    if (page.url === 'about:blank' || capturePending || typeof controller.capturePageImage !== 'function') return
    setCapturePending(true)
    void controller.capturePageImage(page.id, captureDir)
      .then((path) => {
        if (mounted.current) setAnnotatingCapturePath(path)
      })
      .catch(reportError)
      .finally(() => {
        if (mounted.current) setCapturePending(false)
      })
  }

  const runPageNavigation = (action: () => Promise<BrowserPage | void>) => {
    if (navigationActionPendingRef.current || page.loadState === 'loading') return
    navigationActionPendingRef.current = true
    setNavigationActionPending(true)
    const leaveDesignMode = state.designMode
      ? controller.setDesignMode(page.id, false).then(() => dispatch({ type: 'designModeChanged', enabled: false }))
      : Promise.resolve()
    void leaveDesignMode
      .then(action)
      .then((nextPage) => {
        if (!nextPage || nextPage.navigationGeneration <= authoritativeGeneration.current) return
        authoritativeGeneration.current = nextPage.navigationGeneration
        dispatch({ type: 'deviceMetricsChanged', page: nextPage })
      })
      .catch((error) => {
        navigationActionPendingRef.current = false
        setNavigationActionPending(false)
        reportError(error)
      })
  }

  const setDevicePreset = (event: ChangeEvent<HTMLSelectElement>) => {
    const metrics = devicePresets[event.target.value] ?? null
    void controller.setDeviceMetrics(page.id, metrics)
      .then((nextPage) => dispatch({ type: 'deviceMetricsChanged', page: nextPage }))
      .catch(reportError)
  }

  const deliverAnnotation = () => {
    const annotation = state.annotation
    if (!annotation) return
    if (annotation.navigationGeneration !== page.navigationGeneration) {
      dispatch({ type: 'annotationCleared' })
      reportError('The annotation is stale because the page navigated. Pick the element again.')
      return
    }
    void copyAnnotation(annotation).catch(reportError)
  }

  // Every grouped request id MUST be resolved: each one holds a live WebView2
  // deferral, and an unresolved deferral blocks that frame indefinitely.
  const resolvePermissionGroup = (requestIds: string[], decision: 'allow_once' | 'allow_for_origin' | 'deny') => {
    for (const requestId of requestIds) {
      void controller.resolvePermission(requestId, decision)
        .then(() => dispatch({ type: 'permissionResolved', requestId }))
        .catch(reportError)
    }
  }

  const detectCookieSource = () => {
    setCookieImportStatus('Detecting loopback Chrome…')
    void controller.detectCookieImportSource(cookieEndpoint)
      .then((source) => {
        setCookieSource(source)
        setCookieOrigins([])
        setCookieConsent(false)
        setCookieImportStatus(source.origins.length ? 'Choose the exact origins to import.' : 'No HTTP(S) origins were detected.')
      })
      .catch((error) => {
        setCookieSource(null)
        setCookieImportStatus(null)
        reportError(error)
      })
  }

  const importCookies = () => {
    if (!cookieSource || cookieOrigins.length === 0 || !cookieConsent) return
    setCookieImportStatus('Importing and verifying cookies…')
    void controller.importCookies({
      pageId: page.id,
      profileId: state.profile.id,
      endpoint: cookieSource.endpoint,
      origins: cookieOrigins,
      consent: cookieConsent,
    }).then((result) => {
      if (result.quarantined) dispatch({ type: 'profileCookieImportQuarantined' })
      if (result.verified && !result.rolledBack && !result.quarantined) {
        hideImportHint(state.profile.id)
        setImportHintVisible(false)
      }
      setCookieImportStatus(result.quarantined
        ? 'Import failed and this profile is quarantined because rollback could not be proven.'
        : result.rolledBack
          ? 'Import failed; every transaction cookie was rolled back and the original cookie hash was verified.'
          : `${result.importedCount} cookies imported and verified for ${result.originCount} origins.`)
    }).catch((error) => {
      setCookieImportStatus(null)
      reportError(error)
    })
  }

  const toggleOverflow = () => {
    if (overflowOpen) {
      setOverflowOpen(false)
      return
    }
    const epoch = ++surfaceEpoch.current
    if (activationRaf.current !== null) cancelFrame(activationRaf.current)
    void publishSurface(null, epoch, true)
      .then(() => {
        if (mounted.current && epoch === surfaceEpoch.current) setOverflowOpen(true)
      })
      .catch(() => undefined)
  }

  return (
    <section className="browser-panel" aria-label={`Browser page ${page.title}`} aria-busy={page.loadState === 'loading'} data-load-state={page.loadState}>
      <div
        className="browser-toolbar"
        onFocusCapture={handleChromeFocus}
        onBlurCapture={handleChromeBlur}
        onPointerDownCapture={handleChromeFocus}
      >
        <button className="browser-toolbar-icon" type="button" aria-label="Back" disabled={navigationBlocked || !page.canGoBack} onClick={() => runPageNavigation(() => controller.goBack(page.id))}>
          <ArrowLeft size={16} />
        </button>
        <button className="browser-toolbar-icon" type="button" aria-label="Forward" disabled={navigationBlocked || !page.canGoForward} onClick={() => runPageNavigation(() => controller.goForward(page.id))}>
          <ArrowRight size={16} />
        </button>
        <button className="browser-toolbar-icon" type="button" aria-label={page.loadState === 'loading' ? 'Stop loading' : 'Reload'} disabled={navigationActionPending && page.loadState !== 'loading'} onClick={reloadPage}>
          {page.loadState === 'loading' ? <Loader2 className="browser-toolbar-spinner" size={16} /> : <RotateCw size={16} />}
        </button>
        <BrowserAddressBar
          value={state.addressDraft}
          pageUrl={page.url}
          inputRef={addressInput}
          onChange={(value) => dispatch({ type: 'addressChanged', value })}
          onSubmit={navigateTo}
          onDropdownVisibilityChange={setAddressSuggestionsOpen}
        />
        {importHintVisible ? (
          <button className="browser-import-hint" type="button" aria-label="Import browser data" disabled={state.profile.cookieImportQuarantined} onClick={() => setCookieImportOpen(true)}>
            <Import size={14} />
            가져오기
          </button>
        ) : null}
        <button className={`browser-toolbar-icon browser-toolbar-action${state.designMode && state.grabIntent === 'copy' ? ' is-active' : ''}`} type="button" aria-label="Grab page element" title="페이지 요소 가져오기" aria-pressed={state.designMode && state.grabIntent === 'copy'} disabled={page.url === 'about:blank'} onClick={() => startGrabIntent('copy')}>
          <Crosshair size={16} />
        </button>
        <button className={`browser-toolbar-icon browser-toolbar-action${state.designMode && state.grabIntent === 'annotate' ? ' is-active' : ''}`} type="button" aria-label="Annotate page element" title="페이지 요소에 주석 달기" aria-pressed={state.designMode && state.grabIntent === 'annotate'} disabled={page.url === 'about:blank'} onClick={() => startGrabIntent('annotate')}>
          <MessageSquarePlus size={16} />
        </button>
        <button className={`browser-toolbar-icon browser-toolbar-action${capturePending ? ' is-active' : ''}`} type="button" aria-label="Draw on screenshot" title="스크린샷에 그리기" disabled={page.url === 'about:blank' || capturePending || typeof controller.capturePageImage !== 'function'} onClick={openMarkup}>
          <PenTool size={16} />
        </button>
        <button className="browser-toolbar-icon" type="button" aria-label="Open browser devtools" title="브라우저 개발자 도구 열기" onClick={() => {
          if (typeof controller.openDevTools === 'function') void controller.openDevTools(page.id).catch(reportError)
        }}>
          <SquareCode size={16} />
        </button>
        <button className="browser-toolbar-icon" type="button" aria-label="Open in default browser" title="기본 브라우저에서 열기" disabled={!externalUrl} onClick={() => {
          if (externalUrl && typeof controller.openExternal === 'function') void controller.openExternal(externalUrl).catch(reportError)
        }}>
          <ExternalLink size={16} />
        </button>
        <div className="browser-overflow">
          <button className="browser-toolbar-icon browser-toolbar-action" type="button" aria-label="Browser page options" aria-expanded={overflowOpen} onClick={toggleOverflow}>
            <Ellipsis size={18} />
          </button>
          {overflowOpen ? (
            <div className="browser-overflow-menu" role="menu">
              <label>
                Device
                <select aria-label="Device mode" value={page.deviceMetrics ? (page.deviceMetrics.width <= 500 ? 'mobile' : 'tablet') : 'desktop'} onChange={setDevicePreset}>
                  <option value="desktop">Desktop</option>
                  <option value="mobile">Mobile</option>
                  <option value="tablet">Tablet</option>
                </select>
              </label>
              {state.profile.kind === 'imported' ? (
                <>
                  <div className="browser-overflow-separator" role="separator" />
                  <button type="button" role="menuitem" disabled={state.profile.cookieImportQuarantined} onClick={() => { setCookieImportOpen(true); setOverflowOpen(false) }}>
                    Import Chrome cookies…
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        <span className={`browser-profile-badge profile-${state.profile.kind}`} title={`Isolated ${profileLabel.toLowerCase()} browser profile`}>{profileLabel}</span>
        {pendingPromptCount > 0 ? <span className="browser-prompt-count" aria-label="Pending browser prompts">{pendingPromptCount}</span> : null}
        {copyNotice ? <span role="status" className="browser-toolbar-notice">{copyNotice}</span> : null}
        {operationError || page.error ? <span role="alert" className="browser-toolbar-error" title={operationError ?? page.error ?? undefined}>{operationError ?? page.error}</span> : null}
      </div>

      {state.annotation ? (
        <aside
          className="browser-annotation"
          aria-label="Browser annotation"
          onFocusCapture={handleChromeFocus}
          onBlurCapture={handleChromeBlur}
          onPointerDownCapture={handleChromeFocus}
        >
          <div>
            <strong>{state.annotation.selector || state.annotation.browserRef}</strong>
            <span>{state.annotation.ancestorPath.join(' › ')}</span>
          </div>
          <input
            aria-label="Annotation comment"
            placeholder="Add a note (optional)"
            value={state.annotationComment}
            onChange={(event) => dispatch({ type: 'annotationCommentChanged', comment: event.target.value })}
          />
          <button type="button" onClick={deliverAnnotation}>Copy</button>
          <button type="button" aria-label="Clear browser annotation" onClick={() => dispatch({ type: 'annotationCleared' })}>×</button>
        </aside>
      ) : null}

      {pendingPromptCount > 0 && !page.effectiveVisible ? (
        <section className="browser-prompts" aria-label="Browser security prompts">
          {permissionGroups.map((group) => (
            <article key={group.key}>
              <strong>{permissionLabels[group.permission] ?? `Permission: ${group.permission}`}</strong>
              <span>{group.origin}{group.requestIds.length > 1 ? ` · ${group.requestIds.length} frames` : ''}</span>
              <div>
                <button type="button" onClick={() => resolvePermissionGroup(group.requestIds, 'allow_once')}>Allow once</button>
                <button type="button" onClick={() => resolvePermissionGroup(group.requestIds, 'allow_for_origin')}>Always allow</button>
                <button type="button" onClick={() => resolvePermissionGroup(group.requestIds, 'deny')}>Deny</button>
              </div>
            </article>
          ))}
          {state.certificateQueue.map((request) => (
            <article key={request.id} className="danger">
              <strong>Certificate error: {request.errorCode}</strong><span>{request.origin}</span>
              <div>
                <button type="button" onClick={() => void controller.resolveCertificate(request.id, 'allow_for_origin').then(() => dispatch({ type: 'certificateResolved', requestId: request.id })).catch(reportError)}>Allow origin</button>
                <button type="button" onClick={() => void controller.resolveCertificate(request.id, 'deny').then(() => dispatch({ type: 'certificateResolved', requestId: request.id })).catch(reportError)}>Deny</button>
              </div>
            </article>
          ))}
          {state.dialogQueue.map((request) => (
            <article key={request.id}>
              <strong>{request.kind}: {request.message}</strong><span>{request.origin}</span>
              <div>
                <button type="button" onClick={() => void controller.resolveDialog(request.id, true).then(() => dispatch({ type: 'dialogResolved', requestId: request.id })).catch(reportError)}>Accept</button>
                <button type="button" onClick={() => void controller.resolveDialog(request.id, false).then(() => dispatch({ type: 'dialogResolved', requestId: request.id })).catch(reportError)}>Dismiss</button>
              </div>
            </article>
          ))}
        </section>
      ) : null}

      {cookieImportOpen ? (
        <section className="browser-cookie-import" role="dialog" aria-modal="true" aria-label="Import Chrome cookies">
          <header><strong>Import cookies from local Chrome CDP</strong><button type="button" aria-label="Close cookie import" onClick={() => setCookieImportOpen(false)}>×</button></header>
          <p>Cookie-only import uses a loopback CDP endpoint. Choose the exact detected origins and explicitly consent before anything is copied.</p>
          <div className="browser-cookie-endpoint"><input aria-label="Chrome CDP endpoint" value={cookieEndpoint} onChange={(event) => setCookieEndpoint(event.target.value)} /><button type="button" onClick={detectCookieSource}>Detect</button></div>
          {cookieSource?.origins.map((origin) => (
            <label key={origin} className="browser-cookie-origin"><input type="checkbox" checked={cookieOrigins.includes(origin)} onChange={(event) => setCookieOrigins((current) => event.target.checked ? [...current, origin] : current.filter((value) => value !== origin))} />{origin}</label>
          ))}
          <label className="browser-cookie-consent"><input type="checkbox" checked={cookieConsent} onChange={(event) => setCookieConsent(event.target.checked)} />I consent to importing cookies for only the selected origins into this isolated VibeLink profile.</label>
          {cookieImportStatus ? <p role="status">{cookieImportStatus}</p> : null}
          <button type="button" disabled={!cookieSource || cookieOrigins.length === 0 || !cookieConsent || state.profile.cookieImportQuarantined} onClick={importCookies}>Import and verify</button>
        </section>
      ) : null}

      {annotatingCapturePath ? (
        <CaptureAnnotator key={annotatingCapturePath} captureDir={captureDir} imagePath={annotatingCapturePath} onClose={() => setAnnotatingCapturePath(null)} />
      ) : null}

      <div
        ref={surfaceHost}
        className="browser-surface-host"
        role="document"
        aria-label={`Native browser page ${page.title}`}
        data-page-id={page.id}
        data-profile-id={state.profile.id}
        data-native-surface-visible={page.effectiveVisible ? 'true' : 'false'}
        data-idle-hint={page.loadState === 'loading' ? 'Loading…' : page.url === 'about:blank' ? 'Enter an address or search above.' : ''}
      />
    </section>
  )
}
