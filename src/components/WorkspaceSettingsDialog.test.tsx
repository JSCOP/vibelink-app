// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SessionMeta } from '../ipc/types'
import { defaultSettings, normalizeSettings } from '../state/profiles'
import { useWorkspaceStore } from '../state/store'
import { WorkspaceSettingsDialog } from './WorkspaceSettingsDialog'

const session: SessionMeta = {
  id: 'workspace-a',
  name: 'VibeLink',
  paneCount: 2,
  createdAt: 1,
  workspaceFolder: 'E:/VibeCodingProject/vibelink',
}

describe('WorkspaceSettingsDialog', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      agentClis: [],
      settings: normalizeSettings(defaultSettings),
    })
  })

  afterEach(cleanup)

  test('saves workspace metadata and the default terminal profile together', async () => {
    const settings = normalizeSettings({
      ...defaultSettings,
      workspaceProfileIds: { 'workspace-a': 'codex', untouched: 'default' },
      workspaceDetails: {
        'workspace-a': { githubIssue: '12', githubPullRequest: '', notes: 'Old note' },
        untouched: { githubIssue: '', githubPullRequest: '34', notes: '' },
      },
    })
    const onChange = vi.fn()
    const onRename = vi.fn(async () => undefined)
    const onClose = vi.fn()
    render(<WorkspaceSettingsDialog session={session} settings={settings} onChange={onChange} onRename={onRename} onClose={onClose} />)

    expect(screen.getByRole('combobox', { name: 'Default profile' })).toHaveValue('codex')
    const nameInput = screen.getByRole('textbox', { name: 'Name' })
    expect(nameInput).toHaveFocus()
    fireEvent.change(nameInput, { target: { value: 'VibeLink Desktop' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Default profile' }), { target: { value: 'claude' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Issue' }), { target: { value: 'https://github.com/JSCOP/vibelink-app/issues/42' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Pull request' }), { target: { value: '77' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: '**Ship it**' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onRename).toHaveBeenCalledExactlyOnceWith('workspace-a', 'VibeLink Desktop'))
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      workspaceProfileIds: { 'workspace-a': 'claude', untouched: 'default' },
      workspaceDetails: {
        'workspace-a': {
          githubIssue: 'https://github.com/JSCOP/vibelink-app/issues/42',
          githubPullRequest: '77',
          notes: '**Ship it**',
        },
        untouched: { githubIssue: '', githubPullRequest: '34', notes: '' },
      },
      workspaceGroupIds: {},
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  test('stages workspace group assignment and removal in the same settings patch', () => {
    const workspaceGroups = [
      { id: 'group-a', name: 'Client work', collapsed: false },
      { id: 'group-b', name: 'Internal', collapsed: false },
    ]
    const assignmentSettings = normalizeSettings({
      ...defaultSettings,
      workspaceGroups,
      workspaceGroupIds: { untouched: 'group-b' },
    })
    useWorkspaceStore.setState({ settings: assignmentSettings })
    const onAssign = vi.fn()
    const firstRender = render(
      <WorkspaceSettingsDialog
        session={session}
        settings={assignmentSettings}
        onChange={onAssign}
        onRename={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByRole('combobox', { name: 'Workspace group' }), { target: { value: 'group-a' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onAssign).toHaveBeenCalledExactlyOnceWith({
      workspaceProfileIds: { 'workspace-a': 'default' },
      workspaceDetails: {},
      workspaceGroupIds: { untouched: 'group-b', 'workspace-a': 'group-a' },
    })

    firstRender.unmount()
    const removalSettings = normalizeSettings({
      ...defaultSettings,
      workspaceGroups,
      workspaceGroupIds: { 'workspace-a': 'group-a', untouched: 'group-b' },
    })
    useWorkspaceStore.setState({ settings: removalSettings })
    const onRemove = vi.fn()
    render(
      <WorkspaceSettingsDialog
        session={session}
        settings={removalSettings}
        onChange={onRemove}
        onRename={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByRole('combobox', { name: 'Workspace group' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onRemove).toHaveBeenCalledExactlyOnceWith({
      workspaceProfileIds: { 'workspace-a': 'default' },
      workspaceDetails: {},
      workspaceGroupIds: { untouched: 'group-b' },
    })
  })
})
