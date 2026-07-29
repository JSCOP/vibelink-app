// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { IDockviewPanelProps } from 'dockview-react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkspaceContentActionsContext, type WorkspaceContentActions } from './contentActions'
import { TerminalPanePanel } from './TerminalPanePanel'
import { writeAgentSessionDragPayload } from '../components/agent/agentSessionsModel'

const mockStore = vi.hoisted(() => ({
  activePaneId: undefined as string | undefined,
  reviewedPaneId: undefined as string | undefined,
  lease: undefined as undefined | { sessionId: string; paneId: string; deviceId: string; cols: number; rows: number; expiresAt: number },
  panes: {} as Record<string, { config: { title: string } }>,
}))

const managerMock = vi.hoisted(() => ({
  attach: vi.fn(),
  copyContentsToClipboard: vi.fn(),
  copySelectionToClipboard: vi.fn(),
  focus: vi.fn(),
  getRecentOutput: vi.fn(() => ''),
  getSelection: vi.fn(() => ''),
  paste: vi.fn(),
  reflow: vi.fn(),
  selectAll: vi.fn(),
  setPaneVisible: vi.fn(),
  setRemotePaneLease: vi.fn(),
  syncPtySize: vi.fn(),
}))

const openContentMock = vi.fn(async () => 'content:terminal:pane-resumed')
const activateContentMock = vi.fn()

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
    panes: mockStore.panes,
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
  TerminalManager: managerMock,
}))

vi.mock('../ipc/hermes', () => ({
  getHermesRuntimeStatus: vi.fn(async () => ({ detected: false })),
}))

vi.mock('../remote/paneLease', () => ({
  reclaimRemotePaneLease: vi.fn(async () => undefined),
  useRemotePaneLeaseStore: (selector: (state: { leases: Record<string, unknown> }) => unknown) => selector({
    leases: mockStore.lease ? { [mockStore.lease.paneId]: mockStore.lease } : {},
  }),
}))

vi.mock('./terminalWindowRegistry', () => ({
  findTerminalWindowForPane: () => ({ windowId: 'window-target' }),
}))

