import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { DockviewApi } from 'dockview-react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { register, unregister } from '@tauri-apps/plugin-global-shortcut'
import { Activity, AlertTriangle, Bot, Camera, Ellipsis, GitCompare, LayoutGrid, ListTodo, Minus, Save, Settings2, Square, TerminalSquare, Eraser, Video, X } from 'lucide-react'
import { Sidebar } from './components/Sidebar'
import { SidebarRevealEdge } from './components/SidebarRevealEdge'
import { loadSidebarPinned, saveSidebarPinned } from './components/sidebarPinState'
import { SettingsDialog } from './components/SettingsDialog'
import { StartupWorkspaceDialog } from './components/StartupWorkspaceDialog'
import { WorkspaceCreateDialog } from './components/WorkspaceCreateDialog'
import { VoiceSetupDialog } from './components/VoiceSetupDialog'
import { ResourceMonitorDialog } from './components/ResourceMonitorDialog'
import { CaptureAnnotator } from './components/CaptureAnnotator.tsx'
import { TerminalTopbarActions } from './components/TerminalTopbarActions'
import { WorkspaceView } from './layout/WorkspaceView'
import type { WorkspaceChromeState, WorkspaceWindowActions } from './layout/windowActions'
import { startTerminalOutputStream } from './ipc/output'
import { startHermesAgent, startHermesOutputStream } from './ipc/hermes'
import type { HermesWorkspaceState } from './ipc/types'
import { disableVoiceHotkey, enableVoiceHotkey, startVoiceSidecar, stopVoiceSidecar } from './ipc/voice'
import { voiceClient, type VoiceServerMessage } from './services/voiceClient'
import { useWorkspaceStore } from './state/store'
import { TerminalManager } from './terminal/TerminalManager'
import { isAgentPane, orderSessions, selectedProfileForWorkspace } from './state/profiles'
import { applyThemeToDocument } from './state/themePreview'
import { workspaceForShortcut } from './state/workspaceShortcuts'
import { workspaceWindowDescriptors, type WorkspaceWindowKind } from './layout/workspaceLayoutModel'
import './styles/theme.css'
import './styles/voice-setup.css'
import './styles/kanban.css'
import './App.css'


type CaptureShortcutAction = 'captureImage' | 'captureQuickImage' | 'captureVideo'
type CaptureShortcutRegistration = { action: CaptureShortcutAction; label: string; accelerator: string }

type FfmpegDownloadProgress = { downloaded: number; total?: number | null }
type CaptureRecordingState = { startedAtMs: number }
type CaptureRecordingEvent = { startedAtMs: number; path: string }


