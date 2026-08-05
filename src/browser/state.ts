import type {
  BrowserAnnotation,
  BrowserCertificatePrompt,
  BrowserContentState,
  BrowserDialogPrompt,
  BrowserDownloadRecord,
  BrowserLifecycleEvent,
  BrowserPage,
  BrowserPermissionPrompt,
  PhysicalBounds,
} from './types'

export type BrowserGrabIntent = 'copy' | 'annotate'
export type BrowserPanelState = BrowserContentState & { grabIntent: BrowserGrabIntent }

export type BrowserPanelAction =
  | { type: 'addressChanged'; value: string }
  | { type: 'navigationStarted'; input: string; generation: number }
  | { type: 'navigationCommitted'; url: string; generation: number }
  | { type: 'navigationFailed'; generation: number; error: string }
  | { type: 'surfaceBoundsChanged'; bounds: PhysicalBounds | null }
  | { type: 'surfaceVisibilityChanged'; visible: boolean }
  | { type: 'designModeChanged'; enabled: boolean }
  | { type: 'grabIntentChanged'; intent: BrowserGrabIntent }
  | { type: 'annotationCreated'; annotation: BrowserAnnotation }
  | { type: 'annotationCommentChanged'; comment: string }
  | { type: 'annotationCleared' }
  | { type: 'modalDepthChanged'; depth: number }
  | { type: 'permissionQueued'; request: BrowserPermissionPrompt }
  | { type: 'permissionResolved'; requestId: string }
  | { type: 'certificateQueued'; request: BrowserCertificatePrompt }
  | { type: 'certificateResolved'; requestId: string }
  | { type: 'dialogQueued'; request: BrowserDialogPrompt }
  | { type: 'dialogResolved'; requestId: string }
  | { type: 'downloadChanged'; download: BrowserDownloadRecord }
  | { type: 'deviceMetricsChanged'; page: BrowserPage }
  | { type: 'profileCookieImportQuarantined' }
  | { type: 'lifecycleReceived'; event: BrowserLifecycleEvent }

export function createBrowserPanelState(input: BrowserContentState): BrowserPanelState {
  return {
    ...input,
    addressDraft: input.addressDraft ?? input.page.url,
    designMode: input.designMode ?? false,
    grabIntent: 'copy',
    annotation: input.annotation ?? null,
    annotationComment: input.annotationComment ?? '',
    modalDepth: input.modalDepth ?? 0,
    surfaceBounds: input.surfaceBounds ?? null,
    permissionQueue: input.permissionQueue ?? [],
    certificateQueue: input.certificateQueue ?? [],
    dialogQueue: input.dialogQueue ?? [],
    downloads: input.downloads ?? [],
    lastLifecycleEvent: input.lastLifecycleEvent ?? null,
  }
}

export function activeSurfaceVisible(state: BrowserContentState): boolean {
  return state.modalDepth === 0
}

