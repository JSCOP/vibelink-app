import { describe, expect, test } from 'vitest'
import { turnsFromTimeline, type AgentTimelineRow } from './hermesTranscript'

const row = (partial: Partial<AgentTimelineRow> & Pick<AgentTimelineRow, 'seq' | 'role' | 'kind' | 'body'>): AgentTimelineRow => ({
  entityId: null,
  truncated: false,
  createdAt: 0,
  ...partial,
})

describe('turnsFromTimeline', () => {
  test('folds user and assistant rows into alternating turns', () => {
    const turns = turnsFromTimeline([
      row({ seq: 1, role: 'user', kind: 'message', body: '질문입니다' }),
      row({ seq: 2, role: 'assistant', kind: 'thought', body: '생각 중' }),
      row({ seq: 3, role: 'assistant', kind: 'message', body: '답변' }),
      row({ seq: 4, role: 'user', kind: 'message', body: '후속' }),
      row({ seq: 5, role: 'assistant', kind: 'message', body: '두번째 답' }),
    ])
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(turns[0].text).toBe('질문입니다')
    expect(turns[1].thoughts).toBe('생각 중')
    expect(turns[1].text).toBe('답변')
    expect(turns[3].text).toBe('두번째 답')
  })

  test('collapses tool-call rows by entity id, last patch wins', () => {
    const turns = turnsFromTimeline([
      row({ seq: 1, role: 'assistant', kind: 'toolCall', entityId: 'tc-1', body: JSON.stringify({ title: 'Edit file', toolKind: 'edit', status: 'in_progress' }) }),
      row({ seq: 2, role: 'assistant', kind: 'toolCall', entityId: 'tc-1', body: JSON.stringify({ status: 'completed', content: 'done' }) }),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].toolCalls).toHaveLength(1)
    expect(turns[0].toolCalls[0]).toMatchObject({ id: 'tc-1', title: 'Edit file', status: 'completed', content: 'done' })
  })

  test('skips permission records and renders errors as messages', () => {
    const turns = turnsFromTimeline([
      row({ seq: 1, role: 'assistant', kind: 'permission', entityId: 'perm-1', body: '{}' }),
      row({ seq: 2, role: 'system', kind: 'error', body: 'boom' }),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].text).toContain('Agent error: boom')
  })
})
