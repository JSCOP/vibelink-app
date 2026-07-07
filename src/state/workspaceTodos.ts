export type WorkspaceTodoItem = {
  id: string
  text: string
  kanbanTaskId?: string
  createdAt: number
  updatedAt: number
}

export type WorkspaceTodoLists = Record<string, WorkspaceTodoItem[]>
export type WorkspaceTodoNotes = Record<string, string>

export function normalizeWorkspaceTodoLists(value: unknown): WorkspaceTodoLists {
  if (!isRecord(value)) return {}
  const out: WorkspaceTodoLists = {}
  for (const [sessionId, list] of Object.entries(value)) {
    if (!Array.isArray(list)) continue
    const items: WorkspaceTodoItem[] = []
    for (const candidate of list) {
      if (!isRecord(candidate)) continue
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
      const text = typeof candidate.text === 'string' ? candidate.text.trim() : ''
      if (!id || !text) continue
      const kanbanTaskId = typeof candidate.kanbanTaskId === 'string' ? candidate.kanbanTaskId.trim() : ''
      const now = Date.now()
      items.push({
        id,
        text,
        kanbanTaskId: kanbanTaskId || undefined,
        createdAt: typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt) && candidate.createdAt > 0 ? candidate.createdAt : now,
        updatedAt: typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt) && candidate.updatedAt > 0 ? candidate.updatedAt : now,
      })
    }
    if (items.length > 0) out[sessionId] = items
  }
  return out
}

export function normalizeWorkspaceTodoNotes(value: unknown): WorkspaceTodoNotes {
  if (!isRecord(value)) return {}
  const out: WorkspaceTodoNotes = {}
  for (const [sessionId, note] of Object.entries(value)) {
    if (typeof note === 'string' && note.trim().length > 0) out[sessionId] = note
  }
  return out
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
