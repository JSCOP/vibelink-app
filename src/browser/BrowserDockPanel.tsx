import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { BrowserPanel } from './BrowserPanel'
import { publishBrowserSelectionDraft } from './agentContext'
import type {
  ArtifactDescriptor,
  BrowserCaptureState,
  BrowserCertificatePrompt,
  BrowserDialogPrompt,
  BrowserDownloadRecord,
  BrowserLifecycleEvent,
  BrowserPanelController,
  BrowserPanelState,
  BrowserPermissionPrompt,
  BrowserProfile,
  BrowserProjectTarget,
  BrowserTab,
  DesignGrabSelection,
} from './types'
import { useWorkspaceStore } from '../state/store'

type BackendProfile = BrowserProfile & { pageIds: string[]; userDataDir?: string | null }
type BackendPage = {
  id: string
  workspaceId: string
  profileId: string
  url: string
  title: string
  navigationGeneration: number
  requestedVisible: boolean
  effectiveVisible: boolean
  loadState: BrowserTab['loadState']
  canGoBack: boolean
  canGoForward: boolean
  lastError: string | null
  deviceMetrics: BrowserTab['deviceMetrics']
  droppedFrameCount: number
  latestFrameSequence: number | null
}
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
  selection: Omit<DesignGrabSelection, 'pageId' | 'navigationGeneration' | 'snapshotId' | 'screenshotCrop'>
}

type BrowserDockPanelProps = {
  onOpenAgent?: () => void
  onOpenTerminal?: () => void
}

