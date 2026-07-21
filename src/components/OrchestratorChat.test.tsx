import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { normalizeSettings, defaultSettings } from '../state/profiles'
import { useWorkspaceStore } from '../state/store'
import { OrchestratorChat } from './OrchestratorChat'
import { HermesMessage } from './HermesMessage'

const localStorageStub = {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
}

describe('OrchestratorChat', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: localStorageStub })
    useWorkspaceStore.setState({
      sessions: [{ id: 't2in-dev', name: 'T2IN-DEV', paneCount: 0, createdAt: 1, workspaceFolder: 'E:/CityAI/IncheonProject/t2in-dev' }],
      activeSessionId: 't2in-dev',
      panes: {},
      settings: normalizeSettings(defaultSettings),
      kanban: { tasks: {}, taskOrder: {} },
      orchestratorPaneIds: {},
    })
  })
  test('does not crash during render', () => {
    expect(() => renderToString(<OrchestratorChat />)).not.toThrow()
  })

  test('has no duplicate session navigator', () => {
    const html = renderToString(<OrchestratorChat />)
    expect(html).not.toContain('Search sessions')
    expect(html).not.toContain('vibelink-agent-sidebar')
    expect(html).not.toMatch(/Sessions\s+\d+\/\d+/)
  })

  test('renders assistant parts in chronological stream order', () => {
    const html = renderToString(<HermesMessage turn={{
      role: 'assistant',
      text: 'before after',
      thoughts: 'thinking',
      toolCalls: [{ id: 'tool-1', title: 'Read file', toolKind: 'read', status: 'completed', content: 'file output' }],
      parts: [
        { kind: 'message', text: 'before' },
        { kind: 'toolCall', toolCallId: 'tool-1' },
        { kind: 'message', text: 'after' },
        { kind: 'thought', text: 'thinking' },
      ],
    }} />)

    expect(html.indexOf('before')).toBeLessThan(html.indexOf('Read file'))
    expect(html.indexOf('Read file')).toBeLessThan(html.indexOf('after'))
    expect(html.indexOf('after')).toBeLessThan(html.indexOf('thinking'))
  })

  test('respects thought and tool visibility toggles', () => {
    const turn = {
      role: 'assistant' as const,
      text: '',
      thoughts: 'hidden thought',
      toolCalls: [{ id: 'tool-1', title: 'Read file', toolKind: 'read', status: 'completed', content: 'hidden output' }],
      parts: [
        { kind: 'thought' as const, text: 'hidden thought' },
        { kind: 'toolCall' as const, toolCallId: 'tool-1' },
      ],
    }

    const withoutBlocks = renderToString(<HermesMessage turn={turn} showThoughts={false} showToolCalls={false} />)
    expect(withoutBlocks).not.toContain('hidden thought')
    expect(withoutBlocks).not.toContain('Read file')

    const withoutToolContent = renderToString(<HermesMessage turn={turn} showToolCallContent={false} />)
    expect(withoutToolContent).toContain('Read file')
    expect(withoutToolContent).not.toContain('hidden output')
  })
})
