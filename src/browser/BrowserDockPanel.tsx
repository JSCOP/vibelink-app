import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { BrowserPanel } from './BrowserPanel'
import type { BrowserContentPanelProps } from './browserContentLifecycle'
import type {
  BrowserAnnotation,
  BrowserCertificatePrompt,
  BrowserContentController,
  BrowserContentState,
  BrowserCookieImportResult,
  BrowserCookieImportSource,
  BrowserDesignGrab,
  BrowserDialogPrompt,
  BrowserDownloadRecord,
  BrowserLifecycleEvent,
  BrowserPage,
  BrowserPermissionPrompt,
  BrowserProfile,
} from './types'

type BackendProfile = BrowserProfile & { pageIds: string[]; userDataDir?: string | null }
type BackendPage = BrowserPage & { droppedFrameCount?: number; latestFrameSequence?: number | null; focused?: boolean; visibilityLeaseCount?: number }
type BrowserProjection = {
  profiles: BackendProfile[]
  pages: BackendPage[]
  permissions: BrowserPermissionPrompt[]
  certificates: BrowserCertificatePrompt[]
  dialogs: BrowserDialogPrompt[]
  downloads: BrowserDownloadRecord[]
  events: BrowserLifecycleEvent[]
}
type RawDesignGrab = {
  pageId: string
  navigationGeneration: number
  selection: Omit<BrowserDesignGrab, 'pageId' | 'navigationGeneration'>
}

let lastSurfaceOwnerGeneration = 0

function nextSurfaceOwnerGeneration(): number {
  // Date-based generations survive ordinary remounts/reloads while remaining within
  // JavaScript's safe-integer range. The local fence makes same-millisecond mounts unique.
  lastSurfaceOwnerGeneration = Math.max(lastSurfaceOwnerGeneration + 1, Date.now() * 1024)
  return lastSurfaceOwnerGeneration
}

