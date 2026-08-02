import { Bell, Trash2, X } from 'lucide-react'
import type { CompletionHistoryEntry } from '../../state/store'
import { useWorkspaceStore } from '../../state/store'
import './CompletionHistoryDialog.css'

type CompletionHistoryDialogProps = {
  onClose: () => void
  onActivate: (entry: CompletionHistoryEntry) => Promise<void> | void
}

export function CompletionHistoryDialog({ onClose, onActivate }: CompletionHistoryDialogProps) {
  const history = useWorkspaceStore((state) => state.completionHistory)
  const sessions = useWorkspaceStore((state) => state.sessions)
  const markCompletionUnread = useWorkspaceStore((state) => state.markCompletionUnread)
  const clearCompletionHistory = useWorkspaceStore((state) => state.clearCompletionHistory)

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="settings-dialog completion-history-dialog" role="dialog" aria-modal="true" aria-labelledby="completion-history-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-dialog-header">
          <div><p className="settings-eyebrow">Agent hooks</p><h2 id="completion-history-title"><Bell size={16} aria-hidden="true" />Completion history</h2></div>
          <div className="completion-history-header-actions"><button type="button" disabled={history.length === 0} onClick={clearCompletionHistory}><Trash2 size={13} aria-hidden="true" />Clear all</button><button type="button" className="settings-close" title="Close" aria-label="Close completion history" onClick={onClose}><X size={14} aria-hidden="true" /></button></div>
        </header>
        <div className="settings-dialog-body completion-history-body">
          {history.length > 0 ? <ol>{history.map((entry) => {
            const workspaceName = sessions.find((session) => session.id === entry.sessionId)?.name ?? 'Unknown workspace'
            return <li key={entry.id} data-unread={!entry.read || undefined}><button type="button" className="completion-history-entry" onClick={() => { void onActivate(entry) }}><strong>{entry.paneTitle}</strong><span>{workspaceName} · {entry.agent ?? 'Agent'} · {formatRelativeTime(entry.completedAt)}</span></button><button type="button" className="completion-history-unread" disabled={!entry.read} onClick={() => markCompletionUnread(entry.id)}>{entry.read ? 'Mark unread' : 'Unread'}</button></li>
          })}</ol> : <p className="completion-history-empty">No agent hook completions yet.</p>}
        </div>
      </section>
    </div>
  )
}

function formatRelativeTime(completedAt: number): string {
  const seconds = Math.round((completedAt - Date.now()) / 1000)
  const absolute = Math.abs(seconds)
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] = absolute < 60
    ? [seconds, 'second']
    : absolute < 3600
      ? [Math.round(seconds / 60), 'minute']
      : absolute < 86400
        ? [Math.round(seconds / 3600), 'hour']
        : [Math.round(seconds / 86400), 'day']
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(value, unit)
}
