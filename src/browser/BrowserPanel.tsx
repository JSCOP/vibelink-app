import './BrowserPanel.css'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { activeSurfaceVisible, browserPanelReducer, createBrowserPanelState } from './state'
import type {
  BrowserAnnotation,
  BrowserAnnotationDestination,
  BrowserContentController,
  BrowserContentState,
  BrowserCookieImportSource,
  BrowserDeviceMetrics,
  BrowserPage,
  PhysicalBounds,
} from './types'

export type LiveAgentPane = { paneId: string; title: string; role: string | null }

type BrowserPanelProps = {
  controller: BrowserContentController
  initialState: BrowserContentState
  active: boolean
  focused: boolean
  workspaceVisible: boolean
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

export function BrowserPanel({
  controller,
  initialState,
  active,
  focused,
  workspaceVisible,
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
  const surfaceHost = useRef<HTMLDivElement>(null)
  const page = state.page
  const pendingPromptCount = state.permissionQueue.length + state.certificateQueue.length + state.dialogQueue.length
  const panelVisible = active && workspaceVisible && activeSurfaceVisible(state) && !overflowOpen && !cookieImportOpen && pendingPromptCount === 0

  useEffect(() => onStateChange?.(state), [onStateChange, state])
  useEffect(() => onTitleChange?.(page.title || 'Browser'), [onTitleChange, page.title])

  const reportError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    setOperationError(message)
    onError?.(message)
  }, [onError])

  const measureSurface = useCallback(() => {
    const element = surfaceHost.current
    if (!element) return
    const rectangle = element.getBoundingClientRect()
    const scale = window.devicePixelRatio || 1
    const bounds: PhysicalBounds | null = rectangle.width > 0 && rectangle.height > 0
      ? {
          x: Math.round(rectangle.left * scale),
          y: Math.round(rectangle.top * scale),
          width: Math.max(1, Math.round(rectangle.width * scale)),
          height: Math.max(1, Math.round(rectangle.height * scale)),
          scaleFactorMilli: Math.round(scale * 1000),
        }
      : null
    dispatch({ type: 'surfaceBoundsChanged', bounds })
  }, [])

  useEffect(() => {
    measureSurface()
    const element = surfaceHost.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measureSurface)
    observer.observe(element)
    return () => observer.disconnect()
  }, [measureSurface])

  useEffect(() => {
    const visible = panelVisible && state.surfaceBounds !== null
    void controller.setSurfaceState(page.id, {
      bounds: state.surfaceBounds,
      visible,
      focused: visible && focused,
    })
      .then(() => dispatch({ type: 'surfaceVisibilityChanged', visible }))
      .catch(reportError)
  }, [controller, focused, page.id, panelVisible, reportError, state.surfaceBounds])

  useEffect(() => () => {
    void controller.setSurfaceState(page.id, { bounds: null, visible: false, focused: false }).catch(() => undefined)
  }, [controller, page.id])

  useEffect(() => {
    if (!controller.subscribeLifecycle) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    void controller.subscribeLifecycle((event) => dispatch({ type: 'lifecycleReceived', event }))
      .then((stop) => {
        if (cancelled) stop()
        else unsubscribe = stop
      })
      .catch(reportError)
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [controller, reportError])

  useEffect(() => {
    if (!controller.subscribeDesignGrabs) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    void controller.subscribeDesignGrabs((grab) => {
      if (grab.pageId !== page.id || grab.navigationGeneration !== page.navigationGeneration) return
      void controller.createAnnotation(page.id, grab, '')
        .then((annotation) => {
          if (!cancelled) dispatch({ type: 'annotationCreated', annotation })
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
  }, [controller, page.id, page.navigationGeneration, reportError])

  const profileLabel = useMemo(() => {
    if (state.profile.kind === 'workspace') return 'Workspace'
    if (state.profile.kind === 'imported') return 'Imported'
    if (state.profile.kind === 'incognito') return 'Private'
    return 'Persistent'
  }, [state.profile.kind])

  const navigateTo = (input: string) => {
    const normalized = input.trim()
    if (!normalized) return
    const generation = page.navigationGeneration + 1
    dispatch({ type: 'navigationStarted', input: normalized, generation })
    void (state.designMode ? controller.setDesignMode(page.id, false) : Promise.resolve())
      .then(() => controller.navigate(page.id, normalized))
      .then((result) => {
        if (result.navigationGeneration !== generation) throw new Error('Native browser returned an unexpected navigation generation.')
        dispatch({ type: 'navigationCommitted', url: result.url, generation })
      })
      .catch((error) => {
        dispatch({ type: 'navigationFailed', generation, error: error instanceof Error ? error.message : String(error) })
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
    const generation = page.navigationGeneration + 1
    dispatch({ type: 'navigationStarted', input: page.url, generation })
    const leaveDesignMode = state.designMode
      ? controller.setDesignMode(page.id, false).then(() => dispatch({ type: 'designModeChanged', enabled: false }))
      : Promise.resolve()
    void leaveDesignMode
      .then(action)
      .then((nextPage) => {
        if (nextPage && nextPage.navigationGeneration !== generation) {
          throw new Error('Native browser returned an unexpected navigation generation.')
        }
      })
      .catch((error) => {
        dispatch({ type: 'navigationFailed', generation, error: error instanceof Error ? error.message : String(error) })
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

  return (
    <section className="browser-panel" aria-label={`Browser page ${page.title}`} aria-busy={page.loadState === 'loading'} data-load-state={page.loadState}>
      <div className="browser-toolbar">
        <button type="button" aria-label="Back" disabled={!page.canGoBack} onClick={() => runPageNavigation(() => controller.goBack(page.id))}>←</button>
        <button type="button" aria-label="Forward" disabled={!page.canGoForward} onClick={() => runPageNavigation(() => controller.goForward(page.id))}>→</button>
        <button type="button" aria-label="Reload" onClick={() => runPageNavigation(() => controller.reload(page.id))}>↻</button>
        <form onSubmit={navigate}>
          <label className="browser-address-label">
            <span>Address or search</span>
            <input aria-label="Address or search" value={state.addressDraft} onChange={(event) => dispatch({ type: 'addressChanged', value: event.target.value })} />
          </label>
        </form>
        <button type="button" aria-pressed={state.designMode} onClick={setDesignMode}>{state.designMode ? 'Picking…' : 'Pick'}</button>
        {page.loadState === 'loading' ? <span className="browser-load-indicator" aria-label="Page loading" /> : null}
        <span className={`browser-profile-badge profile-${state.profile.kind}`} title={`Isolated ${profileLabel.toLowerCase()} browser profile`}>{profileLabel}</span>
        <div className="browser-overflow">
          <button type="button" aria-label="Browser page options" aria-expanded={overflowOpen} onClick={() => setOverflowOpen((value) => !value)}>⋯</button>
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

      {pendingPromptCount > 0 ? (
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
        data-native-surface-visible={panelVisible && state.surfaceBounds !== null ? 'true' : 'false'}
      />
    </section>
  )
}
