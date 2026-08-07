// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkspaceContentActionsContext, type OpenContentRequest, type WorkspaceContentActions } from '../../layout/contentActions'
import { buildMemoryGraph } from '../../memory/memoryGraph'
import type { MemoryEntry, MemoryProjectionStatus, MemorySnapshot } from '../../ipc/memory'
import type { SessionMeta } from '../../ipc/types'
import { MemoryGraphPanel } from './MemoryGraphPanel'

const session: SessionMeta = { id: 'ws-1', name: 'VibeLink', paneCount: 1, createdAt: 120, workspaceFolder: 'E:/repo' }

const storedEntry: MemoryEntry = {
  id: 'e-stored',
  scope: 'workspace',
  sessionId: 'ws-1',
  title: 'PTY decoder is one state machine',
  body: 'Terminal decoding and parsing must stay in a single state machine.',
  tags: ['terminal'],
  refs: ['src/terminal/TerminalManager.ts'],
  origin: { kind: 'agent', agentId: 'omp' },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  pinned: false,
  readers: [],
}

const harvestedEntry: MemoryEntry = {
  id: 'harvest:AGENTS.md:0',
  scope: 'workspace',
  sessionId: 'ws-1',
  title: 'Build rules',
  body: 'Run pnpm build before shipping.',
  tags: ['build'],
  refs: [],
  origin: { kind: 'harvest', sourcePath: 'AGENTS.md' },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  pinned: false,
  readers: ['codex', 'omp'],
}

const snapshot: MemorySnapshot = {
  workspaces: [{ sessionId: 'ws-1', name: 'VibeLink', workspaceFolder: 'E:/repo' }],
  entries: [storedEntry, harvestedEntry],
  truncated: false,
}

const offStatus: MemoryProjectionStatus = {
  digestPath: 'E:/repo/.vibelink/MEMORY.md',
  entryCount: 1,
  targets: [
    { id: 'digest', relativePath: '.vibelink/MEMORY.md', exists: false, enabled: false },
    { id: 'agents', relativePath: 'AGENTS.md', exists: true, enabled: false },
    { id: 'claude', relativePath: 'CLAUDE.md', exists: false, enabled: false },
  ],
}

const agentsOnStatus: MemoryProjectionStatus = {
  ...offStatus,
  targets: [
    { id: 'digest', relativePath: '.vibelink/MEMORY.md', exists: true, enabled: true },
    { id: 'agents', relativePath: 'AGENTS.md', exists: true, enabled: true },
    { id: 'claude', relativePath: 'CLAUDE.md', exists: false, enabled: false },
  ],
}

const mocks = vi.hoisted(() => ({
  store: {
    sessions: [] as SessionMeta[],
    activeSessionId: 'ws-1' as string | undefined,
  },
  fetchMemorySnapshot: vi.fn(),
  addMemory: vi.fn(),
  removeMemory: vi.fn(),
  setMemoryPinned: vi.fn(),
  fetchProjectionStatus: vi.fn(),
  setMemoryLink: vi.fn(),
}))

vi.mock('../../state/store', () => ({
  useWorkspaceStore: (selector: (state: typeof mocks.store) => unknown) => selector(mocks.store),
}))

vi.mock('../../ipc/memory', () => ({
  fetchMemorySnapshot: mocks.fetchMemorySnapshot,
  addMemory: mocks.addMemory,
  removeMemory: mocks.removeMemory,
  setMemoryPinned: mocks.setMemoryPinned,
  fetchProjectionStatus: mocks.fetchProjectionStatus,
  setMemoryLink: mocks.setMemoryLink,
}))

const openContent = vi.fn<(request: OpenContentRequest) => Promise<string>>(async () => 'panel-editor')
const actions: WorkspaceContentActions = {
  openContent,
  activateContent: vi.fn(),
  requestCloseContent: vi.fn(async () => 'closed' as const),
  splitTerminal: vi.fn(async () => undefined),
  arrangeTerminals: vi.fn(async () => undefined),
  clearTerminals: vi.fn(async () => undefined),
  toggleMaximizeContent: vi.fn(),
  toggleZoomContent: vi.fn(),
  toggleTerminalWindowTitles: vi.fn(),
  renameTerminal: vi.fn(async () => undefined),
  resetLayout: vi.fn(async () => undefined),
  getContentParams: vi.fn(() => null),
}

function renderPanel() {
  return render(
    <WorkspaceContentActionsContext.Provider value={actions}>
      <MemoryGraphPanel />
    </WorkspaceContentActionsContext.Provider>,
  )
}

async function renderWithGraph() {
  const view = renderPanel()
  const expectedNodes = buildMemoryGraph(snapshot).nodes.length
  // `.memory-node` and not bare `circle`: lucide's search glyph is an SVG circle too.
  await waitFor(() => expect(view.container.querySelectorAll('circle.memory-node')).toHaveLength(expectedNodes))
  return { ...view, expectedNodes }
}
/** Real mouse selection is a pointerdown on the circle followed by a pointerup
 *  that pointer capture retargets to the SVG — a plain `click` on the circle is
 *  never what a browser dispatches here. */
