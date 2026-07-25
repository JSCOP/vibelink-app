// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, open } = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open }))

import type { SessionMeta } from '../../ipc/types'
import { defaultSettings, normalizeSettings } from '../../state/profiles'
import { useWorkspaceStore } from '../../state/store'
import { ImportReposDialog } from './ImportReposDialog'

const discoveredRepos = [
  { name: 'repo-a', path: 'E:/code/mono/repo-a', isSubmodule: false },
  { name: 'repo-b', path: 'E:/code/mono/repo-b', isSubmodule: false },
  { name: 'shared-submodule', path: 'E:/code/mono/shared-submodule', isSubmodule: true },
]

const createSession = vi.fn(async (name?: string, workspaceFolder?: string | null): Promise<SessionMeta> => ({
  id: `session-${name}`,
  name: name ?? '',
  paneCount: 0,
  createdAt: 0,
  workspaceFolder,
}))
const createWorkspaceGroup = vi.fn(() => ({ id: 'group-1', name: 'mono', collapsed: false, rootFolder: 'E:\\code\\mono' }))
const setWorkspaceGroup = vi.fn()
const setError = vi.fn()

describe('ImportReposDialog', () => {
  beforeEach(() => {
    window.localStorage.clear()
    open.mockReset()
    invoke.mockReset()
    createSession.mockClear()
    createWorkspaceGroup.mockClear()
    setWorkspaceGroup.mockClear()
    setError.mockClear()
    open.mockResolvedValue('E:\\code\\mono')
    invoke.mockImplementation(async (command: string) => {
      if (command === 'git_discover_repos') return discoveredRepos
      throw new Error(`Unexpected command: ${command}`)
    })
    useWorkspaceStore.setState({
      settings: normalizeSettings({ ...defaultSettings, defaultProfileId: 'codex' }),
      createSession,
      createWorkspaceGroup,
      setWorkspaceGroup,
      setError,
    })
  })

  afterEach(cleanup)

  it('selects every discovered repository by default and toggles the selection count', async () => {
    render(<ImportReposDialog onClose={() => undefined} />)

    expect(await screen.findByText('3 / 3 selected')).toBeInTheDocument()
    expect(open).toHaveBeenCalledWith({ directory: true, multiple: false, title: 'Import repos from folder' })
    expect(screen.getByText('SUB')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('git_discover_repos', { root: 'E:\\code\\mono', maxDepth: null })

    fireEvent.click(screen.getByRole('button', { name: 'Select none' }))
    expect(screen.getByText('0 / 3 selected')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByText('3 / 3 selected')).toBeInTheDocument()
  })

  it('creates one group and assigns every imported workspace to it', async () => {
    const onClose = vi.fn()
    // Hold the first creation open to prove imports run sequentially: no second
    // workspace and no group assignment may happen until it resolves.
    let releaseFirstSession!: (session: SessionMeta) => void
    createSession.mockImplementationOnce(() => new Promise<SessionMeta>((resolve) => { releaseFirstSession = resolve }))
    render(<ImportReposDialog onClose={onClose} />)
    await screen.findByText('3 / 3 selected')

    fireEvent.click(screen.getByRole('button', { name: 'Yes, import as a group' }))
    await waitFor(() => expect(createSession).toHaveBeenCalledOnce())
    expect(setWorkspaceGroup).not.toHaveBeenCalled()
    releaseFirstSession({
      id: 'session-repo-a',
      name: 'repo-a',
      paneCount: 0,
      createdAt: 0,
      workspaceFolder: 'E:/code/mono/repo-a',
    })

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(3))
    expect(createWorkspaceGroup).toHaveBeenCalledWith('mono', 'E:\\code\\mono')
    expect(createSession.mock.calls).toEqual([
      ['repo-a', 'E:/code/mono/repo-a', 'codex'],
      ['repo-b', 'E:/code/mono/repo-b', 'codex'],
      ['shared-submodule', 'E:/code/mono/shared-submodule', 'codex'],
    ])
    expect(setWorkspaceGroup.mock.calls).toEqual([
      ['session-repo-a', 'group-1'],
      ['session-repo-b', 'group-1'],
      ['session-shared-submodule', 'group-1'],
    ])
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })

  it('imports separately without creating or assigning a group', async () => {
    render(<ImportReposDialog onClose={() => undefined} />)
    await screen.findByText('3 / 3 selected')

    fireEvent.click(screen.getByRole('button', { name: 'No, import separately' }))

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(3))
    expect(createWorkspaceGroup).not.toHaveBeenCalled()
    expect(setWorkspaceGroup).not.toHaveBeenCalled()
  })

  it('keeps completed imports and surfaces the first sequential failure', async () => {
    const onClose = vi.fn()
    createSession
      .mockResolvedValueOnce({
        id: 'session-repo-a',
        name: 'repo-a',
        paneCount: 0,
        createdAt: 0,
        workspaceFolder: 'E:/code/mono/repo-a',
      })
      .mockRejectedValueOnce(new Error('import failed'))
    render(<ImportReposDialog onClose={onClose} />)
    await screen.findByText('3 / 3 selected')

    fireEvent.click(screen.getByRole('button', { name: 'Yes, import as a group' }))

    await waitFor(() => expect(setError).toHaveBeenCalledWith('Error: import failed'))
    expect(createSession).toHaveBeenCalledTimes(2)
    expect(setWorkspaceGroup).toHaveBeenCalledExactlyOnceWith('session-repo-a', 'group-1')
    expect(onClose).not.toHaveBeenCalled()
  })
})
