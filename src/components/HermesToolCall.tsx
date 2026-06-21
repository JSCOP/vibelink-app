import type { HermesToolCallView } from '../state/hermes'

type HermesToolCallProps = {
  call: HermesToolCallView
}

export function HermesToolCall({ call }: HermesToolCallProps) {
  return (
    <details className="hermes-toolcall" open>
      <summary>
        <span>{call.title || call.toolKind || 'Tool call'}</span>
        <strong>{call.status || 'running'}</strong>
      </summary>
      {call.content ? <pre>{call.content}</pre> : null}
    </details>
  )
}
