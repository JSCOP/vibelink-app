import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Channel, invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { register, unregister } from '@tauri-apps/plugin-global-shortcut'
import { Activity, AlertTriangle, Bug, Camera, Eraser, Minus, Settings2, Square, Video, X } from 'lucide-react'
import { SettingsDialog } from './components/SettingsDialog'
import { StartupWorkspaceDialog } from './components/StartupWorkspaceDialog'
import { WorkspaceCreateDialog } from './components/WorkspaceCreateDialog'
import { WorkspaceSettingsDialog } from './components/WorkspaceSettingsDialog'
import { ImportReposDialog } from './components/workspaces/ImportReposDialog'
import { ResourceMonitorDialog } from './components/ResourceMonitorDialog'
import { CaptureAnnotator } from './components/CaptureAnnotator.tsx'
import { SetupWizard } from './components/SetupWizard'
import { AppLockedScreen } from './components/AppLockedScreen'
import { BugReportDialog } from './components/BugReportDialog'
import { WorkspaceView } from './layout/WorkspaceView'
import type { WorkspaceContentActions, WorkspaceContentChromeState } from './layout/contentActions'
import { isControlCharacterCode } from './layout/workspaceContentModel'
import { getEditorDocumentStore, type EditorDocumentStore } from './editor/documentStore'
import { startTerminalOutputStream } from './ipc/output'
import { getHermesRuntimeStatus, startHermesAgent, startHermesOutputStream } from './ipc/hermes'
import type { CloneProgress, HermesRuntimeStatus } from './ipc/types'
import type { WorkspaceCreationInput } from './ipc/providerIntegrations'
import { paneCompletionCountsBySession, useWorkspaceStore } from './state/store'
import { useGitStore } from './state/git'
import { TerminalManager } from './terminal/TerminalManager'
import { isAgentPane, orderSessions, selectedProfileForWorkspace } from './state/profiles'
import { flattenWorkspaceRows, workspaceRows } from './state/workspaceGroups'
import { applyThemeToDocument } from './state/themePreview'
import { workspaceForShortcut } from './state/workspaceShortcuts'
import { isAppLocked } from './state/licenseGate'
import { buildRemoteAppearance } from './remote/appearancePayload'
import { applyRemotePaneLeaseEvent, type RemotePaneLeaseEvent } from './remote/paneLease'
import { desktopSelectionPayload } from './remote/desktopSelection'
import { hasNewCompletionHighlight, playCompletionSound } from './notifications/completionSounds'
import './styles/theme.css'
import './styles/kanban.css'
import './App.css'


type CaptureShortcutAction = 'captureImage' | 'captureQuickImage' | 'captureVideo'
type CaptureShortcutRegistration = { action: CaptureShortcutAction; label: string; accelerator: string }

type FfmpegDownloadProgress = { downloaded: number; total?: number | null }
type CaptureRecordingState = { startedAtMs: number }
type CaptureRecordingEvent = { startedAtMs: number; path: string }
type AgentPromptEvent = { sessionId: string; prompt: string }
type DirtyEditorDecision = 'saveAll' | 'discard' | 'cancel'
type DirtyEditorPrompt = { title: string; files: string[]; resolve: (decision: DirtyEditorDecision) => void }


let hermesWarmupRuntime: { commandOverride: string | null; promise: Promise<HermesRuntimeStatus> } | undefined

function hermesWarmupStatus(commandOverride: string | null): Promise<HermesRuntimeStatus> {
  if (!hermesWarmupRuntime || hermesWarmupRuntime.commandOverride !== commandOverride) {
    hermesWarmupRuntime = { commandOverride, promise: getHermesRuntimeStatus(commandOverride) }
  }
  return hermesWarmupRuntime.promise
}