function App() {
  const apiRef = useRef<DockviewApi | null>(null)
  const windowMenuRef = useRef<HTMLDivElement | null>(null)
  const pageMenuRef = useRef<HTMLDivElement | null>(null)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [isWindowMenuOpen, setIsWindowMenuOpen] = useState(false)
  const [isPageMenuOpen, setIsPageMenuOpen] = useState(false)
  const [windowActions, setWindowActions] = useState<WorkspaceWindowActions | null>(null)
  const [chromeState, setChromeState] = useState<WorkspaceChromeState | null>(null)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [isSidebarPinned, setIsSidebarPinned] = useState(loadSidebarPinned)

  const [isResourceMonitorOpen, setIsResourceMonitorOpen] = useState(false)
  const [saveLayoutRequestId, setSaveLayoutRequestId] = useState(0)
  const [workspaceWindowRequest, setWorkspaceWindowRequest] = useState<{ kind: WorkspaceWindowKind; requestId: number; profileId?: string | null } | null>(null)
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
  const status = useWorkspaceStore((state) => state.status)
  const error = useWorkspaceStore((state) => state.error)
  const dismissError = useWorkspaceStore((state) => state.dismissError)
  const bootstrap = useWorkspaceStore((state) => state.bootstrap)
  const createSession = useWorkspaceStore((state) => state.createSession)
  const renameSession = useWorkspaceStore((state) => state.renameSession)
  const deleteSession = useWorkspaceStore((state) => state.deleteSession)
  const openSession = useWorkspaceStore((state) => state.openSession)
  const updateSettings = useWorkspaceStore((state) => state.updateSettings)
  const clearSession = useWorkspaceStore((state) => state.clearSession)
  const workspaceLayouts = useWorkspaceStore((state) => state.workspaceLayouts)
  const setActiveLayoutPage = useWorkspaceStore((state) => state.setActiveLayoutPage)
  const resetLayoutPage = useWorkspaceStore((state) => state.resetLayoutPage)
  const settings = useWorkspaceStore((state) => state.settings)
  const reorderWorkspaces = useWorkspaceStore((state) => state.reorderWorkspaces)
  const keybindings = useWorkspaceStore((state) => state.settings.keybindings)
  const voiceStatus = useWorkspaceStore((state) => state.voiceStatus)
  const voiceModelDownload = useWorkspaceStore((state) => state.voiceModelDownload)
  const voiceLastError = useWorkspaceStore((state) => state.voiceLastError)
  const voiceLastTranscription = useWorkspaceStore((state) => state.voiceLastTranscription)
  const voiceShouldRun = settings.voiceEnabled && settings.voiceModelId !== ''
  const orderedSessions = orderSessions(sessions, settings.workspaceOrder)
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const activeProfile = selectedProfileForWorkspace(settings, activeSessionId)
  const activeWorkspaceLayout = activeSessionId ? workspaceLayouts[activeSessionId] : undefined
  const activeLayoutPage = activeWorkspaceLayout?.pages.find((page) => page.id === activeWorkspaceLayout.activePageId) ?? activeWorkspaceLayout?.pages[0]
  const [startupLastActiveSessionId] = useState(() => window.localStorage.getItem('vibelink:lastActiveSessionId'))

  useEffect(() => {
    applyThemeToDocument(settings.terminalThemeId, settings.selectedPaneHighlightColor, settings.alarmHighlightColor)
  }, [settings.terminalThemeId, settings.selectedPaneHighlightColor, settings.alarmHighlightColor])

  useEffect(() => {
    void invoke('set_keep_terminals_alive_on_close', { value: settings.keepTerminalsAliveOnClose }).catch(() => {})
  }, [settings.keepTerminalsAliveOnClose])

  useEffect(() => {
    void Promise.all([startTerminalOutputStream(), startHermesOutputStream()]).then(() => bootstrap()).catch((caught) => {
      useWorkspaceStore.getState().setError(String(caught))
    })
  }, [bootstrap])

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
      onResponseStart: (paneId) => useWorkspaceStore.getState().clearPaneCompletionHighlight(paneId),
      onUserActivity: (paneId) => useWorkspaceStore.getState().clearPaneCompletionHighlight(paneId),
      onResponseComplete: (paneId) => useWorkspaceStore.getState().markPaneResponseComplete(paneId),
    })
    const unlisteners = [
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

  useEffect(() => voiceClient.subscribe((message: VoiceServerMessage) => {
    const state = useWorkspaceStore.getState()
    if (message.type === 'status') {
      const mapped = message.status === 'recording'
        ? 'recording'
        : message.status === 'processing'
          ? 'transcribing'
          : message.status === 'error'
            ? 'error'
            : message.status === 'loading'
              ? 'starting'
              : 'idle'
      state.setVoiceStatus(mapped)
    } else if (message.type === 'transcription') {
      state.setVoiceLastTranscription(message.text)
      state.setVoiceLastError(undefined)
      state.setVoiceStatus('idle')
    } else if (message.type === 'model_download_progress') {
      state.setVoiceModelDownload({ downloaded: message.downloaded_bytes ?? 0, total: message.total_bytes })
      if (message.stage === 'ready') state.setVoiceModelDownload(undefined)
    } else if (message.type === 'model_runtime_info') {
      state.setVoiceModelDownload(undefined)
      state.setVoiceStatus('idle')
    } else if (message.type === 'error') {
      state.setVoiceLastError(message.message)
      state.setVoiceStatus('error')
    }
  }), [])

  useEffect(() => {
    const unlisteners = [
      listen('vibelink://voice-ptt-pressed', () => voiceClient.startRecording()),
      listen('vibelink://voice-ptt-released', () => voiceClient.stopRecording()),
    ]
    return () => { void Promise.all(unlisteners).then((disposes) => disposes.forEach((dispose) => dispose())) }
  }, [])

  useEffect(() => {
    let disposed = false
    if (!voiceShouldRun) {
      voiceClient.disconnect()
      useWorkspaceStore.getState().setVoiceStatus('off')
      void disableVoiceHotkey().catch(() => {})
      void stopVoiceSidecar().catch(() => {})
      return undefined
    }

    useWorkspaceStore.getState().setVoiceStatus('starting')
    void startVoiceSidecar()
      .then(async ({ port, token }) => {
        await voiceClient.connect(port, token)
        if (disposed) return
        await enableVoiceHotkey()
      })
      .catch((caught) => {
        if (disposed) return
        useWorkspaceStore.getState().setVoiceLastError(String(caught))
        useWorkspaceStore.getState().setError(`Voice input could not start. ${String(caught)}`)
      })

    return () => {
      disposed = true
      voiceClient.disconnect()
      void disableVoiceHotkey().catch(() => {})
      void stopVoiceSidecar().catch(() => {})
    }
  }, [voiceShouldRun])

  useEffect(() => {
    if (!voiceShouldRun) return
    voiceClient.setConfig({
      model_id: settings.voiceModelId,
      device: settings.voiceDevice,
      language: settings.voiceLanguage === 'auto' ? null : settings.voiceLanguage,
      beam_size: 1,
      mute_speakers: settings.voiceMuteSpeakers,
      add_trailing_space: settings.voiceTrailingSpace,
      add_trailing_newline: settings.voiceAutoEnter,
      initial_prompt: '한국어와 English가 섞인 대화. Technical terms like API, GPU, CLI, git, terminal을 자주 사용합니다.',
    })
  }, [settings.voiceAutoEnter, settings.voiceDevice, settings.voiceLanguage, settings.voiceModelId, settings.voiceMuteSpeakers, settings.voiceTrailingSpace, voiceShouldRun])

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
    if (!activeSessionId) return
    const sessionId = activeSessionId
    const workspaceFolder = activeSession?.workspaceFolder ?? null
    const commandOverride = settings.hermesCommand || null
    // Workspace switch work is intentionally backgrounded: the derived profile
    // changes with activeSessionId immediately, while ACP warmup runs in parallel.
    // Warmup only helps once `hermes model` has configured the workspace; without
    // a provider the handshake can only fail, so skip it instead of surfacing errors.
    void invoke<HermesWorkspaceState>('hermes_workspace_state', { sessionId })
      .then((state) => state.model ? startHermesAgent({ sessionId, commandOverride, workspaceFolder }) : undefined)
      .catch(() => {})
  }, [activeSessionId, activeSession?.workspaceFolder, settings.hermesCommand])

  useEffect(() => {
    TerminalManager.reflowAll(true)
    requestAnimationFrame(() => {
      TerminalManager.reflowAll(true)
      TerminalManager.syncAllPtySizes()
    })
  }, [activeLayoutPage?.id])

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
  const persistActiveWorkspaceLayout = useCallback(() => {
    setSaveLayoutRequestId((id) => id + 1)
  }, [])

  const selectSession = useCallback((sessionId: string) => {
    persistActiveWorkspaceLayout()
    void openSession(sessionId)
  }, [openSession, persistActiveWorkspaceLayout])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const session = workspaceForShortcut(event, orderedSessions)
      if (!session) return
      event.preventDefault()
      event.stopPropagation()
      if (session.id !== activeSessionId) selectSession(session.id)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [activeSessionId, orderedSessions, selectSession])

  const createWorkspace = async (name: string, workspaceFolder: string | null, profileId: string) => {
    await createSession(name || undefined, workspaceFolder, profileId)
    setIsCreateOpen(false)
  }

  const clearWorkspace = async () => {
    const sessionId = useWorkspaceStore.getState().activeSessionId
    if (!sessionId) return
    await clearSession(sessionId)
  }

  const reloadAfterRestart = async () => {
    const api = apiRef.current
    if (api) {
      const panels = [...api.panels]
      for (const panel of panels) panel.api.close()
    }
    const sessionId = useWorkspaceStore.getState().activeSessionId
    await useWorkspaceStore.getState().refreshSessions()
    if (sessionId) await openSession(sessionId)
  }

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

  const openWorkspaceWindow = (kind: WorkspaceWindowKind) => {
    if (!activeSessionId) return
    setWorkspaceWindowRequest({ kind, profileId: kind === 'terminal' ? activeProfile.id : null, requestId: Date.now() })
    setIsWindowMenuOpen(false)
  }


  const resetCurrentLayoutPage = () => {
    if (!activeSessionId || !activeLayoutPage) return
    if (!window.confirm(`Reset layout page "${activeLayoutPage.name}"?`)) return
    resetLayoutPage(activeSessionId, activeLayoutPage.id)
  }

  const switchLayoutPage = (pageId: string) => {
    if (!activeSessionId || pageId === activeWorkspaceLayout?.activePageId) return
    persistActiveWorkspaceLayout()
    setActiveLayoutPage(activeSessionId, pageId)
  }

  useEffect(() => {
    const shortcuts = captureShortcutRegistrations(keybindings.captureImage, keybindings.captureVideo, keybindings.captureQuickImage)
    let disposed = false
    const registeredShortcuts = new Set<string>()

    const registerShortcuts = globalShortcutOperationRef.current.then(async () => {
      for (const shortcut of shortcuts) {
        if (disposed) return
        try {
          await register(shortcut.accelerator, (event) => {
            if (event.state !== 'Pressed') return
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

  useEffect(() => {
    if (!isWindowMenuOpen && !isPageMenuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && (windowMenuRef.current?.contains(target) || pageMenuRef.current?.contains(target))) return
      setIsWindowMenuOpen(false)
      setIsPageMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsWindowMenuOpen(false)
        setIsPageMenuOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown, { capture: true })
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, { capture: true })
      window.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [isWindowMenuOpen, isPageMenuOpen])

  const toggleSidebarPin = () => {
    const pinned = !isSidebarPinned
    setIsSidebarPinned(pinned)
    saveSidebarPinned(pinned)
    // Unpinning from inside the sidebar should not make the control disappear
    // under the pointer; keep the overlay open until the pointer leaves.
    setIsSidebarOpen(true)
  }

  const ffmpegDownloadPercent = ffmpegDownload ? ffmpegProgressPercent(ffmpegDownload) : null
  const ffmpegDownloadLabel = ffmpegDownload ? formatFfmpegProgress(ffmpegDownload) : ''
  const voiceDownloadPercent = voiceModelDownload?.total
    ? Math.min(100, Math.max(0, Math.round((voiceModelDownload.downloaded / voiceModelDownload.total) * 100)))
    : null

  return (
    <main className="app-shell" data-sidebar-pinned={isSidebarPinned ? 'true' : undefined} data-terminal-tabs={settings.terminalTabsVisible ? 'visible' : 'hidden'} style={{ '--vibelink-ui-scale': settings.uiScale, '--vibelink-pane-header-height': `${settings.paneHeaderHeight}px` } as CSSProperties}>
      {!isSidebarPinned ? <SidebarRevealEdge onReveal={() => setIsSidebarOpen(true)} /> : null}
      <Sidebar
        isOpen={isSidebarPinned || isSidebarOpen}
        isPinned={isSidebarPinned}
        sessions={orderedSessions}
        activeSessionId={activeSessionId}
        onPointerEnter={() => setIsSidebarOpen(true)}
        onPointerLeave={() => { if (!isSidebarPinned) setIsSidebarOpen(false) }}
        onTogglePin={toggleSidebarPin}
        onSelect={selectSession}
        onCreate={() => setIsCreateOpen(true)}
        onRename={(sessionId, name) => void renameSession(sessionId, name)}
        onDelete={(sessionId) => void deleteSession(sessionId)}
        onReorder={reorderWorkspaces}
      />
      <section className="main-surface">
        <header className="topbar" data-tauri-drag-region>
          <div className="workspace-crumb-box" data-tauri-drag-region>
            <div className="crumb" data-tauri-drag-region>{activeSession?.name ?? 'Loading'}</div>
          </div>
          <div className="window-menu" ref={windowMenuRef}>
            <button type="button" className="topbar-text-button" disabled={!activeSessionId} aria-haspopup="menu" aria-expanded={isWindowMenuOpen} onClick={() => setIsWindowMenuOpen((open) => !open)}>
              <LayoutGrid size={14} /> <span>Window</span>
            </button>
            {isWindowMenuOpen ? (
              <div className="window-menu-popover" role="menu">
                <button type="button" role="menuitem" onClick={() => openWorkspaceWindow('terminal')}>
                  <TerminalSquare size={14} /> Terminal
                </button>
                <button type="button" role="menuitem" onClick={() => openWorkspaceWindow('agent')}>
                  <Bot size={14} /> {workspaceWindowDescriptors.agent.title}
                </button>
                <button type="button" role="menuitem" onClick={() => openWorkspaceWindow('kanban')}>
                  <LayoutGrid size={14} /> Kanban
                </button>
                <button type="button" role="menuitem" onClick={() => openWorkspaceWindow('todo')}>
                  <ListTodo size={14} /> Todo List
                </button>
                <button type="button" role="menuitem" onClick={() => openWorkspaceWindow('diff')}>
                  <GitCompare size={14} /> Diff
                </button>
              </div>
            ) : null}
          </div>
          <div className="layout-page-strip" role="tablist" aria-label="Workspace layout pages">
            {(activeWorkspaceLayout?.pages ?? []).map((page) => (
              <button
                key={page.id}
                type="button"
                role="tab"
                aria-selected={page.id === activeWorkspaceLayout?.activePageId}
                className={page.id === activeWorkspaceLayout?.activePageId ? 'active' : undefined}
                onClick={() => switchLayoutPage(page.id)}
              >
                {page.name}
              </button>
            ))}
          </div>
          <div className="window-menu" ref={pageMenuRef}>
            <button type="button" className="topbar-icon-button" disabled={!activeSessionId} title="Layout page actions" aria-haspopup="menu" aria-expanded={isPageMenuOpen} onClick={() => setIsPageMenuOpen((open) => !open)}>
              <Ellipsis size={15} />
            </button>
            {isPageMenuOpen ? (
              <div className="window-menu-popover" role="menu">
                <button type="button" role="menuitem" onClick={() => { setSaveLayoutRequestId((id) => id + 1); setIsPageMenuOpen(false) }}>
                  <Save size={14} /> Save layout
                </button>
                <button type="button" role="menuitem" disabled={!activeLayoutPage} onClick={() => { setIsPageMenuOpen(false); resetCurrentLayoutPage() }}>
                  <Eraser size={14} /> Reset page
                </button>
              </div>
            ) : null}
          </div>
          <div className="topbar-spacer" data-tauri-drag-region />
          {chromeState?.activeWindowKind === 'terminal' ? <TerminalTopbarActions actions={windowActions} /> : null}
          <button type="button" className="topbar-icon-button" title="Capture image" onClick={openImageCapture}>
            <Camera size={16} />
          </button>
          <button type="button" className="topbar-icon-button" title="Resource monitor" onClick={() => setIsResourceMonitorOpen(true)}>
            <Activity size={16} />
          </button>
          <button type="button" className="topbar-icon-button" title="Capture video" onClick={() => void openVideoCapture()}>
            <Video size={16} />
          </button>
          <button type="button" className="topbar-icon-button" title="Open settings" onClick={() => setIsSettingsOpen(true)}>
            <Settings2 size={16} />
          </button>
          <div className="window-controls">
            <button type="button" className="window-control-button" title="Minimize" onClick={() => void getCurrentWindow().minimize()}>
              <Minus size={14} />
            </button>
            <button type="button" className="window-control-button" title="Maximize" onClick={() => void getCurrentWindow().toggleMaximize()}>
              <Square size={12} />
            </button>
            <button type="button" className="window-control-button window-control-close" title="Close" onClick={() => void getCurrentWindow().close()}>
              <X size={14} />
            </button>
          </div>
        </header>
        {error ? (
          <div className="daemon-banner">
            <AlertTriangle size={16} />
            <span className="daemon-banner-message">{error}</span>
            <button type="button" className="daemon-banner-close" title="Dismiss" onClick={dismissError}>
              <X size={14} />
            </button>
          </div>
        ) : null}
        {status === 'booting' ? <div className="loading-panel">Connecting to daemon…</div> : (
          <div className="workspace-content">
            <WorkspaceView
              onApiReady={(api) => { apiRef.current = api }}
              onActionsReady={setWindowActions}
              onChromeStateChange={setChromeState}
              resizeSnapTolerance={settings.resizeSnapTolerance}
              windowRequest={workspaceWindowRequest}
              saveLayoutRequestId={saveLayoutRequestId}
            />
          </div>
        )}
        {status === 'ready' && settings.voiceSetupCompleted && !activeSessionId && !isCreateOpen ? (
          <StartupWorkspaceDialog
            sessions={orderedSessions}
            lastActiveSessionId={startupLastActiveSessionId}
            onOpen={selectSession}
            onCreate={() => setIsCreateOpen(true)}
          />
        ) : null}
        {isResourceMonitorOpen ? <ResourceMonitorDialog onClose={() => setIsResourceMonitorOpen(false)} onStopWorkspaceTerminals={clearWorkspace} onAfterRestart={reloadAfterRestart} /> : null}
        {status === 'ready' && !settings.voiceSetupCompleted ? (
          <VoiceSetupDialog
            onUse={(voiceModelId, voiceDevice) => updateSettings({ voiceModelId, voiceDevice, voiceSetupCompleted: true })}
            onSkip={() => updateSettings({ voiceEnabled: false, voiceSetupCompleted: true })}
          />
        ) : null}
        {isSettingsOpen ? <SettingsDialog settings={settings} onChange={updateSettings} onClose={() => setIsSettingsOpen(false)} /> : null}
        {isCreateOpen ? <WorkspaceCreateDialog profiles={settings.profiles} defaultProfileId={settings.defaultProfileId} onCreate={(name, workspaceFolder, profileId) => void createWorkspace(name, workspaceFolder, profileId)} onClose={() => setIsCreateOpen(false)} /> : null}
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
        {voiceModelDownload ? (
          <div className="voice-download-toast" role="status" aria-live="polite">
            <span className="ffmpeg-download-title">Downloading voice model… {voiceDownloadPercent !== null ? `${voiceDownloadPercent}%` : formatBytes(voiceModelDownload.downloaded)}</span>
            {voiceDownloadPercent !== null ? (
              <span className="ffmpeg-download-progress" aria-hidden="true"><span style={{ width: `${voiceDownloadPercent}%` }} /></span>
            ) : null}
          </div>
        ) : null}
        {voiceStatus === 'recording' || voiceStatus === 'transcribing' || voiceLastError ? (
          <div className="voice-status-pill" role="status" aria-live="polite" data-state={voiceStatus}>
            <span className="capture-recording-dot" aria-hidden="true" />
            <span>{voiceLastError ?? (voiceStatus === 'recording' ? 'Listening…' : 'Transcribing…')}</span>
            {voiceLastTranscription && voiceStatus !== 'recording' ? <span className="voice-last-text">{voiceLastTranscription}</span> : null}
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
                <button type="button" className="settings-close" title="Close" onClick={() => setFfmpegNotice(null)}>
                  <X size={14} />
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
