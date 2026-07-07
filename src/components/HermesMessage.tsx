import { memo } from 'react'
import type { HermesTranscriptPart, HermesTurn } from '../state/hermes'
import { HermesToolCall } from './HermesToolCall'

type HermesMessageProps = {
  turn: HermesTurn
  showThoughts?: boolean
  showToolCalls?: boolean
  showToolCallContent?: boolean
}

export const HermesMessage = memo(function HermesMessage({
  turn,
  showThoughts = true,
  showToolCalls = true,
  showToolCallContent = true,
}: HermesMessageProps) {
  return (
    <article className={`hermes-message hermes-message-${turn.role}`}>
      <div className="hermes-message-role">{turn.role}</div>
      {transcriptParts(turn).map((part, index) => renderPart(part, index, turn, showThoughts, showToolCalls, showToolCallContent))}
    </article>
  )
})

function renderPart(
  part: HermesTranscriptPart,
  index: number,
  turn: HermesTurn,
  showThoughts: boolean,
  showToolCalls: boolean,
  showToolCallContent: boolean,
) {
  switch (part.kind) {
    case 'message':
      return part.text ? <div key={index} className="hermes-message-text">{part.text}</div> : null
    case 'thought':
      return showThoughts && part.text ? (
        <details key={index} className="hermes-thought" open>
          <summary>Thoughts · {lineCount(part.text)} lines</summary>
          <pre>{part.text}</pre>
        </details>
      ) : null
    case 'plan':
      return part.entries.length ? (
        <ol key={index} className="hermes-plan">
          {part.entries.map((entry, entryIndex) => <li key={`${entryIndex}:${entry.content}`} data-status={entry.status}>{entry.content}</li>)}
        </ol>
      ) : null
    case 'toolCall': {
      if (!showToolCalls) return null
      const call = turn.toolCalls.find((candidate) => candidate.id === part.toolCallId)
      return call ? <HermesToolCall key={`${index}:${part.toolCallId}`} call={call} showContent={showToolCallContent} /> : null
    }
  }
}

function transcriptParts(turn: HermesTurn): HermesTranscriptPart[] {
  if (turn.parts?.length) return turn.parts
  const parts: HermesTranscriptPart[] = []
  if (turn.text) parts.push({ kind: 'message', text: turn.text })
  if (turn.thoughts) parts.push({ kind: 'thought', text: turn.thoughts })
  if (turn.plan?.length) parts.push({ kind: 'plan', entries: turn.plan })
  for (const call of turn.toolCalls) parts.push({ kind: 'toolCall', toolCallId: call.id })
  return parts
}

function lineCount(value: string): number {
  const lines = value.trim().split(/\r?\n/).filter(Boolean).length
  return lines || 1
}
