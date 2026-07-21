import type {
  BrowserCaptureState,
  BrowserCertificatePrompt,
  BrowserDialogPrompt,
  BrowserDownloadRecord,
  BrowserLifecycleEvent,
  BrowserPanelState,
  BrowserPermissionPrompt,
  BrowserProfile,
  BrowserTab,
  DesignGrabSelection,
  PhysicalBounds,
} from './types'

export type BrowserPanelAction =
  | { type: 'tabCreated'; tab: BrowserTab }
  | { type: 'profileCreated'; profile: BrowserProfile }
  | { type: 'profileSelected'; profileId: string }
  | { type: 'tabSelected'; pageId: string }
  | { type: 'tabClosed'; pageId: string }
  | { type: 'addressChanged'; value: string }
  | { type: 'navigationStarted'; pageId: string; input: string; generation: number }
  | { type: 'navigationCommitted'; pageId: string; url: string; generation: number }
  | { type: 'navigationFailed'; pageId: string; error: string; generation: number }
  | { type: 'navigationState'; pageId: string; canGoBack: boolean; canGoForward: boolean; generation: number }
  | { type: 'titleChanged'; pageId: string; title: string; generation: number }
  | { type: 'surfaceBoundsChanged'; bounds: PhysicalBounds | null }
  | { type: 'surfaceVisibilityChanged'; pageId: string; requestedVisible: boolean; effectiveVisible: boolean }
  | { type: 'modalOpened' }
  | { type: 'modalClosed' }
  | { type: 'designModeChanged'; enabled: boolean }
  | { type: 'designGrabbed'; selection: DesignGrabSelection }
  | { type: 'captureStateChanged'; capture: BrowserCaptureState | null }
  | { type: 'deviceMetricsChanged'; pageId: string; metrics: BrowserTab['deviceMetrics'] }
  | { type: 'lifecycleReceived'; event: BrowserLifecycleEvent }
  | { type: 'dialogQueued'; request: BrowserDialogPrompt }
  | { type: 'dialogResolved'; requestId: string }
  | { type: 'downloadUpdated'; download: BrowserDownloadRecord }
  | { type: 'designSelectionCleared' }
  | { type: 'permissionQueued'; request: BrowserPermissionPrompt }
  | { type: 'permissionResolved'; requestId: string }
  | { type: 'certificateQueued'; request: BrowserCertificatePrompt }
  | { type: 'certificateResolved'; requestId: string }

export function createBrowserPanelState(input?: Partial<BrowserPanelState>): BrowserPanelState {
  const tabs = input?.tabs ?? []
  const requestedActive = input?.activePageId ?? tabs[0]?.id ?? null
  const activePageId = tabs.some((tab) => tab.id === requestedActive) ? requestedActive : tabs[0]?.id ?? null
  const active = tabs.find((tab) => tab.id === activePageId)
  return {
    profiles: input?.profiles ?? [],
    tabs,
    activePageId,
    addressDraft: input?.addressDraft ?? active?.url ?? '',
    designMode: input?.designMode ?? false,
    designSelection: input?.designSelection ?? null,
    modalDepth: Math.max(0, input?.modalDepth ?? 0),
    surfaceBounds: input?.surfaceBounds ?? null,
    permissionQueue: input?.permissionQueue ?? [],
    certificateQueue: input?.certificateQueue ?? [],
    dialogQueue: input?.dialogQueue ?? [],
    downloads: input?.downloads ?? [],
    captureState: input?.captureState ?? null,
    selectedProfileId: input?.selectedProfileId
      ?? active?.profileId
      ?? input?.profiles?.[0]?.id
      ?? null,
    lastLifecycleEvent: input?.lastLifecycleEvent ?? null,
  }
}

export function activeBrowserTab(state: BrowserPanelState): BrowserTab | null {
  return state.tabs.find((tab) => tab.id === state.activePageId) ?? null
}