function App() {
  const contentActionsRef = useRef<WorkspaceContentActions | null>(null)
  const windowClosePendingRef = useRef(false)
  const dirtyPromptActiveRef = useRef(false)
  const dirtyPromptQueueRef = useRef<Promise<void>>(Promise.resolve())
  const dirtyPromptDisposedRef = useRef(false)
  const dirtyPromptResolveRef = useRef<((decision: DirtyEditorDecision) => void) | null>(null)
  const dirtyPromptDialogRef = useRef<HTMLElement | null>(null)
  const dirtyPromptCancelRef = useRef<HTMLButtonElement | null>(null)
  const appShellRef = useRef<HTMLElement | null>(null)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isBugReportOpen, setIsBugReportOpen] = useState(false)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null)
  // ImportReposDialog is mounted by the repository import slice.
  const [isImportReposOpen, setIsImportReposOpen] = useState(false)
  const [isSetupWizardOpen, setIsSetupWizardOpen] = useState(false)
  const [contentActions, setContentActions] = useState<WorkspaceContentActions | null>(null)
  const [chromeState, setChromeState] = useState<WorkspaceContentChromeState | null>(null)
  const [dirtyEditorPrompt, setDirtyEditorPrompt] = useState<DirtyEditorPrompt | null>(null)
  const [workspaceLocalInteractionSuspended, setWorkspaceLocalInteractionSuspended] = useState(false)

  const [isResourceMonitorOpen, setIsResourceMonitorOpen] = useState(false)
  const [ffmpegNotice, setFfmpegNotice] = useState<string | null>(null)
  const [ffmpegDownload, setFfmpegDownload] = useState<FfmpegDownloadProgress | null>(null)
  const [recordingStartedAtMs, setRecordingStartedAtMs] = useState<number | null>(null)
  const [recordingElapsedSeconds, setRecordingElapsedSeconds] = useState(0)
  const [isStoppingRecording, setIsStoppingRecording] = useState(false)
  const [annotatingCapturePath, setAnnotatingCapturePath] = useState<string | null>(null)
  const captureActionsRef = useRef<{ openImage: () => void; openQuickImage: () => void; openVideo: () => void }>({
    openImage: () => {},
    openQuickImage: () => {},
    openVideo: () => {},
  })
  const captureShortcutErrorKeysRef = useRef<Set<string>>(new Set())
  const globalShortcutOperationRef = useRef<Promise<void>>(Promise.resolve())
  const sessions = useWorkspaceStore((state) => state.sessions)
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const activePaneId = useWorkspaceStore((state) => state.activePaneId)
  const paneCompletionHighlights = useWorkspaceStore((state) => state.paneCompletionHighlights)
  const status = useWorkspaceStore((state) => state.status)
  const error = useWorkspaceStore((state) => state.error)
  const dismissError = useWorkspaceStore((state) => state.dismissError)
  const bootstrap = useWorkspaceStore((state) => state.bootstrap)
  const license = useWorkspaceStore((state) => state.license)
  const revalidateLicense = useWorkspaceStore((state) => state.revalidateLicense)
  const createSession = useWorkspaceStore((state) => state.createSession)
  const renameSession = useWorkspaceStore((state) => state.renameSession)
  const deleteSession = useWorkspaceStore((state) => state.deleteSession)
  const openSession = useWorkspaceStore((state) => state.openSession)
  const updateSettings = useWorkspaceStore((state) => state.updateSettings)
  const prepareSetupWizardRun = useWorkspaceStore((state) => state.prepareSetupWizardRun)
  const settings = useWorkspaceStore((state) => state.settings)
  const keybindings = useWorkspaceStore((state) => state.settings.keybindings)
  const orderedSessions = orderSessions(sessions, settings.workspaceOrder)
  const shortcutSessions = useMemo(() => flattenWorkspaceRows(workspaceRows(sessions, settings.workspaceGroups, settings.workspaceGroupIds, settings.workspaceOrder)), [sessions, settings.workspaceGroupIds, settings.workspaceGroups, settings.workspaceOrder])
  const completionCounts = useMemo(() => paneCompletionCountsBySession(paneCompletionHighlights), [paneCompletionHighlights])
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const editingWorkspace = sessions.find((session) => session.id === editingWorkspaceId) ?? null
  const activeProfile = selectedProfileForWorkspace(settings, activeSessionId)
  const appLocked = status === 'ready' && license.ready && isAppLocked(license.status)
  const setupWizardVisible = !appLocked && (isSetupWizardOpen || (status === 'ready' && license.ready && settings.setupWizard.completedAt === null))
  const [startupLastActiveSessionId] = useState(() => window.localStorage.getItem('vibelink:lastActiveSessionId'))
  const startupDialogVisible = status === 'ready' && !setupWizardVisible && !activeSessionId && !isCreateOpen
  const appWorkspaceInteractionSuspended = isSettingsOpen
    || isBugReportOpen
    || isCreateOpen
    || Boolean(editingWorkspace)
    || isImportReposOpen
    || setupWizardVisible
    || isResourceMonitorOpen
    || Boolean(ffmpegNotice)
    || Boolean(annotatingCapturePath)
    || Boolean(dirtyEditorPrompt)
    || startupDialogVisible
  const workspaceInteractionSuspended = appWorkspaceInteractionSuspended || workspaceLocalInteractionSuspended
  const nativeSurfacesSuspended = workspaceInteractionSuspended
    || Boolean(ffmpegDownload)
    || recordingStartedAtMs !== null

  useEffect(() => {
    applyThemeToDocument(settings.terminalThemeId, settings.selectedPaneHighlightColor, settings.alarmHighlightColor, settings.reviewedPaneHighlightColor)
  }, [settings.terminalThemeId, settings.selectedPaneHighlightColor, settings.alarmHighlightColor, settings.reviewedPaneHighlightColor])

  useEffect(() => useWorkspaceStore.subscribe((state, previousState) => {
    if (!hasNewCompletionHighlight(state.paneCompletionHighlights, previousState.paneCompletionHighlights)) return
    void playCompletionSound(state.settings).catch((caught) => console.warn('Failed to play completion sound', caught))
  }), [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void invoke('set_remote_appearance', {
        appearance: buildRemoteAppearance(settings),
        workspaceOrder: settings.workspaceOrder,
        workspaceAlerts: completionCounts,
      }).catch((caught) => console.warn('Failed to update remote appearance', caught))
    }, 300)
    return () => window.clearTimeout(timer)
  }, [completionCounts, settings])

  useEffect(() => {
    if (status !== 'ready') return
    void invoke('set_desktop_selection', desktopSelectionPayload(activeSessionId, activePaneId))
      .catch((caught) => console.warn('Failed to update desktop selection', caught))
  }, [activePaneId, activeSessionId, status])

  useEffect(() => {
    void invoke('set_keep_terminals_alive_on_close', { value: settings.keepTerminalsAliveOnClose }).catch(() => {})
  }, [settings.keepTerminalsAliveOnClose])

  useEffect(() => {
    void Promise.all([startTerminalOutputStream(), startHermesOutputStream()]).then(() => bootstrap()).catch((caught) => {
      useWorkspaceStore.getState().setError(String(caught))
    })
  }, [bootstrap])

  useEffect(() => {
    if (!license.ready || !license.status?.email) return
    const timer = window.setInterval(() => { void revalidateLicense() }, 12 * 60 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [license.ready, license.status?.email, revalidateLicense])

  useEffect(() => {
    if (!appLocked) return
    // A completed purchase or sign-in should unlock promptly, so revalidate
    // whenever the locked window regains focus.
    const onFocus = () => { void revalidateLicense() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [appLocked, revalidateLicense])

  useEffect(() => {
    if (!activeSessionId || !activeSession?.workspaceFolder) return
    const onFocus = () => { void useGitStore.getState().refreshGit(activeSessionId, activeSession.workspaceFolder) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [activeSessionId, activeSession?.workspaceFolder])

  useEffect(() => {
    TerminalManager.setLinkActions({
      onOpenPath: (path) => void invoke('open_path', { path }),
      resolveMarker: (paneId, n) => useWorkspaceStore.getState().resolveCaptureMarker(paneId, n),
    })
    TerminalManager.setAgentActivityActions({
      isAgentPane: (paneId) => {
        const state = useWorkspaceStore.getState()
        const pane = state.panes[paneId]
        return Boolean(pane && isAgentPane(pane, state.settings))
      },
      onResponseStart: () => {},
      onResponseComplete: (paneId) => useWorkspaceStore.getState().markPaneResponseComplete(paneId),
    })
    const unlisteners = [
      listen<RemotePaneLeaseEvent>('remote://pane-lease', (event) => {
        const lease = applyRemotePaneLeaseEvent(event.payload)
        TerminalManager.setRemotePaneLease(event.payload.paneId, lease)
      }),
      listen<AgentPromptEvent>('vibelink://agent-prompt', (event) => {
        void (async () => {
          const sessionId = event.payload.sessionId
          const state = useWorkspaceStore.getState()
          if (state.activeSessionId !== sessionId) await state.openSession(sessionId)
          if (useWorkspaceStore.getState().activeSessionId !== sessionId) return
          const actions = contentActionsRef.current
          const panelId = await actions?.openContent({ kind: 'agent' })
          if (useWorkspaceStore.getState().activeSessionId !== sessionId) return
          if (panelId) contentActionsRef.current?.activateContent(panelId)
          await useWorkspaceStore.getState().sendAgentPrompt(sessionId, event.payload.prompt)
        })().catch((caught) => useWorkspaceStore.getState().setError(String(caught)))
      }),
      listen<{ mode: 'image' | 'quick' | 'video'; path: string }>('capture://saved', (event) => {
        const state = useWorkspaceStore.getState()
        state.recordCapture(state.activePaneId, event.payload.path)
        if (event.payload.mode === 'image') setAnnotatingCapturePath(event.payload.path)
        if (event.payload.mode === 'video') {
          setRecordingStartedAtMs(null)
          setRecordingElapsedSeconds(0)
        }
      }),
      listen<CaptureRecordingEvent>('capture://recording-started', (event) => {
        setRecordingStartedAtMs(event.payload.startedAtMs)
        setRecordingElapsedSeconds(0)
      }),
      listen<CaptureRecordingEvent>('capture://recording-stopped', () => {
        setRecordingStartedAtMs(null)
        setRecordingElapsedSeconds(0)
        setIsStoppingRecording(false)
      }),
      listen<FfmpegDownloadProgress>('ffmpeg://progress', (event) => {
        setFfmpegDownload({ downloaded: event.payload.downloaded, total: event.payload.total ?? null })
      }),
    ]
    void invoke<CaptureRecordingState | null>('capture_recording_state').then((recording) => {
      if (recording) {
        setRecordingStartedAtMs(recording.startedAtMs)
        setRecordingElapsedSeconds(Math.max(0, Math.floor((Date.now() - recording.startedAtMs) / 1000)))
      } else {
        setRecordingStartedAtMs(null)
        setRecordingElapsedSeconds(0)
      }
    }).catch(() => {})
    return () => {
      void Promise.all(unlisteners).then((disposes) => {
        for (const dispose of disposes) dispose()
      })
    }
  }, [])

  const requestDirtyEditorDecision = useCallback((title: string, files: string[]) => {
    let resolveDecision: (decision: DirtyEditorDecision) => void = () => undefined
    const decision = new Promise<DirtyEditorDecision>((resolve) => { resolveDecision = resolve })
    const showPrompt = () => {
      if (dirtyPromptDisposedRef.current) {
        resolveDecision('cancel')
        return Promise.resolve()
      }
      return new Promise<void>((complete) => {
        dirtyPromptActiveRef.current = true
        const resolve = (value: DirtyEditorDecision) => {
          if (dirtyPromptResolveRef.current === resolve) dirtyPromptResolveRef.current = null
          resolveDecision(value)
          complete()
        }
        dirtyPromptResolveRef.current = resolve
        setDirtyEditorPrompt({ title, files, resolve })
      })
    }
    const turn = dirtyPromptQueueRef.current.then(showPrompt, showPrompt)
    dirtyPromptQueueRef.current = turn.catch(() => undefined)
    return decision
  }, [])

  useEffect(() => {
    dirtyPromptDisposedRef.current = false
    return () => {
      dirtyPromptDisposedRef.current = true
      const resolve = dirtyPromptResolveRef.current
      dirtyPromptResolveRef.current = null
      resolve?.('cancel')
    }
  }, [])

  const resolveDirtyEditorPrompt = useCallback((decision: DirtyEditorDecision) => {
    setDirtyEditorPrompt((prompt) => {
      if (!prompt) return null
      prompt.resolve(decision)
      return null
    })
  }, [])

  useEffect(() => {
    dirtyPromptActiveRef.current = Boolean(dirtyEditorPrompt)
    if (!dirtyEditorPrompt) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusFrame = requestAnimationFrame(() => dirtyPromptCancelRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        resolveDirtyEditorPrompt('cancel')
        return
      }
      if (event.key !== 'Tab') return
      event.stopImmediatePropagation()
      const dialog = dirtyPromptDialogRef.current
      if (!dialog) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!(document.activeElement instanceof Node) || !dialog.contains(document.activeElement)) {
        event.preventDefault()
        const target = event.shiftKey ? last : first
        target.focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', onKeyDown, true)
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [dirtyEditorPrompt, resolveDirtyEditorPrompt])

  useEffect(() => {
    const appShell = appShellRef.current
    if (!appShell) return
    if (dirtyEditorPrompt) appShell.setAttribute('inert', '')
    else appShell.removeAttribute('inert')
    return () => appShell.removeAttribute('inert')
  }, [dirtyEditorPrompt])

  const prepareDirtySessions = useCallback(async (sessionIds: string[], title: string): Promise<boolean> => {
    const state = useWorkspaceStore.getState()
    const dirty: Array<{ store: EditorDocumentStore; relPath: string; label: string }> = []
    for (const sessionId of new Set(sessionIds)) {
      const session = state.sessions.find((candidate) => candidate.id === sessionId)
      if (!session?.workspaceFolder) continue
      const store = getEditorDocumentStore(sessionId, session.workspaceFolder)
      for (const document of store.listDocuments().filter((candidate) => candidate.dirty)) {
        dirty.push({ store, relPath: document.relPath, label: `${session.name} — ${document.relPath}` })
      }
    }
    if (dirty.length === 0) return true
    const decision = await requestDirtyEditorDecision(title, dirty.map((document) => document.label))
    if (decision === 'cancel') return false
    if (decision === 'saveAll') {
      for (const store of new Set(dirty.map((document) => document.store))) {
        const result = await store.saveAll()
        if (result.failed.length > 0) {
          useWorkspaceStore.getState().setError(`Could not save ${result.failed.map((failure) => failure.relPath).join(', ')}. The operation was cancelled.`)
          return false
        }
      }
      return true
    }
    for (const document of dirty) {
      if (await document.store.requestClose(document.relPath, () => 'discard') === 'cancelled') return false
    }
    return true
  }, [requestDirtyEditorDecision])

  const deleteWorkspace = useCallback(async (sessionId: string) => {
    if (!await prepareDirtySessions([sessionId], 'Delete workspace?')) return
    await deleteSession(sessionId)
  }, [deleteSession, prepareDirtySessions])

  useEffect(() => {
    const appWindow = getCurrentWindow()
    let disposed = false
    let unlisten: (() => void) | undefined
    void appWindow.onCloseRequested(async (event) => {
      if (windowClosePendingRef.current) {
        event.preventDefault()
        return
      }
      windowClosePendingRef.current = true
      try {
        const ready = await prepareDirtySessions(useWorkspaceStore.getState().sessions.map((session) => session.id), 'Close VibeLink?')
        if (!ready || disposed) event.preventDefault()
      } catch (caught) {
        event.preventDefault()
        useWorkspaceStore.getState().setError(String(caught))
      } finally {
        windowClosePendingRef.current = false
      }
    }).then((dispose) => { if (disposed) dispose(); else unlisten = dispose })
    return () => { disposed = true; unlisten?.() }
  }, [prepareDirtySessions])

  useEffect(() => {
    if (recordingStartedAtMs === null) return undefined
    const timer = window.setInterval(() => {
      setRecordingElapsedSeconds(Math.max(0, Math.floor((Date.now() - recordingStartedAtMs) / 1000)))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [recordingStartedAtMs])

  useEffect(() => {
    TerminalManager.applySettings({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      terminalFontWeight: settings.terminalFontWeight,
      scrollback: settings.scrollback,
      terminalThemeId: settings.terminalThemeId,
      terminalScrollbarVisible: settings.terminalScrollbarVisible,
      cursorStyle: settings.cursorStyle,
      cursorWidth: settings.cursorWidth,
    })
  }, [settings.fontFamily, settings.fontSize, settings.terminalFontWeight, settings.scrollback, settings.terminalThemeId, settings.terminalScrollbarVisible, settings.cursorStyle, settings.cursorWidth])

  useEffect(() => {
    if (!activeSessionId || !license.ready || !license.status?.entitled) return
    const sessionId = activeSessionId
    const workspaceFolder = activeSession?.workspaceFolder ?? null
    const commandOverride = settings.hermesCommand || null
    // Workspace switch work is intentionally backgrounded. Detection is cached
    // for this app run; Hermes remains the model/configuration authority.
    void hermesWarmupStatus(commandOverride)
      .then((runtime) => runtime.detected && runtime.configuredModel
        ? startHermesAgent({ sessionId, commandOverride, workspaceFolder })
        : undefined)
      .catch(() => {})
  }, [activeSessionId, activeSession?.workspaceFolder, license.ready, license.status?.entitled, settings.hermesCommand])

  useEffect(() => {
    // Suppress the stock WebView2 context menu (Back/Reload/Print/...) —
    // terminal panes provide their own menu, and the browser one is never
    // useful in the app. Editable fields keep the native menu for spellcheck
    // and clipboard access.
    const onContextMenu = (event: Event) => {
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]')) return
      event.preventDefault()
    }
    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [])
  const handleContentActionsReady = useCallback((actions: WorkspaceContentActions | null) => {
    contentActionsRef.current = actions
    setContentActions(actions)
  }, [])

  const selectSession = useCallback((sessionId: string) => {
    void openSession(sessionId)
  }, [openSession])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (dirtyPromptActiveRef.current) {
        if (event.key === 'Escape' || event.key === 'Tab') return
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      if (workspaceInteractionSuspended) return
      const session = workspaceForShortcut(event, shortcutSessions)
      if (!session) return
      event.preventDefault()
      event.stopPropagation()
      if (session.id !== activeSessionId) selectSession(session.id)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [activeSessionId, selectSession, shortcutSessions, workspaceInteractionSuspended])

  const createWorkspace = async (name: string, workspaceFolder: string | null, profileId: string) => {
    await createSession(name || undefined, workspaceFolder, profileId)
    setIsCreateOpen(false)
  }

  const clearWorkspace = async () => {
    await contentActionsRef.current?.clearTerminals()
  }


  const reloadAfterRestart = async () => {
    const sessionId = useWorkspaceStore.getState().activeSessionId
    await useWorkspaceStore.getState().refreshSessions()
    if (sessionId) await openSession(sessionId)
  }

  const createWorkspaceFromInput = useCallback(async (input: WorkspaceCreationInput) => {
    const chosen = await open({ directory: true, multiple: false, title: input.cloneUrl ? 'Choose clone parent directory' : 'Choose workspace directory' })
    if (typeof chosen !== 'string') return
    let workspaceFolder = chosen
    if (input.cloneUrl) {
      const directoryName = safeWorkspaceDirectoryName(input.suggestedDirectoryName || input.name)
      workspaceFolder = `${chosen.replace(/[\\/]+$/, '')}\\${directoryName}`
      const channel = new Channel<CloneProgress>(() => undefined)
      await invoke('git_clone', { url: input.cloneUrl, targetDir: workspaceFolder, channel })
    }
    await createSession(input.name || undefined, workspaceFolder, activeProfile.id)
  }, [activeProfile.id, createSession])

  const openImageCapture = useCallback(() => {
    void invoke('open_capture_overlay', { mode: 'image', dir: settings.captureDir, ffmpegPath: settings.captureFfmpegPath }).catch((caught) => {
      useWorkspaceStore.getState().setError(String(caught))
    })
  }, [settings.captureDir, settings.captureFfmpegPath])

  const openQuickImageCapture = useCallback(() => {
    void invoke('open_capture_overlay', { mode: 'quick', dir: settings.captureDir, ffmpegPath: settings.captureFfmpegPath }).catch((caught) => {
      useWorkspaceStore.getState().setError(String(caught))
    })
  }, [settings.captureDir, settings.captureFfmpegPath])

  const openVideoCapture = useCallback(async () => {
    setFfmpegNotice(null)
    let ffmpegPath: string
    try {
      ffmpegPath = await invoke<string>('ensure_ffmpeg', { ffmpegPath: settings.captureFfmpegPath })
      setFfmpegDownload(null)
    } catch (caught) {
      setFfmpegDownload(null)
      setFfmpegNotice(String(caught))
      return
    }

    await invoke('open_capture_overlay', { mode: 'video', dir: settings.captureDir, ffmpegPath }).catch((caught) => {
      useWorkspaceStore.getState().setError(String(caught))
    })
  }, [settings.captureDir, settings.captureFfmpegPath, setFfmpegNotice])

  const stopRecording = useCallback(async () => {
    if (isStoppingRecording) return
    setIsStoppingRecording(true)
    try {
      const path = await invoke<string>('stop_video_capture')
      const state = useWorkspaceStore.getState()
      state.recordCapture(state.activePaneId, path)
      setRecordingStartedAtMs(null)
      setRecordingElapsedSeconds(0)
    } catch (caught) {
      useWorkspaceStore.getState().setError(String(caught))
    } finally {
      setIsStoppingRecording(false)
    }
  }, [isStoppingRecording])

  useEffect(() => {
    captureActionsRef.current = {
      openImage: openImageCapture,
      openQuickImage: openQuickImageCapture,
      openVideo: () => { void openVideoCapture() },
    }
  }, [openImageCapture, openQuickImageCapture, openVideoCapture])

  useEffect(() => {
    const shortcuts = captureShortcutRegistrations(keybindings.captureImage, keybindings.captureVideo, keybindings.captureQuickImage)
    let disposed = false
    const registeredShortcuts = new Set<string>()

    const registerShortcuts = globalShortcutOperationRef.current.then(async () => {
      for (const shortcut of shortcuts) {
        if (disposed) return
        try {
          await register(shortcut.accelerator, (event) => {
            if (event.state !== 'Pressed' || dirtyPromptActiveRef.current) return
            if (shortcut.action === 'captureImage') captureActionsRef.current.openImage()
            else if (shortcut.action === 'captureQuickImage') captureActionsRef.current.openQuickImage()
            else captureActionsRef.current.openVideo()
          })
          registeredShortcuts.add(shortcut.accelerator)
        } catch (caught) {
          if (disposed) return
          const message = caught instanceof Error ? caught.message : String(caught)
          const errorKey = `${shortcut.accelerator}:${message}`
          if (!captureShortcutErrorKeysRef.current.has(errorKey)) {
            captureShortcutErrorKeysRef.current.add(errorKey)
            useWorkspaceStore.getState().setError(`Could not register global ${shortcut.label} shortcut (${shortcut.accelerator}). It may already be used by another app. ${message}`)
          }
        }
      }
    })
    globalShortcutOperationRef.current = registerShortcuts.catch(() => {})

    return () => {
      disposed = true
      const unregisterShortcuts = globalShortcutOperationRef.current.then(async () => {
        const registered = Array.from(registeredShortcuts)
        if (registered.length > 0) await unregister(registered).catch(() => {})
      })
      globalShortcutOperationRef.current = unregisterShortcuts.catch(() => {})
    }
  }, [keybindings.captureImage, keybindings.captureQuickImage, keybindings.captureVideo])


  const runSetupWizardAgain = () => {
    prepareSetupWizardRun()
    setIsSettingsOpen(false)
    setIsSetupWizardOpen(true)
  }

  const ffmpegDownloadPercent = ffmpegDownload ? ffmpegProgressPercent(ffmpegDownload) : null
  const ffmpegDownloadLabel = ffmpegDownload ? formatFfmpegProgress(ffmpegDownload) : ''

  if (appLocked) {
    return (
      <main className="app-shell app-shell-locked" style={{ '--vibelink-ui-scale': settings.uiScale } as CSSProperties}>
        <AppLockedScreen onReportBug={license.status?.email ? () => setIsBugReportOpen(true) : undefined} />
        {isBugReportOpen ? <BugReportDialog onClose={() => setIsBugReportOpen(false)} /> : null}
      </main>
    )
  }

  return (
    <>
    <main
      ref={appShellRef}
      className="app-shell"
      data-active-content={chromeState?.activeContentKind ?? undefined}
      style={{ '--vibelink-ui-scale': settings.uiScale, '--vibelink-pane-header-height': `${settings.paneHeaderHeight}px` } as CSSProperties}
      aria-hidden={dirtyEditorPrompt ? true : undefined}
    >
      <section className="main-surface">
        <header className="topbar" data-tauri-drag-region>
          <div className="workspace-crumb-box" data-tauri-drag-region>
            <div className="crumb" data-tauri-drag-region>{activeSession?.name ?? 'Loading'}</div>
          </div>
          <div className="topbar-spacer" data-tauri-drag-region />
          <button type="button" className="topbar-icon-button" disabled={!activeSessionId || !contentActions} title="Reset layout" aria-label="Reset workspace layout" onClick={() => {
            if (window.confirm('Reset the workspace layout?')) void contentActions?.resetLayout()
          }}>
            <Eraser size={16} aria-hidden="true" />
          </button>
          <button type="button" className="topbar-icon-button" title="Capture image" aria-label="Capture image" onClick={openImageCapture}>
            <Camera size={16} aria-hidden="true" />
          </button>
          <button type="button" className="topbar-icon-button" title="Resource monitor" aria-label="Open resource monitor" onClick={() => setIsResourceMonitorOpen(true)}>
            <Activity size={16} aria-hidden="true" />
          </button>
          <button type="button" className="topbar-icon-button" title="Capture video" aria-label="Capture video" onClick={() => void openVideoCapture()}>
            <Video size={16} aria-hidden="true" />
          </button>
          <button type="button" className="topbar-icon-button" title="Report a bug" aria-label="Report a bug" onClick={() => setIsBugReportOpen(true)}>
            <Bug size={16} aria-hidden="true" />
          </button>
          <button type="button" className="topbar-icon-button" title="Open settings" aria-label="Open settings" onClick={() => setIsSettingsOpen(true)}>
            <Settings2 size={16} aria-hidden="true" />
          </button>
          <div className="window-controls">
            <button type="button" className="window-control-button" title="Minimize" aria-label="Minimize window" onClick={() => void getCurrentWindow().minimize()}>
              <Minus size={14} aria-hidden="true" />
            </button>
            <button type="button" className="window-control-button" title="Maximize" aria-label="Maximize or restore window" onClick={() => void getCurrentWindow().toggleMaximize()}>
              <Square size={12} aria-hidden="true" />
            </button>
            <button type="button" className="window-control-button window-control-close" title="Close" aria-label="Close VibeLink" onClick={() => void getCurrentWindow().close()}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </header>
        {error ? (
          <div className="daemon-banner">
            <AlertTriangle size={16} aria-hidden="true" />
            <span className="daemon-banner-message">{error}</span>
            <button type="button" className="daemon-banner-close" title="Dismiss" aria-label="Dismiss error" onClick={dismissError}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ) : null}
        {status === 'booting' ? <div className="loading-panel">Connecting to daemon…</div> : (
          <div className="workspace-content">
            <WorkspaceView
              onActionsReady={handleContentActionsReady}
              onChromeStateChange={setChromeState}
              onDeleteWorkspaceRequested={deleteWorkspace}
              onEditWorkspaceRequested={setEditingWorkspaceId}
              onCreateWorkspaceRequested={() => setIsCreateOpen(true)}
              onImportReposRequested={() => setIsImportReposOpen(true)}
              onWorkspaceInput={createWorkspaceFromInput}
              onWorkspaceInteractionSuspendedChange={setWorkspaceLocalInteractionSuspended}
              workspaceInteractionSuspended={workspaceInteractionSuspended}
              nativeSurfacesSuspended={nativeSurfacesSuspended}
            />
          </div>
        )}
        {startupDialogVisible ? (
          <StartupWorkspaceDialog
            sessions={orderedSessions}
            lastActiveSessionId={startupLastActiveSessionId}
            onOpen={selectSession}
            onCreate={() => setIsCreateOpen(true)}
          />
        ) : null}
        {setupWizardVisible ? <SetupWizard onComplete={() => setIsSetupWizardOpen(false)} /> : null}
        {isResourceMonitorOpen ? <ResourceMonitorDialog onClose={() => setIsResourceMonitorOpen(false)} onStopWorkspaceTerminals={clearWorkspace} onAfterRestart={reloadAfterRestart} /> : null}
        {isSettingsOpen ? <SettingsDialog settings={settings} onChange={updateSettings} onClose={() => setIsSettingsOpen(false)} onRunSetupWizard={runSetupWizardAgain} /> : null}
        {isBugReportOpen ? <BugReportDialog onClose={() => setIsBugReportOpen(false)} /> : null}
        {isCreateOpen ? <WorkspaceCreateDialog profiles={settings.profiles} defaultProfileId={settings.defaultProfileId} onCreate={(name, workspaceFolder, profileId) => void createWorkspace(name, workspaceFolder, profileId)} onClose={() => setIsCreateOpen(false)} /> : null}
        {editingWorkspace ? <WorkspaceSettingsDialog session={editingWorkspace} settings={settings} onChange={updateSettings} onRename={renameSession} onClose={() => setEditingWorkspaceId(null)} /> : null}
        {isImportReposOpen ? <ImportReposDialog onClose={() => setIsImportReposOpen(false)} /> : null}
        {annotatingCapturePath ? <CaptureAnnotator key={annotatingCapturePath} captureDir={settings.captureDir} imagePath={annotatingCapturePath} onClose={() => setAnnotatingCapturePath(null)} /> : null}
        {ffmpegDownload ? (
          <div className="ffmpeg-download-toast" role="status" aria-live="polite">
            <span className="ffmpeg-download-title">Downloading ffmpeg… {ffmpegDownloadLabel}</span>
            {ffmpegDownloadPercent !== null ? (
              <span className="ffmpeg-download-progress" aria-hidden="true">
                <span style={{ width: `${ffmpegDownloadPercent}%` }} />
              </span>
            ) : null}
          </div>
        ) : null}
        {recordingStartedAtMs !== null ? (
          <div className="capture-recording-pill" role="status" aria-live="polite">
            <span className="capture-recording-dot" aria-hidden="true" />
            <span className="capture-recording-time">{formatElapsed(recordingElapsedSeconds)}</span>
            <button type="button" className="capture-recording-stop" disabled={isStoppingRecording} onClick={() => void stopRecording()}>
              {isStoppingRecording ? 'Stopping…' : 'Stop'}
            </button>
          </div>
        ) : null}
        {ffmpegNotice ? (
          <div className="settings-backdrop" role="presentation" onMouseDown={() => setFfmpegNotice(null)}>
            <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="ffmpeg-title" style={{ width: 'min(520px, calc(100vw - 48px))' }} onMouseDown={(event) => event.stopPropagation()}>
              <header className="settings-dialog-header">
                <div>
                  <p className="settings-eyebrow">Capture video</p>
                  <h2 id="ffmpeg-title">ffmpeg is required</h2>
                </div>
                <button type="button" className="settings-close" title="Close" aria-label="Close ffmpeg notice" onClick={() => setFfmpegNotice(null)}>
                  <X size={14} aria-hidden="true" />
                </button>
              </header>
              <div className="settings-dialog-body" style={{ display: 'block', maxHeight: 'none' }}>
                <section className="settings-card">
                  <p>VibeLink tried to download ffmpeg automatically but could not finish. Install ffmpeg, or set the ffmpeg.exe path in Settings → Capture.</p>
                  <p className="ffmpeg-notice-error">{ffmpegNotice}</p>
                  <p><a href="https://www.gyan.dev/ffmpeg/builds/" target="_blank" rel="noreferrer">Download Windows ffmpeg builds</a></p>
                </section>
              </div>
              <footer className="settings-dialog-footer">
                <span>Image capture does not require ffmpeg.</span>
                <button type="button" className="primary-action" onClick={() => setFfmpegNotice(null)}>Close</button>
              </footer>
            </section>
          </div>
        ) : null}
      </section>
    </main>
    {dirtyEditorPrompt && typeof document !== 'undefined' ? createPortal(
      <div className="dirty-editor-backdrop" role="presentation" onMouseDown={() => resolveDirtyEditorPrompt('cancel')}>
        <section
          ref={dirtyPromptDialogRef}
          className="dirty-editor-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dirty-editor-title"
          aria-describedby="dirty-editor-description"
          tabIndex={-1}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <header><AlertTriangle size={18} aria-hidden="true" /><h2 id="dirty-editor-title">{dirtyEditorPrompt.title}</h2></header>
          <p id="dirty-editor-description">The following files have unsaved changes:</p>
          <ul>{dirtyEditorPrompt.files.map((file, index) => <li key={`${index}:${file}`}>{file}</li>)}</ul>
          <footer>
            <button type="button" className="primary-action" onClick={() => resolveDirtyEditorPrompt('saveAll')}>Save All</button>
            <button type="button" onClick={() => resolveDirtyEditorPrompt('discard')}>Discard</button>
            <button ref={dirtyPromptCancelRef} type="button" onClick={() => resolveDirtyEditorPrompt('cancel')}>Cancel</button>
          </footer>
        </section>
      </div>,
      document.body,
    ) : null}
    </>
  )
}

function formatElapsed(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const remaining = safeSeconds % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
  return `${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
}

function safeWorkspaceDirectoryName(value: string): string {
  const trimmed = value.trim()
  let safe = ''
  for (let index = 0; index < trimmed.length; index += 1) {
    safe += isControlCharacterCode(trimmed.charCodeAt(index)) ? '-' : trimmed[index]
  }
  safe = safe.replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '')
  return safe || `workspace-${Date.now()}`
}

function ffmpegProgressPercent(progress: FfmpegDownloadProgress): number | null {
  const total = progress.total ?? 0
  if (total <= 0) return null
  return Math.min(100, Math.max(0, Math.round((progress.downloaded / total) * 100)))
}

function formatFfmpegProgress(progress: FfmpegDownloadProgress): string {
  const percent = ffmpegProgressPercent(progress)
  if (percent !== null) return `${percent}%`
  return formatBytes(progress.downloaded)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib.toFixed(1)} KiB`
  return `${(kib / 1024).toFixed(1)} MiB`
}

function captureShortcutRegistrations(imageChord: string, videoChord: string, quickImageChord: string): CaptureShortcutRegistration[] {
  const candidates: Array<{ action: CaptureShortcutAction; label: string; chord: string }> = [
    { action: 'captureImage', label: 'screenshot capture', chord: imageChord },
    { action: 'captureQuickImage', label: 'quick capture', chord: quickImageChord },
    { action: 'captureVideo', label: 'video capture', chord: videoChord },
  ]
  const accelerators = new Set<string>()
  const registrations: CaptureShortcutRegistration[] = []
  for (const candidate of candidates) {
    const accelerator = toGlobalShortcutAccelerator(candidate.chord)
    if (!accelerator || accelerators.has(accelerator)) continue
    accelerators.add(accelerator)
    registrations.push({ action: candidate.action, label: candidate.label, accelerator })
  }
  return registrations
}

function toGlobalShortcutAccelerator(chord: string): string | null {
  const tokens = chord.split('+').map((part) => part.trim().toLowerCase()).filter(Boolean)
  if (tokens.length === 0) return null

  const keyToken = tokens[tokens.length - 1]
  if (globalShortcutModifierName(keyToken)) return null

  const acceleratorParts: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const part = index === tokens.length - 1 ? globalShortcutKeyName(token) : globalShortcutModifierName(token)
    if (!part) return null
    acceleratorParts.push(part)
  }
  return acceleratorParts.join('+')
}

function globalShortcutModifierName(token: string): string | null {
  switch (token) {
    case 'ctrl':
    case 'control':
      return 'Ctrl'
    case 'alt':
    case 'option':
      return 'Alt'
    case 'shift':
      return 'Shift'
    case 'win':
    case 'meta':
    case 'cmd':
    case 'command':
    case 'super':
      return 'Super'
    default:
      return null
  }
}

function globalShortcutKeyName(token: string): string | null {
  const aliases: Record<string, string> = {
    esc: 'Esc',
    escape: 'Esc',
    pgup: 'PageUp',
    pageup: 'PageUp',
    pgdn: 'PageDown',
    pagedown: 'PageDown',
    left: 'Left',
    right: 'Right',
    up: 'Up',
    down: 'Down',
    space: 'Space',
  }
  if (aliases[token]) return aliases[token]
  if (/^[a-z]$/.test(token)) return token.toUpperCase()
  if (/^\d$/.test(token)) return token
  if (/^f([1-9]|1\d|2[0-4])$/.test(token)) return token.toUpperCase()
  if (token.length === 1) return token
  return token.charAt(0).toUpperCase() + token.slice(1)
}


export default App
