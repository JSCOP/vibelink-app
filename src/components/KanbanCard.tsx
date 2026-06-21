import type { ButtonHTMLAttributes, ComponentType, DragEvent, ReactNode } from 'react'
import { ArrowRight, CheckCircle2, ChevronLeft, Clock3, Eye, FileText, RotateCcw, UserPlus, type LucideProps } from 'lucide-react'
import type { Task, TaskStatus } from '../ipc/types'
import { taskDragMime } from '../layout/taskDrag'
import { useWorkspaceStore } from '../state/store'
import { TASK_COLUMNS } from '../state/kanban'

type KanbanCardProps = {
  task: Task
  onAssign: (taskId: string) => void
  onEdit: (taskId: string) => void
}

const statusOrder: TaskStatus[] = ['pending', 'assigned', 'in-progress', 'done']

export function KanbanCard({ task, onAssign, onEdit }: KanbanCardProps) {
  const selected = useWorkspaceStore((state) => state.selectedTaskId[task.sessionId] === task.id)
  const selectTask = useWorkspaceStore((state) => state.selectTask)
  const moveTask = useWorkspaceStore((state) => state.moveTask)
  const markTaskDone = useWorkspaceStore((state) => state.markTaskDone)
  const updateTask = useWorkspaceStore((state) => state.updateTask)
  const role = task.assignedRole || 'Unassigned'
  const index = statusOrder.indexOf(task.status)
  const timestamps = statusOrder.filter((status) => task.statusTimestamps[status] != null)

  const move = (delta: number) => {
    const next = statusOrder[index + delta]
    if (next) moveTask(task.id, next)
  }

  const onDragStart = (event: DragEvent<HTMLElement>) => {
    event.dataTransfer.setData(taskDragMime, JSON.stringify({ taskId: task.id, status: task.status }))
    event.dataTransfer.effectAllowed = 'move'
  }

  return (
    <article className={`kanban-card${selected ? ' kanban-card-selected' : ''}`} draggable onDragStart={onDragStart} onClick={() => selectTask(task.sessionId, task.id)} onDoubleClick={(event) => { event.stopPropagation(); onEdit(task.id) }}>
      <div className="kanban-card-title" title={task.title.trim() ? task.title : 'Untitled task'}>{task.title.trim() ? task.title : 'Untitled task'}</div>
      <div className="kanban-card-meta">
        <span className="kanban-card-chip" title={`Assigned role: ${role}`}>{role}</span>
        <span className={`kanban-card-chip${task.baselineRef ? ' ok' : ''}`} title={task.baselineRef ? `Diff baseline: ${task.baselineRef}` : 'No git baseline for diff'}>{task.baselineRef ? 'diff ready' : 'no baseline'}</span>
      </div>
      {task.description ? (
        <CardDetails icon={FileText} label="내용">
          <p>{task.description}</p>
        </CardDetails>
      ) : null}
      {timestamps.length ? (
        <CardDetails icon={Clock3} label="시간" badge={String(timestamps.length)}>
          <div className="kanban-card-times">
            {timestamps.map((status) => (
              <span key={status}>{TASK_COLUMNS[status]} {formatTaskTime(task.statusTimestamps[status]!)}</span>
            ))}
          </div>
        </CardDetails>
      ) : null}
      {task.resultSummary ? (
        <CardDetails icon={FileText} label="결과">
          <pre className="kanban-card-notes">{task.resultSummary}</pre>
        </CardDetails>
      ) : null}
      <div className="kanban-card-actions" onClick={(event) => event.stopPropagation()}>
        <ActionButton icon={ChevronLeft} label="Back" title="Move task to previous status" disabled={index <= 0} onClick={() => move(-1)} />
        {task.status === 'pending' ? <ActionButton icon={UserPlus} label="Assign" title="Assign task to a terminal" onClick={() => onAssign(task.id)} /> : null}
        {task.status === 'assigned' || task.status === 'in-progress' ? <ActionButton icon={CheckCircle2} label="Done" title="Mark task done" onClick={() => markTaskDone(task.id)} /> : null}
        {task.status === 'done' ? <ActionButton icon={RotateCcw} label="Reopen" title="Reopen task" onClick={() => updateTask(task.id, { status: 'in-progress' })} /> : null}
        <ActionButton icon={Eye} label="Diff" title="View task diff" onClick={() => selectTask(task.sessionId, task.id)} />
        <ActionButton icon={ArrowRight} label="Next" title="Advance task to next status" disabled={index >= statusOrder.length - 1} onClick={() => move(1)} />
      </div>
    </article>
  )
}

function CardDetails({ icon: Icon, label, badge, children }: { icon: ComponentType<LucideProps>; label: string; badge?: string; children: ReactNode }) {
  return (
    <details className="kanban-card-details" onClick={(event) => event.stopPropagation()}>
      <summary>
        <Icon size={13} strokeWidth={1.8} />
        <span>{label}</span>
        {badge ? <small>{badge}</small> : null}
      </summary>
      <div className="kanban-card-detail-body">{children}</div>
    </details>
  )
}

function ActionButton({ icon: Icon, label, ...props }: { icon: ComponentType<LucideProps>; label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...props} aria-label={props['aria-label'] ?? props.title ?? label}>
      <Icon size={14} strokeWidth={1.9} aria-hidden="true" />
      <span className="kanban-card-action-label">{label}</span>
    </button>
  )
}

function formatTaskTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
