import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { PaneMeta } from '../ipc/types'
import { defaultSettings, normalizeSettings } from './profiles'
import { useWorkspaceStore } from './store'

const spawnedPane: PaneMeta = {
  id: 'pane-test',
  config: {
    paneId: 'pane-test',
    shell: 'codex.cmd',
    args: ['--dangerously-bypass-approvals-and-sandbox'],
    cwd: 'E:/work',
    env: [['TERM_PROGRAM', 'AgenticWorkspaceTerminal']],
    title: 'Codex',
    cols: 120,
    rows: 32,
  },
  alive: true,
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === 'spawn_pane') return spawnedPane
    if (command === 'list_sessions') return []
    return null
  }),
}))

describe('workspace store profiles', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear()
    useWorkspaceStore.setState({
      sessions: [],
      activeSessionId: undefined,
      panes: {},
      manualPaneTitles: {},
      layoutJson: null,
      status: 'ready',
      error: undefined,
      settings: normalizeSettings({
        ...defaultSettings,
        defaultProfileId: 'agent',
        profiles: [
          {
            id: 'agent',
            name: 'Codex',
            shell: 'codex.cmd',
            args: ['--dangerously-bypass-approvals-and-sandbox'],
            env: [['TERM_PROGRAM', 'AgenticWorkspaceTerminal']],
            cwd: 'E:/work',
            color: '#7ee787',
            icon: 'sparkles',
          },
        ],
      }),
    })
  })

  test('spawnPane uses the selected profile when no pane overrides are supplied', async () => {
    await useWorkspaceStore.getState().spawnPane('session-1', { paneId: 'pane-test' })

    expect(invoke).toHaveBeenNthCalledWith(1, 'spawn_pane', {
      sessionId: 'session-1',
      cfg: {
        paneId: 'pane-test',
        shell: 'codex.cmd',
        args: ['--dangerously-bypass-approvals-and-sandbox'],
        cwd: 'E:/work',
        env: [['TERM_PROGRAM', 'AgenticWorkspaceTerminal']],
        title: 'Codex',
        cols: 120,
        rows: 32,
      },
    })
  })

  test('renamePaneTitle persists a manual title and updates local pane metadata', async () => {
    useWorkspaceStore.setState({ panes: { 'pane-test': spawnedPane } })

    await useWorkspaceStore.getState().renamePaneTitle('pane-test', 'Manual Codex', 'manual')

    expect(invoke).toHaveBeenCalledWith('set_pane_title', { paneId: 'pane-test', title: 'Manual Codex' })
    expect(useWorkspaceStore.getState().panes['pane-test'].config.title).toBe('Manual Codex')
  })

  test('applyTerminalTitle does not overwrite manual pane titles', async () => {
    useWorkspaceStore.setState({ panes: { 'pane-test': spawnedPane } })
    await useWorkspaceStore.getState().renamePaneTitle('pane-test', 'Manual Codex', 'manual')

    await useWorkspaceStore.getState().applyTerminalTitle('pane-test', 'Codex: auto task')

    expect(useWorkspaceStore.getState().panes['pane-test'].config.title).toBe('Manual Codex')
  })
})
