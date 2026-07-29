// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import { WorkspaceContentActionsContext, type OpenContentRequest, type WorkspaceContentActions } from '../../layout/contentActions'
import { clearOpenContentSnapshot, publishOpenContentSnapshot } from '../../layout/openContentRegistry'
import { workspaceContentPanelId } from '../../layout/workspaceContentModel'
import type { PaneMeta } from '../../ipc/types'
import { agentResumeLaunch, readAgentSessionDragPayload } from './agentSessionsModel'
import { AgentSessionsSidebar } from './AgentSessionsSidebar'

const conversation = {
  id: 'omp-1',
  title: 'Resumable omp',
  agent: 'omp',
  updatedAt: '2026-07-22T09:00:00.000Z',
  cwd: 'E:/repo',
  path: 'E:/repo/.omp/agent/sessions/x.jsonl',
}

const mocks = vi.hoisted(() => ({
  controller: {
    workspaceId: 'workspace-a' as string | null,
    workspaceName: 'Workspace A',
    workspaceFolder: 'E:/repo' as string | null,
    commandOverride: null,
    status: 'running' as 'idle' | 'starting' | 'running' | 'busy' | 'error',
    error: null as string | null,
    currentSessionId: 'current-acp' as string | null,
    sessions: [{ id: 'current-acp', title: 'VIBELINK_ACP_OK', updatedAt: '2026-07-22T10:00:00.000Z', cwd: 'E:/repo' }],
    permissions: [],
    conversations: [] as Array<{ id: string; title: string; agent: string; updatedAt: string | null; cwd: string | null; path: string }>,
    conversationsLoading: false,
    actionsDisabled: false,
    refreshConversations: vi.fn(async () => undefined),
    refreshSessions: vi.fn(async () => true),
    newSession: vi.fn(async () => 'new-acp'),
    resumeSession: vi.fn(async () => true),
  },
  store: {
    setError: vi.fn(),
    activePaneId: undefined as string | undefined,
    panes: {} as Record<string, PaneMeta>,
  },
}))
vi.mock('../../state/store', () => ({
  useWorkspaceStore: (selector: (state: typeof mocks.store) => unknown) => selector(mocks.store),
}))
vi.mock('./useHermesSessionController', () => ({
  useHermesSessionController: () => mocks.controller,
}))

vi.mock('../WorkspaceSidebarPanelShell', () => ({
  WorkspaceSidebarPanelShell: ({ title, actions, filter, children }: { title: string; actions?: React.ReactNode; filter?: React.ReactNode; children: React.ReactNode }) => (
    <section aria-label={title}>
      <header><h2>{title}</h2>{actions}</header>
      {filter}
      <main>{children}</main>
    </section>
  ),
}))