function selectNode(label: string) {
  const circle = screen.getByLabelText(label)
  fireEvent.pointerDown(circle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
  fireEvent.pointerUp(circle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
}

describe('MemoryGraphPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.store.sessions = [session]
    mocks.store.activeSessionId = 'ws-1'
    mocks.fetchMemorySnapshot.mockResolvedValue(snapshot)
    mocks.fetchProjectionStatus.mockResolvedValue(offStatus)
    mocks.setMemoryLink.mockResolvedValue(agentsOnStatus)
    mocks.removeMemory.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
  })

  test('renders one circle per graph node and queries only the active workspace by default', async () => {
    const { expectedNodes } = await renderWithGraph()
    expect(expectedNodes).toBeGreaterThan(1)
    expect(mocks.fetchMemorySnapshot).toHaveBeenCalledWith([{ sessionId: 'ws-1', name: 'VibeLink', workspaceFolder: 'E:/repo' }])
  })

  test('search narrows the rendered node count', async () => {
    const { container, expectedNodes } = await renderWithGraph()
    fireEvent.change(screen.getByLabelText('Search memory'), { target: { value: 'terminal' } })
    await waitFor(() => expect(container.querySelectorAll('circle.memory-node').length).toBeLessThan(expectedNodes))
    expect(container.querySelectorAll('circle.memory-node').length).toBeGreaterThan(0)
  })

  test('clicking a node lists its entries in the detail sidebar', async () => {
    await renderWithGraph()
    selectNode('VibeLink Memory')
    const sidebar = screen.getByLabelText('Memory details')
    expect(sidebar).toHaveTextContent('PTY decoder is one state machine')
    expect(sidebar).toHaveTextContent('terminal')
  })

  test('deleting an entry calls removeMemory with its id and scope', async () => {
    await renderWithGraph()
    selectNode('PTY decoder is one state machine')
    fireEvent.click(screen.getByLabelText('Delete PTY decoder is one state machine'))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))
    await waitFor(() => expect(mocks.removeMemory).toHaveBeenCalledWith('e-stored', 'ws-1', 'workspace', 'E:/repo'))
  })

  test('a harvested entry is read-only: no delete, opens its source file instead', async () => {
    await renderWithGraph()
    selectNode('Build rules')
    const sidebar = screen.getByLabelText('Memory details')
    expect(sidebar).toHaveTextContent('Read-only · AGENTS.md')
    expect(screen.queryByLabelText('Delete Build rules')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }))
    expect(openContent).toHaveBeenCalledWith({ kind: 'editor', relPath: 'AGENTS.md' })
  })

  test('the sync popover renders one switch per target and disables missing files', async () => {
    await renderWithGraph()
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }))
    const popover = within(screen.getByRole('dialog', { name: 'Memory sync targets' }))
    await waitFor(() => expect(popover.getAllByRole('switch')).toHaveLength(3))
    expect(mocks.fetchProjectionStatus).toHaveBeenCalledWith('ws-1', 'E:/repo')
    expect(popover.getByLabelText('CLAUDE.md')).toBeDisabled()
    expect(popover.getByLabelText('AGENTS.md')).toBeEnabled()
  })

  test('toggling AGENTS.md links the target and re-renders from the returned status', async () => {
    await renderWithGraph()
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }))
    const popover = within(screen.getByRole('dialog', { name: 'Memory sync targets' }))
    await waitFor(() => expect(popover.getByLabelText('AGENTS.md')).not.toBeChecked())
    fireEvent.click(popover.getByLabelText('AGENTS.md'))
    await waitFor(() => expect(mocks.setMemoryLink).toHaveBeenCalledWith('ws-1', 'E:/repo', 'agents', true))
    // The invariant "enabling a target enables the digest" is server-owned; the
    // panel must show it purely by adopting the returned status.
    await waitFor(() => expect(popover.getByLabelText('AGENTS.md')).toBeChecked())
    expect(popover.getByLabelText('.vibelink/MEMORY.md')).toBeChecked()
  })

  test('a snapshot failure shows the error with a retry that refetches', async () => {
    mocks.fetchMemorySnapshot.mockRejectedValueOnce(new Error('daemon offline'))
    renderPanel()
    await waitFor(() => expect(screen.getByText(/daemon offline/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByLabelText('Memory graph')).toBeInTheDocument())
  })

  test('an empty snapshot guides the user to the record command', async () => {
    mocks.fetchMemorySnapshot.mockResolvedValue({ workspaces: snapshot.workspaces, entries: [], truncated: false })
    renderPanel()
    await waitFor(() => expect(screen.getByText(/vibelink memory add --title/)).toBeInTheDocument())
  })

  test('the truncation notice appears only when the snapshot was capped', async () => {
    mocks.fetchMemorySnapshot.mockResolvedValue({ ...snapshot, truncated: true })
    renderPanel()
    await waitFor(() => expect(screen.getByText('Showing the 1500 most recent entries.')).toBeInTheDocument())
  })

  test('the all-workspaces scope queries every session', async () => {
    mocks.store.sessions = [session, { id: 'ws-2', name: 'Other', paneCount: 0, createdAt: 121, workspaceFolder: null }]
    await renderWithGraph()
    fireEvent.change(screen.getByLabelText('Memory scope'), { target: { value: 'all' } })
    await waitFor(() => expect(mocks.fetchMemorySnapshot).toHaveBeenLastCalledWith([
      { sessionId: 'ws-1', name: 'VibeLink', workspaceFolder: 'E:/repo' },
      { sessionId: 'ws-2', name: 'Other', workspaceFolder: null },
    ]))
  })

  test('the sync button is hidden for a workspace without a folder', async () => {
    mocks.store.sessions = [{ ...session, workspaceFolder: null }]
    await renderWithGraph()
    expect(screen.queryByRole('button', { name: 'Sync' })).toBeNull()
  })
})
