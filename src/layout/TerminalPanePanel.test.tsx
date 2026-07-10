import { renderToStaticMarkup } from 'react-dom/server'
import type { IDockviewPanelProps } from 'dockview-react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkspaceActionsContext, type WorkspaceActions } from './actions'
import { TerminalPanePanel } from './TerminalPanePanel'

const mockStore = vi.hoisted(() => ({
  activePaneId: undefined as string | undefined,
}))

vi.mock('../state/store', () => ({
  useWorkspaceStore: (selector: (state: {
    activeSessionId: string
    activePaneId?: string
    panes: Record<string, unknown>
    applyTerminalTitle: () => Promise<void>
    paneCompletionHighlights: Record<string, unknown>
  }) => unknown) => selector({
    activeSessionId: 'session-1',
    activePaneId: mockStore.activePaneId,
    panes: {},
    applyTerminalTitle: async () => undefined,
    paneCompletionHighlights: {},
  }),
}))

vi.mock('../terminal/TerminalManager', () => ({
  TerminalManager: {},
}))

const actions: WorkspaceActions = {
  activatePane: vi.fn(),
  splitPane: vi.fn(async () => undefined),
  closePane: vi.fn(async () => undefined),
  toggleMaximize: vi.fn(),
  renamePaneTitle: vi.fn(async () => undefined),
  swapPaneLocations: vi.fn(async () => undefined),
  movePaneToPosition: vi.fn(async () => undefined),
}

function renderTerminalPane(paneId: string) {
  const props = {
    api: {},
    containerApi: {},
    params: { paneId },
  } as unknown as IDockviewPanelProps<{ paneId: string }>

  return renderToStaticMarkup(
    <WorkspaceActionsContext.Provider value={actions}>
      <TerminalPanePanel {...props} />
    </WorkspaceActionsContext.Provider>,
  )
}

describe('TerminalPanePanel', () => {
  beforeEach(() => {
    mockStore.activePaneId = undefined
  })

  test('marks only the selected terminal pane as active', () => {
    mockStore.activePaneId = 'pane-active'

    const activePane = renderTerminalPane('pane-active')
    const inactivePane = renderTerminalPane('pane-inactive')

    expect(activePane).toContain('class="terminal-panel-shell" data-pane-id="pane-active" data-active="true"')
    expect(inactivePane).toContain('class="terminal-panel-shell" data-pane-id="pane-inactive"')
    expect(inactivePane).not.toContain('data-active=')
  })
})
