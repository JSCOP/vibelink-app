export type BrowserProfileKind = 'persistent' | 'workspace' | 'incognito'
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
}

export type BrowserProjectTarget = {
  label: string
  url: string
  port: number
  running: boolean
  source: string
  startCommand: string | null
}

export type BrowserTab = {
  id: string
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
  droppedFrameCount: number
  latestFrameSequence: number | null
}

export type ArtifactDescriptor = {
  path: string
  contentType: string
  bytes: number
  expiresAtMs: number
  truncated: boolean
}

export type DesignGrabSelection = {
  pageId: string
  navigationGeneration: number
  snapshotId: string
  browserRef: string
  screenshotCrop: ArtifactDescriptor | null
  domAncestry: string[]
  accessibleName: string
  bounds: PhysicalBounds
  computedStyles: Array<[string, string]>
  attributes: Array<[string, string]>
  text: string
  sourceHints: string[]
}

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

export type BrowserPanelState = {
  profiles: BrowserProfile[]
  tabs: BrowserTab[]
  activePageId: string | null
  addressDraft: string
  designMode: boolean
  designSelection: DesignGrabSelection | null
  modalDepth: number
  surfaceBounds: PhysicalBounds | null
  permissionQueue: BrowserPermissionPrompt[]
  certificateQueue: BrowserCertificatePrompt[]
  dialogQueue: BrowserDialogPrompt[]
  downloads: BrowserDownloadRecord[]
  captureState: BrowserCaptureState | null
  selectedProfileId: string | null
  lastLifecycleEvent: BrowserLifecycleEvent | null
}

export type BrowserPanelController = {
  createTab(profileId: string): Promise<BrowserTab>
  createProfile(kind: BrowserProfileKind): Promise<BrowserProfile>
  closeTab(pageId: string): Promise<void>
  selectTab(pageId: string): Promise<void>
  navigate(pageId: string, input: string): Promise<{ url: string; navigationGeneration: number }>
  goBack(pageId: string): Promise<void>
  goForward(pageId: string): Promise<void>
  reload(pageId: string): Promise<void>
  setSurfaceState(pageId: string, state: { bounds: PhysicalBounds | null; visible: boolean }): Promise<void>
  setDesignMode(pageId: string, enabled: boolean): Promise<void>
  setDeviceMetrics(pageId: string, metrics: BrowserDeviceMetrics | null): Promise<BrowserTab>
  getCaptureState(pageId: string): Promise<BrowserCaptureState>
  captureFrame(pageId: string): Promise<BrowserCaptureState>
  resolvePermission(requestId: string, decision: 'allow_once' | 'allow_for_origin' | 'deny'): Promise<void>
  resolveCertificate(requestId: string, decision: 'allow_for_origin' | 'deny'): Promise<void>
  resolveDialog(requestId: string, accept: boolean): Promise<void>
  subscribeLifecycle?(handler: (event: BrowserLifecycleEvent) => void): Promise<() => void>
  subscribeDesignGrabs?(handler: (selection: DesignGrabSelection) => void): Promise<() => void>
}
