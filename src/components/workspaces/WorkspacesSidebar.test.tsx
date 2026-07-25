// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: {
    sessions: [
      { id: 'alpha', name: 'Alpha', paneCount: 2, createdAt: 1, workspaceFolder: 'E:/repos/alpha' },
      { id: 'beta', name: 'Beta', paneCount: 1, createdAt: 2, workspaceFolder: 'E:/repos/beta' },
      { id: 'gamma', name: 'Gamma', paneCount: 3, createdAt: 3, workspaceFolder: 'E:/repos/gamma' },
      { id: 'delta', name: 'Delta', paneCount: 1, createdAt: 4, workspaceFolder: null },
    ],
    activeSessionId: 'gamma',
    paneCompletionHighlights: {} as Record<string, { sessionId: string }>,
    settings: {
      workspaceGroups: [
        { id: 'core', name: 'Core', collapsed: false },
        { id: 'tools', name: 'Tools', collapsed: false },
      ],
      workspaceGroupIds: { alpha: 'tools', beta: 'core', gamma: 'core' } as Record<string, string>,
      workspaceOrder: ['gamma', 'alpha', 'delta', 'beta'],
    },
    openSession: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
    reorderWorkspaces: vi.fn(),
    renameWorkspaceGroup: vi.fn(),
    deleteWorkspaceGroup: vi.fn(),
    setWorkspaceGroup: vi.fn(),
    toggleWorkspaceGroupCollapsed: vi.fn(),
    setError: vi.fn(),
  },
}))

vi.mock('../../state/store', () => ({
  useWorkspaceStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
  paneCompletionCountsBySession: (highlights: Record<string, { sessionId: string }>) => {
    const counts: Record<string, number> = {}
    for (const highlight of Object.values(highlights)) counts[highlight.sessionId] = (counts[highlight.sessionId] ?? 0) + 1
    return counts
  },
}))

import { WorkspacesSidebar } from './WorkspacesSidebar'

const integration = {
  onCreateWorkspaceRequested: vi.fn(),
  onImportReposRequested: vi.fn(),
  onDeleteWorkspaceRequested: vi.fn(),
}

function renderSidebar() {
  return render(<WorkspacesSidebar integration={integration} />)
}

describe('WorkspacesSidebar', () => {
  beforeEach(() => {
    mocks.state.settings.workspaceGroups = [
      { id: 'core', name: 'Core', collapsed: false },
      { id: 'tools', name: 'Tools', collapsed: false },
    ]
    mocks.state.paneCompletionHighlights = {}
    vi.clearAllMocks()
  })

  afterEach(cleanup)

  test('numbers workspaces from the flattened group order and labels the first nine shortcuts', () => {
    renderSidebar()

    const ordered = [
      ['Gamma', 'Ctrl+1', '1'],
      ['Beta', 'Ctrl+2', '2'],
      ['Alpha', 'Ctrl+3', '3'],
      ['Delta', 'Ctrl+4', '4'],
    ] as const
    for (const [name, shortcut, number] of ordered) {
      const row = screen.getByText(name).closest('[data-session-id]') as HTMLElement
      expect(within(row).getByTitle(shortcut)).toHaveTextContent(number)
    }
  })

  test('marks a workspace row and badge with its AI completion count', () => {
    mocks.state.paneCompletionHighlights = {
      'pane-beta-1': { sessionId: 'beta' },
      'pane-beta-2': { sessionId: 'beta' },
    }
    renderSidebar()

    const row = screen.getByText('Beta').closest('[data-session-id]') as HTMLElement
    expect(row).toHaveClass('session-row', 'has-completions')
    expect(row).toHaveAttribute('data-completion-count', '2')
    expect(within(row).getByLabelText('2 AI coding agent panes need attention')).toHaveTextContent('2')
  })

  test('nests group members and hides them when the group is collapsed', () => {
    const view = renderSidebar()

    let coreGroup = screen.getByText('Core').closest('.workspaces-group') as HTMLElement
    expect(within(coreGroup).getByText('Gamma')).toBeInTheDocument()
    expect(within(coreGroup).getByText('Beta')).toBeInTheDocument()
    expect(within(coreGroup).queryByText('Delta')).not.toBeInTheDocument()

    mocks.state.settings.workspaceGroups = [
      { id: 'core', name: 'Core', collapsed: true },
      { id: 'tools', name: 'Tools', collapsed: false },
    ]
    view.rerender(<WorkspacesSidebar integration={integration} />)

    coreGroup = screen.getByText('Core').closest('.workspaces-group') as HTMLElement
    expect(within(coreGroup).queryByText('Gamma')).not.toBeInTheDocument()
    expect(within(coreGroup).queryByText('Beta')).not.toBeInTheDocument()
    expect(screen.getByText('Delta')).toBeInTheDocument()
  })
})
