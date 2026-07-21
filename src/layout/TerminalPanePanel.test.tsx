import { renderToStaticMarkup } from 'react-dom/server'
import type { IDockviewPanelProps } from 'dockview-react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkspaceContentActionsContext, type WorkspaceContentActions } from './contentActions'
import { TerminalPanePanel } from './TerminalPanePanel'

const mockStore = vi.hoisted(() => ({
  activePaneId: undefined as string | undefined,
  reviewedPaneId: undefined as string | undefined,
}))

vi.mock('../state/store', () => ({
  useWorkspaceStore: (selector: (state: {
    activeSessionId: string
    activePaneId?: string
    panes: Record<string, unknown>
    applyTerminalTitle: () => Promise<void>
    paneCompletionHighlights: Record<string, unknown>
    paneReviewMarkers: Record<string, unknown>
    license: { ready: boolean; status: null }
    settings: { paneRoles: Record<string, string>; hermesCommand: string }
    setError: () => void
    sendAgentPrompt: () => Promise<void>
  }) => unknown) => selector({
    activeSessionId: 'session-1',
    activePaneId: mockStore.activePaneId,
    panes: {},
    applyTerminalTitle: async () => undefined,
    paneCompletionHighlights: {},
    paneReviewMarkers: mockStore.reviewedPaneId ? { [mockStore.reviewedPaneId]: {} } : {},
    license: { ready: true, status: null },
    settings: { paneRoles: {}, hermesCommand: '' },
    setError: () => undefined,
    sendAgentPrompt: async () => undefined,
  }),
}))

vi.mock('../terminal/TerminalManager', () => ({
  TerminalManager: {},
}))

const actions: WorkspaceContentActions = {
  openContent: vi.fn(async () => ''),
  activateContent: vi.fn(),
  requestCloseContent: vi.fn(async () => 'closed' as const),
  splitTerminal: vi.fn(async () => undefined),
  arrangeTerminals: vi.fn(async () => undefined),
  clearTerminals: vi.fn(async () => undefined),
  toggleMaximizeContent: vi.fn(),
  renameTerminal: vi.fn(async () => undefined),
  resetLayout: vi.fn(async () => undefined),
  getContentParams: vi.fn(() => null),
}

function renderTerminalPane(paneId: string) {
  const props = {
    api: {},
    containerApi: {},
    params: { schema: 1, kind: 'terminal', instanceId: paneId, paneId, title: 'Shell', icon: 'terminal' },
  } as unknown as IDockviewPanelProps<{ schema: 1; kind: 'terminal'; instanceId: string; paneId: string; title: string; icon: string }>

  return renderToStaticMarkup(
    <WorkspaceContentActionsContext.Provider value={actions}>
      <TerminalPanePanel {...props} />
    </WorkspaceContentActionsContext.Provider>,
  )
}

describe('TerminalPanePanel', () => {
  beforeEach(() => {
    mockStore.activePaneId = undefined
    mockStore.reviewedPaneId = undefined
  })

  test('marks only the selected terminal pane as active', () => {
    mockStore.activePaneId = 'pane-active'

    const activePane = renderTerminalPane('pane-active')
    const inactivePane = renderTerminalPane('pane-inactive')

    expect(activePane).toContain('class="terminal-panel-shell" data-pane-id="pane-active" data-active="true"')
    expect(inactivePane).toContain('class="terminal-panel-shell" data-pane-id="pane-inactive"')
    expect(inactivePane).not.toContain('data-active=')
  })

  test('marks reviewed terminal panes independently from selection', () => {
    mockStore.reviewedPaneId = 'pane-reviewed'

    const reviewedPane = renderTerminalPane('pane-reviewed')

    expect(reviewedPane).toContain('data-pane-reviewed="true"')
    expect(reviewedPane).not.toContain('data-active=')
  })
})
