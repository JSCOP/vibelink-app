import './BrowserPanel.css'
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { activeSurfaceVisible, browserPanelReducer, createBrowserPanelState } from './state'
import type {
  BrowserAnnotation,
  BrowserCertificatePrompt,
  BrowserAnnotationDestination,
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

export type LiveAgentPane = { paneId: string; title: string; role: string | null }

type BrowserPanelProps = {
  controller: BrowserContentController
  initialState: BrowserContentState
  active: boolean
  focused: boolean
  workspaceVisible: boolean
  nativeSurfacesSuspended?: boolean
  liveAgentPanes?: LiveAgentPane[]
  onStateChange?: (state: BrowserContentState) => void
  onError?: (error: string) => void
  onTitleChange?: (title: string) => void
  onDeliverAnnotation?: (annotation: BrowserAnnotation, destination: BrowserAnnotationDestination) => Promise<void>
}

const devicePresets: Record<string, BrowserDeviceMetrics | null> = {
  desktop: null,
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
}

const POST_ACTIVATION_MEASURE_FRAMES = 8

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

export function BrowserPanel({
  controller,
  initialState,
  active,
  focused,
  workspaceVisible,
  nativeSurfacesSuspended = false,
  liveAgentPanes = [],
  onStateChange,
  onError,
  onTitleChange,
  onDeliverAnnotation,
}: BrowserPanelProps) {
  const [state, dispatch] = useReducer(browserPanelReducer, initialState, createBrowserPanelState)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [cookieImportOpen, setCookieImportOpen] = useState(false)
  const [cookieEndpoint, setCookieEndpoint] = useState('http://127.0.0.1:9222')
  const [cookieSource, setCookieSource] = useState<BrowserCookieImportSource | null>(null)
  const [cookieOrigins, setCookieOrigins] = useState<string[]>([])
  const [cookieConsent, setCookieConsent] = useState(false)
  const [cookieImportStatus, setCookieImportStatus] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [navigationActionPending, setNavigationActionPending] = useState(false)
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
  const pendingPromptCount: number = state.permissionQueue.length + state.certificateQueue.length + state.dialogQueue.length
  const navigationBlocked = navigationActionPending || page.loadState === 'loading'
  // Annotation no longer hides the native page: the annotation UI is an in-page
  // popover injected into the WebView itself, so the page must stay visible.
  const domSurfaceBlocker = overflowOpen || cookieImportOpen || pendingPromptCount > 0
  const panelVisible = active
    && workspaceVisible
    && !nativeSurfacesSuspended
    && activeSurfaceVisible(state)
    && !domSurfaceBlocker
  const panelVisibleRef = useRef(false)
  const focusedRef = useRef(false)

  useLayoutEffect(() => {
    panelVisibleRef.current = panelVisible
    focusedRef.current = focused && page.url !== 'about:blank'
  }, [focused, page.url, panelVisible])

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

  useLayoutEffect(() => {
    const epoch = ++surfaceEpoch.current
    if (activationRaf.current !== null) cancelFrame(activationRaf.current)
    void publishSurface(null, epoch, true).catch(() => undefined)
    if (!panelVisible) return
    let remaining = POST_ACTIVATION_MEASURE_FRAMES
    const measureFrame = () => {
      if (!mounted.current || epoch !== surfaceEpoch.current) return
      void publishSurface(measureSurface(), epoch).catch(() => undefined)
      remaining -= 1
      if (remaining > 0) activationRaf.current = scheduleFrame(measureFrame)
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
  }, [focused, page.url, publishSurface])

  useEffect(() => {
    if (!active || !workspaceVisible || nativeSurfacesSuspended || page.url !== 'about:blank') return
    const frame = scheduleFrame(() => {
      addressInput.current?.focus()
      addressInput.current?.select()
    })
    return () => cancelFrame(frame)
  }, [active, nativeSurfacesSuspended, page.id, page.navigationGeneration, page.url, workspaceVisible])

  useEffect(() => () => {
    mounted.current = false
    surfaceEpoch.current += 1
    if (activationRaf.current !== null) cancelFrame(activationRaf.current)
    if (resizeRaf.current !== null) cancelFrame(resizeRaf.current)
    void controller.setSurfaceState(page.id, { bounds: null, visible: false, focused: false }).catch(() => undefined)
  }, [controller, page.id])

  useEffect(() => {
    if (!controller.subscribeLifecycle) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    void controller.subscribeLifecycle((event) => {
      if (cancelled) return
      if (event.pageId !== page.id || event.navigationGeneration < authoritativeGeneration.current) return
      authoritativeGeneration.current = Math.max(authoritativeGeneration.current, event.navigationGeneration)
      dispatch({ type: 'lifecycleReceived', event })
      const permission = permissionPrompt(event)
      if (permission) dispatch({ type: 'permissionQueued', request: permission })
      const certificate = certificatePrompt(event)
      if (certificate) dispatch({ type: 'certificateQueued', request: certificate })
      const dialog = dialogPrompt(event)
      if (dialog) dispatch({ type: 'dialogQueued', request: dialog })
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
  }, [controller, page.id, reportError])

  useEffect(() => {
    if (!controller.subscribeDesignGrabs) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    void controller.subscribeDesignGrabs((grab) => {
      if (grab.pageId !== page.id || grab.navigationGeneration !== page.navigationGeneration) return
      // The in-page annotation popover already collected the comment and the
      // user clicked "Send to Agent"; create the annotation with that comment
      // and deliver it straight to the Agent panel. The native page stays
      // visible throughout (annotation state is no longer a surface blocker).
      const comment = grab.comment ?? ''
      void controller.createAnnotation(page.id, grab, comment)
        .then((annotation) => {
          if (cancelled) return
          if (onDeliverAnnotation) void onDeliverAnnotation(annotation, { kind: 'agent' }).catch(reportError)
        })
        .catch(reportError)
    }).then((stop) => {
      if (cancelled) stop()
      else unsubscribe = stop
    }).catch(reportError)
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [controller, onDeliverAnnotation, page.id, page.navigationGeneration, reportError])

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

  const navigate = (event: FormEvent) => {
    event.preventDefault()
    navigateTo(state.addressDraft)
  }

  const setDesignMode = () => {
    const enabled = !state.designMode
    void controller.setDesignMode(page.id, enabled)
      .then(() => dispatch({ type: 'designModeChanged', enabled }))
      .catch(reportError)
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

  const deliverAnnotation = (destination: BrowserAnnotationDestination) => {
    const annotation = state.annotation
    if (!annotation) return
    if (annotation.navigationGeneration !== page.navigationGeneration) {
      dispatch({ type: 'annotationCleared' })
      reportError('The annotation is stale because the page navigated. Pick the element again.')
      return
    }
    if (destination.kind === 'copy') {
      void import('./agentContext').then(({ formatBrowserAnnotation }) => navigator.clipboard.writeText(formatBrowserAnnotation(annotation))).catch(reportError)
      return
    }
    if (onDeliverAnnotation) void onDeliverAnnotation(annotation, destination).catch(reportError)
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
      <div className="browser-toolbar">
        <button type="button" aria-label="Back" disabled={navigationBlocked || !page.canGoBack} onClick={() => runPageNavigation(() => controller.goBack(page.id))}>←</button>
        <button type="button" aria-label="Forward" disabled={navigationBlocked || !page.canGoForward} onClick={() => runPageNavigation(() => controller.goForward(page.id))}>→</button>
        <button type="button" aria-label="Reload" disabled={navigationBlocked} onClick={() => runPageNavigation(() => controller.reload(page.id))}>↻</button>
        <form onSubmit={navigate}>
          <label className="browser-address-label">
            <span>Address or search</span>
            <input ref={addressInput} aria-label="Address or search" value={state.addressDraft} onChange={(event) => dispatch({ type: 'addressChanged', value: event.target.value })} />
          </label>
        </form>
        <button type="button" aria-pressed={state.designMode} onClick={setDesignMode}>{state.designMode ? 'Picking…' : 'Pick'}</button>
        {page.loadState === 'loading' ? <span className="browser-load-indicator" aria-label="Page loading" /> : null}
        <span className={`browser-profile-badge profile-${state.profile.kind}`} title={`Isolated ${profileLabel.toLowerCase()} browser profile`}>{profileLabel}</span>
        <div className="browser-overflow">
          <button type="button" aria-label="Browser page options" aria-expanded={overflowOpen} onClick={toggleOverflow}>⋯</button>
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
                <button type="button" role="menuitem" disabled={state.profile.cookieImportQuarantined} onClick={() => { setCookieImportOpen(true); setOverflowOpen(false) }}>
                  Import Chrome cookies…
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {pendingPromptCount > 0 ? <span className="browser-prompt-count" aria-label="Pending browser prompts">{pendingPromptCount}</span> : null}
        {operationError || page.error ? <span role="alert" className="browser-toolbar-error" title={operationError ?? page.error ?? undefined}>{operationError ?? page.error}</span> : null}
      </div>

      {state.annotation ? (
        <aside className="browser-annotation" aria-label="Browser annotation">
          <div>
            <strong>{state.annotation.accessibleName || state.annotation.browserRef}</strong>
            <span>{state.annotation.domAncestry.join(' › ')}</span>
          </div>
          <input
            aria-label="Annotation comment"
            placeholder="What should change?"
            value={state.annotationComment}
            onChange={(event) => dispatch({ type: 'annotationCommentChanged', comment: event.target.value })}
          />
          <button type="button" onClick={() => deliverAnnotation({ kind: 'agent' })}>VibeLink Agent</button>
          {liveAgentPanes.map((pane) => (
            <button key={pane.paneId} type="button" title={pane.role ?? pane.title} onClick={() => deliverAnnotation({ kind: 'terminal', ...pane })}>{pane.title}</button>
          ))}
          <button type="button" onClick={() => deliverAnnotation({ kind: 'copy' })}>Copy</button>
          <button type="button" aria-label="Clear browser annotation" onClick={() => dispatch({ type: 'annotationCleared' })}>×</button>
        </aside>
      ) : null}

      {pendingPromptCount > 0 && !page.effectiveVisible ? (
        <section className="browser-prompts" aria-label="Browser security prompts">
          {state.permissionQueue.map((request) => (
            <article key={request.id}>
              <strong>Permission: {request.permission}</strong><span>{request.origin}</span>
              <div>
                <button type="button" onClick={() => void controller.resolvePermission(request.id, 'allow_once').then(() => dispatch({ type: 'permissionResolved', requestId: request.id })).catch(reportError)}>Allow once</button>
                <button type="button" onClick={() => void controller.resolvePermission(request.id, 'allow_for_origin').then(() => dispatch({ type: 'permissionResolved', requestId: request.id })).catch(reportError)}>Allow origin</button>
                <button type="button" onClick={() => void controller.resolvePermission(request.id, 'deny').then(() => dispatch({ type: 'permissionResolved', requestId: request.id })).catch(reportError)}>Deny</button>
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

      <div
        ref={surfaceHost}
        className="browser-surface-host"
        role="document"
        aria-label={`Native browser page ${page.title}`}
        data-page-id={page.id}
        data-profile-id={state.profile.id}
        data-native-surface-visible={page.effectiveVisible ? 'true' : 'false'}
      />
    </section>
  )
}
