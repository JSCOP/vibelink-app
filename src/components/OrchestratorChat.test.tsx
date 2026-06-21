import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { normalizeSettings, defaultSettings } from '../state/profiles'
import { useWorkspaceStore } from '../state/store'
import { OrchestratorChat } from './OrchestratorChat'

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
})
