import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { DockviewApi } from 'dockview-react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { register, unregister } from '@tauri-apps/plugin-global-shortcut'
import { Activity, AlertTriangle, Bot, Camera, Copy, Edit2, Ellipsis, GitCompare, LayoutGrid, ListTodo, Minus, Plus, Save, Settings2, Square, TerminalSquare, Trash2, Eraser, Video, X } from 'lucide-react'
import { Sidebar } from './components/Sidebar'
import { SettingsDialog } from './components/SettingsDialog'
import { StartupWorkspaceDialog } from './components/StartupWorkspaceDialog'
import { WorkspaceCreateDialog } from './components/WorkspaceCreateDialog'
import { ResourceMonitorDialog } from './components/ResourceMonitorDialog'
import { CaptureAnnotator } from './components/CaptureAnnotator.tsx'
import { TerminalTopbarActions } from './components/TerminalTopbarActions'
import { WorkspaceView } from './layout/WorkspaceView'
import type { WorkspaceChromeState, WorkspaceWindowActions } from './layout/windowActions'
import { startTerminalOutputStream } from './ipc/output'
import { startHermesAgent, startHermesOutputStream } from './ipc/hermes'
import { useWorkspaceStore } from './state/store'
import { TerminalManager } from './terminal/TerminalManager'
import { isAgentPane, selectedProfileForWorkspace } from './state/profiles'
import { terminalThemeDefinitionById, themeCssVariables } from './state/terminalThemes'
import { workspaceWindowDescriptors, type WorkspaceWindowKind } from './layout/workspaceLayoutModel'
import './styles/theme.css'
import './styles/kanban.css'
import './App.css'

