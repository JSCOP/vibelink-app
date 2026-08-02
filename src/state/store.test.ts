import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { LicenseStatus, PaneMeta, SessionMeta } from '../ipc/types'
import { defaultSettings, normalizeSettings } from './profiles'
import type { WorktreeProjection, WorktreeRecord } from './worktrees'
import { getWorkspaceSessionEpoch, isWorkspaceInitialPanePending, loadCompletionHistory, loadPaneCompletionHighlights, loadPaneReviewMarkers, paneCompletionCountsBySession, persistCompletionHistory, persistPaneCompletionHighlights, persistPaneReviewMarkers, resetWorkspaceSessionOwnershipForTests, useWorkspaceStore } from './store'

const spawnedPane: PaneMeta = {
  id: 'pane-test',
  config: {
    paneId: 'pane-test',
    shell: 'codex.cmd',
    args: ['--dangerously-bypass-approvals-and-sandbox'],
    cwd: 'E:/work',
    env: [['TERM_PROGRAM', 'VibeLink']],
    title: 'Codex',
    cols: 120,
    rows: 32,
  },
  alive: true,
}

const nonAgentPane: PaneMeta = {
  id: 'pane-shell',
  config: {
    paneId: 'pane-shell',
    shell: 'pwsh.exe',
    args: ['-NoLogo'],
    cwd: 'E:/work',
    env: [['TERM_PROGRAM', 'VibeLink']],
    title: 'PowerShell',
    cols: 120,
    rows: 32,
  },
  alive: true,
}

const createdSession: SessionMeta = {
  id: 'session-workspace',
  name: 'Repo',
  paneCount: 0,
  createdAt: 123,
  workspaceFolder: 'E:/repo',
}

const secondSession: SessionMeta = {
  id: 'session-other',
  name: 'Other',
  paneCount: 0,
  createdAt: 124,
  workspaceFolder: 'E:/other',
}

const profileSession: SessionMeta = {
  id: 'session-1',
  name: 'Profile test workspace',
  paneCount: 0,
  createdAt: 125,
  workspaceFolder: null,
}

function worktreeFixture(session: SessionMeta = {
  id: 'session-worktree', name: 'Fix Login', paneCount: 0, createdAt: 126, workspaceFolder: 'E:/managed-worktrees/fix-login',
}, overrides: Partial<WorktreeRecord> = {}): WorktreeProjection {
  const record: WorktreeRecord = {
    id: 'worktree-1', instanceId: 'instance-1', repositoryId: 'repository-1', repositoryPath: 'E:/repo',
    worktreePath: session.workspaceFolder ?? '', branch: 'vibelink/fix-login', head: 'abc123', baseRef: 'origin/main',
    sessionId: session.id, parentSessionId: createdSession.id, parentWorktreeId: null, parentInstanceId: null,
    origin: 'manual', lifecycle: 'active', locked: false, lockReason: null, prunable: false, prunableReason: null,
    dirty: false, untracked: false, hasConflicts: false, ahead: 0, behind: 0, exists: true,
    setupPolicy: 'inherit', sparsePreset: null, linkedFiles: [], initialAgent: null, initialPrompt: null,
    comment: null, reviewTarget: null, createdAt: 1, updatedAt: 1, lastActivityAt: 1, ...overrides,
  }
  return { id: record.id, instanceId: record.instanceId, state: 'managed', record, native: null, parentWorktreeId: record.parentWorktreeId, childWorktreeIds: [] }
}

const unlicensedStatus: LicenseStatus = {
  state: 'unlicensed',
  entitled: false,
  provider: null,
  maskedKey: null,
  activationId: null,
  deviceId: 'device-test',
  deviceName: 'Test device',
  maxDevices: 0,
  devices: [],
  validatedAt: null,
  offlineGraceUntil: null,
  purchaseUrl: 'https://example.com',
  message: 'License required',
}

const localStorageStub = {
  getItem: vi.fn((key: string): string | null => { void key; return null }),
  setItem: vi.fn((key: string, value: string): void => { void key; void value }),
  removeItem: vi.fn((key: string): void => { void key }),
  clear: vi.fn(),
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === 'license_status') return unlicensedStatus
    if (command === 'spawn_pane') return spawnedPane
    if (command === 'attach_session') return { layoutJson: null, panes: [] }
    if (command === 'list_sessions') return []
    return null
  }),
}))

async function attachReadySession(session: SessionMeta, sessions: SessionMeta[] = [session]): Promise<void> {
  useWorkspaceStore.setState({ sessions })
  // A ready fixture must already own a pane; an empty attach auto-spawns and refreshes sessions before the spawn under test.
  vi.mocked(invoke).mockResolvedValueOnce({ layoutJson: null, panes: [nonAgentPane] })
  await useWorkspaceStore.getState().attachSession(session.id)
  vi.mocked(invoke).mockClear()
}

