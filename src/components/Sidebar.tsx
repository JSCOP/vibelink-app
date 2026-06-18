import { Plus, Trash2 } from 'lucide-react'
import type { SessionMeta } from '../ipc/types'

type SidebarProps = {
  isOpen: boolean
  sessions: SessionMeta[]
  activeSessionId?: string
  onSelect: (sessionId: string) => void
  onCreate: () => void
  onRename: (sessionId: string, name: string) => void
  onDelete: (sessionId: string) => void
  onPointerEnter: () => void
  onPointerLeave: () => void
}

export function Sidebar({ sessions, activeSessionId, isOpen, onPointerEnter, onPointerLeave, onSelect, onCreate, onRename, onDelete }: SidebarProps) {
  return (
    <aside className={`sidebar ${isOpen ? 'open' : ''}`} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      <div className="sidebar-heading">
        <span>Workspaces</span>
        <button type="button" title="New workspace" onClick={onCreate}>
          <Plus size={14} />
        </button>
      </div>
      <div className="session-list">
        {sessions.map((session) => (
          <div key={session.id} className={`session-row ${session.id === activeSessionId ? 'active' : ''}`}>
            <button type="button" className="session-main" onClick={() => onSelect(session.id)}>
              <span className="session-icon" />
              <span className="session-name">{session.name}</span>
              <span className="session-badge">{session.paneCount}</span>
            </button>
            <button
              type="button"
              title="Rename workspace"
              className="session-small-action"
              onClick={() => {
                const name = window.prompt('Rename workspace', session.name)
                if (name?.trim()) onRename(session.id, name.trim())
              }}
            >
              ···
            </button>
            <button
              type="button"
              title="Delete workspace"
              className="session-small-action danger"
              onClick={() => onDelete(session.id)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </aside>
  )
}
