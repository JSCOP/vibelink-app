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
    useWorkspaceStore.setState({ agentClis: [] })
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

    expect(screen.getByRole('combobox', { name: /Default terminal profile/ })).toHaveValue('codex')
    fireEvent.change(screen.getByRole('textbox', { name: /Display name/ }), { target: { value: 'VibeLink Desktop' } })
    fireEvent.change(screen.getByRole('combobox', { name: /Default terminal profile/ }), { target: { value: 'claude' } })
    fireEvent.change(screen.getByRole('textbox', { name: /GitHub issue/ }), { target: { value: 'https://github.com/JSCOP/vibelink-app/issues/42' } })
    fireEvent.change(screen.getByRole('textbox', { name: /GitHub pull request/ }), { target: { value: '77' } })
    fireEvent.change(screen.getByRole('textbox', { name: /Notes/ }), { target: { value: '**Ship it**' } })
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
    })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
