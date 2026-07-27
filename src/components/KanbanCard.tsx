import { memo, useCallback, type ButtonHTMLAttributes, type ComponentType, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { CheckCircle2, Eye, RotateCcw, Trash2, UserPlus, type LucideProps } from 'lucide-react'
import type { Task } from '../ipc/types'
import { taskDragMime } from '../layout/taskDrag'
import { useWorkspaceStore } from '../state/store'
import { confirmDialog } from './appDialogStore'

type KanbanCardProps = {
  task: Task
  onAssign: (taskId: string) => void
  onEdit: (taskId: string) => void
}

export const KanbanCard = memo(function KanbanCard({ task, onAssign, onEdit }: KanbanCardProps) {
  const selected = useWorkspaceStore((state) => state.selectedTaskId[task.sessionId] === task.id)
  const selectTask = useWorkspaceStore((state) => state.selectTask)
  const markTaskDone = useWorkspaceStore((state) => state.markTaskDone)
  const updateTask = useWorkspaceStore((state) => state.updateTask)
  const deleteTask = useWorkspaceStore((state) => state.deleteTask)
  const role = task.assignedRole || 'Unassigned'

  const onDragStart = useCallback((event: DragEvent<HTMLElement>) => {
    event.dataTransfer.setData(taskDragMime, JSON.stringify({ taskId: task.id, status: task.status }))
    event.dataTransfer.effectAllowed = 'move'
  }, [task.id, task.status])

  const selectCurrentTask = useCallback(() => selectTask(task.sessionId, task.id), [selectTask, task.id, task.sessionId])
  const onCardKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter') {
      event.preventDefault()
      selectCurrentTask()
      return
    }
    if (event.key === ' ') {
      event.preventDefault()
      selectCurrentTask()
    }
  }, [selectCurrentTask])
  const editCurrentTask = useCallback((event: MouseEvent<HTMLElement>) => {
    event.stopPropagation()
    onEdit(task.id)
  }, [onEdit, task.id])
  const assignCurrentTask = useCallback(() => onAssign(task.id), [onAssign, task.id])
  const markCurrentTaskDone = useCallback(() => markTaskDone(task.id), [markTaskDone, task.id])
  const reopenCurrentTask = useCallback(() => updateTask(task.id, { status: 'in-progress' }), [updateTask, task.id])
  const removeTask = useCallback(() => {
    void confirmDialog({ title: 'Delete task', message: 'Delete this task? This cannot be undone.', confirmLabel: 'Delete', danger: true })
      .then((confirmed) => { if (confirmed) deleteTask(task.id) })
  }, [deleteTask, task.id])
  return (
    <article
      className={`kanban-card${selected ? ' kanban-card-selected' : ''}`}
      draggable
      role="button"
      tabIndex={0}
      onDragStart={onDragStart}
      onClick={selectCurrentTask}
      onDoubleClick={editCurrentTask}
      onKeyDown={onCardKeyDown}
    >
      <div className="kanban-card-title" title={task.title.trim() ? task.title : 'Untitled task'}>{task.title.trim() ? task.title : 'Untitled task'}</div>
      <div className="kanban-card-meta">
        <span className="kanban-card-chip" title={`Assigned role: ${role}`}>{role}</span>
        {task.assignedPaneId ? <span className="kanban-card-chip ok" title={`Assigned terminal: ${task.assignedPaneId}`}>agent</span> : null}
      </div>
      <div className="kanban-card-actions" onClick={(event) => event.stopPropagation()}>
        {task.status === 'pending' ? <ActionButton icon={UserPlus} label="Assign" title="Assign task to a terminal" onClick={assignCurrentTask} /> : null}
        {task.status === 'assigned' || task.status === 'in-progress' ? <ActionButton icon={CheckCircle2} label="Done" title="Mark task done" onClick={markCurrentTaskDone} /> : null}
        {task.status === 'done' ? <ActionButton icon={RotateCcw} label="Reopen" title="Reopen task" onClick={reopenCurrentTask} /> : null}
        <ActionButton icon={Eye} label="Diff" title="View task diff" onClick={selectCurrentTask} />
        <ActionButton icon={Trash2} label="Delete" title="Delete task" className="danger" onClick={removeTask} />
      </div>
    </article>
  )
})

function ActionButton({ icon: Icon, label, ...props }: { icon: ComponentType<LucideProps>; label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...props} aria-label={props['aria-label'] ?? props.title ?? label}>
      <Icon size={14} strokeWidth={1.9} aria-hidden="true" />
      <span className="kanban-card-action-label">{label}</span>
    </button>
  )
}
