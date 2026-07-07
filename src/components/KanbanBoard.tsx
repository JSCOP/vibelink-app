import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { TASK_COLUMNS, tasksForSession } from '../state/kanban'
import { useWorkspaceStore } from '../state/store'
import type { Task, TaskStatus } from '../ipc/types'
import { KanbanColumn } from './KanbanColumn'
import { TaskAssignDialog } from './TaskAssignDialog'
import { TaskCreateDialog } from './TaskCreateDialog'
import { TaskEditDialog } from './TaskEditDialog'

const EMPTY_SESSION_TASKS: Task[] = []
const KANBAN_STATUSES = Object.keys(TASK_COLUMNS) as TaskStatus[]
const EMPTY_GROUPED_TASKS: Record<TaskStatus, Task[]> = {
  pending: [],
  assigned: [],
  'in-progress': [],
  done: [],
}

export function KanbanBoard() {
  const sessionId = useWorkspaceStore((state) => state.activeSessionId)
  const sessionTasks = useWorkspaceStore(useShallow((state) => sessionId ? tasksForSession(state.kanban, sessionId) : EMPTY_SESSION_TASKS))
  const [isCreateOpen, setCreateOpen] = useState(false)
  const [assigningTaskId, setAssigningTaskId] = useState<string | null>(null)
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const grouped = useMemo(() => sessionId ? groupTasksByStatus(sessionTasks) : EMPTY_GROUPED_TASKS, [sessionId, sessionTasks])

  if (!sessionId) return <div className="kanban-empty">Open a workspace to use Kanban.</div>

  return (
    <div className="kanban-board-panel">
      <div className="kanban-board-header">
        <div>
          <h2>Board</h2>
          <p>Snapshot diffs include shared working-tree changes unless isolated worktrees are used.</p>
        </div>
        <button type="button" onClick={() => setCreateOpen(true)}>New task</button>
      </div>
      <div className="kanban-board">
        {KANBAN_STATUSES.map((status) => (
          <KanbanColumn key={status} status={status} tasks={grouped[status]} onAssign={setAssigningTaskId} onEdit={setEditingTaskId} />
        ))}
      </div>
      {isCreateOpen ? <TaskCreateDialog sessionId={sessionId} onClose={() => setCreateOpen(false)} /> : null}
      {assigningTaskId ? <TaskAssignDialog taskId={assigningTaskId} onClose={() => setAssigningTaskId(null)} /> : null}
      {editingTaskId ? <TaskEditDialog taskId={editingTaskId} onClose={() => setEditingTaskId(null)} /> : null}
    </div>
  )
}

function groupTasksByStatus(tasks: Task[]): Record<TaskStatus, Task[]> {
  const grouped: Record<TaskStatus, Task[]> = {
    pending: [],
    assigned: [],
    'in-progress': [],
    done: [],
  }
  for (const task of tasks) grouped[task.status].push(task)
  return grouped
}
