import { useState } from 'react'
import { TASK_COLUMNS } from '../state/kanban'
import { useWorkspaceStore } from '../state/store'
import type { TaskStatus } from '../ipc/types'

type TaskEditDialogProps = {
  taskId: string
  onClose: () => void
}

export function TaskEditDialog({ taskId, onClose }: TaskEditDialogProps) {
  const task = useWorkspaceStore((state) => state.kanban.tasks[taskId])
  const updateTask = useWorkspaceStore((state) => state.updateTask)
  const panes = useWorkspaceStore((state) => state.panes)
  const [title, setTitle] = useState(task?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? '')


  if (!task) return null
  const assignedPane = task.assignedPaneId ? panes[task.assignedPaneId] : undefined
  const timestamps = (['pending', 'assigned', 'in-progress', 'done'] as TaskStatus[])
    .filter((status) => task.statusTimestamps[status] != null)

  const submit = () => {
    updateTask(taskId, { title: title.trim(), description })
    onClose()
  }

  return (
    <div className="kanban-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="kanban-dialog kanban-edit-dialog" role="dialog" aria-modal="true" aria-label="Edit task" onMouseDown={(event) => event.stopPropagation()}>
        <h2>Edit task</h2>
        <label>
          Title
          <input value={title} autoFocus onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit() }} />
        </label>
        <label>
          Description
          <textarea value={description} rows={6} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <section className="kanban-task-details" aria-label="Task details">
          <div className="kanban-task-detail-row">
            <span>Status</span>
            <strong>{TASK_COLUMNS[task.status]}</strong>
          </div>
          <div className="kanban-task-detail-row">
            <span>Assigned terminal</span>
            <strong>{terminalLabel(assignedPane, task.assignedPaneId)}</strong>
          </div>
          <div className="kanban-task-detail-row">
            <span>Role</span>
            <strong>{task.assignedRole || 'Unassigned'}</strong>
          </div>
          {task.baselineRef ? (
            <div className="kanban-task-detail-row">
              <span>Baseline</span>
              <strong>{task.baselineRef}</strong>
            </div>
          ) : null}
          {task.worktreePath ? (
            <div className="kanban-task-detail-row">
              <span>Worktree</span>
              <strong>{task.worktreePath}</strong>
            </div>
          ) : null}
          {task.commitMessage ? (
            <div className="kanban-task-detail-row">
              <span>Commit</span>
              <strong>{task.commitMessage}</strong>
            </div>
          ) : null}
          {timestamps.length ? (
            <div className="kanban-task-detail-row kanban-task-detail-row-block">
              <span>Timeline</span>
              <div className="kanban-task-timeline">
                {timestamps.map((status) => (
                  <span key={status}>{TASK_COLUMNS[status]} {formatTaskTime(task.statusTimestamps[status]!)}</span>
                ))}
              </div>
            </div>
          ) : null}
          {task.resultSummary ? (
            <div className="kanban-task-detail-row kanban-task-detail-row-block">
              <span>Result notes</span>
              <pre>{task.resultSummary}</pre>
            </div>
          ) : null}
        </section>
        <div className="kanban-dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" onClick={submit}>Save</button>
        </div>
      </div>
    </div>
  )
}

function formatTaskTime(ts: number): string {
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function terminalLabel(pane: { config: { title?: string | null } } | undefined, paneId: string | undefined): string {
  if (pane?.config.title?.trim()) return pane.config.title
  if (paneId) return `Missing pane ${paneId.slice(0, 8)}`
  return 'Unassigned'
}