export function activeSurfaceVisible(state: BrowserPanelState): boolean {
  const active = activeBrowserTab(state)
  const hasPrompt = state.permissionQueue.length > 0
    || state.certificateQueue.length > 0
    || state.dialogQueue.length > 0
  return Boolean(active?.effectiveVisible && state.modalDepth === 0 && !hasPrompt)
}

export function browserPanelReducer(state: BrowserPanelState, action: BrowserPanelAction): BrowserPanelState {
  switch (action.type) {
    case 'profileCreated':
      return {
        ...state,
        profiles: appendUnique(state.profiles, action.profile),
        selectedProfileId: action.profile.id,
      }
    case 'profileSelected':
      return state.profiles.some((profile) => profile.id === action.profileId)
        ? { ...state, selectedProfileId: action.profileId }
        : state
    case 'tabCreated':
      return {
        ...state,
        tabs: [...state.tabs, action.tab],
        activePageId: action.tab.id,
        addressDraft: action.tab.url,
        designMode: false,
        designSelection: null,
      }
    case 'tabSelected': {
      const active = state.tabs.find((tab) => tab.id === action.pageId)
      if (!active) return state
      return { ...state, activePageId: active.id, addressDraft: active.url, designMode: false, designSelection: null }
    }
    case 'tabClosed': {
      const index = state.tabs.findIndex((tab) => tab.id === action.pageId)
      if (index < 0) return state
      const tabs = state.tabs.filter((tab) => tab.id !== action.pageId)
      if (state.activePageId !== action.pageId) return { ...state, tabs }
      const next = tabs[Math.min(index, tabs.length - 1)] ?? null
      return {
        ...state,
        tabs,
        activePageId: next?.id ?? null,
        addressDraft: next?.url ?? '',
        designMode: false,
        designSelection: null,
      }
    }
    case 'addressChanged':
      return { ...state, addressDraft: action.value }
    case 'navigationStarted': {
      const tab = state.tabs.find((candidate) => candidate.id === action.pageId)
      if (!tab || action.generation <= tab.navigationGeneration) return state
      return updateTab(state, action.pageId, (current) => ({
        ...current,
        navigationGeneration: action.generation,
        loadState: 'loading',
        error: null,
        url: action.input,
      }), state.activePageId === action.pageId ? action.input : state.addressDraft)
    }
    case 'navigationCommitted':
      return updateGenerationMatchedTab(state, action.pageId, action.generation, (tab) => ({
        ...tab,
        url: action.url,
        loadState: 'loaded',
        error: null,
      }), state.activePageId === action.pageId ? action.url : state.addressDraft)
    case 'navigationFailed':
      return updateGenerationMatchedTab(state, action.pageId, action.generation, (tab) => ({
        ...tab,
        loadState: 'failed',
        error: action.error,
      }))
    case 'navigationState':
      return updateGenerationMatchedTab(state, action.pageId, action.generation, (tab) => ({
        ...tab,
        canGoBack: action.canGoBack,
        canGoForward: action.canGoForward,
      }))
    case 'titleChanged':
      return updateGenerationMatchedTab(state, action.pageId, action.generation, (tab) => ({ ...tab, title: action.title }))
    case 'surfaceBoundsChanged':
      return { ...state, surfaceBounds: action.bounds }
    case 'surfaceVisibilityChanged':
      return updateTab(state, action.pageId, (tab) => ({
        ...tab,
        requestedVisible: action.requestedVisible,
        effectiveVisible: action.effectiveVisible,
      }))
    case 'modalOpened':
      return { ...state, modalDepth: state.modalDepth + 1 }
    case 'modalClosed':
      return { ...state, modalDepth: Math.max(0, state.modalDepth - 1) }
    case 'designModeChanged':
      return { ...state, designMode: action.enabled, designSelection: action.enabled ? state.designSelection : null }
    case 'designGrabbed':
      if (action.selection.pageId !== state.activePageId) return state
      return { ...state, designSelection: action.selection }
    case 'deviceMetricsChanged':
      return updateTab(state, action.pageId, (tab) => ({ ...tab, deviceMetrics: action.metrics }))
    case 'designSelectionCleared':
      return { ...state, designSelection: null }
    case 'captureStateChanged':
      return { ...state, captureState: action.capture }
    case 'lifecycleReceived': {
      const next = { ...state, lastLifecycleEvent: action.event }
      switch (action.event.kind) {
        case 'navigation_committed':
          return updateGenerationMatchedTab(next, action.event.pageId, action.event.navigationGeneration, (tab) => ({
            ...tab,
            url: action.event.url ?? tab.url,
            loadState: 'loading',
            error: null,
          }), state.activePageId === action.event.pageId ? action.event.url ?? state.addressDraft : state.addressDraft)
        case 'navigation_finished':
          return updateGenerationMatchedTab(next, action.event.pageId, action.event.navigationGeneration, (tab) => ({
            ...tab,
            url: action.event.url ?? tab.url,
            loadState: 'loaded',
            error: null,
            canGoBack: tab.navigationGeneration > 0,
          }), state.activePageId === action.event.pageId ? action.event.url ?? state.addressDraft : state.addressDraft)
        case 'navigation_failed':
          return updateGenerationMatchedTab(next, action.event.pageId, action.event.navigationGeneration, (tab) => ({
            ...tab,
            loadState: 'failed',
            error: action.event.detail ?? 'Navigation failed.',
          }))
        case 'title_changed':
          return updateGenerationMatchedTab(next, action.event.pageId, action.event.navigationGeneration, (tab) => ({
            ...tab,
            title: action.event.detail ?? tab.title,
          }))
        case 'popup_requested':
          return updateTab(next, action.event.pageId, (tab) => ({
            ...tab,
            error: `Popup blocked: ${action.event.url ?? 'unknown destination'}`,
          }))
        default:
          return next
      }
    }
    case 'dialogQueued':
      return { ...state, dialogQueue: appendUnique(state.dialogQueue, action.request) }
    case 'dialogResolved':
      return { ...state, dialogQueue: state.dialogQueue.filter((request) => request.id !== action.requestId) }
    case 'downloadUpdated':
      return {
        ...state,
        downloads: [
          ...state.downloads.filter((download) => download.id !== action.download.id),
          action.download,
        ],
      }
    case 'permissionQueued':
      return { ...state, permissionQueue: appendUnique(state.permissionQueue, action.request) }
    case 'permissionResolved':
      return { ...state, permissionQueue: state.permissionQueue.filter((request) => request.id !== action.requestId) }
    case 'certificateQueued':
      return { ...state, certificateQueue: appendUnique(state.certificateQueue, action.request) }
    case 'certificateResolved':
      return { ...state, certificateQueue: state.certificateQueue.filter((request) => request.id !== action.requestId) }
  }
}

function updateTab(
  state: BrowserPanelState,
  pageId: string,
  update: (tab: BrowserTab) => BrowserTab,
  addressDraft = state.addressDraft,
): BrowserPanelState {
  const index = state.tabs.findIndex((tab) => tab.id === pageId)
  if (index < 0) return state
  const tabs = state.tabs.slice()
  tabs[index] = update(tabs[index])
  return { ...state, tabs, addressDraft }
}

function updateGenerationMatchedTab(
  state: BrowserPanelState,
  pageId: string,
  generation: number,
  update: (tab: BrowserTab) => BrowserTab,
  addressDraft = state.addressDraft,
): BrowserPanelState {
  const tab = state.tabs.find((candidate) => candidate.id === pageId)
  if (!tab || tab.navigationGeneration !== generation) return state
  return updateTab(state, pageId, update, addressDraft)
}

function appendUnique<T extends { id: string }>(items: T[], item: T): T[] {
  return items.some((candidate) => candidate.id === item.id) ? items : [...items, item]
}
