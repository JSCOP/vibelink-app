import { useEffect, useRef } from 'react'
import type { DockviewApi } from 'dockview-react'
import { AlertTriangle, TerminalSquare } from 'lucide-react'
import { Sidebar } from './components/Sidebar'
import { WorkspaceView } from './layout/WorkspaceView'
import { startTerminalOutputStream } from './ipc/output'
import { useWorkspaceStore } from './state/store'
import { selectedProfile } from './state/profiles'
import './styles/theme.css'
import './App.css'

function App() {
  const apiRef = useRef<DockviewApi | null>(null)
  const sessions = useWorkspaceStore((state) => state.sessions)
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const status = useWorkspaceStore((state) => state.status)
  const error = useWorkspaceStore((state) => state.error)
  const bootstrap = useWorkspaceStore((state) => state.bootstrap)
  const createSession = useWorkspaceStore((state) => state.createSession)
  const renameSession = useWorkspaceStore((state) => state.renameSession)
  const deleteSession = useWorkspaceStore((state) => state.deleteSession)
  const attachSession = useWorkspaceStore((state) => state.attachSession)
  const saveLayout = useWorkspaceStore((state) => state.saveLayout)
  const updateSettings = useWorkspaceStore((state) => state.updateSettings)
  const setDefaultProfile = useWorkspaceStore((state) => state.setDefaultProfile)
  const settings = useWorkspaceStore((state) => state.settings)
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const activeProfile = selectedProfile(settings)

  useEffect(() => {
    void startTerminalOutputStream().then(bootstrap).catch((caught) => {
      useWorkspaceStore.getState().setError(String(caught))
    })
  }, [bootstrap])

  const selectSession = (sessionId: string) => {
    const currentSessionId = useWorkspaceStore.getState().activeSessionId
    if (currentSessionId && apiRef.current) {
      void saveLayout(currentSessionId, JSON.stringify(apiRef.current.toJSON()))
    }
    void attachSession(sessionId)
  }

  return (
    <main className="app-shell">
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={selectSession}
        onCreate={() => void createSession()}
        onRename={(sessionId, name) => void renameSession(sessionId, name)}
        onDelete={(sessionId) => void deleteSession(sessionId)}
      />
      <section className="main-surface">
        <header className="topbar">
          <div className="brand-mark"><TerminalSquare size={18} /></div>
          <div>
            <div className="crumb">WORKSPACE › {activeSession?.name ?? 'Loading'}</div>
          </div>
          <div className="topbar-spacer" />
          <label className="setting-inline">
            Font
            <input
              type="number"
              min="10"
              max="22"
              value={settings.fontSize}
              onChange={(event) => updateSettings({ fontSize: Number(event.target.value) })}
            />
          </label>
          <label className="setting-inline profile-setting">
            Profile
            <span className="profile-swatch" aria-hidden="true" style={{ backgroundColor: activeProfile.color, color: activeProfile.color }} />
            <select
              aria-label="Active terminal profile"
              value={settings.defaultProfileId}
              onChange={(event) => setDefaultProfile(event.target.value)}
            >
              {settings.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.name}</option>
              ))}
            </select>
          </label>
        </header>
        {error ? (
          <div className="daemon-banner"><AlertTriangle size={16} /> {error}</div>
        ) : null}
        {status === 'booting' ? <div className="loading-panel">Connecting to daemon…</div> : <WorkspaceView onApiReady={(api) => { apiRef.current = api }} />}
      </section>
    </main>
  )
}

export default App
