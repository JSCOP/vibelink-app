import type { HermesPlanEntry, HermesTextPartKind, HermesToolCallView, HermesTranscriptPart, HermesTurn } from './hermes'

/** One durable timeline row from the control-plane database. */
export type AgentTimelineRow = {
  seq: number
  role: 'user' | 'assistant' | 'system'
  kind: 'message' | 'thought' | 'toolCall' | 'plan' | 'permission' | 'error'
  entityId?: string | null
  body: string
  truncated: boolean
  createdAt: number
}

const MAX_HERMES_TURNS = 400

export function capHermesTurns(turns: HermesTurn[]): HermesTurn[] {
  return turns.length > MAX_HERMES_TURNS ? turns.slice(-MAX_HERMES_TURNS) : turns
}

export function updateLastAssistantTurn(turns: HermesTurn[], update: (turn: HermesTurn) => HermesTurn): HermesTurn[] {
  const last = turns[turns.length - 1]
  if (!last || last.role !== 'assistant') {
    return capHermesTurns([...turns, update(createAssistantTurn())])
  }
  return capHermesTurns([...turns.slice(0, -1), update(last)])
}

export function createAssistantTurn(): HermesTurn {
  return { role: 'assistant', text: '', thoughts: '', toolCalls: [], parts: [] }
}

export function appendHermesTextPart(turn: HermesTurn, kind: HermesTextPartKind, text: string): HermesTurn {
  const parts = transcriptPartsForUpdate(turn)
  const last = parts[parts.length - 1]
  const nextParts: HermesTranscriptPart[] = last?.kind === kind
    ? [...parts.slice(0, -1), { kind, text: last.text + text }]
    : [...parts, { kind, text }]
  return kind === 'message'
    ? { ...turn, text: turn.text + text, parts: nextParts }
    : { ...turn, thoughts: turn.thoughts + text, parts: nextParts }
}

export function appendHermesToolCallPart(turn: HermesTurn, call: Omit<HermesToolCallView, 'content'> & { content?: string }): HermesTurn {
  const nextCall: HermesToolCallView = { ...call, content: call.content ?? '' }
  return {
    ...turn,
    toolCalls: [...turn.toolCalls, nextCall],
    parts: [...transcriptPartsForUpdate(turn), { kind: 'toolCall', toolCallId: nextCall.id }],
  }
}

export function updateHermesPlanPart(turn: HermesTurn, entries: HermesPlanEntry[]): HermesTurn {
  const parts = transcriptPartsForUpdate(turn)
  const planPart: HermesTranscriptPart = { kind: 'plan', entries }
  const index = parts.findIndex((part) => part.kind === 'plan')
  const nextParts = index >= 0
    ? parts.map((part, current) => current === index ? planPart : part)
    : [...parts, planPart]
  return { ...turn, plan: entries, parts: nextParts }
}

export function transcriptPartsForUpdate(turn: HermesTurn): HermesTranscriptPart[] {
  if (turn.parts) return [...turn.parts]
  const parts: HermesTranscriptPart[] = []
  if (turn.text) parts.push({ kind: 'message', text: turn.text })
  if (turn.thoughts) parts.push({ kind: 'thought', text: turn.thoughts })
  if (turn.plan?.length) parts.push({ kind: 'plan', entries: turn.plan })
  for (const call of turn.toolCalls) parts.push({ kind: 'toolCall', toolCallId: call.id })
  return parts
}

/** Folds persisted timeline rows into renderable turns. Tool-call rows sharing
 * an entityId collapse patch-style, last row wins per field. Permission rows
 * are historical records and are not rendered as chat content. */
export function turnsFromTimeline(rows: AgentTimelineRow[]): HermesTurn[] {
  const turns: HermesTurn[] = []
  const withAssistant = (update: (turn: HermesTurn) => HermesTurn) => {
    const last = turns[turns.length - 1]
    if (!last || last.role !== 'assistant') turns.push(update(createAssistantTurn()))
    else turns[turns.length - 1] = update(last)
  }
  for (const row of rows) {
    if (row.kind === 'permission') continue
    if (row.role === 'user') {
      turns.push({ role: 'user', text: row.body, thoughts: '', toolCalls: [], parts: [{ kind: 'message', text: row.body }] })
      continue
    }
    if (row.kind === 'message' || row.kind === 'error') {
      const text = row.kind === 'error' ? `Agent error: ${row.body}` : row.body
      withAssistant((turn) => appendHermesTextPart(turn, 'message', text))
    } else if (row.kind === 'thought') {
      withAssistant((turn) => appendHermesTextPart(turn, 'thought', row.body))
    } else if (row.kind === 'plan') {
      const entries = parseJson<HermesPlanEntry[]>(row.body) ?? []
      withAssistant((turn) => updateHermesPlanPart(turn, entries))
    } else if (row.kind === 'toolCall' && row.entityId) {
      const patch = parseJson<{ title?: string; toolKind?: string; status?: string; content?: string }>(row.body) ?? {}
      withAssistant((turn) => {
        const existing = turn.toolCalls.find((call) => call.id === row.entityId)
        if (!existing) {
          return appendHermesToolCallPart(turn, {
            id: row.entityId ?? '',
            title: patch.title ?? '',
            toolKind: patch.toolKind ?? '',
            status: patch.status ?? '',
            content: patch.content,
          })
        }
        return {
          ...turn,
          toolCalls: turn.toolCalls.map((call) => call.id === row.entityId
            ? {
                ...call,
                status: patch.status ?? call.status,
                content: patch.content !== undefined ? call.content + patch.content : call.content,
                title: patch.title ?? call.title,
                toolKind: patch.toolKind ?? call.toolKind,
              }
            : call),
        }
      })
    }
  }
  return capHermesTurns(turns)
}

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}
