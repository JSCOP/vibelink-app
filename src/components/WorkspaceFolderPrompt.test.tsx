// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStore } from '../state/store'
import { WorkspaceFolderPrompt } from './WorkspaceFolderPrompt'

const { open } = vi.hoisted(() => ({ open: vi.fn() }))

vi.mock('@tauri-apps/plugin-dialog', () => ({ open }))

describe('WorkspaceFolderPrompt', () => {
  beforeEach(() => {
    open.mockReset()
    window.localStorage.clear()
  })

  it('assigns the selected project folder to the existing workspace', async () => {
    const setSessionWorkspaceFolder = vi.fn(async () => undefined)
    useWorkspaceStore.setState({ setSessionWorkspaceFolder })
    open.mockResolvedValue('E:\\repo')

    render(<WorkspaceFolderPrompt sessionId="session-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose workspace folder…' }))

    await waitFor(() => expect(setSessionWorkspaceFolder).toHaveBeenCalledWith('session-1', 'E:\\repo'))
    expect(screen.getByText('This workspace has no local folder.')).toBeTruthy()
  })
})