const openContent = vi.fn<(request: OpenContentRequest) => Promise<string>>(async () => workspaceContentPanelId({ kind: 'terminal', instanceId: 'pane-selected' }))
const activateContent = vi.fn()
const actions: WorkspaceContentActions = {
  openContent,
  activateContent,
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

function pane(id: string, args: string[]): PaneMeta {
  return {
    id,
    alive: true,
    config: { paneId: id, shell: 'pwsh.exe', args, cwd: 'E:/repo', env: [], title: id, cols: 120, rows: 32 },
  }
}

function renderSidebar() {
  return render(
    <WorkspaceContentActionsContext.Provider value={actions}>
      <AgentSessionsSidebar />
    </WorkspaceContentActionsContext.Provider>,
  )
}

describe('AgentSessionsSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearOpenContentSnapshot()
    mocks.controller.conversations = [conversation]
    mocks.controller.conversationsLoading = false
    openContent.mockResolvedValue(workspaceContentPanelId({ kind: 'terminal', instanceId: 'pane-selected' }))
    mocks.store.activePaneId = undefined
    mocks.store.panes = {}
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  })

  afterEach(() => {
    cleanup()
    clearOpenContentSnapshot()
    vi.unstubAllGlobals()
  })

  test('shows only terminal conversation history, not raw Hermes ACP sessions or details', async () => {
    mocks.controller.conversations = [
      conversation,
      { ...conversation, id: 'omp-2', title: 'Automation UI', path: 'E:/repo/.omp/agent/sessions/y.jsonl' },
    ]
    renderSidebar()

    expect(screen.queryByText('VIBELINK_ACP_OK')).not.toBeInTheDocument()
    expect(screen.queryByText('Live sessions')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New agent session' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('2 shown of 2 conversations')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search agent sessions' }), { target: { value: 'Automation' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh agent sessions' }))
    await waitFor(() => expect(mocks.controller.refreshConversations).toHaveBeenCalledTimes(1))
    expect(mocks.controller.refreshSessions).not.toHaveBeenCalled()
  })

  test('resumes a closed conversation in a fresh terminal beside the active pane', async () => {
    mocks.store.activePaneId = 'pane-selected'
    mocks.store.panes = { 'pane-selected': pane('pane-selected', ['pwsh']) }
    openContent.mockResolvedValueOnce(workspaceContentPanelId({ kind: 'terminal', instanceId: 'pane-resumed' }))
    renderSidebar()

    fireEvent.click(screen.getByText('Resumable omp').closest('button') as HTMLButtonElement)

    await waitFor(() => expect(openContent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'terminal', referencePaneId: 'pane-selected', shell: 'pwsh.exe',
    })))
    expect(openContent.mock.calls.at(-1)?.[0]).not.toHaveProperty('newWindow')
    expect(openContent.mock.calls.at(-1)?.[0]).not.toHaveProperty('replacePaneId')
    expect(activateContent).toHaveBeenCalledWith(workspaceContentPanelId({ kind: 'terminal', instanceId: 'pane-resumed' }))
    expect(mocks.store.panes['pane-selected']?.alive).toBe(true)
  })

  test('drags a closed conversation with its agent icon and resume launch data', () => {
    renderSidebar()
    const row = screen.getByText('Resumable omp').closest('button') as HTMLButtonElement
    const dataTransfer = dragDataTransfer()

    fireEvent.dragStart(row, { dataTransfer })

    expect(row).toHaveAttribute('draggable', 'true')
    expect(dataTransfer.setDragImage).toHaveBeenCalledWith(row.querySelector('.agent-conversation-brand'), 7, 7)
    expect(readAgentSessionDragPayload(dataTransfer)).toEqual({
      cwd: 'E:/repo',
      shell: 'pwsh.exe',
      args: ['-NoLogo', '-NoExit', '-Command', 'omp -r omp-1'],
      title: 'Oh My Pi: Resumable omp',
    })
  })

  test('marks an open conversation with its pane number and reveals the active pane without resuming', () => {
    const launch = agentResumeLaunch(conversation)
    mocks.store.activePaneId = 'pane-2'
    mocks.store.panes = {
      'pane-1': pane('pane-1', ['pwsh']),
      'pane-2': pane('pane-2', launch?.args ?? []),
    }
    publishOpenContentSnapshot([
      { panelId: 'content:terminalWindow:window-1', kind: 'terminalWindow', title: 'Terminal window', icon: 'terminal', active: false, parentPanelId: null },
      { panelId: 'content:terminal:pane-1', kind: 'terminal', title: 'Pane 1', icon: 'terminal', active: false, parentPanelId: 'content:terminalWindow:window-1' },
      { panelId: 'content:terminal:pane-2', kind: 'terminal', title: 'Pane 2', icon: 'oh-my-pi', active: true, parentPanelId: 'content:terminalWindow:window-1' },
    ])
    const shell = document.createElement('div')
    shell.className = 'terminal-panel-shell'
    shell.dataset.paneId = 'pane-2'
    document.body.append(shell)
    renderSidebar()

    const row = screen.getByText('Resumable omp').closest('button') as HTMLButtonElement
    expect(row).toHaveTextContent('Pane 2')
    expect(row).toHaveClass('is-open', 'is-active')
    expect(row).toHaveAttribute('aria-current', 'true')

    fireEvent.click(row)
    expect(openContent).not.toHaveBeenCalled()
    expect(activateContent).toHaveBeenCalledWith('content:terminal:pane-2')
    expect(shell).toHaveClass('agent-session-pane-reveal')
    shell.remove()
  })
})

function dragDataTransfer(): DataTransfer & { setDragImage: Mock } {
  const values = new Map<string, string>()
  const types: string[] = []
  return {
    types,
    effectAllowed: 'none',
    dropEffect: 'none',
    files: {} as FileList,
    items: {} as DataTransferItemList,
    setData: (type: string, value: string) => { values.set(type, value); if (!types.includes(type)) types.push(type) },
    getData: (type: string) => values.get(type) ?? '',
    clearData: (type?: string) => { if (type) values.delete(type); else values.clear() },
    setDragImage: vi.fn(),
  }
}
