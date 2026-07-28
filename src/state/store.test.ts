import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { LicenseStatus, PaneMeta, SessionMeta } from '../ipc/types'
import { defaultSettings, normalizeSettings } from './profiles'
import { loadPaneReviewMarkers, paneCompletionCountsBySession, persistPaneReviewMarkers, resetWorkspaceSessionOwnershipForTests, useWorkspaceStore } from './store'

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
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
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
    localStorageStub.getItem.mockReturnValue(null)
    localStorageStub.setItem.mockClear()
    localStorageStub.removeItem.mockClear()
    localStorageStub.clear.mockClear()
    vi.mocked(invoke).mockClear()
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'license_status') return unlicensedStatus
      if (command === 'spawn_pane') return spawnedPane
      if (command === 'attach_session') return { layoutJson: null, panes: [] }
      if (command === 'list_sessions') return []
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
      manualPaneTitles: {},
      layoutJson: null,
      status: 'ready',
      error: undefined,
      hermesPendingPrompts: {},
      hermesTranscript: {},
      hermesCurrentSession: {},
      paneCompletionHighlights: {},
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

  test('createSession persists a workspace folder and launches exactly one initial pane there', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'create_session') return createdSession
      if (command === 'list_sessions') return [createdSession]
      if (command === 'attach_session') return { layoutJson: null, panes: [] }
      if (command === 'spawn_pane') return spawnedPane
      return null
    })

    await useWorkspaceStore.getState().createSession('Repo', 'E:/repo')

    expect(invoke).toHaveBeenCalledWith('create_session', {
      name: 'Repo',
      workspaceFolder: 'E:/repo',
    })
    expect(invoke).toHaveBeenCalledWith('spawn_pane', {
      sessionId: 'session-workspace',
      cfg: expect.objectContaining({ cwd: 'E:/repo' }),
    })
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'spawn_pane')).toHaveLength(1)
    expect(JSON.parse(useWorkspaceStore.getState().layoutJson ?? '{}')).toEqual({ version: 3, dockview: null })
  })

  test('creates a named Git worktree and launches the chosen agent inside its child workspace', async () => {
    const childSession: SessionMeta = {
      id: 'session-worktree',
      name: 'Fix Login',
      paneCount: 0,
      createdAt: 126,
      workspaceFolder: 'E:/managed-worktrees/fix-login-abcd1234',
    }
    const worktreeStorage = {
      mode: 'custom' as const,
      drive: 'E:',
      folderName: 'TeamWorktrees',
      customRoot: 'E:/managed-worktrees',
      groupByRepository: false,
    }
    useWorkspaceStore.setState({
      sessions: [createdSession],
      settings: normalizeSettings({ ...useWorkspaceStore.getState().settings, workspaceOrder: [createdSession.id], worktreeStorage }),
    })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'git_worktree_create_named') return {
        worktreePath: childSession.workspaceFolder,
        branch: 'vibelink/fix-login',
      }
      if (command === 'create_session') return childSession
      if (command === 'list_sessions') return [createdSession, childSession]
      if (command === 'attach_session') return { layoutJson: null, panes: [] }
      if (command === 'spawn_pane') return { ...spawnedPane, id: 'pane-worktree', config: { ...spawnedPane.config, paneId: 'pane-worktree' } }
      return null
    })

    const created = await useWorkspaceStore.getState().createWorktreeSession({
      parentSessionId: createdSession.id,
      name: 'Fix Login',
      startRef: 'origin/main',
      branch: 'vibelink/fix-login',
      profileId: 'agent',
    })

    expect(created).toEqual(childSession)
    expect(invoke).toHaveBeenCalledWith('git_worktree_create_named', {
      workspaceFolder: 'E:/repo',
      name: 'Fix Login',
      startRef: 'origin/main',
      branch: 'vibelink/fix-login',
      storage: worktreeStorage,
    })
    expect(invoke).toHaveBeenCalledWith('spawn_pane', {
      sessionId: childSession.id,
      cfg: expect.objectContaining({ cwd: childSession.workspaceFolder, profileId: 'agent' }),
    })
    expect(useWorkspaceStore.getState().settings.workspaceWorktrees[childSession.id]).toMatchObject({
      parentSessionId: createdSession.id,
      sourceWorkspaceFolder: createdSession.workspaceFolder,
      worktreePath: childSession.workspaceFolder,
      branch: 'vibelink/fix-login',
      startRef: 'origin/main',
    })
    expect(useWorkspaceStore.getState().settings.workspaceOrder).toEqual([createdSession.id, childSession.id])
    expect(localStorageStub.setItem).toHaveBeenCalledWith('vibelink:settings', expect.stringContaining('"folderName":"TeamWorktrees"'))
  })

  test('removes a recorded worktree before deleting its workspace session', async () => {
    const worktreeSession: SessionMeta = {
      id: 'session-worktree',
      name: 'Fix Login',
      paneCount: 0,
      createdAt: 126,
      workspaceFolder: 'E:/managed-worktrees/fix-login',
    }
    const relation = {
      parentSessionId: createdSession.id,
      sourceWorkspaceFolder: 'E:/repo',
      worktreePath: worktreeSession.workspaceFolder as string,
      branch: 'vibelink/fix-login',
      startRef: 'origin/main',
      createdAt: '2026-07-27T00:00:00.000Z',
    }
    useWorkspaceStore.setState({
      sessions: [createdSession, worktreeSession],
      activeSessionId: createdSession.id,
      settings: normalizeSettings({
        ...useWorkspaceStore.getState().settings,
        workspaceWorktrees: { [worktreeSession.id]: relation },
        workspaceOrder: [createdSession.id, worktreeSession.id],
      }),
    })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'list_sessions') return [createdSession]
      return null
    })

    await useWorkspaceStore.getState().removeWorktreeSession(worktreeSession.id, { deleteBranch: true, force: false })

    expect(invoke).toHaveBeenCalledWith('git_worktree_remove', {
      workspaceFolder: relation.sourceWorkspaceFolder,
      worktreePath: relation.worktreePath,
      branch: relation.branch,
      force: false,
      deleteBranch: true,
    })
    expect(invoke).toHaveBeenCalledWith('delete_session', { sessionId: worktreeSession.id })
    expect(useWorkspaceStore.getState().sessions).toEqual([createdSession])
    expect(useWorkspaceStore.getState().settings.workspaceWorktrees[worktreeSession.id]).toBeUndefined()
  })

  test('keeps a worktree session when Git removal fails', async () => {
    const worktreeSession: SessionMeta = {
      id: 'session-worktree',
      name: 'Fix Login',
      paneCount: 0,
      createdAt: 126,
      workspaceFolder: 'E:/managed-worktrees/fix-login',
    }
    const relation = {
      parentSessionId: createdSession.id,
      sourceWorkspaceFolder: 'E:/repo',
      worktreePath: worktreeSession.workspaceFolder as string,
      branch: 'vibelink/fix-login',
      startRef: 'origin/main',
      createdAt: '2026-07-27T00:00:00.000Z',
    }
    useWorkspaceStore.setState({
      sessions: [createdSession, worktreeSession],
      settings: normalizeSettings({ ...useWorkspaceStore.getState().settings, workspaceWorktrees: { [worktreeSession.id]: relation } }),
    })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'git_worktree_remove') throw new Error('worktree is locked')
      return null
    })

    await expect(useWorkspaceStore.getState().removeWorktreeSession(worktreeSession.id, { deleteBranch: false, force: true }))
      .rejects.toThrow('worktree is locked')

    expect(invoke).not.toHaveBeenCalledWith('delete_session', expect.anything())
    expect(useWorkspaceStore.getState().sessions).toContainEqual(worktreeSession)
    expect(useWorkspaceStore.getState().settings.workspaceWorktrees[worktreeSession.id]).toEqual(relation)
  })

  test('moves a recorded worktree and updates its workspace folder metadata', async () => {
    const worktreeSession: SessionMeta = {
      id: 'session-worktree',
      name: 'Fix Login',
      paneCount: 0,
      createdAt: 126,
      workspaceFolder: 'E:/managed-worktrees/fix-login',
    }
    const relation = {
      parentSessionId: createdSession.id,
      sourceWorkspaceFolder: 'E:/repo',
      worktreePath: worktreeSession.workspaceFolder as string,
      branch: 'vibelink/fix-login',
      startRef: 'origin/main',
      createdAt: '2026-07-27T00:00:00.000Z',
    }
    const movedPath = 'E:/target/fix-login-normalized'
    const movedSession = { ...worktreeSession, workspaceFolder: movedPath }
    useWorkspaceStore.setState({
      sessions: [createdSession, worktreeSession],
      settings: normalizeSettings({ ...useWorkspaceStore.getState().settings, workspaceWorktrees: { [worktreeSession.id]: relation } }),
    })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'git_worktree_move') return { worktreePath: movedPath, branch: relation.branch }
      if (command === 'list_sessions') return [createdSession, movedSession]
      return null
    })

    await useWorkspaceStore.getState().moveWorktreeSession(worktreeSession.id, '  E:/target/fix-login  ')

    expect(invoke).toHaveBeenCalledWith('git_worktree_move', {
      workspaceFolder: relation.sourceWorkspaceFolder,
      worktreePath: relation.worktreePath,
      destinationPath: 'E:/target/fix-login',
    })
    expect(invoke).toHaveBeenCalledWith('set_session_workspace_folder', {
      sessionId: worktreeSession.id,
      workspaceFolder: movedPath,
    })
    expect(useWorkspaceStore.getState().sessions).toContainEqual(movedSession)
    expect(useWorkspaceStore.getState().settings.workspaceWorktrees[worktreeSession.id].worktreePath).toBe(movedPath)
    expect(localStorageStub.setItem).toHaveBeenCalledWith('vibelink:settings', expect.stringContaining(movedPath))
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

  test('openSession launches an empty workspace pane in the workspace folder', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'attach_session') return { layoutJson: null, panes: [] }
      if (command === 'list_sessions') return [createdSession]
      if (command === 'spawn_pane') return spawnedPane
      return null
    })
    useWorkspaceStore.setState({ sessions: [createdSession] })

    await useWorkspaceStore.getState().openSession(createdSession.id)

    expect(invoke).toHaveBeenCalledWith('attach_session', { sessionId: createdSession.id })
    expect(invoke).toHaveBeenCalledWith('spawn_pane', {
      sessionId: 'session-workspace',
      cfg: expect.objectContaining({ cwd: 'E:/repo' }),
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

  test('pane completion survives active-state changes until explicitly acknowledged', () => {
    vi.stubGlobal('document', { hasFocus: () => true })
    useWorkspaceStore.setState({
      activeSessionId: createdSession.id,
      activePaneId: 'pane-test',
      panes: { 'pane-test': spawnedPane },
      paneCompletionHighlights: {},
    })

    useWorkspaceStore.getState().markPaneResponseComplete('pane-test')

    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-test']).toMatchObject({ source: 'agent-response', sessionId: createdSession.id })

    useWorkspaceStore.getState().setActivePaneId('pane-test')
    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-test']).toBeDefined()

    useWorkspaceStore.getState().clearPaneCompletionHighlight('pane-test')
    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-test']).toBeUndefined()
  })

  test('reviewed pane marker toggles explicitly and acknowledges completion', () => {
    useWorkspaceStore.setState({
      activeSessionId: createdSession.id,
      activePaneId: 'pane-test',
      panes: { 'pane-test': spawnedPane },
      paneCompletionHighlights: {
        'pane-test': { completedAt: 1, source: 'agent-response', sessionId: createdSession.id },
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

  test('pane completion highlights the active agent pane while the app is unfocused', () => {
    useWorkspaceStore.setState({
      activeSessionId: createdSession.id,
      activePaneId: 'pane-test',
      panes: { 'pane-test': spawnedPane },
      paneCompletionHighlights: {},
    })

    useWorkspaceStore.getState().markPaneResponseComplete('pane-test')

    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-test']).toMatchObject({ source: 'agent-response' })
  })

  test('pane completion remains while an inactive workspace or pane becomes active', () => {
    vi.stubGlobal('document', { hasFocus: () => true })
    useWorkspaceStore.setState({
      activeSessionId: createdSession.id,
      activePaneId: undefined,
      panes: { 'pane-test': spawnedPane },
      paneCompletionHighlights: {},
    })

    useWorkspaceStore.getState().markPaneResponseComplete('pane-test')
    useWorkspaceStore.getState().setActivePaneId('pane-test')

    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-test']).toMatchObject({ source: 'agent-response' })

    useWorkspaceStore.getState().clearPaneCompletionHighlight('pane-test')
    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-test']).toBeUndefined()
  })

  test('pane completion does not highlight a non-agent pane', () => {
    useWorkspaceStore.setState({
      activeSessionId: createdSession.id,
      activePaneId: 'pane-shell',
      panes: { 'pane-shell': nonAgentPane },
      paneCompletionHighlights: {},
    })

    useWorkspaceStore.getState().markPaneResponseComplete('pane-shell')

    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-shell']).toBeUndefined()
  })

  test('completion counts stay associated with their workspace', () => {
    expect(paneCompletionCountsBySession({
      'pane-a': { completedAt: 1, source: 'agent-response', sessionId: createdSession.id },
      'pane-b': { completedAt: 2, source: 'task-done', sessionId: createdSession.id },
      'pane-c': { completedAt: 3, source: 'agent-response', sessionId: secondSession.id },
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
        [spawnedPane.id]: { completedAt: 1, source: 'agent-response', sessionId: createdSession.id },
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
    expect(useWorkspaceStore.getState().capturesByPane).toEqual({ [survivorPane.id]: ['keep.png'] })
    expect(useWorkspaceStore.getState().settings.paneRoles).toEqual({ [survivorPane.id]: 'Keep' })
  })

  test('queues Hermes prompts FIFO and drains once', () => {
    const store = useWorkspaceStore.getState()

    store.enqueueHermesPrompt('session-1', 'first')
    store.enqueueHermesPrompt('session-1', 'second')

    expect(useWorkspaceStore.getState().takeHermesPrompt('session-1')).toBe('first')
    expect(useWorkspaceStore.getState().takeHermesPrompt('session-1')).toBe('second')
    expect(useWorkspaceStore.getState().takeHermesPrompt('session-1')).toBeUndefined()
  })
})
