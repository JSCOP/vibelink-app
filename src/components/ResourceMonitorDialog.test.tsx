// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { closePane, confirmDialog, invoke } = vi.hoisted(() => ({ closePane: vi.fn(), confirmDialog: vi.fn(), invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('./appDialogStore', () => ({ confirmDialog, isAppDialogOpen: () => false }))

import { defaultSettings, normalizeSettings } from '../state/profiles'
import { useWorkspaceStore } from '../state/store'
import { ResourceMonitorDialog } from './ResourceMonitorDialog'

const snapshot = {
  daemon: { pid: 50, cpuPercentX10: 2, memBytes: 80 * 1024 * 1024, processCount: 1, processes: [{ pid: 50, name: 'app.exe', cpuPercentX10: 2, memBytes: 80 * 1024 * 1024 }] },
  app: { pid: 40, cpuPercentX10: 6, memBytes: 120 * 1024 * 1024, processCount: 2, processes: [{ pid: 40, name: 'app.exe', cpuPercentX10: 6, memBytes: 120 * 1024 * 1024 }] },
  panes: [{
    sessionId: 'session-1', paneId: 'pane-1', rootPid: 86960, title: 'Terminal 2', role: 'omp', cpuPercentX10: 25,
    memBytes: 352.9 * 1024 * 1024, processCount: 2,
    processes: [
      { pid: 86960, name: 'pwsh.exe', cpuPercentX10: 0, memBytes: 44 * 1024 * 1024 },
      { pid: 86460, name: 'omp.exe', cpuPercentX10: 25, memBytes: 308.9 * 1024 * 1024 },
    ],
  }],
  totalCpuPercentX10: 33,
  totalMemBytes: 552.9 * 1024 * 1024,
}

function setDocumentVisibility(visibilityState: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibilityState })
}

describe('ResourceMonitorDialog', () => {
  beforeEach(() => {
    setDocumentVisibility('visible')
    invoke.mockReset()
    invoke.mockImplementation(async (command: string) => command === 'resource_snapshot' ? snapshot : undefined)
    confirmDialog.mockReset()
    confirmDialog.mockResolvedValue(true)
    closePane.mockReset()
    useWorkspaceStore.setState({
      sessions: [{ id: 'session-1', name: 'vibelink', paneCount: 1, createdAt: 1, workspaceFolder: 'C:/repo' }],
      activeSessionId: 'session-1',
      panes: { 'pane-1': { id: 'pane-1', alive: true, config: { paneId: 'pane-1', args: [], env: [], title: 'Fallback', shell: 'pwsh.exe', role: 'shell', cols: 80, rows: 24 } } } as never,
      closePane,
      manualPaneTitles: {},
      layoutJson: null,
      status: 'ready',
      error: undefined,
      settings: normalizeSettings(defaultSettings),
      kanban: { tasks: {}, taskOrder: {} },
      selectedTaskId: {},
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    setDocumentVisibility('visible')
  })

  test('shows CPU, working set, terminals, and each process grouped by workspace', async () => {
    render(<ResourceMonitorDialog onClose={() => undefined} onStopWorkspaceTerminals={() => undefined} onAfterRestart={() => undefined} />)

    expect(await screen.findByText('Terminal 2')).toBeTruthy()
    expect(screen.getByText('omp')).toBeTruthy()
    expect(screen.getByText('pid 86960')).toBeTruthy()
    expect(screen.getByText('pid 86460')).toBeTruthy()
    expect(screen.getAllByText('2.5%').length).toBeGreaterThan(0)
    expect(screen.getAllByText('352.9 MB').length).toBeGreaterThan(0)
    expect(screen.getByText('1 terminal · 5 processes')).toBeTruthy()
    expect(invoke).toHaveBeenCalledWith('resource_snapshot', { includeDetails: true })
  })

  test('stops only the selected terminal tree after confirmation', async () => {
    render(<ResourceMonitorDialog onClose={() => undefined} onStopWorkspaceTerminals={() => undefined} onAfterRestart={() => undefined} />)
    fireEvent.click(await screen.findByTitle('Stop Terminal 2'))

    await waitFor(() => expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Stop Terminal 2?', danger: true })))
    await waitFor(() => expect(closePane).toHaveBeenCalledWith('pane-1', 'session-1'))
  })

  test('stops one process inside a terminal without closing the terminal', async () => {
    render(<ResourceMonitorDialog onClose={() => undefined} onStopWorkspaceTerminals={() => undefined} onAfterRestart={() => undefined} />)
    fireEvent.click(await screen.findByTitle('Stop omp.exe'))

    await waitFor(() => expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Stop omp.exe?', danger: true })))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('kill_pane_process', { paneId: 'pane-1', pid: 86460 }))
    expect(closePane).not.toHaveBeenCalled()
  })

  test('lists the heaviest process first and warns that the root process ends the terminal', async () => {
    render(<ResourceMonitorDialog onClose={() => undefined} onStopWorkspaceTerminals={() => undefined} onAfterRestart={() => undefined} />)
    await screen.findByText('pid 86460')

    expect(screen.getAllByText(/^pid /).map((node) => node.textContent)).toEqual(['pid 86460', 'pid 86960'])

    fireEvent.click(screen.getByTitle('Stop pwsh.exe'))
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('the whole terminal stops with it') })))
  })

  test('pauses automatic polling while hidden, then refreshes on focus when visible', async () => {
    vi.useFakeTimers()
    setDocumentVisibility('hidden')
    render(<ResourceMonitorDialog onClose={() => undefined} onStopWorkspaceTerminals={() => undefined} onAfterRestart={() => undefined} />)

    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(invoke.mock.calls.filter(([command]) => command === 'resource_snapshot')).toHaveLength(0)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh resource snapshot' }))
      await Promise.resolve()
    })
    expect(invoke.mock.calls.filter(([command]) => command === 'resource_snapshot')).toHaveLength(1)

    invoke.mockClear()
    setDocumentVisibility('visible')
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    expect(invoke.mock.calls.filter(([command]) => command === 'resource_snapshot')).toHaveLength(1)
  })
})
