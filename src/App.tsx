import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { DockviewApi } from 'dockview-react'
import { AlertTriangle, Settings2, TerminalSquare, Eraser, LayoutGrid } from 'lucide-react'
import { Sidebar } from './components/Sidebar'
import { NewTerminalLauncher } from './components/NewTerminalLauncher'
import { SettingsDialog } from './components/SettingsDialog'
import { StartupWorkspaceDialog } from './components/StartupWorkspaceDialog'
import { WorkspaceCreateDialog } from './components/WorkspaceCreateDialog'
import { WorkspaceView } from './layout/WorkspaceView'
import { startTerminalOutputStream } from './ipc/output'
import { useWorkspaceStore } from './state/store'
import { TerminalManager } from './terminal/TerminalManager'
import { selectedProfileForWorkspace } from './state/profiles'
import { ProfileIcon } from './components/ProfileIcon'
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
  const sessions = useWorkspaceStore((state) => state.sessions)
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const status = useWorkspaceStore((state) => state.status)
  const error = useWorkspaceStore((state) => state.error)
  const bootstrap = useWorkspaceStore((state) => state.bootstrap)
  const createSession = useWorkspaceStore((state) => state.createSession)
  const renameSession = useWorkspaceStore((state) => state.renameSession)
  const deleteSession = useWorkspaceStore((state) => state.deleteSession)
  const openSession = useWorkspaceStore((state) => state.openSession)
  const saveLayout = useWorkspaceStore((state) => state.saveLayout)
  const updateSettings = useWorkspaceStore((state) => state.updateSettings)
  const setDefaultProfile = useWorkspaceStore((state) => state.setDefaultProfile)
  const clearSession = useWorkspaceStore((state) => state.clearSession)
  const settings = useWorkspaceStore((state) => state.settings)
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const activeProfile = selectedProfileForWorkspace(settings, activeSessionId)
  const [startupLastActiveSessionId] = useState(() => window.localStorage.getItem('awt:lastActiveSessionId'))

  useEffect(() => {
    void startTerminalOutputStream().then(bootstrap).catch((caught) => {
      useWorkspaceStore.getState().setError(String(caught))
    })
  }, [bootstrap])

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

  const selectSession = (sessionId: string) => {
    const currentSessionId = useWorkspaceStore.getState().activeSessionId
    if (currentSessionId && apiRef.current) {
      void saveLayout(currentSessionId, JSON.stringify(apiRef.current.toJSON()))
    }
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

  return (
    <main className="app-shell" style={{ '--awt-ui-scale': settings.uiScale } as CSSProperties}>
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
          <button type="button" className="topbar-icon-button" title="Open settings" onClick={() => setIsSettingsOpen(true)}>
            <Settings2 size={16} />
          </button>
        </header>
        {error ? (
          <div className="daemon-banner"><AlertTriangle size={16} /> {error}</div>
        ) : null}
        {status === 'booting' ? <div className="loading-panel">Connecting to daemon…</div> : (
          <WorkspaceView
            onApiReady={(api) => { apiRef.current = api }}
            pendingTemplate={pendingTemplate}
            arrangeRequestId={arrangeRequestId}
            resizeSnapTolerance={settings.resizeSnapTolerance}
            onTemplateApplied={(requestId) => {
              setPendingTemplate((current) => current?.requestId === requestId ? null : current)
            }}
          />
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
      </section>
    </main>
  )
}

function templateFromId(templateId: string): { cols: number; rows: number } {
  const [cols, rows] = templateId.split('x').map(Number)
  return {
    cols: Number.isFinite(cols) && cols > 0 ? cols : 1,
    rows: Number.isFinite(rows) && rows > 0 ? rows : 1,
  }
}

export default App
