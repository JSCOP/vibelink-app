import { useMemo, useState } from 'react'
import { useWorkspaceStore } from '../state/store'
import { isAgentPane } from '../state/profiles'

type TaskCreateDialogProps = {
  sessionId: string
  onClose: () => void
}

export function TaskCreateDialog({ sessionId, onClose }: TaskCreateDialogProps) {
  const createTask = useWorkspaceStore((state) => state.createTask)
  const panesRecord = useWorkspaceStore((state) => state.panes)
  const settings = useWorkspaceStore((state) => state.settings)
  const assignTask = useWorkspaceStore((state) => state.assignTask)
  const panes = useMemo(() => Object.values(panesRecord).filter((pane) => pane.alive && isAgentPane(pane, settings)), [panesRecord, settings])
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [targetPaneId, setTargetPaneId] = useState('')

  const submit = async () => {
    const trimmed = title.trim()
    if (!trimmed) return
    const task = createTask(sessionId, { title: trimmed, description })
    if (!task) return
    if (targetPaneId) await assignTask(task.id, targetPaneId)
    onClose()
  }

  return (
    <div className="kanban-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="kanban-dialog" role="dialog" aria-modal="true" aria-label="Create task" onMouseDown={(event) => event.stopPropagation()}>
        <h2>New task</h2>
        <label>
          Title
          <input value={title} autoFocus onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} />
        </label>
        <label>
          Description
          <textarea value={description} rows={6} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label>
          Assign to terminal
          <select value={targetPaneId} onChange={(event) => setTargetPaneId(event.target.value)}>
            <option value="">Leave in Pending</option>
            {panes.map((pane) => (
              <option key={pane.id} value={pane.id}>{settings.paneRoles[pane.id] ?? 'No role'} · {pane.config.title ?? 'Agent'}</option>
            ))}
          </select>
        </label>
        <div className="kanban-dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" onClick={() => void submit()}>Create</button>
        </div>
      </div>
    </div>
  )
}