const actions: WorkspaceContentActions = {
  openContent: openContentMock,
  activateContent: activateContentMock,
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

function terminalPaneProps(paneId: string) {
  return {
    api: {
      id: `panel-${paneId}`,
      isVisible: true,
      onDidVisibilityChange: () => ({ dispose: () => undefined }),
      onDidDimensionsChange: () => ({ dispose: () => undefined }),
    },
    containerApi: { getPanel: () => undefined },
    params: { schema: 1, kind: 'terminal', instanceId: paneId, paneId, title: 'Shell', icon: 'terminal' },
  } as unknown as IDockviewPanelProps<{ schema: 1; kind: 'terminal'; instanceId: string; paneId: string; title: string; icon: string }>
}

function renderTerminalPane(paneId: string) {
  const props = terminalPaneProps(paneId)

  return renderToStaticMarkup(
    <WorkspaceContentActionsContext.Provider value={actions}>
      <TerminalPanePanel {...props} />
    </WorkspaceContentActionsContext.Provider>,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TerminalPanePanel', () => {
  beforeEach(() => {
    mockStore.activePaneId = undefined
    mockStore.reviewedPaneId = undefined
    mockStore.lease = undefined
    mockStore.panes = {}
    managerMock.attach.mockClear()
    managerMock.reflow.mockClear()
    managerMock.setPaneVisible.mockClear()
    managerMock.syncPtySize.mockClear()
    openContentMock.mockClear()
    activateContentMock.mockClear()
  })


  test('stages terminal mounts across animation frames', () => {
    const frameCallbacks: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    mockStore.panes = {
      'pane-first': { config: { title: 'First' } },
      'pane-second': { config: { title: 'Second' } },
    }

    const view = render(
      <WorkspaceContentActionsContext.Provider value={actions}>
        <TerminalPanePanel {...terminalPaneProps('pane-first')} />
        <TerminalPanePanel {...terminalPaneProps('pane-second')} />
      </WorkspaceContentActionsContext.Provider>,
    )

    expect(managerMock.attach.mock.calls.map(([paneId]) => paneId)).toEqual(['pane-first'])

    act(() => {
      for (const callback of frameCallbacks.splice(0)) callback(16)
    })

    expect(managerMock.attach.mock.calls.map(([paneId]) => paneId)).toEqual(['pane-first', 'pane-second'])
    view.unmount()
  })
  test('marks only the selected terminal pane as active', () => {
    mockStore.activePaneId = 'pane-active'

    const activePane = renderTerminalPane('pane-active')
    const inactivePane = renderTerminalPane('pane-inactive')

    expect(activePane).toContain('class="terminal-panel-shell" data-pane-id="pane-active"')
    expect(activePane).toContain('data-active="true"')
    expect(inactivePane).toContain('class="terminal-panel-shell" data-pane-id="pane-inactive"')
    expect(inactivePane).not.toContain('data-active=')
  })

  test('marks reviewed terminal panes independently from selection', () => {
    mockStore.reviewedPaneId = 'pane-reviewed'

    const reviewedPane = renderTerminalPane('pane-reviewed')

    expect(reviewedPane).toContain('data-pane-reviewed="true"')
    expect(reviewedPane).not.toContain('data-active=')
  })

  test('drops an agent session onto a pane by creating a fresh sibling terminal', async () => {
    mockStore.panes = { 'pane-target': { config: { title: 'Target' } } }
    const dataTransfer = dragDataTransfer()
    writeAgentSessionDragPayload(dataTransfer, {
      cwd: 'E:/repo',
      shell: 'pwsh.exe',
      args: ['-NoLogo', '-NoExit', '-Command', 'omp -r omp-1'],
      title: 'Oh My Pi: Resumable omp',
    })
    render(
      <WorkspaceContentActionsContext.Provider value={actions}>
        <TerminalPanePanel {...terminalPaneProps('pane-target')} />
      </WorkspaceContentActionsContext.Provider>,
    )
    const shell = document.querySelector<HTMLElement>('.terminal-panel-shell[data-pane-id="pane-target"]')
    expect(shell).not.toBeNull()

    fireEvent.dragOver(shell as HTMLElement, { dataTransfer })
    expect(screen.getByText('Resume in a new terminal here')).toBeInTheDocument()

    fireEvent.drop(shell as HTMLElement, { dataTransfer })

    await waitFor(() => expect(openContentMock).toHaveBeenCalledWith({
      kind: 'terminal',
      windowId: 'window-target',
      referencePaneId: 'pane-target',
      cwd: 'E:/repo',
      shell: 'pwsh.exe',
      args: ['-NoLogo', '-NoExit', '-Command', 'omp -r omp-1'],
      title: 'Oh My Pi: Resumable omp',
    }))
    expect(activateContentMock).toHaveBeenCalledWith('content:terminal:pane-resumed')
    expect(screen.queryByText('Resume in a new terminal here')).not.toBeInTheDocument()
  })

  test('keeps the terminal mounted beneath an actionable remote lease cover', () => {
    mockStore.lease = {
      sessionId: 'session-1',
      paneId: 'pane-leased',
      deviceId: 'device-mobile',
      cols: 48,
      rows: 27,
      expiresAt: 1_800_000_000_000,
    }

    const leasedPane = renderTerminalPane('pane-leased')

    expect(leasedPane).toContain('class="dock-terminal-host"')
    expect(leasedPane).toContain('class="remote-pane-lease-cover"')
    expect(leasedPane).toContain('Your phone is controlling this terminal')
    expect(leasedPane).toContain('The desktop keyboard is paused')
    expect(leasedPane).toContain('device-mobile · phone size 48 × 27')
    expect(leasedPane).toContain('Take back this terminal')
    expect(leasedPane).toContain('Take back all terminals')
    expect(leasedPane).toContain('Collapse')
  })
})

function dragDataTransfer(): DataTransfer {
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
    setDragImage: () => undefined,
  }
}