type TerminalGridPreference = { cols: number; rows: number }

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
  const [isResourceMonitorOpen, setIsResourceMonitorOpen] = useState(false)
  const [saveLayoutRequestId, setSaveLayoutRequestId] = useState(0)
  const [workspaceWindowRequest, setWorkspaceWindowRequest] = useState<{ kind: WorkspaceWindowKind; requestId: number; profileId?: string | null } | null>(null)
  const [terminalGridPreference, setTerminalGridPreference] = useState<TerminalGridPreference | null>(null)
  const [pendingTemplate, setPendingTemplate] = useState<{ sessionId: string; templateId?: string; cols: number; rows: number; occupiedGrid?: TerminalGridPreference | null; profileId?: string | null; requestId: number } | null>(null)
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
  const createLayoutPage = useWorkspaceStore((state) => state.createLayoutPage)
  const renameLayoutPage = useWorkspaceStore((state) => state.renameLayoutPage)
  const deleteLayoutPage = useWorkspaceStore((state) => state.deleteLayoutPage)
  const duplicateLayoutPage = useWorkspaceStore((state) => state.duplicateLayoutPage)
  const resetLayoutPage = useWorkspaceStore((state) => state.resetLayoutPage)
  const settings = useWorkspaceStore((state) => state.settings)
  const keybindings = useWorkspaceStore((state) => state.settings.keybindings)
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const activeProfile = selectedProfileForWorkspace(settings, activeSessionId)
  const activeWorkspaceLayout = activeSessionId ? workspaceLayouts[activeSessionId] : undefined
  const activeLayoutPage = activeWorkspaceLayout?.pages.find((page) => page.id === activeWorkspaceLayout.activePageId) ?? activeWorkspaceLayout?.pages[0]
  const [startupLastActiveSessionId] = useState(() => window.localStorage.getItem('awt:lastActiveSessionId'))

  useEffect(() => {
    const root = document.documentElement
    const theme = terminalThemeDefinitionById(settings.terminalThemeId)
    root.dataset.awtTheme = theme.id
    root.style.colorScheme = theme.colorScheme
    for (const [name, value] of Object.entries(themeCssVariables(theme.id))) {
      root.style.setProperty(name, value)
    }
  }, [settings.terminalThemeId])

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
    void startHermesAgent({ sessionId, commandOverride, workspaceFolder }).catch(() => {})
  }, [activeSessionId, activeSession?.workspaceFolder, settings.hermesCommand])

  useEffect(() => {
    TerminalManager.reflowAll(true)
    requestAnimationFrame(() => {
      TerminalManager.reflowAll(true)
      TerminalManager.syncAllPtySizes()
    })
  }, [activeLayoutPage?.id])
  const persistActiveWorkspaceLayout = () => {
    setSaveLayoutRequestId((id) => id + 1)
  }


  const selectSession = (sessionId: string) => {
    persistActiveWorkspaceLayout()
    void openSession(sessionId)
  }

  const createWorkspace = async (name: string, templateId: string, workspaceFolder: string | null, profileId: string) => {
    const created = await createSession(name || undefined, workspaceFolder, profileId)
    const template = templateFromId(templateId)
    setTerminalGridPreference({ cols: template.cols, rows: template.rows })
    setPendingTemplate({ sessionId: created.id, templateId, cols: template.cols, rows: template.rows, profileId, requestId: Date.now() })
    setIsCreateOpen(false)
  }

  const clearWorkspace = async () => {
    const sessionId = useWorkspaceStore.getState().activeSessionId
    if (!sessionId) return
    await clearSession(sessionId)
    setTerminalGridPreference(null)
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

  const addLayoutPage = () => {
    if (!activeSessionId) return
    persistActiveWorkspaceLayout()
    const name = window.prompt('Layout page name', `Layout ${(activeWorkspaceLayout?.pages.length ?? 0) + 1}`)?.trim()
    if (!name) return
    createLayoutPage(activeSessionId, name)
  }

  const renameCurrentLayoutPage = () => {
    if (!activeSessionId || !activeLayoutPage) return
    const name = window.prompt('Rename layout page', activeLayoutPage.name)?.trim()
    if (!name) return
    renameLayoutPage(activeSessionId, activeLayoutPage.id, name)
  }

  const duplicateCurrentLayoutPage = () => {
    if (!activeSessionId || !activeLayoutPage) return
    persistActiveWorkspaceLayout()
    duplicateLayoutPage(activeSessionId, activeLayoutPage.id)
  }

  const deleteCurrentLayoutPage = () => {
    if (!activeSessionId || !activeLayoutPage || (activeWorkspaceLayout?.pages.length ?? 0) <= 1) return
    if (!window.confirm(`Delete layout page "${activeLayoutPage.name}"?`)) return
    deleteLayoutPage(activeSessionId, activeLayoutPage.id)
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

  const ffmpegDownloadPercent = ffmpegDownload ? ffmpegProgressPercent(ffmpegDownload) : null
  const ffmpegDownloadLabel = ffmpegDownload ? formatFfmpegProgress(ffmpegDownload) : ''

  return (
    <main className="app-shell" data-terminal-tabs={settings.terminalTabsVisible ? 'visible' : 'hidden'} style={{ '--awt-ui-scale': settings.uiScale, '--awt-pane-header-height': `${settings.paneHeaderHeight}px` } as CSSProperties}>
      <div className="sidebar-hover-edge" onPointerEnter={() => setIsSidebarOpen(true)} />
      <Sidebar
        isOpen={isSidebarOpen}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onPointerEnter={() => setIsSidebarOpen(true)}
        onPointerLeave={() => setIsSidebarOpen(false)}
        onSelect={selectSession}
        onCreate={() => setIsCreateOpen(true)}
        onRename={(sessionId, name) => void renameSession(sessionId, name)}
        onDelete={(sessionId) => void deleteSession(sessionId)}
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
                onDoubleClick={renameCurrentLayoutPage}
              >
                {page.name}
              </button>
            ))}
            <button type="button" title="New layout page" disabled={!activeSessionId} onClick={addLayoutPage}>
              <Plus size={13} />
            </button>
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
                <button type="button" role="menuitem" disabled={!activeLayoutPage} onClick={() => { setIsPageMenuOpen(false); renameCurrentLayoutPage() }}>
                  <Edit2 size={14} /> Rename page
                </button>
                <button type="button" role="menuitem" disabled={!activeLayoutPage} onClick={() => { setIsPageMenuOpen(false); duplicateCurrentLayoutPage() }}>
                  <Copy size={14} /> Duplicate page
                </button>
                <button type="button" role="menuitem" disabled={!activeLayoutPage} onClick={() => { setIsPageMenuOpen(false); resetCurrentLayoutPage() }}>
                  <Eraser size={14} /> Reset page
                </button>
                <button type="button" role="menuitem" disabled={(activeWorkspaceLayout?.pages.length ?? 0) <= 1} onClick={() => { setIsPageMenuOpen(false); deleteCurrentLayoutPage() }}>
                  <Trash2 size={14} /> Delete page
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
              pendingTemplate={pendingTemplate}
              arrangeGrid={terminalGridPreference}
              resizeSnapTolerance={settings.resizeSnapTolerance}
              windowRequest={workspaceWindowRequest}
              saveLayoutRequestId={saveLayoutRequestId}
              onTemplateApplied={(requestId) => {
                setPendingTemplate((current) => current?.requestId === requestId ? null : current)
              }}
            />
          </div>
        )}
        {status === 'ready' && !activeSessionId && !isCreateOpen ? (
          <StartupWorkspaceDialog
            sessions={sessions}
            lastActiveSessionId={startupLastActiveSessionId}
            onOpen={selectSession}
            onCreate={() => setIsCreateOpen(true)}
          />
        ) : null}
        {isResourceMonitorOpen ? <ResourceMonitorDialog onClose={() => setIsResourceMonitorOpen(false)} onStopWorkspaceTerminals={clearWorkspace} onAfterRestart={reloadAfterRestart} /> : null}
        {isSettingsOpen ? <SettingsDialog settings={settings} onChange={updateSettings} onClose={() => setIsSettingsOpen(false)} /> : null}
        {isCreateOpen ? <WorkspaceCreateDialog profiles={settings.profiles} defaultProfileId={settings.defaultProfileId} onCreate={(name, templateId, workspaceFolder, profileId) => void createWorkspace(name, templateId, workspaceFolder, profileId)} onClose={() => setIsCreateOpen(false)} /> : null}
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
                <button type="button" className="settings-close" title="Close" onClick={() => setFfmpegNotice(null)}>
                  <X size={14} />
                </button>
              </header>
              <div className="settings-dialog-body" style={{ display: 'block', maxHeight: 'none' }}>
                <section className="settings-card">
                  <p>AWT tried to download ffmpeg automatically but could not finish. Install ffmpeg, or set the ffmpeg.exe path in Settings → Capture.</p>
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

function templateFromId(templateId: string): { cols: number; rows: number } {
  const [cols, rows] = templateId.split('x').map(Number)
  return {
    cols: Number.isFinite(cols) && cols > 0 ? cols : 1,
    rows: Number.isFinite(rows) && rows > 0 ? rows : 1,
  }
}

export default App
