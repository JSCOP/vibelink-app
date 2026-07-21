export type BrowserProfileKind = 'persistent' | 'workspace' | 'imported' | 'incognito'
export type BrowserLoadState = 'idle' | 'loading' | 'loaded' | 'failed'

export type PhysicalBounds = {
  x: number
  y: number
  width: number
  height: number
  scaleFactorMilli: number
}

export type BrowserDeviceMetrics = {
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
}

export type BrowserProfile = {
  id: string
  kind: BrowserProfileKind
  workspaceId: string | null
  cookieImportQuarantined: boolean
}

export type BrowserProjectTarget = {
  label: string
  url: string
  port: number
  running: boolean
  source: string
  startCommand: string | null
}

export type BrowserPage = {
  id: string
  workspaceId: string
  profileId: string
  title: string
  url: string
  navigationGeneration: number
  loadState: BrowserLoadState
  canGoBack: boolean
  canGoForward: boolean
  requestedVisible: boolean
  effectiveVisible: boolean
  error: string | null
  deviceMetrics: BrowserDeviceMetrics | null
}

export type ArtifactDescriptor = {
  path: string
  contentType: string
  bytes: number
  expiresAtMs: number
  truncated: boolean
}

export type BrowserAnnotation = {
  id: string
  workspaceId: string
  pageId: string
  navigationGeneration: number
  url: string
  browserRef: string
  accessibleName: string
  domAncestry: string[]
  bounds: PhysicalBounds
  text: string
  attributes: Array<[string, string]>
  computedStyles: Array<[string, string]>
  sourceHints: string[]
  comment: string
  screenshot: ArtifactDescriptor | null
}

export type BrowserAnnotationDestination =
  | { kind: 'agent' }
  | { kind: 'terminal'; paneId: string; title: string; role: string | null }
  | { kind: 'copy' }

export type BrowserDesignGrab = Omit<BrowserAnnotation, 'id' | 'workspaceId' | 'url' | 'comment' | 'screenshot'>

export type BrowserPermissionPrompt = {
  id: string
  pageId: string
  origin: string
  permission: string
}

export type BrowserCertificatePrompt = {
  id: string
  pageId: string
  origin: string
  errorCode: string
}

export type BrowserDialogPrompt = {
  id: string
  pageId: string
  origin: string
  kind: 'alert' | 'confirm' | 'prompt' | 'before_unload'
  message: string
  defaultText: string | null
}

export type BrowserDownloadRecord = {
  id: string
  pageId: string
  url: string
  path: string | null
  success: boolean | null
  error: string | null
  updatedAtMs: number
}

export type BrowserCaptureState = {
  pageId: string
  pendingFrames: number
  droppedFrames: number
  latestSequence: number | null
  latestBytes: number | null
}

export type BrowserLifecycleEvent = {
  sequence: number
  pageId: string
  navigationGeneration: number
  kind:
    | 'page_created'
    | 'page_closed'
    | 'popup_requested'
    | 'navigation_started'
    | 'navigation_committed'
    | 'navigation_finished'
    | 'navigation_failed'
    | 'title_changed'
    | 'download_requested'
    | 'download_finished'
    | 'dialog_requested'
    | 'permission_requested'
    | 'certificate_error'
    | 'capture_updated'
    | 'device_metrics_changed'
    | 'restored'
  url: string | null
  detail: string | null
  timestampMs: number
}

export type BrowserCookieImportSource = {
  endpoint: string
  browser: 'chrome' | 'edge' | 'chromium' | 'unknown'
  origins: string[]
}

export type BrowserCookieImportResult = {
  importedCount: number
  originCount: number
  verified: boolean
  rolledBack: boolean
  quarantined: boolean
}

export type BrowserCloseResult = {
  closed: boolean
  persistencePending: boolean
}

export type BrowserContentState = {
  profile: BrowserProfile
  page: BrowserPage
  addressDraft: string
  designMode: boolean
  annotation: BrowserAnnotation | null
  annotationComment: string
  modalDepth: number
  surfaceBounds: PhysicalBounds | null
  permissionQueue: BrowserPermissionPrompt[]
  certificateQueue: BrowserCertificatePrompt[]
  dialogQueue: BrowserDialogPrompt[]
  downloads: BrowserDownloadRecord[]
  lastLifecycleEvent: BrowserLifecycleEvent | null
}

export type BrowserContentController = {
  navigate(pageId: string, input: string): Promise<{ url: string; navigationGeneration: number }>
  goBack(pageId: string): Promise<BrowserPage | void>
  goForward(pageId: string): Promise<BrowserPage | void>
  reload(pageId: string): Promise<BrowserPage | void>
  setSurfaceState(pageId: string, state: { bounds: PhysicalBounds | null; visible: boolean; focused: boolean }): Promise<void>
  setDesignMode(pageId: string, enabled: boolean): Promise<void>
  setDeviceMetrics(pageId: string, metrics: BrowserDeviceMetrics | null): Promise<BrowserPage>
  resolvePermission(requestId: string, decision: 'allow_once' | 'allow_for_origin' | 'deny'): Promise<void>
  resolveCertificate(requestId: string, decision: 'allow_for_origin' | 'deny'): Promise<void>
  resolveDialog(requestId: string, accept: boolean): Promise<void>
  createAnnotation(pageId: string, grab: BrowserDesignGrab, comment: string): Promise<BrowserAnnotation>
  detectCookieImportSource(endpoint: string): Promise<BrowserCookieImportSource>
  importCookies(input: { pageId: string; profileId: string; endpoint: string; origins: string[]; consent: boolean }): Promise<BrowserCookieImportResult>
  subscribeLifecycle?(handler: (event: BrowserLifecycleEvent) => void): Promise<() => void>
  subscribeDesignGrabs?(handler: (selection: BrowserDesignGrab) => void): Promise<() => void>
}
