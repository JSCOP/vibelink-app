// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useWorkspaceStore, type CompletionHistoryEntry } from '../../state/store'
import { CompletionHistoryDialog } from './CompletionHistoryDialog'

const entry: CompletionHistoryEntry = { id: 'pane-1:1', paneId: 'pane-1', sessionId: 'session-1', paneTitle: 'Codex', agent: 'codex', completedAt: Date.now() - 60_000, read: true }

beforeEach(() => {
  useWorkspaceStore.setState({ sessions: [{ id: 'session-1', name: 'Workspace', paneCount: 1, createdAt: 1, workspaceFolder: 'C:/repo' }], completionHistory: [entry] })
})
afterEach(cleanup)

test('activates rows, restores unread state, and clears history', () => {
  const onActivate = vi.fn()
  render(<CompletionHistoryDialog onClose={vi.fn()} onActivate={onActivate} />)

  fireEvent.click(screen.getByText('Codex').closest('button')!)
  expect(onActivate).toHaveBeenCalledWith(entry)
  fireEvent.click(screen.getByRole('button', { name: 'Mark unread' }))
  expect(useWorkspaceStore.getState().completionHistory[0].read).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
  expect(useWorkspaceStore.getState().completionHistory).toEqual([])
})
