// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { HostingInfo, SessionMeta } from '../../ipc/types'
import type { WorkspaceContentActions } from '../../layout/contentActions'
import type * as OpenContentRegistry from '../../layout/openContentRegistry'
import type { HermesStatus } from '../../state/hermes'
import type { Profile, WorkspaceSortMode } from '../../state/profiles'
import type { PaneCompletionHighlight } from '../../state/store'
import type { WorkspaceGroup } from '../../state/workspaceGroups'
import type { AttentionSnapshot } from '../../state/worktreeAttention'
import type { PaletteItem } from './paletteModel'

type WorkspaceStateShape = {
  sessions: SessionMeta[]
  activeSessionId?: string
  workspaceReadyEpoch: number
  settings: {
    profiles: Profile[]
    workspaceGroups: WorkspaceGroup[]
    workspaceGroupIds: Record<string, string>
    workspaceSortMode: WorkspaceSortMode
    workspaceOrder: string[]
  }
  worktreeProjections: never[]
  attentionSnapshot: AttentionSnapshot | null
  hermesStatus: Record<string, HermesStatus>
  hermesPermissions: Record<string, never>
  paneCompletionHighlights: Record<string, PaneCompletionHighlight>
  paneReviewMarkers: Record<string, { reviewedAt: number; sessionId: string }>
  openSession: (sessionId: string) => Promise<void>
}

const { invoke, listWorkspaceFiles, contentsRender, openSession, openContent, activateContent } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listWorkspaceFiles: vi.fn<(workspaceFolder: string) => Promise<string[]>>(async () => ['src/main.ts']),
  contentsRender: vi.fn(),
  openSession: vi.fn<(sessionId: string) => Promise<void>>(async () => undefined),
  openContent: vi.fn(async () => 'panel-1'),
  activateContent: vi.fn(),
}))

/** Real external store: subscription and re-render behaviour must match
 *  production, and `reads` counts hook calls a closed palette must never make. */
const workspace = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const store: {
    state: WorkspaceStateShape
    reads: number
    subscribe: (listener: () => void) => () => void
    reset: (next: WorkspaceStateShape) => void
    patch: (next: Partial<WorkspaceStateShape>) => void
  } = {
    state: null as unknown as WorkspaceStateShape,
    reads: 0,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    reset: (next) => {
      store.state = next
      store.reads = 0
    },
    patch: (next) => {
      store.state = { ...store.state, ...next }
      for (const listener of [...listeners]) listener()
    },
  }
  return store
})

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('../../ipc/fs', () => ({ listWorkspaceFiles }))

vi.mock('../../state/store', async () => {
  // `vi.mock` factories are hoisted above every static import, so React is only reachable dynamically here.
  const { useSyncExternalStore } = await import('react')
  function useWorkspaceStore<T>(selector: (state: WorkspaceStateShape) => T): T {
    workspace.reads += 1
    return useSyncExternalStore(workspace.subscribe, () => selector(workspace.state))
  }
  return { useWorkspaceStore }
})

// `CommandPaletteContents` is the only external reader of the open-content
// registry, so a snapshot read is a faithful per-render counter for it. Reads
// inside the registry use its module-local binding and are not counted.
vi.mock('../../layout/openContentRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof OpenContentRegistry>()
  return {
    ...actual,
    getOpenContentSnapshot: () => {
      contentsRender()
      return actual.getOpenContentSnapshot()
    },
  }
})

import { clearOpenContentSnapshot, publishOpenContentSnapshot } from '../../layout/openContentRegistry'
import { emptyGitRepositoryState, emptyGitSessionState, useGitStore } from '../../state/git'
import { closePalette, openPalette } from './paletteStore'
import { CommandPaletteHost } from './CommandPalette'

// jsdom has no scroll implementation; the palette scrolls its selected row.
Element.prototype.scrollIntoView = vi.fn()

const profile: Profile = {
  id: 'pwsh',
  name: 'PowerShell',
  type: 'local',
  shell: 'powershell.exe',
  args: [],
  command: '',
  sshHost: '',
  sshUser: '',
  sshPort: null,
  sshIdentityFile: null,
  sshRemoteCommand: '',
  sshRemoteCwd: null,
  sshOptions: '',
  sshAllocateTty: false,
  env: [],
  cwd: null,
  color: '#ffffff',
  icon: 'powershell',
}

const commands: PaletteItem[] = [{ id: 'cmd:settings', category: 'command', label: 'Open settings', run: vi.fn() }]
const contentActions = { openContent, activateContent } as unknown as WorkspaceContentActions

const hostingInfo: HostingInfo = {
  provider: 'github',
  host: 'github.com',
  owner: 'moobang',
  repo: 'vibelink',
  webUrl: null,
  tokenPresent: false,
}

