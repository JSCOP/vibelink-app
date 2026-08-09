// @vitest-environment jsdom
import { Profiler } from 'react'
import { renderToString } from 'react-dom/server'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { PaneMeta, Task } from '../ipc/types'
import { normalizeSettings, defaultSettings } from '../state/profiles'
import { useWorkspaceStore } from '../state/store'
import { OrchestratorChat } from './OrchestratorChat'
import { HermesMessage } from './HermesMessage'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: class Channel {} }))
vi.mock('../terminal/TerminalManager', () => ({
  TerminalManager: { getRecentOutput: (paneId: string) => `digest terminal line for ${paneId}` },
}))

const digestPrompts: string[] = []
const sendAgentPrompt = vi.fn(async (sessionId: string, text: string) => { digestPrompts.push(`${sessionId}|${text}`) })

describe('OrchestratorChat', () => {
  afterEach(cleanup)
  beforeEach(() => {
    digestPrompts.length = 0
    sendAgentPrompt.mockClear()
    invoke.mockReset()
    invoke.mockImplementation(async (command: string) => {
      if (command === 'hermes_runtime_status') return { detected: true, command: 'hermes-acp', cliCommand: 'hermes', version: '1.0.0', home: 'C:/hermes', source: 'path', configuredModel: 'gpt' }
      if (command === 'hermes_cli_command') return 'hermes'
      if (command === 'hermes_workspace_state') return { home: 'C:/hermes', workspaceFolder: 'E:/CityAI/IncheonProject/t2in-dev', model: { provider: 'openai', model: 'gpt' } }
      return null
    })
    window.localStorage.clear()
    useWorkspaceStore.setState({
      sessions: [{ id: 't2in-dev', name: 'T2IN-DEV', paneCount: 0, createdAt: 1, workspaceFolder: 'E:/CityAI/IncheonProject/t2in-dev' }],
      activeSessionId: 't2in-dev',
      panes: {},
      settings: normalizeSettings(defaultSettings),
      kanban: { tasks: {}, taskOrder: {} },
      workspaceBriefs: {},
      hermesTranscript: {},
      orchestratorPaneIds: {},
      sendAgentPrompt,
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

  test('pane and Kanban churn never re-renders the chat, and Digest still reads the newest state', async () => {
    let renders = 0
    render(
      <Profiler id="orchestrator-chat" onRender={() => { renders += 1 }}>
        <OrchestratorChat />
      </Profiler>,
    )
    const digest = await screen.findByRole('button', { name: 'Ask VibeLink Agent for a workspace progress digest' })
    await act(async () => {
      const settled = Promise.withResolvers<void>()
      setTimeout(settled.resolve, 5)
      await settled.promise
    })
    const rendersAfterMount = renders
    expect(rendersAfterMount).toBeGreaterThan(0)

    const pane: PaneMeta = {
      id: 'pane-1',
      alive: true,
      config: { paneId: 'pane-1', args: [], env: [], title: 'renamed pane', cols: 80, rows: 24 },
    }
    const task: Task = {
      id: 'task-1',
      sessionId: 't2in-dev',
      title: 'Ship digest fix',
      description: '',
      status: 'pending',
      statusTimestamps: {},
      createdAt: 1,
      updatedAt: 1,
    }
    act(() => { useWorkspaceStore.setState({ panes: { 'pane-1': pane } }) })
    act(() => { useWorkspaceStore.setState({ kanban: { tasks: { 'task-1': task }, taskOrder: { 't2in-dev': ['task-1'] } } }) })
    act(() => { useWorkspaceStore.setState({ workspaceBriefs: { 't2in-dev': { purpose: 'Cut render churn', notes: 'none', updatedAt: '1' } } }) })

    expect(renders).toBe(rendersAfterMount)

    fireEvent.click(digest)
    await waitFor(() => expect(sendAgentPrompt).toHaveBeenCalledTimes(1))
    const prompt = digestPrompts[0]
    expect(prompt).toContain('### renamed pane')
    expect(prompt).toContain('digest terminal line for pane-1')
    expect(prompt).toContain('Ship digest fix')
    expect(prompt).toContain('Purpose: Cut render churn')
  })
})
