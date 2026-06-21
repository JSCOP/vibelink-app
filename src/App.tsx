import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { DockviewApi } from 'dockview-react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { AlertTriangle, Camera, Settings2, TerminalSquare, Eraser, LayoutGrid, Video, X } from 'lucide-react'
import { Sidebar } from './components/Sidebar'
import { NewTerminalLauncher } from './components/NewTerminalLauncher'
import { SettingsDialog } from './components/SettingsDialog'
import { StartupWorkspaceDialog } from './components/StartupWorkspaceDialog'
import { WorkspaceCreateDialog } from './components/WorkspaceCreateDialog'
import { WorkspaceView } from './layout/WorkspaceView'
import { KanbanView } from './layout/KanbanView'
import { startTerminalOutputStream } from './ipc/output'
import { startHermesAgent, startHermesOutputStream } from './ipc/hermes'
import { useWorkspaceStore } from './state/store'
import { TerminalManager } from './terminal/TerminalManager'
import { selectedProfileForWorkspace } from './state/profiles'
import { terminalThemeDefinitionById, themeCssVariables } from './state/terminalThemes'
import { ProfileIcon } from './components/ProfileIcon'
import { handleCapturedKeybindingEvent } from './state/keybindings'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles/theme.css'
import './App.css'

function App() {
  const apiRef = useRef<DockviewApi | null>(null)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [isTerminalLauncherOpen, setIsTerminalLauncherOpen] = useState(false)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [arrangeRequestId, setArrangeRequestId] = useState(0)
  const [pendingTemplate, setPendingTemplate] = useState<{ sessionId: string; templateId?: string; cols: number; rows: number; profileId?: string | null; requestId: number } | null>(null)
  const [ffmpegNotice, setFfmpegNotice] = useState(false)
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
  const saveLayout = useWorkspaceStore((state) => state.saveLayout)
  const updateSettings = useWorkspaceStore((state) => state.updateSettings)
  const setDefaultProfile = useWorkspaceStore((state) => state.setDefaultProfile)
  const clearSession = useWorkspaceStore((state) => state.clearSession)
  const viewModes = useWorkspaceStore((state) => state.viewModes)
  const setViewMode = useWorkspaceStore((state) => state.setViewMode)
  const settings = useWorkspaceStore((state) => state.settings)
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const activeProfile = selectedProfileForWorkspace(settings, activeSessionId)
  const viewMode = activeSessionId ? viewModes[activeSessionId] ?? 'terminal' : 'terminal'
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
    void Promise.all([startTerminalOutputStream(), startHermesOutputStream()]).then(() => bootstrap()).catch((caught) => {
      useWorkspaceStore.getState().setError(String(caught))
    })
  }, [bootstrap])

  useEffect(() => {
    TerminalManager.setLinkActions({
      onOpenPath: (path) => void invoke('open_path', { path }),
      resolveMarker: (paneId, n) => useWorkspaceStore.getState().resolveCaptureMarker(paneId, n),
    })
    const unlisten = listen<{ mode: string; path: string }>('capture://saved', (event) => {
      const state = useWorkspaceStore.getState()
      state.recordCapture(state.activePaneId, event.payload.path)
    })
    return () => { void unlisten.then((dispose) => dispose()) }
  }, [])

  useEffect(() => {
    TerminalManager.applySettings({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      terminalFontWeight: settings.terminalFontWeight,
      scrollback: settings.scrollback,
      terminalThemeId: settings.terminalThemeId,
      terminalScrollbarVisible: settings.terminalScrollbarVisible,
    })
  }, [settings.fontFamily, settings.fontSize, settings.terminalFontWeight, settings.scrollback, settings.terminalThemeId, settings.terminalScrollbarVisible])

  useEffect(() => {
    if (!activeSessionId) return
    const sessionId = activeSessionId
    const workspaceFolder = activeSession?.workspaceFolder ?? null
    const commandOverride = settings.hermesCommand || null
    // Workspace switch work is intentionally backgrounded: the derived profile
    // changes with activeSessionId immediately, while ACP warmup runs in parallel.
    void startHermesAgent({ sessionId, commandOverride, workspaceFolder }).catch((caught) => {
      useWorkspaceStore.getState().setError(String(caught))
    })
  }, [activeSessionId, activeSession?.workspaceFolder, settings.hermesCommand])

  useEffect(() => {
    if (viewMode !== 'terminal') return
    TerminalManager.reflowAll(true)
    requestAnimationFrame(() => TerminalManager.reflowAll(true))
  }, [viewMode])
  const persistActiveTerminalLayout = () => {
    const currentSessionId = useWorkspaceStore.getState().activeSessionId
    const api = apiRef.current
    if (!currentSessionId || !api) return
    void saveLayout(currentSessionId, JSON.stringify(api.toJSON()))
  }

  const switchWorkspaceView = (mode: 'terminal' | 'kanban') => {
    if (!activeSessionId) return
    if (mode === 'kanban') persistActiveTerminalLayout()
    setViewMode(activeSessionId, mode)
  }


  const selectSession = (sessionId: string) => {
    persistActiveTerminalLayout()
    void openSession(sessionId)
  }

  const createWorkspace = async (name: string, templateId: string, workspaceFolder: string | null, profileId: string) => {
    const created = await createSession(name || undefined, workspaceFolder, profileId)
    const template = templateFromId(templateId)
    setPendingTemplate({ sessionId: created.id, templateId, cols: template.cols, rows: template.rows, profileId, requestId: Date.now() })
    setIsCreateOpen(false)
  }

  const clearWorkspace = async () => {
    const sessionId = useWorkspaceStore.getState().activeSessionId
    const api = apiRef.current
    if (!sessionId || !api) return
    await clearSession(sessionId)
    const panels = [...api.panels]
    for (const panel of panels) panel.api.close()
  }

  const openImageCapture = useCallback(() => {
    void invoke('open_capture_overlay', { mode: 'image', dir: settings.captureDir, ffmpegPath: settings.captureFfmpegPath }).catch((caught) => {
      useWorkspaceStore.getState().setError(String(caught))
    })
  }, [settings.captureDir, settings.captureFfmpegPath])

  const openVideoCapture = useCallback(async () => {
    try {
      await invoke('check_ffmpeg', { ffmpegPath: settings.captureFfmpegPath })
      await invoke('open_capture_overlay', { mode: 'video', dir: settings.captureDir, ffmpegPath: settings.captureFfmpegPath })
    } catch {
      setFfmpegNotice(true)
    }
  }, [settings.captureDir, settings.captureFfmpegPath])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableShortcutTarget(event.target)) return
      handleCapturedKeybindingEvent(
        settings.keybindings,
        event,
        (action) => {
          if (action === 'captureImage') openImageCapture()
          else if (action === 'captureVideo') void openVideoCapture()
        },
        (action) => action === 'captureImage' || action === 'captureVideo',
      )
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [openImageCapture, openVideoCapture, settings.keybindings])

  return (
    <main className="app-shell" style={{ '--awt-ui-scale': settings.uiScale, '--awt-pane-header-height': `${settings.paneHeaderHeight}px` } as CSSProperties}>
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
        <header className="topbar">
          <div className="brand-mark"><TerminalSquare size={18} /></div>
          <div className="workspace-crumb-box">
            <div className="crumb">WORKSPACE › {activeSession?.name ?? 'Loading'}</div>
          </div>
          <div className="topbar-spacer" />
          <div className="view-toggle" role="group" aria-label="Workspace view">
            <button
              type="button"
              className={viewMode === 'terminal' ? 'active' : undefined}
              disabled={!activeSessionId}
              onClick={() => switchWorkspaceView('terminal')}
            >
              <TerminalSquare size={14} /> Terminal
            </button>
            <button
              type="button"
              className={viewMode === 'kanban' ? 'active' : undefined}
              disabled={!activeSessionId}
              onClick={() => switchWorkspaceView('kanban')}
            >
              <LayoutGrid size={14} /> Kanban
            </button>
          </div>
          <label className="setting-inline profile-setting">
            Profile
            <span className="profile-swatch" aria-hidden="true" style={{ color: activeProfile.color }}><ProfileIcon name={activeProfile.icon} size={14} /></span>
            <select
              aria-label="Active terminal profile"
              value={activeProfile.id}
              onChange={(event) => setDefaultProfile(event.target.value)}
            >
              {settings.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.name}</option>
              ))}
            </select>
          </label>
          <button type="button" className="topbar-text-button" disabled={!activeSessionId} title="Clear workspace terminal buffers" onClick={() => void clearWorkspace()}>
            <Eraser size={14} /> Clear
          </button>
          <button type="button" className="topbar-text-button" disabled={!activeSessionId} title="Arrange all panes" onClick={() => setArrangeRequestId(Date.now())}>
            <LayoutGrid size={14} /> Align
          </button>
          <NewTerminalLauncher
            isOpen={isTerminalLauncherOpen}
            disabled={!activeSessionId}
            onToggle={() => setIsTerminalLauncherOpen((open) => !open)}
            onClose={() => setIsTerminalLauncherOpen(false)}
            onLaunch={(request) => {
              if (!activeSessionId) return
              setPendingTemplate({ sessionId: activeSessionId, ...request, profileId: activeProfile.id, requestId: Date.now() })
              setIsTerminalLauncherOpen(false)
            }}
          />
          <button type="button" className="topbar-icon-button" title="Capture image" onClick={openImageCapture}>
            <Camera size={16} />
          </button>
          <button type="button" className="topbar-icon-button" title="Capture video" onClick={() => void openVideoCapture()}>
            <Video size={16} />
          </button>
          <button type="button" className="topbar-icon-button" title="Open settings" onClick={() => setIsSettingsOpen(true)}>
            <Settings2 size={16} />
          </button>
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
            <div className={`view-pane${viewMode === 'kanban' ? ' view-pane-hidden' : ' view-pane-active'}`} aria-hidden={viewMode === 'kanban'}>
              <WorkspaceView
                onApiReady={(api) => { apiRef.current = api }}
                pendingTemplate={pendingTemplate}
                arrangeRequestId={arrangeRequestId}
                resizeSnapTolerance={settings.resizeSnapTolerance}
                onTemplateApplied={(requestId) => {
                  setPendingTemplate((current) => current?.requestId === requestId ? null : current)
                }}
              />
            </div>
            {activeSessionId && viewMode === 'kanban' ? (
              <ErrorBoundary fallback={(boundaryError) => <div className="kanban-crash-panel"><AlertTriangle size={16} /> Kanban failed: {boundaryError.message}</div>}>
                <KanbanView sessionId={activeSessionId} />
              </ErrorBoundary>
            ) : null}
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
        {isSettingsOpen ? <SettingsDialog settings={settings} onChange={updateSettings} onClose={() => setIsSettingsOpen(false)} /> : null}
        {isCreateOpen ? <WorkspaceCreateDialog profiles={settings.profiles} defaultProfileId={settings.defaultProfileId} onCreate={(name, templateId, workspaceFolder, profileId) => void createWorkspace(name, templateId, workspaceFolder, profileId)} onClose={() => setIsCreateOpen(false)} /> : null}
        {ffmpegNotice ? (
          <div className="settings-backdrop" role="presentation" onMouseDown={() => setFfmpegNotice(false)}>
            <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="ffmpeg-title" style={{ width: 'min(520px, calc(100vw - 48px))' }} onMouseDown={(event) => event.stopPropagation()}>
              <header className="settings-dialog-header">
                <div>
                  <p className="settings-eyebrow">Capture video</p>
                  <h2 id="ffmpeg-title">ffmpeg is required</h2>
                </div>
                <button type="button" className="settings-close" title="Close" onClick={() => setFfmpegNotice(false)}>
                  <X size={14} />
                </button>
              </header>
              <div className="settings-dialog-body" style={{ display: 'block', maxHeight: 'none' }}>
                <section className="settings-card">
                  <p>Install ffmpeg, or set the ffmpeg.exe path in Settings → Capture.</p>
                  <p><a href="https://www.gyan.dev/ffmpeg/builds/" target="_blank" rel="noreferrer">Download Windows ffmpeg builds</a></p>
                </section>
              </div>
              <footer className="settings-dialog-footer">
                <span>Image capture does not require ffmpeg.</span>
                <button type="button" className="primary-action" onClick={() => setFfmpegNotice(false)}>Close</button>
              </footer>
            </section>
          </div>
        ) : null}
      </section>
    </main>
  )
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.classList.contains('xterm-helper-textarea')) return false
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
}

function templateFromId(templateId: string): { cols: number; rows: number } {
  const [cols, rows] = templateId.split('x').map(Number)
  return {
    cols: Number.isFinite(cols) && cols > 0 ? cols : 1,
    rows: Number.isFinite(rows) && rows > 0 ? rows : 1,
  }
}

export default App
