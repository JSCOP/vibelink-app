import type { HermesPlanEntry, HermesTextPartKind, HermesToolCallView, HermesTranscriptPart, HermesTurn } from './hermes'

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