export function BrowserDockPanel({ onOpenAgent, onOpenTerminal }: BrowserDockPanelProps = {}) {
  const workspaceId = useWorkspaceStore((state) => state.activeSessionId)
  const workspaceFolder = useWorkspaceStore((state) => state.sessions.find((session) => session.id === state.activeSessionId)?.workspaceFolder ?? null)
  const spawnPane = useWorkspaceStore((state) => state.spawnPane)
  const [initialState, setInitialState] = useState<BrowserPanelState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedWorkspaceId, setLoadedWorkspaceId] = useState<string | null>(null)
  const [projectTargets, setProjectTargets] = useState<BrowserProjectTarget[]>([])

  const controller = useMemo<BrowserPanelController | null>(() => {
    if (!workspaceId) return null
    return {
      async createTab(profileId) {
        return toTab(await invoke<BackendPage>('browser_create_tab', { workspaceId, profileId }))
      },
      async createProfile(kind) {
        const profile = await invoke<BackendProfile>('browser_create_profile', { workspaceId, kind })
        return { id: profile.id, kind: profile.kind, workspaceId: profile.workspaceId }
      },
      async closeTab(pageId) {
        await invoke('browser_close_tab', { workspaceId, pageId })
      },
      async selectTab(pageId) {
        await invoke('browser_select_tab', { workspaceId, pageId })
      },
      async navigate(pageId, input) {
        const page = await invoke<BackendPage>('browser_navigate', { pageId, input })
        return { url: page.url, navigationGeneration: page.navigationGeneration }
      },
      async goBack(pageId) {
        await invoke('browser_go_back', { pageId })
      },
      async goForward(pageId) {
        await invoke('browser_go_forward', { pageId })
      },
      async reload(pageId) {
        await invoke('browser_reload', { pageId })
      },
      async setSurfaceState(pageId, state) {
        await invoke('browser_set_surface', {
          pageId,
          bounds: state.bounds,
          visible: state.visible,
        })
      },
      async setDesignMode(pageId, enabled) {
        await invoke('browser_set_design_mode', { pageId, enabled })
      },
      async setDeviceMetrics(pageId, metrics) {
        return toTab(await invoke<BackendPage>('browser_set_device_metrics', { pageId, metrics }))
      },
      async getCaptureState(pageId) {
        return invoke<BrowserCaptureState>('browser_capture_state', { pageId })
      },
      async captureFrame(pageId) {
        return invoke<BrowserCaptureState>('browser_capture_state', { pageId, capture: true })
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
      async subscribeLifecycle(handler) {
        return listen<BrowserLifecycleEvent>('browser-lifecycle', ({ payload }) => handler(payload))
      },
      async subscribeDesignGrabs(handler) {
        return listen<RawDesignGrab>('browser-design-grab', ({ payload }) => {
          const selection = {
            ...payload.selection,
            pageId: payload.pageId,
            navigationGeneration: 0,
            snapshotId: `design-${Date.now()}`,
          }
          void invoke<ArtifactDescriptor>('browser_capture_crop', {
            pageId: payload.pageId,
            bounds: payload.selection.bounds,
          })
            .then((screenshotCrop) => handler({ ...selection, screenshotCrop }))
            .catch((cause) => {
              const message = cause instanceof Error ? cause.message : String(cause)
              setError(message)
              handler({
                ...selection,
                screenshotCrop: null,
                sourceHints: [...selection.sourceHints, `Screenshot capture failed: ${message}`],
              })
            })
        })
      },
    }
  }, [workspaceId])

  useEffect(() => {
    let cancelled = false
    if (!workspaceId) return
    void invoke<BrowserProjection>('browser_initialize', { workspaceId })
      .then((projection) => {
        if (cancelled) return
        setInitialState(toPanelState(projection))
        setError(null)
        setLoadedWorkspaceId(workspaceId)
      })
      .catch((cause) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setLoadedWorkspaceId(workspaceId)
      })
    return () => { cancelled = true }
  }, [workspaceId])

  useEffect(() => {
    let cancelled = false
    if (!workspaceFolder) {
      const timer = window.setTimeout(() => setProjectTargets([]), 0)
      return () => window.clearTimeout(timer)
    }
    const loadTargets = () => {
      void invoke<BrowserProjectTarget[]>('browser_project_targets', { workspaceFolder })
        .then((targets) => { if (!cancelled) setProjectTargets(targets) })
        .catch(() => { if (!cancelled) setProjectTargets([]) })
    }
    loadTargets()
    const timer = window.setInterval(loadTargets, 3_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [workspaceFolder])

  if (!workspaceId) return <div className="browser-panel-empty">Open a workspace to use Browser.</div>
  if (loadedWorkspaceId !== workspaceId) return <div className="browser-panel-empty">Starting native WebView2…</div>
  if (error) return <div className="browser-panel-error">{error}</div>
  if (!initialState || !controller) return <div className="browser-panel-empty">Starting native WebView2…</div>
  return (
    <BrowserPanel
      controller={controller}
      initialState={initialState}
      projectTargets={projectTargets}
      onError={setError}
      onSendSelectionToAgent={(selection, url) => {
        publishBrowserSelectionDraft(selection, url)
        onOpenAgent?.()
      }}
      onStartProject={(target) => {
        if (!workspaceId || !workspaceFolder || !target.startCommand) return
        void spawnPane(workspaceId, {
          shell: 'cmd.exe',
          args: ['/D', '/S', '/C', target.startCommand],
          cwd: workspaceFolder,
          title: `${target.label} dev server`,
          icon: 'globe',
        }).then(() => onOpenTerminal?.()).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      }}
    />
  )
}

function toPanelState(projection: BrowserProjection): BrowserPanelState {
  const tabs = projection.pages.map(toTab)
  const active = tabs.find((tab) => tab.effectiveVisible) ?? tabs[0] ?? null
  return {
    profiles: projection.profiles.map((profile) => ({
      id: profile.id,
      kind: profile.kind,
      workspaceId: profile.workspaceId,
    })),
    tabs,
    activePageId: active?.id ?? null,
    addressDraft: active?.url ?? '',
    designMode: false,
    designSelection: null,
    modalDepth: 0,
    surfaceBounds: null,
    permissionQueue: projection.permissions,
    certificateQueue: projection.certificates,
    dialogQueue: projection.dialogs,
    downloads: projection.downloads,
    captureState: null,
    selectedProfileId: active?.profileId ?? projection.profiles[0]?.id ?? null,
    lastLifecycleEvent: projection.events.at(-1) ?? null,
  }
}

function toTab(page: BackendPage): BrowserTab {
  return {
    id: page.id,
    profileId: page.profileId,
    title: page.title,
    url: page.url,
    navigationGeneration: page.navigationGeneration,
    loadState: page.loadState,
    canGoBack: page.canGoBack,
    canGoForward: page.canGoForward,
    requestedVisible: page.requestedVisible,
    effectiveVisible: page.effectiveVisible,
    error: page.lastError,
    deviceMetrics: page.deviceMetrics,
    droppedFrameCount: page.droppedFrameCount,
    latestFrameSequence: page.latestFrameSequence,
  }
}

