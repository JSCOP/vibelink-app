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
import { TerminalManager, invokeMock, makeContainer, terminalSnapshot } from './terminalTestHarness'

describe('TerminalManager atomic snapshot replay', () => {
  it('hydrates the atomic snapshot before live frames that arrive while subscribing', async () => {
    const paneId = 'pane-atomic-replay'
    const container = makeContainer()
    const snapshotResult = Promise.withResolvers<unknown>()
    invokeMock.mockImplementation((command) => {
      if (command === 'subscribe_pane') return snapshotResult.promise
      return Promise.resolve()
    })

    TerminalManager.attach(paneId, container, { sessionId: 'session-replay' })
    TerminalManager.writeSequenced(paneId, 9n, 3n, new TextEncoder().encode('live'))
    snapshotResult.resolve(terminalSnapshot(paneId, 2n, 'snapshot'))
    await TerminalManager.waitForReplay('session-replay', [paneId])

    const manager = TerminalManager as unknown as {
      entries: Map<string, { term: { writes: Uint8Array[]; resetCalls: number } }>
    }
    const entry = manager.entries.get(paneId)
    expect(invokeMock).toHaveBeenCalledWith('subscribe_pane', { sessionId: 'session-replay', paneId })
    expect(entry?.term.resetCalls).toBe(1)
    expect(entry?.term.writes.map((bytes) => new TextDecoder().decode(bytes))).toEqual(['snapshot', 'live'])
    TerminalManager.dispose(paneId)
  })

  it('pins a rebuilt pane to the bottom instead of leaving it where the replay cursor stopped', async () => {
    const paneId = 'pane-replay-scroll'
    const container = makeContainer()
    invokeMock.mockImplementation((command: string) => (
      command === 'subscribe_pane'
        ? Promise.resolve(terminalSnapshot(paneId, 1n, 'snapshot', 'session-replay-scroll'))
        : Promise.resolve(undefined)
    ))

    TerminalManager.attach(paneId, container, { sessionId: 'session-replay-scroll' })
    await TerminalManager.waitForReplay('session-replay-scroll', [paneId])

    const manager = TerminalManager as unknown as {
      entries: Map<string, { term: { resetCalls: number; scrollToBottomCalls: number } }>
    }
    const entry = manager.entries.get(paneId)
    // reset() empties the buffer, so the replay re-parses from row 0 and the
    // viewport ends wherever its cursor stopped. Without the restore the pane
    // stays parked at the top of the rebuilt scrollback.
    expect(entry?.term.resetCalls).toBe(1)
    expect(entry?.term.scrollToBottomCalls).toBeGreaterThan(0)
    TerminalManager.dispose(paneId)
  })

  it('answers a cold-snapshot cursor query when the emulator emits no CPR', async () => {
    const paneId = 'pane-cold-dsr'
    invokeMock.mockImplementation((command) => command === 'subscribe_pane'
      ? Promise.resolve(terminalSnapshot(paneId, 1n, '\x1b[?9001h\x1b[?1004h\x1b[6n', 'session-cold-dsr'))
      : Promise.resolve())

    TerminalManager.attach(paneId, makeContainer(), { sessionId: 'session-cold-dsr' })
    await TerminalManager.waitForReplay('session-cold-dsr', [paneId])

    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('write_pane', {
      sessionId: 'session-cold-dsr',
      paneId,
      data: '\x1b[1;1R',
    }))
    TerminalManager.dispose(paneId)
  })

  it('resubscribes and replaces the pane when a live output sequence has a gap', async () => {
    const paneId = 'pane-gap-replay'
    const container = makeContainer()
    const snapshots = [terminalSnapshot(paneId, 1n, 'initial'), terminalSnapshot(paneId, 3n, 'healed')]
    invokeMock.mockImplementation((command) => {
      if (command === 'subscribe_pane') return Promise.resolve(snapshots.shift())
      return Promise.resolve()
    })

    TerminalManager.attach(paneId, container, { sessionId: 'session-replay' })
    await TerminalManager.waitForReplay('session-replay', [paneId])
    TerminalManager.writeSequenced(paneId, 9n, 3n, new TextEncoder().encode('gap frame'))
    await TerminalManager.waitForReplay('session-replay', [paneId])

    const manager = TerminalManager as unknown as {
      entries: Map<string, { term: { writes: Uint8Array[]; resetCalls: number } }>
    }
    const entry = manager.entries.get(paneId)
    expect(invokeMock.mock.calls.filter(([command]) => command === 'subscribe_pane')).toHaveLength(2)
    expect(entry?.term.resetCalls).toBe(2)
    expect(entry?.term.writes.map((bytes) => new TextDecoder().decode(bytes))).toEqual(['healed'])
    TerminalManager.dispose(paneId)
  })

  it('keeps a retained terminal buffer when a workspace reattach snapshot is unchanged', async () => {
    const paneId = 'pane-retained-replay'
    const sessionId = 'session-retained-replay'
    const firstContainer = makeContainer()
    const secondContainer = makeContainer()
    const snapshots = [
      terminalSnapshot(paneId, 7n, 'retained transcript', sessionId),
      terminalSnapshot(paneId, 7n, 'must not replay', sessionId),
    ]
    invokeMock.mockImplementation((command) => {
      if (command === 'subscribe_pane') return Promise.resolve(snapshots.shift())
      return Promise.resolve()
    })

    TerminalManager.attach(paneId, firstContainer, { sessionId })
    await TerminalManager.waitForReplay(sessionId, [paneId])
    TerminalManager.attach(paneId, secondContainer, { sessionId })
    TerminalManager.reattachToDaemon(sessionId, [paneId], { force: false })
    await TerminalManager.waitForReplay(sessionId, [paneId])

    const manager = TerminalManager as unknown as {
      entries: Map<string, { term: { element?: HTMLElement; writes: Uint8Array[]; resetCalls: number } }>
    }
    const entry = manager.entries.get(paneId)
    expect(invokeMock.mock.calls.filter(([command]) => command === 'subscribe_pane')).toHaveLength(2)
    expect(entry?.term.resetCalls).toBe(1)
    expect(entry?.term.writes.map((bytes) => new TextDecoder().decode(bytes))).toEqual(['retained transcript'])
    expect(entry?.term.element?.parentElement).toBe(secondContainer)
    TerminalManager.dispose(paneId)
  })

  it('chunks a large cold snapshot so replay yields between bounded writes', async () => {
    const paneId = 'pane-chunked-replay'
    const sessionId = 'session-chunked-replay'
    const transcript = 'x'.repeat(200 * 1024)
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      queueMicrotask(() => callback(performance.now()))
      return 1
    })
    invokeMock.mockImplementation((command) => command === 'subscribe_pane'
      ? Promise.resolve(terminalSnapshot(paneId, 1n, transcript, sessionId))
      : Promise.resolve())

    try {
      TerminalManager.attach(paneId, makeContainer(), { sessionId })
      await TerminalManager.waitForReplay(sessionId, [paneId])

      const manager = TerminalManager as unknown as {
        entries: Map<string, { term: { writes: Uint8Array[] } }>
      }
      const writes = manager.entries.get(paneId)?.term.writes ?? []
      expect(writes.length).toBeGreaterThan(1)
      expect(writes.map((bytes) => new TextDecoder().decode(bytes)).join('')).toBe(transcript)
    } finally {
      TerminalManager.dispose(paneId)
      requestFrame.mockRestore()
    }
  })
})

describe('TerminalManager workspace cache', () => {
  it('prunes stale panes only from the active workspace and retains background terminals', () => {
    TerminalManager.getOrCreate('pane-active-live').sessionId = 'session-active'
    TerminalManager.getOrCreate('pane-active-stale').sessionId = 'session-active'
    TerminalManager.getOrCreate('pane-background').sessionId = 'session-background'

    TerminalManager.pruneWorkspaceCache('session-active', new Set(['pane-active-live']))

    const manager = TerminalManager as unknown as { entries: Map<string, unknown> }
    expect([...manager.entries.keys()]).toEqual(expect.arrayContaining(['pane-active-live', 'pane-background']))
    expect(manager.entries.has('pane-active-stale')).toBe(false)
    TerminalManager.dispose('pane-active-live')
    TerminalManager.dispose('pane-background')
  })
})
