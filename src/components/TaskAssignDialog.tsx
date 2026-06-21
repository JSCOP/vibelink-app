import { useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import { ProfileIcon } from './ProfileIcon'
import { useWorkspaceStore } from '../state/store'

type TaskAssignDialogProps = {
  taskId: string
  onClose: () => void
}

export function TaskAssignDialog({ taskId, onClose }: TaskAssignDialogProps) {
  const panesRecord = useWorkspaceStore((state) => state.panes)
  const paneRoles = useWorkspaceStore((state) => state.settings.paneRoles)
  const setPaneRole = useWorkspaceStore((state) => state.setPaneRole)
  const assignTask = useWorkspaceStore((state) => state.assignTask)
  const panes = useMemo(() => Object.values(panesRecord).filter((pane) => pane.alive), [panesRecord])
  const [selectedPaneId, setSelectedPaneId] = useState(panes[0]?.id ?? '')
  const [error, setError] = useState<string | null>(null)
  const [isolated, setIsolated] = useState(false)

  const submit = async () => {
    if (!selectedPaneId) return
    setError(null)
    await assignTask(taskId, selectedPaneId, { isolated })
    const currentError = useWorkspaceStore.getState().error
    if (currentError) setError(currentError)
    else onClose()
  }

  return (
    <div className="kanban-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="kanban-dialog kanban-assign-dialog" role="dialog" aria-modal="true" aria-label="Assign task" onMouseDown={(event) => event.stopPropagation()}>
        <h2>Assign task</h2>
        {panes.length === 0 ? <p className="kanban-dialog-note">No live terminal panes. Open a terminal pane first, then assign the task.</p> : null}
        {panes.length > 0 ? (
          <div className="task-pane-list">
            {panes.map((pane) => {
              const isSelected = selectedPaneId === pane.id
              return (
                <div key={pane.id} className={`task-pane-card${isSelected ? ' selected' : ''}`}>
                  <button type="button" className="task-pane-card-head" aria-pressed={isSelected} onClick={() => setSelectedPaneId(pane.id)}>
                    <ProfileIcon name={pane.config.icon} size={16} strokeWidth={1.75} className="task-pane-card-icon" />
                    <span className="task-pane-card-title">{pane.config.title ?? 'Shell'}</span>
                    {isSelected ? <Check size={14} /> : null}
                  </button>
                  <input
                    className="task-pane-card-role"
                    aria-label={`Role for ${pane.config.title ?? pane.id}`}
                    value={paneRoles[pane.id] ?? ''}
                    placeholder="Role (e.g. Reviewer)"
                    onChange={(event) => setPaneRole(pane.id, event.target.value)}
                  />
                </div>
              )
            })}
          </div>
        ) : null}
        <label className="kanban-checkbox-row">
          <input type="checkbox" checked={isolated} onChange={(event) => setIsolated(event.target.checked)} />
          Use isolated git worktree for this task
        </label>
        {error ? <div className="kanban-error">{error}</div> : null}
        <div className="kanban-dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" disabled={!selectedPaneId} onClick={() => void submit()}>Assign</button>
        </div>
      </div>
    </div>
  )
}