export function browserPanelReducer(state: BrowserPanelState, action: BrowserPanelAction): BrowserPanelState {
  switch (action.type) {
    case 'addressChanged':
      return { ...state, addressDraft: action.value }
    case 'navigationStarted':
      if (action.generation <= state.page.navigationGeneration) return state
      return {
        ...state,
        page: { ...state.page, navigationGeneration: action.generation, loadState: 'loading', error: null },
        addressDraft: action.input,
        designMode: false,
        annotation: null,
        annotationComment: '',
      }
    case 'navigationCommitted':
      if (action.generation !== state.page.navigationGeneration) return state
      return { ...state, page: { ...state.page, url: action.url, loadState: 'loading', error: null }, addressDraft: action.url }
    case 'navigationFailed':
      if (action.generation !== state.page.navigationGeneration) return state
      return { ...state, page: { ...state.page, loadState: 'failed', error: action.error } }
    case 'surfaceBoundsChanged':
      return { ...state, surfaceBounds: action.bounds }
    case 'surfaceVisibilityChanged':
      return { ...state, page: { ...state.page, effectiveVisible: action.visible } }
    case 'designModeChanged':
      return { ...state, designMode: action.enabled }
    case 'grabIntentChanged':
      return { ...state, grabIntent: action.intent }
    case 'annotationCreated':
      if (action.annotation.pageId !== state.page.id || action.annotation.navigationGeneration !== state.page.navigationGeneration) return state
      return { ...state, annotation: action.annotation, annotationComment: action.annotation.comment }
    case 'annotationCommentChanged':
      return {
        ...state,
        annotationComment: action.comment,
        annotation: state.annotation ? { ...state.annotation, comment: action.comment } : null,
      }
    case 'annotationCleared':
      return { ...state, annotation: null, annotationComment: '' }
    case 'modalDepthChanged':
      return { ...state, modalDepth: Math.max(0, action.depth) }
    case 'permissionQueued':
      return state.permissionQueue.some((item) => item.id === action.request.id) ? state : { ...state, permissionQueue: [...state.permissionQueue, action.request] }
    case 'permissionResolved':
      return { ...state, permissionQueue: state.permissionQueue.filter((item) => item.id !== action.requestId) }
    case 'certificateQueued':
      return state.certificateQueue.some((item) => item.id === action.request.id) ? state : { ...state, certificateQueue: [...state.certificateQueue, action.request] }
    case 'certificateResolved':
      return { ...state, certificateQueue: state.certificateQueue.filter((item) => item.id !== action.requestId) }
    case 'dialogQueued':
      return state.dialogQueue.some((item) => item.id === action.request.id) ? state : { ...state, dialogQueue: [...state.dialogQueue, action.request] }
    case 'dialogResolved':
      return { ...state, dialogQueue: state.dialogQueue.filter((item) => item.id !== action.requestId) }
    case 'downloadChanged': {
      const downloads = state.downloads.filter((item) => item.id !== action.download.id)
      return { ...state, downloads: [...downloads, action.download].slice(-32) }
    }
    case 'deviceMetricsChanged':
      return action.page.id === state.page.id ? { ...state, page: action.page } : state
    case 'profileCookieImportQuarantined':
      return { ...state, profile: { ...state.profile, cookieImportQuarantined: true } }
    case 'lifecycleReceived':
      return reduceLifecycle(state, action.event)
  }
}

function reduceLifecycle(state: BrowserPanelState, event: BrowserLifecycleEvent): BrowserPanelState {
  if (event.pageId !== state.page.id || event.navigationGeneration < state.page.navigationGeneration) return state
  let page = state.page
  let addressDraft = state.addressDraft
  let annotation = state.annotation
  let annotationComment = state.annotationComment
  let designMode = state.designMode
  if (event.navigationGeneration > page.navigationGeneration) {
    page = { ...page, navigationGeneration: event.navigationGeneration }
    annotation = null
    annotationComment = ''
    designMode = false
  }
  switch (event.kind) {
    case 'navigation_started':
      page = { ...page, loadState: 'loading', error: null }
      annotation = null
      annotationComment = ''
      designMode = false
      break
    case 'navigation_committed':
      page = { ...page, url: event.url ?? page.url, loadState: 'loading', error: null }
      addressDraft = event.url ?? addressDraft
      break
    case 'navigation_finished':
      page = { ...page, url: event.url ?? page.url, loadState: 'loaded', error: null }
      addressDraft = event.url ?? addressDraft
      break
    case 'navigation_failed':
      page = { ...page, loadState: 'failed', error: event.detail ?? 'Navigation failed.' }
      break
    case 'title_changed':
      page = { ...page, title: event.detail?.trim() || page.title }
      break
    case 'page_closed':
      page = { ...page, effectiveVisible: false, requestedVisible: false }
      break
    default:
      break
  }
  return { ...state, page, addressDraft, designMode, annotation, annotationComment, lastLifecycleEvent: event }
}
