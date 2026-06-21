import { useState } from 'react'
import { TASK_COLUMNS, tasksByStatus } from '../state/kanban'
import { useWorkspaceStore } from '../state/store'
import type { TaskStatus } from '../ipc/types'
import { KanbanColumn } from './KanbanColumn'
import { TaskAssignDialog } from './TaskAssignDialog'
import { TaskCreateDialog } from './TaskCreateDialog'
import { TaskEditDialog } from './TaskEditDialog'

export function KanbanBoard() {
  const sessionId = useWorkspaceStore((state) => state.activeSessionId)
  const kanban = useWorkspaceStore((state) => state.kanban)
  const [isCreateOpen, setCreateOpen] = useState(false)
  const [assigningTaskId, setAssigningTaskId] = useState<string | null>(null)
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)

  if (!sessionId) return <div className="kanban-empty">Open a workspace to use Kanban.</div>

  const grouped = tasksByStatus(kanban, sessionId)
  const statuses = Object.keys(TASK_COLUMNS) as TaskStatus[]

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
        {statuses.map((status) => (
          <KanbanColumn key={status} status={status} tasks={grouped[status]} onAssign={setAssigningTaskId} onEdit={setEditingTaskId} />
        ))}
      </div>
      {isCreateOpen ? <TaskCreateDialog sessionId={sessionId} onClose={() => setCreateOpen(false)} /> : null}
      {assigningTaskId ? <TaskAssignDialog taskId={assigningTaskId} onClose={() => setAssigningTaskId(null)} /> : null}
      {editingTaskId ? <TaskEditDialog taskId={editingTaskId} onClose={() => setEditingTaskId(null)} /> : null}
    </div>
  )
}
