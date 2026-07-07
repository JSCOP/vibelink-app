import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { defaultSettings, normalizeSettings } from '../state/profiles'
import { useWorkspaceStore } from '../state/store'
import { ResourceMonitorDialog } from './ResourceMonitorDialog'

const localStorageStub = {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
}

describe('ResourceMonitorDialog', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: localStorageStub })
    useWorkspaceStore.setState({
      sessions: [{ id: 'session-1', name: 'Workspace', paneCount: 0, createdAt: 1, workspaceFolder: null }],
      activeSessionId: 'session-1',
      panes: {},
      manualPaneTitles: {},
      layoutJson: null,
      status: 'ready',
      error: undefined,
      settings: normalizeSettings(defaultSettings),
      kanban: { tasks: {}, taskOrder: {} },
      selectedTaskId: {},
    })
  })

  test('renders monitor actions before a snapshot is loaded', () => {
    const html = renderToString(
      <ResourceMonitorDialog
        onClose={() => undefined}
        onStopWorkspaceTerminals={() => undefined}
        onAfterRestart={() => undefined}
      />,
    )

    expect(html).toContain('Terminal process memory')
    expect(html).toContain('Stop workspace terminals')
    expect(html).toContain('Restart daemon')
    expect(html).toContain('Loading')
  })
})
