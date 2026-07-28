import { describe, expect, test } from 'vitest'
import type { HermesSessionInfo } from '../../state/hermes'
import {
  agentSessionIsUnread,
  agentSessionLiveState,
  compactAgentSessionCwd,
  loadAgentSessionViews,
  saveAgentSessionViews,
  visibleAgentSessions,
} from './agentSessionsModel'

const sessions: HermesSessionInfo[] = [
  { id: 'null-time', title: 'No timestamp', updatedAt: null, cwd: 'E:/repo' },
  { id: 'newer', title: 'Fix renderer', updatedAt: '2026-07-22T12:00:00.000Z', cwd: 'E:/repo/src' },
  { id: 'older', title: null, updatedAt: '2026-07-21T12:00:00.000Z', cwd: 'D:/other' },
]

describe('Agent session model', () => {
  test('sorts newest first with null timestamps last and searches title, ID, and cwd', () => {
    expect(visibleAgentSessions(sessions, '').map((session) => session.id)).toEqual(['newer', 'older', 'null-time'])
    expect(visibleAgentSessions(sessions, 'renderer').map((session) => session.id)).toEqual(['newer'])
    expect(visibleAgentSessions(sessions, 'older').map((session) => session.id)).toEqual(['older'])
    expect(visibleAgentSessions(sessions, 'repo/src').map((session) => session.id)).toEqual(['newer'])
  })

  test('permission waiting state takes precedence over busy work', () => {
    expect(agentSessionLiveState('busy', [{ requestId: 1, generation: 1, title: 'Write file', toolKind: 'edit', options: [] }])).toEqual({
      label: 'Waiting for input',
      tone: 'waiting',
      pulse: false,
    })
    expect(agentSessionLiveState('starting', [])).toEqual({ label: 'Working', tone: 'working', pulse: true })
    expect(agentSessionLiveState('running', [])).toEqual({ label: 'Idle', tone: 'idle', pulse: false })
    expect(agentSessionLiveState('error', [])).toEqual({ label: 'Error', tone: 'error', pulse: false })
    expect(agentSessionLiveState('idle', [])).toEqual({ label: 'Stopped', tone: 'stopped', pulse: false })
  })

  test('persists versioned viewed timestamps by workspace and session', () => {
    let stored = ''
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => { stored = value },
    }
    const views = { workspace: { newer: 42 } }
    saveAgentSessionViews(storage, views)
    expect(JSON.parse(stored)).toEqual({ version: 1, workspaces: views })
    expect(loadAgentSessionViews(storage)).toEqual(views)
    expect(agentSessionIsUnread(sessions[1], Date.parse('2026-07-22T11:00:00.000Z'))).toBe(true)
    expect(agentSessionIsUnread(sessions[1], Date.parse('2026-07-22T13:00:00.000Z'))).toBe(false)
  })

  test('compacts workspace-relative folders without discarding external context', () => {
    expect(compactAgentSessionCwd('E:\\repo', 'E:/repo')).toBe('.')
    expect(compactAgentSessionCwd('E:/repo/src/components', 'E:/repo')).toBe('./src/components')
    expect(compactAgentSessionCwd('D:/other/project', 'E:/repo')).toBe('…/other/project')
  })
})
