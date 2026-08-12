// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

// Async factories must load the cycle-free mock module lazily because vi.mock is hoisted per test file.
vi.mock('@tauri-apps/api/event', async () => (await import('./terminalTestMocks')).tauriEventModule())
vi.mock('@tauri-apps/api/core', async () => (await import('./terminalTestMocks')).tauriCoreModule())
vi.mock('@xterm/xterm', async () => (await import('./terminalTestMocks')).xtermModule())
vi.mock('./scrollbar', async () => (await import('./terminalTestMocks')).scrollbarModule())
vi.mock('@xterm/addon-webgl', async () => (await import('./terminalTestMocks')).webglAddonModule())
vi.mock('@xterm/addon-clipboard', async () => (await import('./terminalTestMocks')).clipboardAddonModule())
vi.mock('@xterm/addon-search', async () => (await import('./terminalTestMocks')).searchAddonModule())
vi.mock('@xterm/addon-unicode11', async () => (await import('./terminalTestMocks')).unicode11AddonModule())
vi.mock('@xterm/addon-serialize', async () => (await import('./terminalTestMocks')).serializeAddonModule())
import { TerminalManager, invokeMock, makeContainer } from './terminalTestHarness'

type ResizableEntry = { term: { cols: number; rows: number; resize(cols: number, rows: number): void } }

function entryFor(paneId: string): ResizableEntry {
  const manager = TerminalManager as unknown as { entries: Map<string, ResizableEntry> }
  const entry = manager.entries.get(paneId)
  if (!entry) throw new Error(`missing entry for ${paneId}`)
  return entry
}

function snapshotCalls(): { sessionId: string; paneId: string; data: string }[] {
  return invokeMock.mock.calls
    .filter(([command]) => command === 'set_pane_snapshot')
    .map(([, payload]) => payload as { sessionId: string; paneId: string; data: string })
}

/** The daemon stores raw PTY bytes, which carry no geometry: once a pane has been
 *  resized, replaying them re-wraps every full-width rule and lands every absolute
 *  cursor move in the wrong cell. Handing the daemon what the pane RENDERS is what
 *  makes a restart restore the screen the user was looking at. */
describe('pane snapshot rebase', () => {
  it('sends one rendered snapshot for the geometry a resize lands on, not one per step', async () => {
    const paneId = 'pane-snapshot-resize'
    TerminalManager.attach(paneId, makeContainer(), { sessionId: 'session-snapshot' })
    await TerminalManager.waitForReplay('session-snapshot', [paneId])
    const entry = entryFor(paneId)
    invokeMock.mockClear()

    // A divider drag or a window resize walks the grid through several sizes.
    entry.term.resize(120, 40)
    TerminalManager.syncPtySize(paneId)
    entry.term.resize(90, 40)
    TerminalManager.syncPtySize(paneId)

    await vi.waitFor(() => expect(snapshotCalls()).toHaveLength(1), { timeout: 5_000 })
    const [snapshot] = snapshotCalls()
    expect(snapshot.sessionId).toBe('session-snapshot')
    expect(snapshot.paneId).toBe(paneId)
    // Serialized at the geometry the resize settled on, never an intermediate one.
    expect(snapshot.data).toContain('rendered 90x40')
    // Self-clearing, so the daemon ring drops the pre-resize bytes and
    // `terminalOutputAfterLastHardClear` trims the replay to exactly this point.
    expect(snapshot.data.startsWith('\x1b[3J\x1b[2J\x1b[H')).toBe(true)
    // Row-capped: serializing the full 50,000-row default measured 1.3 s and 14 MiB.
    expect(snapshot.data).toContain('scrollback=2000')
    // A fixed-grid alternate-buffer frame cannot be repainted at another width
    // without clipping, so it is never captured; the live application repaints it.
    expect(snapshot.data).toContain('altExcluded=true')

    TerminalManager.dispose(paneId)
  })

  it('rebases the daemon when a pane is cleared, so the clear survives a restart', async () => {
    const paneId = 'pane-snapshot-clear'
    TerminalManager.attach(paneId, makeContainer(), { sessionId: 'session-clear' })
    await TerminalManager.waitForReplay('session-clear', [paneId])
    invokeMock.mockClear()

    TerminalManager.clearPane(paneId)

    await vi.waitFor(() => expect(snapshotCalls()).toHaveLength(1), { timeout: 5_000 })
    expect(snapshotCalls()[0].data.startsWith('\x1b[3J\x1b[2J\x1b[H')).toBe(true)
    // Clearing is a view operation: the program keeps running and is never written to.
    expect(invokeMock).not.toHaveBeenCalledWith('write_pane', expect.anything())

    TerminalManager.dispose(paneId)
  })

  it('never snapshots a pane that has no daemon attachment to rebase', () => {
    const paneId = 'pane-snapshot-detached'
    TerminalManager.attach(paneId, makeContainer(), {})
    invokeMock.mockClear()

    const entry = entryFor(paneId)
    entry.term.resize(100, 30)
    TerminalManager.syncPtySize(paneId)
    TerminalManager.clearPane(paneId)

    expect(snapshotCalls()).toEqual([])

    TerminalManager.dispose(paneId)
  })
})