function makeWorkspaceState(): WorkspaceStateShape {
  return {
    sessions: [
      { id: 'alpha', name: 'Alpha', paneCount: 1, createdAt: 1, workspaceFolder: 'E:/repos/alpha' },
      { id: 'beta', name: 'Beta', paneCount: 2, createdAt: 2, workspaceFolder: 'E:/repos/beta' },
    ],
    activeSessionId: 'beta',
    workspaceReadyEpoch: 7,
    settings: {
      profiles: [profile],
      workspaceGroups: [],
      workspaceGroupIds: {},
      workspaceSortMode: 'manual',
      workspaceOrder: ['alpha', 'beta', 'gamma'],
    },
    worktreeProjections: [],
    attentionSnapshot: null,
    hermesStatus: {},
    hermesPermissions: {},
    paneCompletionHighlights: {},
    paneReviewMarkers: {},
    openSession,
  }
}

/** Exactly what a closed palette used to observe: an attention refresh, a Git
 *  root poll (refreshing, then the result), Hermes/completion markers, a new
 *  workspace, and an open-content publish. */
function publishBackgroundActivity() {
  act(() => {
    workspace.patch({
      attentionSnapshot: {
        capturedAt: 1_000,
        panes: [{
          workspaceId: 'beta',
          paneId: 'pane-1',
          state: 'working',
          stateUpdatedAt: 900,
          lastOutputAt: 900,
          unreadCount: 1,
          interrupted: false,
          source: 'native',
          alive: true,
          title: 'agent',
        }],
      },
    })
  })
  act(() => {
    useGitStore.setState({
      sessions: { beta: { ...emptyGitSessionState, repositories: { '': { ...emptyGitRepositoryState, refreshing: true } } } },
    })
  })
  act(() => {
    useGitStore.setState({
      sessions: { beta: { ...emptyGitSessionState, repositories: { '': { ...emptyGitRepositoryState, hostingInfo, lastRefreshAt: 1_000 } } } },
    })
  })
  act(() => {
    workspace.patch({
      hermesStatus: { beta: 'busy' },
      paneCompletionHighlights: { 'pane-1': { completedAt: 1_200, source: 'agent-hook', sessionId: 'beta' } },
    })
  })
  act(() => {
    workspace.patch({
      sessions: [
        ...workspace.state.sessions,
        { id: 'gamma', name: 'Gamma', paneCount: 1, createdAt: 3, workspaceFolder: 'E:/repos/gamma' },
      ],
    })
  })
  act(() => {
    publishOpenContentSnapshot([{ panelId: 'editor:notes', kind: 'editor', title: 'Notes.md', icon: 'file-text', active: false }])
  })
}

function renderHost() {
  return render(<CommandPaletteHost contentActions={contentActions} commands={commands} />)
}

beforeEach(() => {
  window.localStorage.clear()
  closePalette()
  clearOpenContentSnapshot()
  useGitStore.setState({ sessions: {} })
  workspace.reset(makeWorkspaceState())
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('CommandPaletteHost', () => {
  test('a closed palette renders no contents and reads no workspace state while background activity churns', () => {
    renderHost()

    expect(contentsRender).not.toHaveBeenCalled()
    expect(workspace.reads).toBe(0)

    publishBackgroundActivity()

    expect(contentsRender).not.toHaveBeenCalled()
    expect(workspace.reads).toBe(0)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('opening the palette mounts contents with the workspace and Git state published while it was closed', () => {
    renderHost()
    publishBackgroundActivity()

    act(() => { openPalette() })

    expect(contentsRender).toHaveBeenCalled()
    expect(workspace.reads).toBeGreaterThan(0)
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveFocus()
    // Git hosting arrived while the palette was closed; it must still classify Beta.
    expect(screen.getByRole('button', { name: 'Project: vibelink' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Host: github.com' })).toBeInTheDocument()
    expect(screen.getByText('Project workspaces')).toBeInTheDocument()
    // Workspace and open content added while the palette was closed.
    expect(screen.getByRole('button', { name: /Gamma/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Notes\.md/ })).toBeInTheDocument()
  })

  test('item order and keyboard navigation are unchanged after opening', () => {
    renderHost()
    publishBackgroundActivity()
    act(() => { openPalette() })

    expect([...document.querySelectorAll('.command-palette-item-label')].map((node) => node.textContent))
      .toEqual(['Beta', 'Alpha', 'Gamma', 'Notes.md', 'PowerShell', 'Open settings', 'Go to file'])

    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(openSession).toHaveBeenCalledWith('alpha')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('Go to file opens the editor with the current workspace ready epoch', async () => {
    renderHost()
    act(() => { openPalette() })

    fireEvent.click(screen.getByRole('button', { name: /Go to file/ }))

    await waitFor(() => expect(listWorkspaceFiles).toHaveBeenCalledWith('E:/repos/beta'))
    fireEvent.click(await screen.findByRole('button', { name: /main\.ts/ }))

    expect(openContent).toHaveBeenCalledWith({
      kind: 'editor',
      relPath: 'src/main.ts',
      workspaceId: 'beta',
      workspaceEpoch: 7,
    })
  })
})
