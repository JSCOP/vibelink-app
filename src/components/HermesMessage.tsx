import type { HermesTurn } from '../state/hermes'
import { HermesToolCall } from './HermesToolCall'

type HermesMessageProps = {
  turn: HermesTurn
}

export function HermesMessage({ turn }: HermesMessageProps) {
  return (
    <article className={`hermes-message hermes-message-${turn.role}`}>
      <div className="hermes-message-role">{turn.role}</div>
      {turn.thoughts ? (
        <details className="hermes-thought" open>
          <summary>Thoughts</summary>
          <pre>{turn.thoughts}</pre>
        </details>
      ) : null}
      {turn.text ? <div className="hermes-message-text">{turn.text}</div> : null}
      {turn.plan?.length ? (
        <ol className="hermes-plan">
          {turn.plan.map((entry, index) => <li key={`${index}:${entry.content}`} data-status={entry.status}>{entry.content}</li>)}
        </ol>
      ) : null}
      {turn.toolCalls.map((call) => <HermesToolCall key={call.id} call={call} />)}
    </article>
  )
}
