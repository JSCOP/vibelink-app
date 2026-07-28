import { FolderOpen, Plus, TerminalSquare } from 'lucide-react'
import type { SessionMeta } from '../ipc/types'

type StartupWorkspaceDialogProps = {
  sessions: SessionMeta[]
  lastActiveSessionId?: string | null
  onOpen: (sessionId: string) => void
  onCreate: () => void
}

export function StartupWorkspaceDialog({ sessions, lastActiveSessionId, onOpen, onCreate }: StartupWorkspaceDialogProps) {

  return (
    <div className="startup-workspace-backdrop" role="presentation">
      <section className="startup-workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="startup-workspace-title">
        <header className="startup-workspace-header">
          <div className="startup-workspace-mark">
            <TerminalSquare size={18} />
          </div>
          <div>
            <p className="settings-eyebrow">VibeLink</p>
            <h2 id="startup-workspace-title">Open workspace</h2>
          </div>
        </header>

        <div className="startup-workspace-list">
          {sessions.map((session) => (
            <button key={session.id} type="button" className="startup-workspace-row" onClick={() => onOpen(session.id)}>
              <span className="startup-workspace-row-icon"><FolderOpen size={16} /></span>
              <span className="startup-workspace-row-main">
                <strong>{session.name}</strong>
                <small>{session.workspaceFolder ?? '~'}</small>
              </span>
              {session.id === lastActiveSessionId ? <span className="startup-workspace-badge">Last</span> : null}
            </button>
          ))}
        </div>

        <footer className="startup-workspace-footer">
          <button type="button" className="secondary-action" onClick={onCreate}>
            <Plus size={14} /> New
          </button>
        </footer>
      </section>
    </div>
  )
}
