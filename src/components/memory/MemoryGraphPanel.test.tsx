// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkspaceContentActionsContext, type OpenContentRequest, type WorkspaceContentActions } from '../../layout/contentActions'
import { buildMemoryGraph } from '../../memory/memoryGraph'
import type { MemoryEntry, MemorySnapshot } from '../../ipc/memory'
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

/** Word and one-line hint for every node kind, in legend order. The panel is
 *  the only place a first-time reader learns what a dot is, so the wording is
 *  part of the contract. */
const LEGEND: [label: string, hint: string][] = [
  ['Workspace', 'A workspace'],
  ['Document', 'File or store it came from'],
  ['Entry', 'One recorded fact'],
  ['Tag', 'Shared label'],
  ['Agent', 'Agent that reads this document'],
  ['File', 'Path an entry references'],
]

/** lucide renders its icon name as a `lucide-*` class; which name maps to which
 *  kind is lucide's business, so the assertions only compare node glyph against
 *  legend glyph rather than hard-coding the six names. */
function lucideClass(element: Element): string {
  return [...element.classList].find((name) => name.startsWith('lucide-')) ?? ''
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
}))

vi.mock('../../state/store', () => ({
  useWorkspaceStore: (selector: (state: typeof mocks.store) => unknown) => selector(mocks.store),
}))

vi.mock('../../ipc/memory', () => ({
  fetchMemorySnapshot: mocks.fetchMemorySnapshot,
  addMemory: mocks.addMemory,
  removeMemory: mocks.removeMemory,
  setMemoryPinned: mocks.setMemoryPinned,
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
    await waitFor(() => expect(mocks.removeMemory).toHaveBeenCalledWith('e-stored', 'ws-1', 'workspace'))
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

  test('double-clicking a harvested document opens its file; the store document has none', async () => {
    await renderWithGraph()
    fireEvent.doubleClick(screen.getByLabelText('AGENTS.md'))
    expect(openContent).toHaveBeenCalledWith({ kind: 'editor', relPath: 'AGENTS.md' })
    openContent.mockClear()
    fireEvent.doubleClick(screen.getByLabelText('VibeLink Memory'))
    expect(openContent).not.toHaveBeenCalled()
  })

  test('selecting a node backed by a file offers an explicit open button', async () => {
    await renderWithGraph()
    selectNode('src/terminal/TerminalManager.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Open src/terminal/TerminalManager.ts' }))
    expect(openContent).toHaveBeenCalledWith({ kind: 'editor', relPath: 'src/terminal/TerminalManager.ts' })
  })

  test('the legend names every node kind with its one-line meaning', async () => {
    await renderWithGraph()
    const legend = within(screen.getByRole('group', { name: 'Node kinds' }))
    for (const [label, hint] of LEGEND) {
      expect(legend.getByTitle(hint)).toHaveTextContent(label)
    }
    const glyphs = LEGEND.map(([, hint]) => lucideClass(legend.getByTitle(hint).querySelector('svg')!))
    expect(glyphs.every((name) => name !== '')).toBe(true)
    expect(new Set(glyphs).size).toBe(LEGEND.length)
  })

  test('hiding a kind removes its nodes but keeps its legend entry', async () => {
    const { container } = await renderWithGraph()
    expect(container.querySelectorAll('circle.memory-node-tag').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Tag' }))
    await waitFor(() => expect(container.querySelectorAll('circle.memory-node-tag')).toHaveLength(0))
    expect(screen.getByTitle('Shared label')).toHaveTextContent('Tag')
    expect(screen.getByRole('button', { name: 'Tag' })).toHaveAttribute('aria-pressed', 'false')
  })

  test('a node big enough to hold one is drawn with its kind icon, matching the legend', async () => {
    const { container } = await renderWithGraph()
    const legend = within(screen.getByRole('group', { name: 'Node kinds' }))
    const icons = [...container.querySelectorAll('svg.memory-node-icon')]
    expect(icons.length).toBeGreaterThan(0)
    for (const icon of icons) {
      const kind = icon.getAttribute('data-kind')!
      const label = LEGEND.find(([word]) => word.toLowerCase() === kind)![0]
      expect(lucideClass(icon)).toBe(lucideClass(legend.getByText(label).closest('.memory-chip')!.querySelector('svg')!))
      // Sized off the circle it sits in, so it can never swamp its own node.
      expect(Number(icon.getAttribute('width'))).toBeLessThan(2 * Number(icon.getAttribute('height')))
    }
    // The busiest node in the fixture is a document, so the graph must show one.
    expect(container.querySelector('svg.memory-node-icon[data-kind="document"]')).not.toBeNull()
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
})