describe('workspace store profiles', () => {
  beforeEach(() => {
    resetWorkspaceSessionOwnershipForTests()
    vi.stubGlobal('window', { localStorage: localStorageStub })
    vi.stubGlobal('document', { hasFocus: () => false })
    localStorageStub.getItem.mockReset().mockReturnValue(null)
    localStorageStub.setItem.mockReset()
    localStorageStub.removeItem.mockReset()
    localStorageStub.clear.mockClear()
    vi.mocked(invoke).mockClear()
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'license_status') return unlicensedStatus
      if (command === 'spawn_pane') return spawnedPane
      if (command === 'attach_session') return { layoutJson: null, panes: [] }
      if (command === 'list_sessions') return useWorkspaceStore.getState().sessions
      return null
    })
    useWorkspaceStore.setState({
      workspaceEpoch: 0,
      workspaceReadyEpoch: 0,
      license: { ready: false, status: null },
      sessions: [],
      activeSessionId: undefined,
      activePaneId: undefined,
      panes: {},
      paneLifecycle: {},
      manualPaneTitles: {},
      layoutJson: null,
      status: 'ready',
      error: undefined,
      hermesPendingPrompts: {},
      hermesGenerations: {},
      hermesTranscript: {},
      hermesCurrentSession: {},
      paneCompletionHighlights: {},
      completionHistory: [],
      paneReviewMarkers: {},
      capturesByPane: {},
      recentCaptures: [],
      hermesSessions: {},
      settings: normalizeSettings({
        ...defaultSettings,
        defaultProfileId: 'agent',
        profiles: [
          {
            id: 'agent',
            name: 'Codex',
            shell: 'codex.cmd',
            args: ['--dangerously-bypass-approvals-and-sandbox'],
            env: [['TERM_PROGRAM', 'VibeLink']],
            cwd: 'E:/work',
            color: '#7ee787',
            icon: 'sparkles',
          },
        ],
      }),
    })
  })

  test('dismissError clears only the notification', () => {
    useWorkspaceStore.setState({ status: 'error', error: 'boom' })

    useWorkspaceStore.getState().dismissError()

    expect(useWorkspaceStore.getState().error).toBeUndefined()
    expect(useWorkspaceStore.getState().status).toBe('error')
  })

  test('spawnPane rejects a workspace that is not active and ready', async () => {
    await expect(useWorkspaceStore.getState().spawnPane(profileSession.id, { paneId: 'pane-test' }))
      .rejects.toThrow('Workspace changed while the terminal was opening.')

    expect(invoke).not.toHaveBeenCalledWith('spawn_pane', expect.anything())
  })

  test('spawnPane advertises color terminal capabilities by default', async () => {
    await attachReadySession(profileSession)
    await useWorkspaceStore.getState().spawnPane('session-1', { paneId: 'pane-test' })

    expect(invoke).toHaveBeenCalledWith('spawn_pane', {
      sessionId: 'session-1',
      cfg: expect.objectContaining({
        env: expect.arrayContaining([
          ['TERM', 'xterm-256color'],
          ['COLORTERM', 'truecolor'],
          ['FORCE_COLOR', '1'],
          ['CLICOLOR_FORCE', '1'],
          ['TERM_PROGRAM', 'VibeLink'],
        ]),
      }),
    })
  })

  test('spawnPane uses the selected profile when no pane overrides are supplied', async () => {
    await attachReadySession(profileSession)
    await useWorkspaceStore.getState().spawnPane('session-1', { paneId: 'pane-test' })

    expect(invoke).toHaveBeenNthCalledWith(1, 'spawn_pane', {
      sessionId: 'session-1',
      cfg: {
        paneId: 'pane-test',
        shell: 'codex.cmd',
        args: ['--dangerously-bypass-approvals-and-sandbox'],
        cwd: 'E:/work',
        env: [
          ['TERM', 'xterm-256color'],
          ['COLORTERM', 'truecolor'],
          ['FORCE_COLOR', '1'],
          ['CLICOLOR_FORCE', '1'],
          ['TERM_PROGRAM', 'VibeLink'],
          ['VIBELINK_SESSION_ID', 'session-1'],
          ['VIBELINK_PANE_ID', 'pane-test'],
          ['VIBELINK_CLI_EXE', 'vibelink.exe'],
        ],
        title: 'Codex',
        icon: 'sparkles',
        profileId: 'agent',
        // User-created panes are restorable, so an unclean exit can rebuild
        // them; a deliberate quit is excluded by the daemon's clean-exit gate.
        restoreOnStart: true,
        cols: 120,
        rows: 32,
      },
    })
  })

  test('spawnPane exposes pane and session ids to terminal agents', async () => {
    await attachReadySession(profileSession)
    await useWorkspaceStore.getState().spawnPane('session-1', { paneId: 'pane-test' })

    expect(invoke).toHaveBeenCalledWith('spawn_pane', {
      sessionId: 'session-1',
      cfg: expect.objectContaining({
        env: expect.arrayContaining([
          ['VIBELINK_SESSION_ID', 'session-1'],
          ['VIBELINK_PANE_ID', 'pane-test'],
        ]),
      }),
    })
  })

  test('createSession persists a workspace folder and accepts one measured initial pane there', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'create_session') return createdSession
      if (command === 'list_sessions') return [createdSession]
      if (command === 'attach_session') return { layoutJson: null, panes: [] }
      if (command === 'spawn_pane') return spawnedPane
      return null
    })

    await useWorkspaceStore.getState().createSession('Repo', 'E:/repo')
    expect(isWorkspaceInitialPanePending(createdSession.id, getWorkspaceSessionEpoch())).toBe(true)
    await useWorkspaceStore.getState().spawnPane(createdSession.id, { paneId: 'pane-test', cols: 222, rows: 77 })

    expect(invoke).toHaveBeenCalledWith('create_session', {
      name: 'Repo',
      workspaceFolder: 'E:/repo',
    })
    expect(invoke).toHaveBeenCalledWith('spawn_pane', {
      sessionId: 'session-workspace',
      cfg: expect.objectContaining({ cwd: 'E:/repo', cols: 222, rows: 77 }),
    })
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'spawn_pane')).toHaveLength(1)
    expect(JSON.parse(useWorkspaceStore.getState().layoutJson ?? '{}')).toEqual({ version: 3, dockview: null })
  })

  test('creates a registered worktree transaction and launches its bound child workspace', async () => {
    const childSession: SessionMeta = { id: 'session-worktree', name: 'Fix Login', paneCount: 0, createdAt: 126, workspaceFolder: 'E:/managed-worktrees/fix-login' }
    const projection = worktreeFixture(childSession)
    useWorkspaceStore.setState({
      sessions: [createdSession],
      settings: normalizeSettings({
        ...useWorkspaceStore.getState().settings,
        profiles: [...useWorkspaceStore.getState().settings.profiles, defaultSettings.profiles.find((profile) => profile.id === 'claude')!],
        workspaceSortMode: 'manual',
        workspaceOrder: [createdSession.id],
      }),
    })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'worktree_lifecycle_create') return { worktree: projection.record, sessionId: childSession.id }
      if (command === 'list_sessions') return [createdSession, childSession]
      if (command === 'worktree_registry_list') return [projection]
      if (command === 'attach_session') return { layoutJson: null, panes: [] }
      if (command === 'spawn_pane') return { ...spawnedPane, id: 'pane-worktree', config: { ...spawnedPane.config, paneId: 'pane-worktree' } }
      return null
    })

    const creating = useWorkspaceStore.getState().createWorktreeSession({
      parentSessionId: createdSession.id, name: 'Fix Login', startRef: 'origin/main', branch: 'vibelink/fix-login', profileId: 'codex', initialAgent: 'claude', initialPrompt: 'Fix the login redirect',
    })
    await vi.waitFor(() => expect(isWorkspaceInitialPanePending(childSession.id, getWorkspaceSessionEpoch())).toBe(true))
    await useWorkspaceStore.getState().spawnPane(childSession.id, { paneId: 'pane-worktree', cols: 160, rows: 44 })
    const created = await creating

    expect(created).toEqual(childSession)
    expect(invoke).toHaveBeenCalledWith('worktree_lifecycle_create', { request: expect.objectContaining({ parentSessionId: createdSession.id, branch: 'vibelink/fix-login', origin: 'manual' }) })
    expect(useWorkspaceStore.getState().worktreeProjections).toEqual([projection])
    expect(useWorkspaceStore.getState().settings.workspaceOrder).toEqual([createdSession.id, childSession.id])
    expect(useWorkspaceStore.getState().settings.workspaceProfileIds[childSession.id]).toBe('claude')
    expect(invoke).toHaveBeenCalledWith('write_pane', { sessionId: childSession.id, paneId: 'pane-worktree', data: 'Fix the login redirect' })
    expect(invoke).toHaveBeenCalledWith('write_pane', { sessionId: childSession.id, paneId: 'pane-worktree', data: '\r' })
  })

  test('refreshes the daemon-created workspace session after importing an external worktree', async () => {
    const importedSession: SessionMeta = {
      id: 'session-imported',
      name: 'external-feature',
      paneCount: 0,
      createdAt: 127,
      workspaceFolder: 'E:/external-worktrees/feature',
    }
    const projection = worktreeFixture(importedSession, {
      branch: 'feature/external',
      origin: 'external_import',
      worktreePath: importedSession.workspaceFolder!,
    })
    useWorkspaceStore.setState({ sessions: [createdSession], worktreeProjections: [] })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'worktree_registry_import') return projection
      if (command === 'list_sessions') return [createdSession, importedSession]
      if (command === 'worktree_registry_list') return [projection]
      return null
    })

    const imported = await useWorkspaceStore.getState().importExternalWorktree({
      repositoryPath: 'E:/repo',
      worktreePath: importedSession.workspaceFolder!,
      parentSessionId: createdSession.id,
    })

    expect(imported).toEqual(projection)
    expect(invoke).toHaveBeenCalledWith('worktree_registry_import', {
      request: {
        repositoryPath: 'E:/repo',
        worktreePath: importedSession.workspaceFolder,
        parentSessionId: createdSession.id,
        sessionId: null,
      },
    })
    expect(useWorkspaceStore.getState().sessions).toEqual([createdSession, importedSession])
    expect(useWorkspaceStore.getState().worktreeProjections).toEqual([projection])
  })

  test('does not overwrite manual workspace order when a smart-sorted worktree is created', async () => {
    const childSession: SessionMeta = { id: 'session-worktree', name: 'Fix Login', paneCount: 0, createdAt: 126, workspaceFolder: 'E:/managed-worktrees/fix-login' }
    const projection = worktreeFixture(childSession)
    const workspaceOrder = ['manual-preserved', createdSession.id]
    useWorkspaceStore.setState({
      sessions: [createdSession],
      settings: normalizeSettings({ ...useWorkspaceStore.getState().settings, workspaceSortMode: 'smart', workspaceOrder }),
    })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'worktree_lifecycle_create') return { worktree: projection.record, sessionId: childSession.id }
      if (command === 'list_sessions') return [createdSession, childSession]
      if (command === 'worktree_registry_list') return [projection]
      if (command === 'attach_session') return { layoutJson: null, panes: [] }
      if (command === 'spawn_pane') return { ...spawnedPane, id: 'pane-worktree', config: { ...spawnedPane.config, paneId: 'pane-worktree' } }
      return null
    })

    await useWorkspaceStore.getState().createWorktreeSession({
      parentSessionId: createdSession.id, name: 'Fix Login', startRef: 'origin/main', branch: 'vibelink/fix-login', profileId: 'agent',
    })

    expect(useWorkspaceStore.getState().settings.workspaceOrder).toEqual(workspaceOrder)
  })

  test('removes a registered worktree only after blocker preflight succeeds', async () => {
    const worktreeSession: SessionMeta = { id: 'session-worktree', name: 'Fix Login', paneCount: 0, createdAt: 126, workspaceFolder: 'E:/managed-worktrees/fix-login' }
    const projection = worktreeFixture(worktreeSession)
    useWorkspaceStore.setState({ sessions: [createdSession, worktreeSession], worktreeProjections: [projection], activeSessionId: createdSession.id })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'worktree_removal_preflight') return { worktreeId: projection.id, instanceId: projection.instanceId, repositoryPath: 'E:/repo', worktreePath: worktreeSession.workspaceFolder, branch: 'vibelink/fix-login', blockers: [], warnings: [] }
      if (command === 'worktree_lifecycle_remove') return { checkoutRemoved: true, branchDeleted: true, branchPreservedReason: null, sessionRemoved: true, metadataRemoved: true }
      if (command === 'list_sessions') return [createdSession]
      if (command === 'worktree_registry_list') return []
      return null
    })

    await useWorkspaceStore.getState().removeWorktreeSession(worktreeSession.id, { deleteBranch: true, acknowledgedBlockers: [] })

    expect(invoke).toHaveBeenCalledWith('worktree_lifecycle_remove', { request: expect.objectContaining({ worktreeId: projection.id, expectedInstanceId: projection.instanceId, deleteBranch: true }) })
    expect(useWorkspaceStore.getState().sessions).toEqual([createdSession])
    expect(useWorkspaceStore.getState().worktreeProjections).toEqual([])
  })

  test('keeps the registered session and metadata when lifecycle removal fails', async () => {
    const worktreeSession: SessionMeta = { id: 'session-worktree', name: 'Fix Login', paneCount: 0, createdAt: 126, workspaceFolder: 'E:/managed-worktrees/fix-login' }
    const projection = worktreeFixture(worktreeSession)
    useWorkspaceStore.setState({ sessions: [createdSession, worktreeSession], worktreeProjections: [projection] })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'worktree_removal_preflight') return { worktreeId: projection.id, instanceId: projection.instanceId, repositoryPath: 'E:/repo', worktreePath: worktreeSession.workspaceFolder, branch: 'vibelink/fix-login', blockers: [], warnings: [] }
      if (command === 'worktree_lifecycle_remove') throw new Error('worktree is locked')
      return null
    })

    await expect(useWorkspaceStore.getState().removeWorktreeSession(worktreeSession.id, { deleteBranch: false, acknowledgedBlockers: [] })).rejects.toThrow('worktree is locked')
    expect(useWorkspaceStore.getState().sessions).toContainEqual(worktreeSession)
    expect(useWorkspaceStore.getState().worktreeProjections).toEqual([projection])
  })

  test('refuses removal and skips GUI cleanup when a live blocker was not acknowledged', async () => {
    const worktreeSession: SessionMeta = { id: 'session-worktree', name: 'Fix Login', paneCount: 0, createdAt: 126, workspaceFolder: 'E:/managed-worktrees/fix-login' }
    const projection = worktreeFixture(worktreeSession)
    useWorkspaceStore.setState({ sessions: [createdSession, worktreeSession], worktreeProjections: [projection] })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'worktree_removal_preflight') return { worktreeId: projection.id, instanceId: projection.instanceId, repositoryPath: 'E:/repo', worktreePath: worktreeSession.workspaceFolder, branch: 'vibelink/fix-login', blockers: [{ kind: 'dirty', hard: false, message: 'Uncommitted changes are present.' }], warnings: [] }
      return null
    })

    await expect(useWorkspaceStore.getState().removeWorktreeSession(worktreeSession.id, { deleteBranch: false, acknowledgedBlockers: [] }))
      .rejects.toThrow('Uncommitted changes are present.')
    expect(invoke).not.toHaveBeenCalledWith('browser_cleanup_workspace', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('worktree_lifecycle_remove', expect.anything())
    expect(useWorkspaceStore.getState().sessions).toContainEqual(worktreeSession)
  })

  test('refuses removal on a hard blocker even when it was passed as acknowledged', async () => {
    const worktreeSession: SessionMeta = { id: 'session-worktree', name: 'Fix Login', paneCount: 0, createdAt: 126, workspaceFolder: 'E:/managed-worktrees/fix-login' }
    const projection = worktreeFixture(worktreeSession)
    useWorkspaceStore.setState({ sessions: [createdSession, worktreeSession], worktreeProjections: [projection] })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'worktree_removal_preflight') return { worktreeId: projection.id, instanceId: projection.instanceId, repositoryPath: 'E:/repo', worktreePath: worktreeSession.workspaceFolder, branch: 'vibelink/fix-login', blockers: [{ kind: 'git_locked', hard: true, message: 'The checkout is locked by Git.' }], warnings: [] }
      return null
    })

    await expect(useWorkspaceStore.getState().removeWorktreeSession(worktreeSession.id, { deleteBranch: false, acknowledgedBlockers: ['git_locked'] }))
      .rejects.toThrow('The checkout is locked by Git.')
    expect(invoke).not.toHaveBeenCalledWith('worktree_lifecycle_remove', expect.anything())
  })

  test('moves a registered worktree by stable id and refreshes its bound session', async () => {
    const worktreeSession: SessionMeta = { id: 'session-worktree', name: 'Fix Login', paneCount: 0, createdAt: 126, workspaceFolder: 'E:/managed-worktrees/fix-login' }
    const projection = worktreeFixture(worktreeSession)
    const movedPath = 'E:/target/fix-login-normalized'
    const movedSession = { ...worktreeSession, workspaceFolder: movedPath }
    const movedProjection = worktreeFixture(movedSession, { worktreePath: movedPath })
    useWorkspaceStore.setState({ sessions: [createdSession, worktreeSession], worktreeProjections: [projection] })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'worktree_lifecycle_move') return { worktree: movedProjection.record, previousPath: projection.record?.worktreePath }
      if (command === 'list_sessions') return [createdSession, movedSession]
      if (command === 'worktree_registry_list') return [movedProjection]
      return null
    })

    await useWorkspaceStore.getState().moveWorktreeSession(worktreeSession.id, '  E:/target/fix-login  ')

    expect(invoke).toHaveBeenCalledWith('worktree_lifecycle_move', { request: expect.objectContaining({ worktreeId: projection.id, expectedInstanceId: projection.instanceId, destinationPath: 'E:/target/fix-login' }) })
    expect(useWorkspaceStore.getState().sessions).toContainEqual(movedSession)
    expect(useWorkspaceStore.getState().worktreeProjections).toEqual([movedProjection])
  })

  test('writes the registry migration marker only after every legacy row reconciles', async () => {
    const worktreeSession: SessionMeta = { id: 'session-worktree', name: 'Fix Login', paneCount: 0, createdAt: 126, workspaceFolder: 'E:/managed-worktrees/fix-login' }
    const projection = worktreeFixture(worktreeSession)
    // The shared stub is call-recording only; back it with real storage so the
    // migration's read → reconcile → delete round-trip is actually observable.
    const stored = new Map<string, string>([['vibelink:settings', JSON.stringify({
      workspaceWorktrees: {
        'session-worktree': {
          parentSessionId: createdSession.id,
          sourceWorkspaceFolder: 'E:/repo',
          worktreePath: 'E:/managed-worktrees/fix-login',
          branch: 'vibelink/fix-login',
          startRef: 'HEAD',
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      },
    })]])
    localStorageStub.getItem.mockImplementation((key: string) => stored.get(key) ?? null)
    localStorageStub.setItem.mockImplementation((key: string, value: string) => { stored.set(key, value) })
    useWorkspaceStore.setState({ settings: normalizeSettings({ ...useWorkspaceStore.getState().settings, worktreeRegistryMigrationVersion: 0 }) })
    const reconcileRequests: unknown[] = []
    vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'list_sessions') return [createdSession, worktreeSession]
      if (command === 'worktree_registry_reconcile') {
        reconcileRequests.push(args && typeof args === 'object' && 'request' in args ? args.request : null)
        return [projection]
      }
      if (command === 'attention_snapshot') return { capturedAt: 0, panes: [] }
      if (command === 'attach_session') return { layoutJson: null, panes: [] }
      return null
    })

    await useWorkspaceStore.getState().bootstrap()

    expect(reconcileRequests).toContainEqual(expect.objectContaining({
      repositoryPath: 'E:/repo',
      legacyRows: [expect.objectContaining({ sessionId: 'session-worktree', branch: 'vibelink/fix-login', startRef: 'HEAD' })],
    }))
    expect(useWorkspaceStore.getState().settings.worktreeRegistryMigrationVersion).toBe(1)
    expect(JSON.parse(stored.get('vibelink:settings') ?? '{}')).not.toHaveProperty('workspaceWorktrees')
  })

  test('recovers a lost folder group during bootstrap and persists the recovered membership', async () => {
    const root: SessionMeta = { id: 'workspace-root', name: 'VibeLink', paneCount: 1, createdAt: 120, workspaceFolder: 'E:/VibeCodingProject/vibelink' }
    const app: SessionMeta = { id: 'workspace-app', name: 'vibelink-app', paneCount: 1, createdAt: 121, workspaceFolder: 'E:/VibeCodingProject/vibelink/vibelink-app' }
    const web: SessionMeta = { id: 'workspace-web', name: 'vibelink-web', paneCount: 1, createdAt: 122, workspaceFolder: 'E:/VibeCodingProject/vibelink/vibelink-web' }
    const stored = new Map<string, string>()
    localStorageStub.getItem.mockImplementation((key: string) => stored.get(key) ?? null)
    localStorageStub.setItem.mockImplementation((key: string, value: string) => { stored.set(key, value) })
    useWorkspaceStore.setState({
      settings: normalizeSettings({
        ...useWorkspaceStore.getState().settings,
        workspaceGroups: [],
        workspaceGroupIds: {},
        worktreeRegistryMigrationVersion: 1,
      }),
    })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'license_status') return unlicensedStatus
      if (command === 'agent_cli_status') return []
      if (command === 'list_sessions') return [root, app, web]
      if (command === 'worktree_registry_reconcile') return []
      if (command === 'attention_snapshot') return { capturedAt: 0, panes: [] }
      return null
    })

    await useWorkspaceStore.getState().bootstrap()

    const settings = useWorkspaceStore.getState().settings
    expect(settings.workspaceGroups).toEqual([expect.objectContaining({ name: 'vibelink', rootFolder: 'E:/VibeCodingProject/vibelink' })])
    const groupId = settings.workspaceGroups[0]?.id
    expect(groupId).toBe('recovered-workspace-root')
    expect(settings.workspaceGroupIds).toEqual({
      'workspace-root': groupId,
      'workspace-app': groupId,
      'workspace-web': groupId,
    })
    expect(stored.get('vibelink:workspaceGroupRecovery:v1')).toBe('1')
    expect(JSON.parse(stored.get('vibelink:settings') ?? '{}').workspaceGroupIds).toEqual(settings.workspaceGroupIds)
  })

  test('repairs a saved rootless group even after one-time group recovery already ran', async () => {
    const root: SessionMeta = { id: 'workspace-root', name: 'VibeLink', paneCount: 1, createdAt: 120, workspaceFolder: 'E:/VibeCodingProject/vibelink' }
    const duplicateRoot: SessionMeta = { ...root, id: 'workspace-root-duplicate', createdAt: 121 }
    const app: SessionMeta = { id: 'workspace-app', name: 'vibelink-app', paneCount: 1, createdAt: 122, workspaceFolder: 'E:/VibeCodingProject/vibelink/vibelink-app' }
    const web: SessionMeta = { id: 'workspace-web', name: 'vibelink-web', paneCount: 1, createdAt: 123, workspaceFolder: 'E:/VibeCodingProject/vibelink/vibelink-web' }
    const stored = new Map<string, string>([['vibelink:workspaceGroupRecovery:v1', '1']])
    localStorageStub.getItem.mockImplementation((key: string) => stored.get(key) ?? null)
    localStorageStub.setItem.mockImplementation((key: string, value: string) => { stored.set(key, value) })
    useWorkspaceStore.setState({
      settings: normalizeSettings({
        ...useWorkspaceStore.getState().settings,
        workspaceGroups: [{ id: 'group-vibelink', name: 'VibeLink', collapsed: false, rootFolder: null }],
        workspaceGroupIds: { [app.id]: 'group-vibelink', [web.id]: 'group-vibelink' },
        worktreeRegistryMigrationVersion: 1,
      }),
    })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'license_status') return unlicensedStatus
      if (command === 'agent_cli_status') return []
      if (command === 'list_sessions') return [duplicateRoot, app, root, web]
      if (command === 'worktree_registry_reconcile') return []
      if (command === 'attention_snapshot') return { capturedAt: 0, panes: [] }
      return null
    })

    await useWorkspaceStore.getState().bootstrap()

    expect(useWorkspaceStore.getState().settings.workspaceGroups[0]?.rootFolder).toBe('E:/VibeCodingProject/vibelink')
    expect(JSON.parse(stored.get('vibelink:settings') ?? '{}').workspaceGroups[0].rootFolder).toBe('E:/VibeCodingProject/vibelink')
  })

  test('keeps the migration marker unset when a legacy reconcile fails', async () => {
    const stored = new Map<string, string>([['vibelink:settings', JSON.stringify({
      workspaceWorktrees: {
        'session-worktree': {
          parentSessionId: createdSession.id,
          sourceWorkspaceFolder: 'E:/repo',
          worktreePath: 'E:/managed-worktrees/fix-login',
          branch: 'vibelink/fix-login',
          startRef: 'HEAD',
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      },
    })]])
    localStorageStub.getItem.mockImplementation((key: string) => stored.get(key) ?? null)
    localStorageStub.setItem.mockImplementation((key: string, value: string) => { stored.set(key, value) })
    useWorkspaceStore.setState({ settings: normalizeSettings({ ...useWorkspaceStore.getState().settings, worktreeRegistryMigrationVersion: 0 }) })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'list_sessions') return [createdSession]
      if (command === 'worktree_registry_reconcile') throw new Error('repository identity is unavailable')
      if (command === 'attention_snapshot') return { capturedAt: 0, panes: [] }
      return null
    })

    await useWorkspaceStore.getState().bootstrap()

    expect(useWorkspaceStore.getState().settings.worktreeRegistryMigrationVersion).toBe(0)
    expect(JSON.parse(stored.get('vibelink:settings') ?? '{}')).toHaveProperty('workspaceWorktrees')
  })

  test('keeps a failed creation pending with its recovery detail instead of discarding it', async () => {
    useWorkspaceStore.setState({ sessions: [createdSession], pendingWorktreeCreations: {} })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'worktree_lifecycle_create') throw new Error('setup failed; retained E:/managed-worktrees/fix-login')
      return null
    })

    await expect(useWorkspaceStore.getState().createWorktreeSession({
      parentSessionId: createdSession.id, name: 'Fix Login', startRef: 'HEAD', branch: 'vibelink/fix-login', profileId: 'agent',
    })).rejects.toThrow('setup failed')

    const pending = Object.values(useWorkspaceStore.getState().pendingWorktreeCreations)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ stage: 'failed', name: 'Fix Login' })
    expect(pending[0].error).toContain('retained E:/managed-worktrees/fix-login')
  })

  test('retries a failed creation under a fresh operation id', async () => {
    const childSession: SessionMeta = { id: 'session-worktree', name: 'Fix Login', paneCount: 0, createdAt: 126, workspaceFolder: 'E:/managed-worktrees/fix-login' }
    const projection = worktreeFixture(childSession)
    useWorkspaceStore.setState({ sessions: [createdSession], pendingWorktreeCreations: {} })
    let attempt = 0
    const operationIds: string[] = []
    vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'worktree_lifecycle_create') {
        const request = args && typeof args === 'object' && 'request' in args ? args.request : null
        if (request && typeof request === 'object' && 'operationId' in request && typeof request.operationId === 'string') {
          operationIds.push(request.operationId)
        }
        attempt += 1
        if (attempt === 1) throw new Error('transient failure')
        return { worktree: projection.record, sessionId: childSession.id }
      }
      if (command === 'list_sessions') return [createdSession, childSession]
      if (command === 'worktree_registry_list') return [projection]
      if (command === 'attach_session') return { layoutJson: null, panes: [] }
      if (command === 'spawn_pane') return { ...spawnedPane, id: 'pane-worktree', config: { ...spawnedPane.config, paneId: 'pane-worktree' } }
      return null
    })

    await expect(useWorkspaceStore.getState().createWorktreeSession({
      parentSessionId: createdSession.id, name: 'Fix Login', startRef: 'HEAD', branch: 'vibelink/fix-login', profileId: 'agent',
    })).rejects.toThrow('transient failure')
    const [failedOperationId] = Object.keys(useWorkspaceStore.getState().pendingWorktreeCreations)

    await useWorkspaceStore.getState().retryPendingWorktreeCreation(failedOperationId)

    expect(operationIds).toHaveLength(2)
    expect(operationIds[0]).not.toBe(operationIds[1])
    expect(useWorkspaceStore.getState().sessions).toContainEqual(childSession)
  })

  test('finishes a creation in the background without stealing focus from another workspace', async () => {
    const childSession: SessionMeta = { id: 'session-worktree', name: 'Fix Login', paneCount: 0, createdAt: 126, workspaceFolder: 'E:/managed-worktrees/fix-login' }
    const otherSession: SessionMeta = { id: 'session-other', name: 'Other', paneCount: 0, createdAt: 127, workspaceFolder: 'E:/repo-other' }
    const projection = worktreeFixture(childSession)
    useWorkspaceStore.setState({ sessions: [createdSession, otherSession], activeSessionId: createdSession.id, pendingWorktreeCreations: {} })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'worktree_lifecycle_create') {
        // The user navigates away while the checkout is still provisioning.
        useWorkspaceStore.setState({ activeSessionId: otherSession.id })
        return { worktree: projection.record, sessionId: childSession.id }
      }
      if (command === 'list_sessions') return [createdSession, otherSession, childSession]
      if (command === 'worktree_registry_list') return [projection]
      return null
    })

    const created = await useWorkspaceStore.getState().createWorktreeSession({
      parentSessionId: createdSession.id, name: 'Fix Login', startRef: 'HEAD', branch: 'vibelink/fix-login', profileId: 'agent',
    })

    expect(created).toEqual(childSession)
    expect(useWorkspaceStore.getState().activeSessionId).toBe(otherSession.id)
    expect(invoke).not.toHaveBeenCalledWith('attach_session', { sessionId: childSession.id })
    const pending = Object.values(useWorkspaceStore.getState().pendingWorktreeCreations)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ stage: 'complete', sessionId: childSession.id })
  })

  test('adds a local folder to an existing folderless workspace', async () => {
    const folderless = { ...profileSession, name: 'Workspace 1' }
    const updated = { ...folderless, workspaceFolder: 'E:/repo' }
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'set_session_workspace_folder') return null
      if (command === 'list_sessions') return [updated]
      return null
    })
    useWorkspaceStore.setState({ sessions: [folderless], activeSessionId: folderless.id })

    await useWorkspaceStore.getState().setSessionWorkspaceFolder(folderless.id, '  E:/repo  ')

    expect(invoke).toHaveBeenCalledWith('set_session_workspace_folder', {
      sessionId: folderless.id,
      workspaceFolder: 'E:/repo',
    })
    expect(useWorkspaceStore.getState().sessions[0].workspaceFolder).toBe('E:/repo')
  })

  test('attachSession replaces legacy page layouts with a v3 envelope', async () => {
    const persistedLayout = JSON.stringify({
      version: 2,
      activePageId: 'scratch',
      pages: [
        { id: 'scratch', name: 'Scratch', layoutJson: null, createdAt: 1, updatedAt: 1 },
        { id: 'planning', name: 'Old Planning', layoutJson: null, createdAt: 2, updatedAt: 3 },
      ],
    })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'attach_session') return { layoutJson: persistedLayout, panes: [nonAgentPane] }
      return null
    })
    useWorkspaceStore.setState({ sessions: [createdSession] })

    await useWorkspaceStore.getState().attachSession(createdSession.id)

    expect(JSON.parse(useWorkspaceStore.getState().layoutJson ?? '{}')).toEqual({ version: 3, dockview: null })
  })

  test('refreshAttachedSession keeps the frontend layout and only reconciles panes', async () => {
    // save_layout itself makes the daemon emit SessionChanged, which lands here.
    // Adopting the daemon copy replayed a layout the view had just written, so
    // WorkspaceView cleared and restored the whole dock and flickered in a loop.
    const staleDaemonLayout = JSON.stringify({ version: 3, dockview: null })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'attach_session') return { layoutJson: null, panes: [nonAgentPane] }
      return null
    })
    useWorkspaceStore.setState({ sessions: [createdSession] })
    await useWorkspaceStore.getState().attachSession(createdSession.id)
    const authoredByView = JSON.stringify({ version: 3, dockview: null, authored: true })
    useWorkspaceStore.setState({ layoutJson: authoredByView })

    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'attach_session') return { layoutJson: staleDaemonLayout, panes: [nonAgentPane, spawnedPane] }
      return null
    })
    await useWorkspaceStore.getState().refreshAttachedSession(createdSession.id)

    expect(useWorkspaceStore.getState().layoutJson).toBe(authoredByView)
    expect(Object.keys(useWorkspaceStore.getState().panes).sort()).toEqual([nonAgentPane.id, spawnedPane.id].sort())
  })

  test('attachSession detaches the previously active workspace', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'attach_session') return { layoutJson: null, panes: [nonAgentPane] }
      return null
    })
    useWorkspaceStore.setState({ activeSessionId: createdSession.id })

    await useWorkspaceStore.getState().attachSession(secondSession.id)

    expect(invoke).toHaveBeenCalledWith('detach_session', { sessionId: createdSession.id })
  })

  test('bootstrap loads sessions without auto-opening a workspace', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'license_status') return unlicensedStatus
      if (command === 'list_sessions') return [createdSession]
      if (command === 'attach_session') return { layoutJson: null, panes: [] }
      if (command === 'spawn_pane') return spawnedPane
      return null
    })

    await useWorkspaceStore.getState().bootstrap()

    expect(useWorkspaceStore.getState().sessions).toEqual([createdSession])
    expect(useWorkspaceStore.getState().activeSessionId).toBeUndefined()
    expect(useWorkspaceStore.getState().status).toBe('ready')
    expect(invoke).not.toHaveBeenCalledWith('attach_session', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('spawn_pane', expect.anything())
  })

  test('openSession leaves an empty workspace ready for a measured pane spawn', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'attach_session') return { layoutJson: null, panes: [] }
      if (command === 'list_sessions') return [createdSession]
      if (command === 'spawn_pane') return spawnedPane
      return null
    })
    useWorkspaceStore.setState({ sessions: [createdSession] })

    await useWorkspaceStore.getState().openSession(createdSession.id)
    expect(isWorkspaceInitialPanePending(createdSession.id, getWorkspaceSessionEpoch())).toBe(true)
    await useWorkspaceStore.getState().spawnPane(createdSession.id, { paneId: 'pane-test', cols: 222, rows: 77 })

    expect(invoke).toHaveBeenCalledWith('attach_session', { sessionId: createdSession.id })
    expect(invoke).toHaveBeenCalledWith('spawn_pane', {
      sessionId: 'session-workspace',
      cfg: expect.objectContaining({ cwd: 'E:/repo', cols: 222, rows: 77 }),
    })
  })

  test('createSession launches the initial pane with the requested profile', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'create_session') return createdSession
      if (command === 'list_sessions') return [createdSession]
      if (command === 'attach_session') return { layoutJson: null, panes: [] }
      if (command === 'spawn_pane') return spawnedPane
      return null
    })
    useWorkspaceStore.setState({
      settings: normalizeSettings({
        ...defaultSettings,
        defaultProfileId: 'agent',
        profiles: [
          {
            id: 'ssh-dev',
            name: 'SSH Dev',
            type: 'ssh',
            sshHost: 'dev.example.com',
            sshUser: 'me',
            sshRemoteCwd: '/srv/app',
            env: [],
            cwd: 'E:/local-ssh-launch-dir',
            color: '#76e3ea',
            icon: 'radio-tower',
          },
        ],
      }),
    })

    await useWorkspaceStore.getState().createSession('Remote', 'E:/repo', 'ssh-dev')
    await useWorkspaceStore.getState().spawnPane(createdSession.id, { paneId: 'pane-test', cols: 222, rows: 77 })

    expect(invoke).toHaveBeenCalledWith('spawn_pane', {
      sessionId: 'session-workspace',
      cfg: expect.objectContaining({
        shell: 'ssh',
        args: ['-t', 'me@dev.example.com', "cd -- 'E:/repo' && exec \"${SHELL:-sh}\" -l"],
        cwd: 'E:/local-ssh-launch-dir',
        title: 'SSH Dev',
      }),
    })
  })

  test('spawnPane prefers the session workspace folder over the active profile cwd', async () => {
    await attachReadySession(createdSession)

    await useWorkspaceStore.getState().spawnPane(createdSession.id, { paneId: 'pane-test' })

    expect(invoke).toHaveBeenCalledWith('spawn_pane', {
      sessionId: 'session-workspace',
      cfg: expect.objectContaining({ cwd: 'E:/repo' }),
    })
  })

  test('spawnPane preserves an explicit cwd override when a session has a workspace folder', async () => {
    await attachReadySession(createdSession)

    await useWorkspaceStore.getState().spawnPane(createdSession.id, { paneId: 'pane-test', cwd: null })

    expect(invoke).toHaveBeenCalledWith('spawn_pane', {
      sessionId: 'session-workspace',
      cfg: expect.objectContaining({ cwd: null }),
    })
  })

  test('setDefaultProfile stores the active profile per workspace', async () => {
    useWorkspaceStore.setState({
      sessions: [createdSession, secondSession],
      settings: normalizeSettings({
        ...defaultSettings,
        defaultProfileId: 'agent',
        profiles: [
          {
            id: 'agent',
            name: 'Codex',
            shell: 'codex.cmd',
            args: [],
            env: [],
            cwd: null,
            color: '#7ee787',
            icon: 'bot',
          },
          {
            id: 'powershell',
            name: 'PowerShell',
            shell: 'pwsh.exe',
            args: ['-NoLogo'],
            env: [],
            cwd: null,
            color: '#58a6ff',
            icon: 'terminal-square',
          },
        ],
      }),
    })
    await attachReadySession(createdSession, [createdSession, secondSession])

    useWorkspaceStore.getState().setDefaultProfile('powershell')

    expect(useWorkspaceStore.getState().settings.defaultProfileId).toBe('agent')
    expect(useWorkspaceStore.getState().settings.workspaceProfileIds).toMatchObject({
      [createdSession.id]: 'powershell',
    })

    await useWorkspaceStore.getState().spawnPane(createdSession.id, { paneId: 'pane-test' })

    expect(invoke).toHaveBeenCalledWith('spawn_pane', {
      sessionId: createdSession.id,
      cfg: expect.objectContaining({
        shell: 'pwsh.exe',
        title: 'PowerShell',
      }),
    })
  })

  test('renamePaneTitle persists a manual title and updates local pane metadata', async () => {
    useWorkspaceStore.setState({ activeSessionId: createdSession.id, panes: { 'pane-test': spawnedPane } })

    await useWorkspaceStore.getState().renamePaneTitle('pane-test', 'Manual Codex', 'manual')

    expect(invoke).toHaveBeenCalledWith('set_pane_title', { sessionId: createdSession.id, paneId: 'pane-test', title: 'Manual Codex' })
    expect(useWorkspaceStore.getState().panes['pane-test'].config.title).toBe('Manual Codex')
  })

  test('renamePaneTitle skips unchanged titles', async () => {
    useWorkspaceStore.setState({
      activeSessionId: createdSession.id,
      panes: { 'pane-test': { ...spawnedPane, config: { ...spawnedPane.config, title: 'Manual Codex' } } },
    })

    await useWorkspaceStore.getState().renamePaneTitle('pane-test', 'Manual Codex', 'manual')

    expect(invoke).not.toHaveBeenCalledWith('set_pane_title', expect.anything())
  })

  test('applyPaneConfiguration skips unchanged titles', () => {
    useWorkspaceStore.setState({
      panes: { 'pane-test': { ...spawnedPane, config: { ...spawnedPane.config, title: 'Same' } } },
      manualPaneTitles: {},
    })

    useWorkspaceStore.getState().applyPaneConfiguration('pane-test', { title: 'Same' })

    expect(useWorkspaceStore.getState().manualPaneTitles['pane-test']).toBeUndefined()
  })

  test('applyTerminalTitle does not overwrite manual pane titles', async () => {
    useWorkspaceStore.setState({ activeSessionId: createdSession.id, panes: { 'pane-test': spawnedPane } })
    await useWorkspaceStore.getState().renamePaneTitle('pane-test', 'Manual Codex', 'manual')

    await useWorkspaceStore.getState().applyTerminalTitle('pane-test', 'Codex: auto task')

    expect(useWorkspaceStore.getState().panes['pane-test'].config.title).toBe('Manual Codex')
  })

  test('stores Hermes session metadata and replaces transcripts', () => {
    const store = useWorkspaceStore.getState()

    store.addHermesUserMessage('session-1', 'old')
    store.setHermesTranscript('session-1', [{ role: 'assistant', text: 'restored', thoughts: 'thinking', toolCalls: [] }])
    store.setHermesCurrentSession('session-1', 'acp-1')
    store.setHermesSessions('session-1', [{
      id: 'acp-1',
      title: null,
      updatedAt: '2026-07-18T00:00:00.000Z',
      cwd: 'E:/repo',
    }])

    expect(useWorkspaceStore.getState().hermesTranscript['session-1']).toEqual([{ role: 'assistant', text: 'restored', thoughts: 'thinking', toolCalls: [] }])
    expect(useWorkspaceStore.getState().hermesCurrentSession['session-1']).toBe('acp-1')
    expect(useWorkspaceStore.getState().hermesSessions['session-1']).toHaveLength(1)
  })

  test('preserves Hermes assistant event order inside a turn', () => {
    const store = useWorkspaceStore.getState()

    store.appendHermesText('session-1', 'message', 'before')
    store.addHermesToolCall('session-1', { id: 'tool-1', title: 'Read file', toolKind: 'read', status: 'running' })
    store.appendHermesText('session-1', 'message', 'after')
    store.appendHermesText('session-1', 'thought', 'thinking')

    expect(useWorkspaceStore.getState().hermesTranscript['session-1'][0].parts).toEqual([
      { kind: 'message', text: 'before' },
      { kind: 'toolCall', toolCallId: 'tool-1' },
      { kind: 'message', text: 'after' },
      { kind: 'thought', text: 'thinking' },
    ])
  })

  test('hook completion survives active-state changes until explicitly acknowledged', () => {
    vi.stubGlobal('document', { hasFocus: () => true })
    useWorkspaceStore.setState({
      activeSessionId: createdSession.id,
      activePaneId: 'pane-test',
      panes: { 'pane-test': spawnedPane },
      paneCompletionHighlights: {},
    })

    useWorkspaceStore.getState().markPaneHookComplete('pane-test', createdSession.id)

    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-test']).toMatchObject({ source: 'agent-hook', sessionId: createdSession.id })

    useWorkspaceStore.getState().setActivePaneId('pane-test')
    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-test']).toBeDefined()

    useWorkspaceStore.getState().clearPaneCompletionHighlight('pane-test')
    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-test']).toBeUndefined()
  })

  test('hook completion records agent history independently from the pane highlight', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123)
    useWorkspaceStore.setState({ panes: { 'pane-test': spawnedPane }, paneCompletionHighlights: {}, completionHistory: [] })

    useWorkspaceStore.getState().markPaneHookComplete('pane-test', createdSession.id, 'codex')
    expect(useWorkspaceStore.getState().completionHistory).toEqual([{ id: 'pane-test:123', paneId: 'pane-test', sessionId: createdSession.id, paneTitle: 'Codex', agent: 'codex', completedAt: 123, read: false }])
    useWorkspaceStore.getState().clearPaneCompletionHighlight('pane-test')
    expect(useWorkspaceStore.getState().completionHistory).toHaveLength(1)
    useWorkspaceStore.getState().markCompletionRead('pane-test:123')
    expect(useWorkspaceStore.getState().completionHistory[0].read).toBe(true)
    useWorkspaceStore.getState().markCompletionUnread('pane-test:123')
    expect(useWorkspaceStore.getState().completionHistory[0].read).toBe(false)
  })

  test('reviewed pane marker toggles explicitly and acknowledges completion', () => {
    useWorkspaceStore.setState({
      activeSessionId: createdSession.id,
      activePaneId: 'pane-test',
      panes: { 'pane-test': spawnedPane },
      paneCompletionHighlights: {
        'pane-test': { completedAt: 1, source: 'agent-hook', sessionId: createdSession.id },
      },
      paneReviewMarkers: {},
    })

    useWorkspaceStore.getState().togglePaneReviewed('pane-test')

    expect(useWorkspaceStore.getState().paneReviewMarkers['pane-test']).toMatchObject({ sessionId: createdSession.id })
    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-test']).toBeUndefined()

    useWorkspaceStore.getState().setActivePaneId(undefined)
    expect(useWorkspaceStore.getState().paneReviewMarkers['pane-test']).toBeDefined()

    useWorkspaceStore.getState().togglePaneReviewed('pane-test')
    expect(useWorkspaceStore.getState().paneReviewMarkers['pane-test']).toBeUndefined()
  })

  test('reviewed pane markers persist valid entries and ignore malformed storage', () => {
    const stored = loadPaneReviewMarkers({
      getItem: () => JSON.stringify({
        'pane-valid': { reviewedAt: 123, sessionId: 'session-1' },
        'pane-invalid': { reviewedAt: 'now', sessionId: '' },
      }),
    })
    expect(stored).toEqual({ 'pane-valid': { reviewedAt: 123, sessionId: 'session-1' } })
    expect(loadPaneReviewMarkers({ getItem: () => '{broken' })).toEqual({})

    const storage = { setItem: vi.fn(), removeItem: vi.fn() }
    persistPaneReviewMarkers(stored, storage)
    expect(storage.setItem).toHaveBeenCalledWith('vibelink:paneReviewMarkers', JSON.stringify(stored))

    persistPaneReviewMarkers({}, storage)
    expect(storage.removeItem).toHaveBeenCalledWith('vibelink:paneReviewMarkers')
  })

  test('completion markers persist valid entries until explicit acknowledgement', () => {
    const stored = loadPaneCompletionHighlights({
      getItem: () => JSON.stringify({
        'pane-valid': { completedAt: 123, source: 'agent-hook', sessionId: 'session-1' },
        'pane-invalid-source': { completedAt: 124, source: 'unknown', sessionId: 'session-1' },
        'pane-non-hook': { completedAt: 125, source: 'task-done', sessionId: 'session-1' },
        'pane-invalid-time': { completedAt: 'now', source: 'agent-hook', sessionId: 'session-1' },
      }),
    })
    expect(stored).toEqual({ 'pane-valid': { completedAt: 123, source: 'agent-hook', sessionId: 'session-1' } })
    expect(loadPaneCompletionHighlights({ getItem: () => '{broken' })).toEqual({})

    const storage = { setItem: vi.fn(), removeItem: vi.fn() }
    persistPaneCompletionHighlights(stored, storage)
    expect(storage.setItem).toHaveBeenCalledWith('vibelink:paneCompletionHighlights', JSON.stringify(stored))

    persistPaneCompletionHighlights({}, storage)
    expect(storage.removeItem).toHaveBeenCalledWith('vibelink:paneCompletionHighlights')
  })

  test('completion history validates, persists, and removes its storage entry', () => {
    const stored = loadCompletionHistory({
      getItem: () => JSON.stringify([
        { id: 'pane-1:123', paneId: 'pane-1', sessionId: 'session-1', paneTitle: 'Codex', agent: 'codex', completedAt: 123, read: true },
        { id: '', paneId: 'pane-2', sessionId: 'session-1', completedAt: 124 },
      ]),
    })
    expect(stored).toEqual([{ id: 'pane-1:123', paneId: 'pane-1', sessionId: 'session-1', paneTitle: 'Codex', agent: 'codex', completedAt: 123, read: true }])
    expect(loadCompletionHistory({ getItem: () => '{broken' })).toEqual([])

    const storage = { setItem: vi.fn(), removeItem: vi.fn() }
    persistCompletionHistory(stored, storage)
    expect(storage.setItem).toHaveBeenCalledWith('vibelink:completionHistory', JSON.stringify(stored))
    persistCompletionHistory([], storage)
    expect(storage.removeItem).toHaveBeenCalledWith('vibelink:completionHistory')
  })

  test('only manual mode can overwrite persisted workspace order', () => {
    useWorkspaceStore.setState({ settings: normalizeSettings({ workspaceSortMode: 'smart', workspaceOrder: ['a', 'b'] }) })
    useWorkspaceStore.getState().reorderWorkspaces(['b', 'a'])
    expect(useWorkspaceStore.getState().settings.workspaceOrder).toEqual(['a', 'b'])

    useWorkspaceStore.setState({ settings: normalizeSettings({ workspaceSortMode: 'manual', workspaceOrder: ['a', 'b'] }) })
    useWorkspaceStore.getState().reorderWorkspaces(['b', 'a'])
    expect(useWorkspaceStore.getState().settings.workspaceOrder).toEqual(['b', 'a'])
  })

  test('hook completion highlights the active agent pane while the app is unfocused', () => {
    useWorkspaceStore.setState({
      activeSessionId: createdSession.id,
      activePaneId: 'pane-test',
      panes: { 'pane-test': spawnedPane },
      paneCompletionHighlights: {},
    })

    useWorkspaceStore.getState().markPaneHookComplete('pane-test', createdSession.id)

    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-test']).toMatchObject({ source: 'agent-hook' })
  })

  test('hook completion remains while an inactive workspace or pane becomes active', () => {
    vi.stubGlobal('document', { hasFocus: () => true })
    useWorkspaceStore.setState({
      activeSessionId: createdSession.id,
      activePaneId: undefined,
      panes: { 'pane-test': spawnedPane },
      paneCompletionHighlights: {},
    })

    useWorkspaceStore.getState().markPaneHookComplete('pane-test', createdSession.id)
    useWorkspaceStore.getState().setActivePaneId('pane-test')

    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-test']).toMatchObject({ source: 'agent-hook' })

    useWorkspaceStore.getState().clearPaneCompletionHighlight('pane-test')
    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-test']).toBeUndefined()
  })

  test('terminal quiet completion only clears working state', () => {
    useWorkspaceStore.setState({
      paneAgentActivity: { 'pane-test': { startedAt: 1 } },
      paneCompletionHighlights: {},
    })

    useWorkspaceStore.getState().notePaneAgentTurnEnd('pane-test')

    expect(useWorkspaceStore.getState().paneAgentActivity['pane-test']).toBeUndefined()
    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-test']).toBeUndefined()
  })

  test('completion counts stay associated with their workspace', () => {
    expect(paneCompletionCountsBySession({
      'pane-a': { completedAt: 1, source: 'agent-hook', sessionId: createdSession.id },
      'pane-b': { completedAt: 2, source: 'agent-hook', sessionId: createdSession.id },
      'pane-c': { completedAt: 3, source: 'agent-hook', sessionId: secondSession.id },
    })).toEqual({ [createdSession.id]: 2, [secondSession.id]: 1 })
  })

  test('switching workspaces preserves completion highlights from inactive workspaces', async () => {
    const otherPane = { ...spawnedPane, id: 'pane-other', config: { ...spawnedPane.config, paneId: 'pane-other' } }
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'attach_session') return { layoutJson: null, panes: [otherPane] }
      return null
    })
    useWorkspaceStore.setState({
      sessions: [createdSession, secondSession],
      activeSessionId: createdSession.id,
      panes: { [spawnedPane.id]: spawnedPane },
      paneCompletionHighlights: {
        [spawnedPane.id]: { completedAt: 1, source: 'agent-hook', sessionId: createdSession.id },
      },
    })

    await useWorkspaceStore.getState().attachSession(secondSession.id)

    expect(useWorkspaceStore.getState().paneCompletionHighlights[spawnedPane.id]).toMatchObject({ sessionId: createdSession.id })
  })

  test('deleteSession clears Hermes session browser state', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'delete_session') return null
      if (command === 'list_sessions') return [secondSession]
      if (command === 'attach_session') return { layoutJson: null, panes: [spawnedPane] }
      return null
    })
    useWorkspaceStore.setState({
      sessions: [createdSession, secondSession],
      hermesCurrentSession: { [createdSession.id]: 'acp-1' },
      hermesSessions: { [createdSession.id]: [{ id: 'acp-1', title: null, updatedAt: '2026-07-18T00:00:00.000Z', cwd: 'E:/repo' }] },
      hermesTranscript: { [createdSession.id]: [{ role: 'user', text: 'hello', thoughts: '', toolCalls: [] }] },
    })

    await useWorkspaceStore.getState().deleteSession(createdSession.id)

    expect(useWorkspaceStore.getState().hermesCurrentSession[createdSession.id]).toBeUndefined()
    expect(useWorkspaceStore.getState().hermesSessions[createdSession.id]).toBeUndefined()
    expect(useWorkspaceStore.getState().hermesTranscript[createdSession.id]).toBeUndefined()
  })

  test('setPaneRole preserves keybindings identity while updating pane roles', () => {
    useWorkspaceStore.setState({
      settings: normalizeSettings({
        ...defaultSettings,
        keybindings: { ...defaultSettings.keybindings, splitRight: 'Ctrl+Alt+Right' },
        paneRoles: {},
      }),
    })
    const keybindings = useWorkspaceStore.getState().settings.keybindings

    useWorkspaceStore.getState().setPaneRole('pane-test', 'Reviewer')

    expect(useWorkspaceStore.getState().settings.paneRoles).toEqual({ 'pane-test': 'Reviewer' })
    expect(useWorkspaceStore.getState().settings.keybindings).toBe(keybindings)
  })

  test('deleteSession prunes pane keyed maps for the deleted active session', async () => {
    const survivorPane: PaneMeta = {
      ...spawnedPane,
      id: 'pane-survivor',
      config: { ...spawnedPane.config, paneId: 'pane-survivor', title: 'Survivor' },
    }
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'delete_session') return null
      if (command === 'list_sessions') return [secondSession]
      if (command === 'attach_session') return { layoutJson: null, panes: [survivorPane] }
      return null
    })
    useWorkspaceStore.setState({
      sessions: [createdSession, secondSession],
      activeSessionId: createdSession.id,
      panes: { [spawnedPane.id]: spawnedPane, [nonAgentPane.id]: nonAgentPane },
      manualPaneTitles: { [spawnedPane.id]: true, [nonAgentPane.id]: true, [survivorPane.id]: true },
      capturesByPane: { [spawnedPane.id]: ['deleted.png'], [nonAgentPane.id]: ['deleted-shell.png'], [survivorPane.id]: ['keep.png'] },
      settings: normalizeSettings({
        ...defaultSettings,
        paneRoles: { [spawnedPane.id]: 'Deleted agent', [nonAgentPane.id]: 'Deleted shell', [survivorPane.id]: 'Keep' },
      }),
    })

    await useWorkspaceStore.getState().deleteSession(createdSession.id)

    expect(useWorkspaceStore.getState().manualPaneTitles).toEqual({ [survivorPane.id]: true })
    const cleanupCall = vi.mocked(invoke).mock.calls.findIndex(([command]) => command === 'agent_workspace_cleanup')
    const deleteCall = vi.mocked(invoke).mock.calls.findIndex(([command]) => command === 'delete_session')
    expect(cleanupCall).toBeGreaterThanOrEqual(0)
    expect(deleteCall).toBeGreaterThan(cleanupCall)
    expect(useWorkspaceStore.getState().capturesByPane).toEqual({ [survivorPane.id]: ['keep.png'] })
    expect(useWorkspaceStore.getState().settings.paneRoles).toEqual({ [survivorPane.id]: 'Keep' })
  })

  test('cancels a pane closed before its spawn reply arrives', async () => {
    let resolveSpawn: ((pane: PaneMeta) => void) | undefined
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'attach_session') return { layoutJson: null, panes: [nonAgentPane] }
      if (command === 'spawn_pane') {
        return await new Promise<PaneMeta>((resolve) => { resolveSpawn = resolve })
      }
      if (command === 'cancel_pane_spawn') return null
      if (command === 'list_sessions') return []
      return null
    })
    await useWorkspaceStore.getState().attachSession('session-1')

    const spawning = useWorkspaceStore.getState().spawnPane('session-1', { paneId: 'pane-test' })
    expect(useWorkspaceStore.getState().paneLifecycle['pane-test']).toBe('spawning')

    await useWorkspaceStore.getState().closePane('pane-test')
    resolveSpawn?.(spawnedPane)

    await expect(spawning).rejects.toThrow('PANE_SPAWN_CANCELLED')
    expect(useWorkspaceStore.getState().paneLifecycle['pane-test']).toBe('closed')
    expect(useWorkspaceStore.getState().panes['pane-test']).toBeUndefined()
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'cancel_pane_spawn')).toHaveLength(2)
    expect(invoke).not.toHaveBeenCalledWith('close_pane', expect.anything())
  })

  test('deduplicates concurrent closes for a live pane', async () => {
    let releaseClose: (() => void) | undefined
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'close_pane') await new Promise<void>((resolve) => { releaseClose = resolve })
      if (command === 'list_sessions') return []
      return null
    })
    useWorkspaceStore.setState({
      activeSessionId: 'session-1',
      panes: { [spawnedPane.id]: spawnedPane },
      paneLifecycle: { [spawnedPane.id]: 'live' },
    })

    const first = useWorkspaceStore.getState().closePane(spawnedPane.id)
    const duplicate = useWorkspaceStore.getState().closePane(spawnedPane.id)
    await duplicate
    releaseClose?.()
    await first

    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'close_pane')).toHaveLength(1)
    expect(useWorkspaceStore.getState().paneLifecycle[spawnedPane.id]).toBe('closed')
  })

  test('collapses a burst of session refreshes into one in-flight pass plus one follow-up', async () => {
    let release: (() => void) | undefined
    const listed: Promise<void>[] = []
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command !== 'list_sessions') return null
      // Hold the FIRST pass open so the rest of the burst arrives while it runs.
      if (listed.length === 0) {
        listed.push(new Promise<void>((resolve) => { release = resolve }))
        await listed[0]
      }
      return [createdSession]
    })
    useWorkspaceStore.setState({ sessions: [] })

    const burst = Array.from({ length: 7 }, () => useWorkspaceStore.getState().refreshSessions())
    release?.()
    await Promise.all(burst)

    // A parallel grid spawn must not fan out to one list_sessions per pane, and
    // two passes must never reconcile removed workspaces at the same time.
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'list_sessions')).toHaveLength(2)
    expect(useWorkspaceStore.getState().sessions).toEqual([createdSession])
  })

  test('claims, releases, and acknowledges Hermes prompts without duplication', () => {
    const store = useWorkspaceStore.getState()

    store.enqueueHermesPrompt('session-1', 'first')
    store.enqueueHermesPrompt('session-1', 'second')

    const first = useWorkspaceStore.getState().claimHermesPrompt('session-1')
    expect(first?.text).toBe('first')
    expect(useWorkspaceStore.getState().claimHermesPrompt('session-1')).toBeUndefined()

    useWorkspaceStore.getState().releaseHermesPrompt('session-1', first!.id)
    expect(useWorkspaceStore.getState().claimHermesPrompt('session-1')).toEqual(first)
    useWorkspaceStore.getState().ackHermesPrompt('session-1', first!.id)

    const second = useWorkspaceStore.getState().claimHermesPrompt('session-1')
    expect(second?.text).toBe('second')
    useWorkspaceStore.getState().ackHermesPrompt('session-1', second!.id)
    expect(useWorkspaceStore.getState().hermesPendingPrompts['session-1']).toEqual([])
  })
})
