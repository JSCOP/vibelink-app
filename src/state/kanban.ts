import type { Task, TaskStatus, WorkspaceBrief } from '../ipc/types'

export const TASK_COLUMNS: Record<TaskStatus, string> = {
  pending: 'Pending',
  assigned: 'Assigned',
  'in-progress': 'In Progress',
  done: 'Done',
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
  const orderedIds = new Set(ids)
  const ordered = ids.map((id) => data.tasks[id]).filter((task): task is Task => Boolean(task))
  const missing = Object.values(data.tasks).filter((task) => task.sessionId === sessionId && !orderedIds.has(task.id))
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
  ctx: { role?: string | null; sessionId: string; brief?: WorkspaceBrief | null },
): string {
  const short = task.id.slice(0, 8)
  const title = inlineText(task.title)
  const roleLine = ctx.role ? `Role: ${inlineText(ctx.role)}` : undefined
  const purposeLine = ctx.brief?.purpose.trim() ? `Workspace purpose: ${inlineText(ctx.brief.purpose)}` : undefined
  const worktreeLine = task.worktreePath ? `Work in isolated git worktree: ${inlineText(task.worktreePath)}` : undefined
  const description = inlineText(task.description)
  return [
    `[Task #${short}] ${title}`,
    purposeLine,
    roleLine,
    worktreeLine,
    description || undefined,
    'When you make progress, report a note from this VibeLink pane with:',
    `& $env:VIBELINK_APP_EXE cli task note --task ${task.id} --message "<short progress note>"`,
    'When finished, report completion from this VibeLink pane with:',
    `& $env:VIBELINK_APP_EXE cli task done --task ${task.id} --result-summary "<short result summary>"`,
  ]
    .filter((line): line is string => line !== undefined)
    .join(' | ')
}

export function composeAgentTaskPrompt(
  task: Task,
  ctx: { brief?: WorkspaceBrief | null; worktreePath?: string | null },
): string {
  const short = task.id.slice(0, 8)
  const title = inlineText(task.title)
  const purposeLine = ctx.brief?.purpose.trim() ? `Workspace purpose: ${inlineText(ctx.brief.purpose)}` : undefined
  const worktreeLine = ctx.worktreePath ? `Work in isolated git worktree: ${inlineText(ctx.worktreePath)}` : undefined
  const description = inlineText(task.description)
  return [
    `[Task #${short}] ${title}`,
    purposeLine,
    worktreeLine,
    description || undefined,
    `Report progress with the vibelink_task_note tool (taskId ${task.id}).`,
    `When finished, call vibelink_task_done (taskId ${task.id}) with a short resultSummary.`,
  ]
    .filter((line): line is string => line !== undefined)
    .join(' | ')
}

export function composeWorkspaceDigestPrompt(input: {
  workspaceName: string
  brief?: WorkspaceBrief | null
  tasks: Task[]
  terminalOutputs: Array<{ title: string; output: string }>
}): string {
  const grouped = input.tasks.reduce<Record<TaskStatus, Task[]>>((result, task) => {
    result[task.status].push(task)
    return result
  }, { pending: [], assigned: [], 'in-progress': [], done: [] })
  const kanbanLines = (Object.keys(TASK_COLUMNS) as TaskStatus[]).map((status) => {
    const tasks = grouped[status]
    const titles = tasks.map((task) => inlineText(task.title)).join('; ')
    return `- ${TASK_COLUMNS[status]} (${tasks.length})${titles ? `: ${titles}` : ''}`
  })
  const terminalSections = input.terminalOutputs.length > 0
    ? input.terminalOutputs.map(({ title, output }) => `### ${inlineText(title)}\n<terminal_output>\n${output}\n</terminal_output>`).join('\n')
    : 'No live terminal output was available.'

  return [
    'Create a concise advisor digest for this VibeLink workspace.',
    'Report: current progress, blockers or risks, and the three highest-priority next actions. Do not change files or run commands unless I ask after reviewing the digest.',
    `Workspace: ${inlineText(input.workspaceName)}`,
    input.brief?.purpose.trim() ? `Purpose: ${input.brief.purpose.trim()}` : 'Purpose: not recorded',
    input.brief?.notes.trim() ? `Notes: ${input.brief.notes.trim()}` : 'Notes: none',
    '## Kanban',
    ...kanbanLines,
    '## Recent terminal output',
    terminalSections,
  ].join('\n')
}

function inlineText(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
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
