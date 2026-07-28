import { describe, expect, test } from 'vitest'
import type { AgentConversationInfo } from '../../ipc/agentHistory'
import type { PaneMeta } from '../../ipc/types'
import {
  agentConversationPaneIds,
  agentResumeLaunch,
  formatAgentSessionUpdatedAt,
  visibleAgentConversations,
} from './agentSessionsModel'

const ompConversation: AgentConversationInfo = {
  id: 'omp-1',
  title: 'Fix renderer',
  agent: 'omp',
  updatedAt: '2026-07-22T12:00:00.000Z',
  cwd: 'E:/repo/src',
  path: 'E:/repo/.omp/agent/sessions/omp-1.jsonl',
}

function pane(id: string, args: string[], alive = true): PaneMeta {
  return {
    id,
    alive,
    config: {
      paneId: id,
      shell: 'pwsh.exe',
      args,
      cwd: 'E:/repo',
      env: [],
      title: id,
      cols: 120,
      rows: 32,
    },
  }
}

describe('Agent session model', () => {
  test('searches conversation title, agent, and cwd', () => {
    const conversations = [
      ompConversation,
      { ...ompConversation, id: 'claude-1', title: 'Write docs', agent: 'claude', cwd: 'D:/docs' },
    ]
    expect(visibleAgentConversations(conversations, 'renderer')).toEqual([ompConversation])
    expect(visibleAgentConversations(conversations, 'claude')).toHaveLength(1)
    expect(visibleAgentConversations(conversations, 'repo/src')).toEqual([ompConversation])
  })


  test('formats recent conversation timestamps', () => {
    const updatedAt = Date.parse('2026-07-22T12:00:00.000Z')
    expect(formatAgentSessionUpdatedAt(ompConversation.updatedAt, updatedAt + 120_000)).toBe('2m ago')
    expect(formatAgentSessionUpdatedAt(null, updatedAt)).toBe('Time unavailable')
  })

  test('matches only live panes launched for the same conversation', () => {
    const launch = agentResumeLaunch(ompConversation)
    expect(launch).toMatchObject({ shell: 'pwsh.exe', title: 'Oh My Pi: Fix renderer' })
    expect(agentConversationPaneIds(ompConversation, [
      pane('matching', launch?.args ?? []),
      pane('dead', launch?.args ?? [], false),
      pane('other', ['-NoLogo', '-NoExit', '-Command', 'omp -r other']),
    ])).toEqual(['matching'])
  })
})
