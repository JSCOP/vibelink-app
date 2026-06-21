import { useState } from 'react'
import { useWorkspaceStore } from '../state/store'

type TaskEditDialogProps = {
  taskId: string
  onClose: () => void
}

export function TaskEditDialog({ taskId, onClose }: TaskEditDialogProps) {
  const task = useWorkspaceStore((state) => state.kanban.tasks[taskId])
  const updateTask = useWorkspaceStore((state) => state.updateTask)
  const [title, setTitle] = useState(task?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? '')


  if (!task) return null

  const submit = () => {
    updateTask(taskId, { title: title.trim(), description })
    onClose()
  }

  return (
    <div className="kanban-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="kanban-dialog" role="dialog" aria-modal="true" aria-label="Edit task" onMouseDown={(event) => event.stopPropagation()}>
        <h2>Edit task</h2>
        <label>
          Title
          <input value={title} autoFocus onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit() }} />
        </label>
        <label>
          Description
          <textarea value={description} rows={6} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <div className="kanban-dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" onClick={submit}>Save</button>
        </div>
      </div>
    </div>
  )
}