export function BrowserContentPanel({
  workspaceId,
  pageId,
  profileId,
  active,
  focused,
  workspaceVisible,
  nativeSurfacesSuspended = false,
  onTitleChange,
}: BrowserContentPanelProps & { nativeSurfacesSuspended?: boolean }) {
  const [initialState, setInitialState] = useState<BrowserContentState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [surfaceOwnerGeneration] = useState(nextSurfaceOwnerGeneration)
  const surfaceUpdateTail = useRef<Promise<void>>(Promise.resolve())
  const latestSurfaceUpdateGeneration = useRef(0)
  const lifecycleSubscribers = useRef(new Set<(event: BrowserLifecycleEvent) => void>())
  const bufferedLifecycleEvents = useRef<BrowserLifecycleEvent[]>([])

  const controller = useMemo<BrowserContentController>(() => ({
    async navigate(targetPageId, input) {
      const page = await invoke<BackendPage>('browser_navigate', { pageId: targetPageId, input })
      return { url: page.url, navigationGeneration: page.navigationGeneration }
    },
    async goBack(targetPageId) {
      return toPage(await invoke<BackendPage>('browser_go_back', { pageId: targetPageId }))
    },
    async goForward(targetPageId) {
      return toPage(await invoke<BackendPage>('browser_go_forward', { pageId: targetPageId }))
    },
    async reload(targetPageId) {
      return toPage(await invoke<BackendPage>('browser_reload', { pageId: targetPageId }))
    },
    async setSurfaceState(targetPageId, state) {
      const updateGeneration = ++latestSurfaceUpdateGeneration.current
      const update = surfaceUpdateTail.current
        .catch(() => undefined)
        .then(() => {
          if (updateGeneration !== latestSurfaceUpdateGeneration.current) return
          return invoke('browser_set_surface', {
            pageId: targetPageId,
            bounds: state.bounds,
            visible: state.visible,
            focused: state.focused,
            ownerGeneration: surfaceOwnerGeneration,
          })
        })
        .then(() => undefined)
      surfaceUpdateTail.current = update.catch(() => undefined)
      await update
    },
    async setDesignMode(targetPageId, enabled) {
      await invoke('browser_set_design_mode', { pageId: targetPageId, enabled })
    },
    async setDeviceMetrics(targetPageId, metrics) {
      return toPage(await invoke<BackendPage>('browser_set_device_metrics', { pageId: targetPageId, metrics }))
    },
    async resolvePermission(requestId, decision) {
      await invoke('browser_resolve_permission', { requestId, decision })
    },
    async resolveCertificate(requestId, decision) {
      await invoke('browser_resolve_certificate', { requestId, decision })
    },
    async resolveDialog(requestId, accept) {
      await invoke('browser_resolve_dialog', { requestId, accept })
    },
    async createAnnotation(targetPageId, grab, comment) {
      return invoke<BrowserAnnotation>('browser_create_annotation', {
        input: {
          workspaceId,
          pageId: targetPageId,
          navigationGeneration: grab.navigationGeneration,
          browserRef: grab.browserRef,
          accessibleName: grab.accessibleName,
          domAncestry: grab.domAncestry,
          bounds: grab.bounds,
          text: grab.text,
          attributes: grab.attributes,
          computedStyles: grab.computedStyles,
          sourceHints: grab.sourceHints,
          comment,
        },
      })
    },
    async detectCookieImportSource(endpoint) {
      return invoke<BrowserCookieImportSource>('browser_detect_cookie_import_source', { endpoint })
    },
    async importCookies(input) {
      return invoke<BrowserCookieImportResult>('browser_import_cookies', { input: { ...input, workspaceId } })
    },
    async subscribeLifecycle(handler) {
      lifecycleSubscribers.current.add(handler)
      const buffered = bufferedLifecycleEvents.current.splice(0)
      for (const event of buffered) handler(event)
      return () => {
        lifecycleSubscribers.current.delete(handler)
      }
    },
    async subscribeDesignGrabs(handler) {
      return listen<RawDesignGrab>('browser-design-grab', ({ payload }) => {
        handler({ ...payload.selection, pageId: payload.pageId, navigationGeneration: payload.navigationGeneration })
      })
    },
  }), [surfaceOwnerGeneration, workspaceId])

  useEffect(() => {
    const lifecycleSubscriberSet = lifecycleSubscribers.current
    let cancelled = false
    let stopLifecycle: (() => void) | undefined
    const initialize = async () => {
      const stop = await listen<BrowserLifecycleEvent>('browser-lifecycle', ({ payload }) => {
        if (payload.pageId !== pageId) return
        const subscribers = [...lifecycleSubscribers.current]
        if (subscribers.length === 0) {
          bufferedLifecycleEvents.current.push(payload)
          if (bufferedLifecycleEvents.current.length > 64) bufferedLifecycleEvents.current.shift()
          return
        }
        for (const subscriber of subscribers) subscriber(payload)
      })
      if (cancelled) {
        stop()
        return
      }
      stopLifecycle = stop
      const projection = await invoke<BrowserProjection>('browser_initialize', { workspaceId })
      if (cancelled) return
      const page = projection.pages.find((candidate) => candidate.id === pageId)
      const profile = projection.profiles.find((candidate) => candidate.id === profileId)
      if (!page || page.workspaceId !== workspaceId) throw new Error('The native browser page is not available in this workspace.')
      if (!profile || page.profileId !== profile.id) throw new Error('The browser content profile does not match its native page.')
      setInitialState(toContentState(projection, toPage(page), toProfile(profile)))
      setError(null)
    }
    void initialize().catch((cause) => {
      stopLifecycle?.()
      stopLifecycle = undefined
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      cancelled = true
      stopLifecycle?.()
      lifecycleSubscriberSet.clear()
      bufferedLifecycleEvents.current = []
    }
  }, [pageId, profileId, workspaceId])

  if (error) return <div className="browser-panel-error">{error}</div>
  if (!initialState
    || initialState.page.id !== pageId
    || initialState.page.workspaceId !== workspaceId
    || initialState.profile.id !== profileId) {
    return <div className="browser-panel-empty">Starting native WebView2…</div>
  }
  return (
    <BrowserPanel
      key={`${workspaceId}:${pageId}:${profileId}`}
      controller={controller}
      initialState={initialState}
      active={active}
      focused={focused}
      workspaceVisible={workspaceVisible}
      nativeSurfacesSuspended={nativeSurfacesSuspended}
      onTitleChange={onTitleChange}
    />
  )
}

function toContentState(projection: BrowserProjection, page: BrowserPage, profile: BrowserProfile): BrowserContentState {
  return {
    profile,
    page,
    addressDraft: page.url === 'about:blank' ? '' : page.url,
    designMode: false,
    annotation: null,
    annotationComment: '',
    modalDepth: 0,
    surfaceBounds: null,
    permissionQueue: projection.permissions.filter((request) => request.pageId === page.id),
    certificateQueue: projection.certificates.filter((request) => request.pageId === page.id),
    dialogQueue: projection.dialogs.filter((request) => request.pageId === page.id),
    downloads: projection.downloads.filter((download) => download.pageId === page.id),
    lastLifecycleEvent: projection.events.filter((event) => event.pageId === page.id).at(-1) ?? null,
  }
}

function toProfile(profile: BackendProfile): BrowserProfile {
  return {
    id: profile.id,
    kind: profile.kind,
    workspaceId: profile.workspaceId,
    cookieImportQuarantined: profile.cookieImportQuarantined ?? false,
  }
}

function toPage(page: BackendPage): BrowserPage {
  return {
    id: page.id,
    workspaceId: page.workspaceId,
    profileId: page.profileId,
    title: page.title,
    url: page.url,
    navigationGeneration: page.navigationGeneration,
    loadState: page.loadState,
    canGoBack: page.canGoBack,
    canGoForward: page.canGoForward,
    requestedVisible: page.requestedVisible,
    effectiveVisible: page.effectiveVisible,
    error: page.error ?? (page as BackendPage & { lastError?: string | null }).lastError ?? null,
    deviceMetrics: page.deviceMetrics,
  }
}
