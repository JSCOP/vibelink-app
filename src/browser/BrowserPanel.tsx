import './BrowserPanel.css'
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { activeBrowserTab, activeSurfaceVisible, browserPanelReducer, createBrowserPanelState } from './state'
import type { BrowserPanelAction } from './state'
import type { BrowserDeviceMetrics, BrowserPanelController, BrowserPanelState, BrowserProjectTarget, DesignGrabSelection, PhysicalBounds } from './types'

type BrowserPanelProps = {
  controller: BrowserPanelController
  initialState?: Partial<BrowserPanelState>
  subscribe?: (listener: (action: BrowserPanelAction) => void) => () => void
  onStateChange?: (state: BrowserPanelState) => void
  onError?: (error: string) => void
  projectTargets?: BrowserProjectTarget[]
  onSendSelectionToAgent?: (selection: DesignGrabSelection, url: string) => void
  onStartProject?: (target: BrowserProjectTarget) => void
}

export function BrowserPanel({ controller, initialState, subscribe, onStateChange, onError, projectTargets = [], onSendSelectionToAgent, onStartProject }: BrowserPanelProps) {
  const [state, dispatch] = useReducer(browserPanelReducer, initialState, createBrowserPanelState)
  const surfaceHost = useRef<HTMLDivElement>(null)
  const active = activeBrowserTab(state)
  const surfaceVisible = activeSurfaceVisible(state)
  const activePageId = active?.id ?? null

  const projectTarget = useMemo(
    () => projectTargets.find((target) => target.running) ?? projectTargets[0] ?? null,
    [projectTargets],
  )
  useEffect(() => subscribe?.(dispatch), [subscribe])
  useEffect(() => onStateChange?.(state), [onStateChange, state])

  const reportError = useCallback((error: unknown) => {
    onError?.(error instanceof Error ? error.message : String(error))
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
    if (!active) return
    void controller.setSurfaceState(active.id, { bounds: state.surfaceBounds, visible: surfaceVisible && state.surfaceBounds !== null }).catch(reportError)
  }, [active, controller, reportError, state.surfaceBounds, surfaceVisible])

  useEffect(() => {
    if (!activePageId) return
    return () => { void controller.setSurfaceState(activePageId, { bounds: null, visible: false }).catch(() => undefined) }
  }, [activePageId, controller])

  useEffect(() => {
    if (!controller.subscribeDesignGrabs) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    void controller.subscribeDesignGrabs((selection) => dispatch({ type: 'designGrabbed', selection }))
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
    if (!controller.subscribeLifecycle) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    void controller.subscribeLifecycle((event) => {
      dispatch({ type: 'lifecycleReceived', event })
      if (event.kind === 'capture_updated' && event.pageId === activePageId) {
        void controller.getCaptureState(event.pageId)
          .then((capture) => dispatch({ type: 'captureStateChanged', capture }))
          .catch(reportError)
      }
    }).then((stop) => {
      if (cancelled) stop()
      else unsubscribe = stop
    }).catch(reportError)
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [activePageId, controller, reportError])

  useEffect(() => {
    if (!activePageId) {
      dispatch({ type: 'captureStateChanged', capture: null })
      return
    }
    void controller.getCaptureState(activePageId)
      .then((capture) => dispatch({ type: 'captureStateChanged', capture }))
      .catch(reportError)
  }, [activePageId, controller, reportError])

  const pendingPromptCount = state.permissionQueue.length
    + state.certificateQueue.length
    + state.dialogQueue.length
  const activeProfile = useMemo(
    () => state.profiles.find((profile) => profile.id === state.selectedProfileId)
      ?? state.profiles.find((profile) => profile.id === active?.profileId)
      ?? state.profiles[0]
      ?? null,
    [active?.profileId, state.profiles, state.selectedProfileId],
  )

  const selectTab = (pageId: string) => {
    void (async () => {
      if (state.designMode && active && active.id !== pageId) await controller.setDesignMode(active.id, false)
      await controller.selectTab(pageId)
      dispatch({ type: 'tabSelected', pageId })
    })().catch(reportError)
  }

  const closeTab = (pageId: string) => {
    void controller.closeTab(pageId)
      .then(() => dispatch({ type: 'tabClosed', pageId }))
      .catch(reportError)
  }

  const createTab = () => {
    if (!activeProfile) return
    void (async () => {
      if (state.designMode && active) await controller.setDesignMode(active.id, false)
      const tab = await controller.createTab(activeProfile.id)
      dispatch({ type: 'tabCreated', tab })
    })().catch(reportError)
  }

  const createIncognitoProfile = () => {
    void controller.createProfile('incognito')
      .then((profile) => dispatch({ type: 'profileCreated', profile }))
      .catch(reportError)
  }

  const setDevicePreset = (event: ChangeEvent<HTMLSelectElement>) => {
    if (!active) return
    const preset = event.target.value
    const metrics: BrowserDeviceMetrics | null = preset === 'mobile'
      ? { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }
      : preset === 'tablet'
        ? { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true }
        : null
    void controller.setDeviceMetrics(active.id, metrics)
      .then((tab) => {
        dispatch({ type: 'deviceMetricsChanged', pageId: tab.id, metrics: tab.deviceMetrics })
        dispatch({
          type: 'lifecycleReceived',
          event: {
            sequence: (state.lastLifecycleEvent?.sequence ?? 0) + 1,
            pageId: active.id,
            navigationGeneration: active.navigationGeneration,
            kind: 'device_metrics_changed',
            url: null,
            detail: metrics ? `${metrics.width}×${metrics.height}` : 'Desktop viewport restored',
            timestampMs: Date.now(),
          },
        })
      })
      .catch(reportError)
  }

  const refreshCaptureState = () => {
    if (!active) return
    void controller.captureFrame(active.id)
      .then((capture) => dispatch({ type: 'captureStateChanged', capture }))
      .catch(reportError)
  }

  const resolvePermission = (requestId: string, decision: 'allow_once' | 'allow_for_origin' | 'deny') => {
    void controller.resolvePermission(requestId, decision)
      .then(() => dispatch({ type: 'permissionResolved', requestId }))
      .catch(reportError)
  }

  const resolveCertificate = (requestId: string, decision: 'allow_for_origin' | 'deny') => {
    void controller.resolveCertificate(requestId, decision)
      .then(() => dispatch({ type: 'certificateResolved', requestId }))
      .catch(reportError)
  }

  const resolveDialog = (requestId: string, accept: boolean) => {
    void controller.resolveDialog(requestId, accept)
      .then(() => dispatch({ type: 'dialogResolved', requestId }))
      .catch(reportError)
  }

  const navigateTo = (input: string) => {
    if (!active) return
    const normalized = input.trim()
    if (!normalized) return
    const generation = active.navigationGeneration + 1
    dispatch({ type: 'navigationStarted', pageId: active.id, input: normalized, generation })
    void controller.navigate(active.id, normalized)
      .then((result) => {
        if (result.navigationGeneration !== generation) {
          dispatch({
            type: 'navigationFailed',
            pageId: active.id,
            generation,
            error: 'Native browser returned an unexpected navigation generation.',
          })
          return
        }
        dispatch({
          type: 'navigationCommitted',
          pageId: active.id,
          url: result.url,
          generation: result.navigationGeneration,
        })
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        dispatch({ type: 'navigationFailed', pageId: active.id, generation, error: message })
        reportError(error)
      })
  }

  const navigate = (event: FormEvent) => {
    event.preventDefault()
    navigateTo(state.addressDraft)
  }

  const setDesignMode = () => {
    if (!active) return
    const enabled = !state.designMode
    void controller.setDesignMode(active.id, enabled)
      .then(() => dispatch({ type: 'designModeChanged', enabled }))
      .catch(reportError)
  }

  return (
    <section className="browser-panel" aria-label="Browser">
      <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
        {state.tabs.map((tab) => (
          <div className={`browser-tab ${tab.id === state.activePageId ? 'active' : ''}`} key={tab.id}>
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === state.activePageId}
              aria-controls="browser-surface-host"
              onClick={() => selectTab(tab.id)}
            >
              {tab.title || 'Untitled'}
              {tab.loadState === 'loading' ? <span aria-label="Loading"> …</span> : null}
            </button>
            <button type="button" aria-label={`Close ${tab.title || 'tab'}`} onClick={() => closeTab(tab.id)}>×</button>
          </div>
        ))}
        <button type="button" aria-label="New browser tab" disabled={!activeProfile} onClick={createTab}>+</button>
      </div>

      <div className="browser-secondary-toolbar">
        <div className="browser-project-launcher">
          <div>
            <strong>Project preview</strong>
            <span title={projectTarget?.url ?? 'No project URL detected'}>
              {projectTarget
                ? `${projectTarget.label} · ${projectTarget.url}`
                : 'Start a local dev server or enter a URL below.'}
            </span>
          </div>
          <button
            type="button"
            disabled={!active || !projectTarget}
            title={projectTarget?.running ? 'Open running project preview' : projectTarget?.startCommand ? 'Start the detected project dev server' : 'Open the detected project URL'}
            onClick={() => {
              if (!projectTarget) return
              if (projectTarget.running || !projectTarget.startCommand) navigateTo(projectTarget.url)
              else onStartProject?.(projectTarget)
            }}
          >
            {projectTarget?.running ? 'Open live' : projectTarget?.startCommand ? 'Start server' : 'Open project'}
          </button>
          {projectTarget ? <small data-running={projectTarget.running}>{projectTarget.running ? 'Live' : 'Server not detected'}</small> : null}
        </div>
        <div className="browser-utility-controls">
          <label>
            <span>Profile</span>
            <select
              aria-label="Browser profile"
              value={activeProfile?.id ?? ''}
              onChange={(event) => dispatch({ type: 'profileSelected', profileId: event.target.value })}
            >
              {state.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.kind === 'workspace' ? 'Workspace' : profile.kind === 'incognito' ? 'Private' : 'Persistent'}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Device</span>
            <select
              aria-label="Device mode"
              disabled={!active}
              value={active?.deviceMetrics ? (active.deviceMetrics.width <= 500 ? 'mobile' : 'tablet') : 'desktop'}
              onChange={setDevicePreset}
            >
              <option value="desktop">Desktop</option>
              <option value="mobile">Mobile</option>
              <option value="tablet">Tablet</option>
            </select>
          </label>
          <button type="button" onClick={createIncognitoProfile}>Private</button>
          <button type="button" disabled={!active} onClick={refreshCaptureState}>Capture</button>
          <span className="browser-capture-status" aria-label="Browser capture state">
            {state.captureState
              ? `${state.captureState.pendingFrames} queued · ${state.captureState.droppedFrames} dropped`
              : 'Capture ready'}
          </span>
        </div>
      </div>

      <div className="browser-toolbar">
        <button type="button" aria-label="Back" disabled={!active?.canGoBack} onClick={() => active && void controller.goBack(active.id).catch(reportError)}>←</button>
        <button type="button" aria-label="Forward" disabled={!active?.canGoForward} onClick={() => active && void controller.goForward(active.id).catch(reportError)}>→</button>
        <button type="button" aria-label="Reload" disabled={!active} onClick={() => active && void controller.reload(active.id).catch(reportError)}>↻</button>
        <form onSubmit={navigate}>
          <label className="browser-address-label">
            <span>Address or search</span>
            <input
              aria-label="Address or search"
              value={state.addressDraft}
              disabled={!active}
              onChange={(event) => dispatch({ type: 'addressChanged', value: event.target.value })}
            />
          </label>
        </form>
        <button type="button" aria-pressed={state.designMode} disabled={!active} onClick={setDesignMode}>{state.designMode ? 'Picking…' : 'Pick element'}</button>
        {pendingPromptCount > 0 ? <span aria-label="Pending browser prompts">{pendingPromptCount}</span> : null}
      </div>

      {active?.error ? <div role="alert" className="browser-error">{active.error}</div> : null}
      {state.designSelection ? (
        <aside className="browser-design-selection" aria-label="Design selection">
          <div>
            <strong>{state.designSelection.accessibleName || state.designSelection.browserRef}</strong>
            <span>{state.designSelection.domAncestry.join(' › ')}</span>
          </div>
          <button type="button" onClick={() => onSendSelectionToAgent?.(state.designSelection!, active?.url ?? state.addressDraft)}>Add to Agent</button>
          <button type="button" onClick={() => dispatch({ type: 'designSelectionCleared' })}>Clear</button>
        </aside>
      ) : null}
      {pendingPromptCount > 0 ? (
        <section className="browser-prompts" aria-label="Browser security prompts">
          {state.permissionQueue.map((request) => (
            <article key={request.id}>
              <strong>Permission: {request.permission}</strong>
              <span>{request.origin}</span>
              <div>
                <button type="button" onClick={() => resolvePermission(request.id, 'allow_once')}>Allow once</button>
                <button type="button" onClick={() => resolvePermission(request.id, 'allow_for_origin')}>Allow origin</button>
                <button type="button" onClick={() => resolvePermission(request.id, 'deny')}>Deny</button>
              </div>
            </article>
          ))}
          {state.certificateQueue.map((request) => (
            <article key={request.id} className="danger">
              <strong>Certificate error: {request.errorCode}</strong>
              <span>{request.origin}</span>
              <div>
                <button type="button" onClick={() => resolveCertificate(request.id, 'allow_for_origin')}>Allow origin</button>
                <button type="button" onClick={() => resolveCertificate(request.id, 'deny')}>Deny</button>
              </div>
            </article>
          ))}
          {state.dialogQueue.map((request) => (
            <article key={request.id}>
              <strong>{request.kind}: {request.message}</strong>
              <span>{request.origin}</span>
              <div>
                <button type="button" onClick={() => resolveDialog(request.id, true)}>Accept</button>
                <button type="button" onClick={() => resolveDialog(request.id, false)}>Dismiss</button>
              </div>
            </article>
          ))}
        </section>
      ) : null}
      {state.downloads.length > 0 ? (
        <aside className="browser-downloads" aria-label="Browser downloads">
          <strong>Downloads</strong>
          {state.downloads.slice(-3).map((download) => (
            <span key={download.id}>{download.path ?? download.url} · {download.success == null ? 'pending' : download.success ? 'complete' : 'failed'}</span>
          ))}
        </aside>
      ) : null}
      {state.lastLifecycleEvent ? (
        <div className="browser-lifecycle-status" aria-label="Latest browser event">
          {state.lastLifecycleEvent.kind.replaceAll('_', ' ')}
          {state.lastLifecycleEvent.detail ? ` · ${state.lastLifecycleEvent.detail}` : ''}
        </div>
      ) : null}
      <div
        id="browser-surface-host"
        ref={surfaceHost}
        role="tabpanel"
        aria-label={active ? `Browser page ${active.title}` : 'No browser page'}
        data-page-id={active?.id ?? ''}
        data-native-surface-visible={surfaceVisible ? 'true' : 'false'}
      >
        {!active ? <p>No browser tabs open.</p> : null}
      </div>
    </section>
  )
}
