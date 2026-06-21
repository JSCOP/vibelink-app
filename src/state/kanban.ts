import type { Task, TaskStatus } from '../ipc/types'

export const TASK_COLUMNS: Record<TaskStatus, string> = {
  pending: '대기중',
  assigned: '배정됨',
  'in-progress': '작업중',
  done: '끝남',
}

export type KanbanData = {
  tasks: Record<string, Task>
  taskOrder: Record<string, string[]>
}

export const emptyKanban = (): KanbanData => ({ tasks: {}, taskOrder: {} })

export function normalizeKanban(value: unknown): KanbanData {
  if (!isRecord(value)) return emptyKanban()
  const tasksRecord = isRecord(value.tasks) ? value.tasks : {}
  const tasks = Object.fromEntries(
    Object.entries(tasksRecord)
      .map(([id, task]) => normalizeTask(id, task))
      .filter((entry): entry is [string, Task] => Boolean(entry)),
  )
  const taskOrder = normalizeTaskOrder(value.taskOrder, tasks)
  for (const task of Object.values(tasks)) {
    const order = taskOrder[task.sessionId] ?? []
    if (!order.includes(task.id)) taskOrder[task.sessionId] = [...order, task.id]
  }
  return { tasks, taskOrder }
}

export function tasksForSession(data: KanbanData, sessionId: string): Task[] {
  const ids = data.taskOrder[sessionId] ?? []
  const ordered = ids.map((id) => data.tasks[id]).filter((task): task is Task => Boolean(task))
  const missing = Object.values(data.tasks).filter((task) => task.sessionId === sessionId && !ids.includes(task.id))
  return [...ordered, ...missing].sort((left, right) => left.createdAt - right.createdAt)
}

export function tasksByStatus(data: KanbanData, sessionId: string): Record<TaskStatus, Task[]> {
  const grouped: Record<TaskStatus, Task[]> = {
    pending: [],
    assigned: [],
    'in-progress': [],
    done: [],
  }
  for (const task of tasksForSession(data, sessionId)) grouped[task.status].push(task)
  return grouped
}

export function composeTaskPrompt(
  task: Task,
  ctx: { role?: string | null; sessionId: string },
): string {
  const short = task.id.slice(0, 8)
  const roleLine = ctx.role ? `Role: ${ctx.role}` : undefined
  const worktreeLine = task.worktreePath ? `Work in isolated git worktree: ${task.worktreePath}` : undefined
  return [
    `[Task #${short}] ${task.title}`,
    roleLine,
    worktreeLine,
    task.description.trim() ? `\n${task.description.trim()}` : undefined,
    '',
    'When you make progress, report a note from this AWT pane with:',
    `& $env:AWT_APP_EXE cli task note --task ${task.id} --message "<short progress note>"`,
    '',
    'When finished, report completion from this AWT pane with:',
    `& $env:AWT_APP_EXE cli task done --task ${task.id}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n')
}

function normalizeTask(id: string, value: unknown): [string, Task] | null {
  if (!isRecord(value)) return null
  const sessionId = readNonEmptyString(value.sessionId)
  const title = readNonEmptyString(value.title)
  if (!sessionId || !title) return null
  const createdAt = readTimestamp(value.createdAt)
  const status = normalizeStatus(value.status)
  const updatedAt = readTimestamp(value.updatedAt, createdAt)
  return [
    id,
    {
      id,
      sessionId,
      title,
      description: typeof value.description === 'string' ? value.description : '',
      status,
      assignedPaneId: readOptionalString(value.assignedPaneId),
      assignedRole: readOptionalString(value.assignedRole),
      baselineRef: readOptionalString(value.baselineRef),
      worktreePath: readOptionalString(value.worktreePath),
      commitMessage: readOptionalString(value.commitMessage),
      resultSummary: readOptionalString(value.resultSummary),
      statusTimestamps: normalizeStatusTimestamps(value.statusTimestamps, { createdAt, status, updatedAt }),
      createdAt,
      updatedAt,
    },
  ]
}

function normalizeTaskOrder(value: unknown, tasks: Record<string, Task>): Record<string, string[]> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, unknown[]] => entry[0].trim().length > 0 && Array.isArray(entry[1]))
      .map(([sessionId, ids]) => [
        sessionId,
        ids.filter((id): id is string => typeof id === 'string' && tasks[id]?.sessionId === sessionId),
      ]),
  )
}

function normalizeStatus(value: unknown): TaskStatus {
  return value === 'assigned' || value === 'in-progress' || value === 'done' ? value : 'pending'
}

function normalizeStatusTimestamps(value: unknown, ctx: { createdAt: number; status: TaskStatus; updatedAt: number }): Partial<Record<TaskStatus, number>> {
  const out: Partial<Record<TaskStatus, number>> = {}
  if (isRecord(value)) {
    for (const status of ['pending', 'assigned', 'in-progress', 'done'] as TaskStatus[]) {
      const ts = value[status]
      if (typeof ts === 'number' && Number.isFinite(ts)) out[status] = ts
    }
  }
  if (Object.keys(out).length === 0) {
    out.pending = ctx.createdAt
    out[ctx.status] = ctx.updatedAt
  }
  return out
}

function readTimestamp(value: unknown, fallback = Date.now()): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : ''
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
