import { memo } from 'react'
import type { HermesToolCallView } from '../state/hermes'

type HermesToolCallProps = {
  call: HermesToolCallView
  showContent?: boolean
}

export const HermesToolCall = memo(function HermesToolCall({ call, showContent = true }: HermesToolCallProps) {
  return (
    <details className="hermes-toolcall" open>
      <summary>
        <span>{call.title || call.toolKind || 'Tool call'}</span>
        <strong>{call.status || 'running'}{call.content ? ` · ${lineCount(call.content)} lines` : ''}</strong>
      </summary>
      {showContent && call.content ? <pre>{call.content}</pre> : null}
    </details>
  )
})

function lineCount(value: string): number {
  const lines = value.trim().split(/\r?\n/).filter(Boolean).length
  return lines || 1
}
