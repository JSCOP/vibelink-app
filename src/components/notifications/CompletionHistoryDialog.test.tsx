// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useWorkspaceStore, type CompletionHistoryEntry } from '../../state/store'
import { CompletionHistoryDialog } from './CompletionHistoryDialog'

const entry: CompletionHistoryEntry = { id: 'pane-1:1', paneId: 'pane-1', sessionId: 'session-1', paneTitle: 'Codex', agent: 'codex', completedAt: Date.now() - 60_000, read: true }
const unreadEntry: CompletionHistoryEntry = { id: 'pane-2:2', paneId: 'pane-2', sessionId: 'session-1', paneTitle: 'Claude', agent: 'claude', completedAt: Date.now() - 30_000, read: false }

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

test('filters unread completions and marks all as read', () => {
  useWorkspaceStore.setState({ completionHistory: [entry, unreadEntry] })
  render(<CompletionHistoryDialog onClose={vi.fn()} onActivate={vi.fn()} />)

  const filter = screen.getByRole('group', { name: 'Completion history filter' })
  expect(within(filter).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
  const unreadFilter = within(filter).getByRole('button', { name: 'Unread' })
  expect(filter).toContainElement(unreadFilter)
  fireEvent.click(unreadFilter)
  expect(screen.queryByText('Codex')).toBeNull()
  expect(screen.getByText('Claude')).toBeTruthy()

  const markAllRead = screen.getByRole('button', { name: 'Mark all read' })
  fireEvent.click(markAllRead)
  expect(useWorkspaceStore.getState().completionHistory.every((completion) => completion.read)).toBe(true)
  expect(screen.getByText('No unread completions.')).toBeTruthy()
  expect(markAllRead).toBeDisabled()
})
