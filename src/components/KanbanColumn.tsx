import type { DragEvent } from 'react'
import type { Task, TaskStatus } from '../ipc/types'
import { hasTaskDragPayload, readTaskDragPayload } from '../layout/taskDrag'
import { useWorkspaceStore } from '../state/store'
import { TASK_COLUMNS } from '../state/kanban'
import { KanbanCard } from './KanbanCard'

type KanbanColumnProps = {
  status: TaskStatus
  tasks: Task[]
  onAssign: (taskId: string) => void
  onEdit: (taskId: string) => void
}

export function KanbanColumn({ status, tasks, onAssign, onEdit }: KanbanColumnProps) {
  const moveTask = useWorkspaceStore((state) => state.moveTask)
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!hasTaskDragPayload(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }
  const onDrop = (event: DragEvent<HTMLElement>) => {
    const payload = readTaskDragPayload(event)
    if (!payload) return
    event.preventDefault()
    moveTask(payload.taskId, status)
  }
  return (
    <section className="kanban-column" data-status={status} onDragOver={onDragOver} onDrop={onDrop}>
      <header className="kanban-column-header">
        <span>{TASK_COLUMNS[status]}</span>
        <strong>{tasks.length}</strong>
      </header>
      <div className="kanban-column-cards">
        {tasks.map((task) => <KanbanCard key={task.id} task={task} onAssign={onAssign} onEdit={onEdit} />)}
      </div>
    </section>
  )
}
