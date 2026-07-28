// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { SessionMeta } from '../ipc/types'
import { StartupWorkspaceDialog } from './StartupWorkspaceDialog'

const sessions: SessionMeta[] = [
  { id: 'blocked', name: 'Blocked', paneCount: 1, createdAt: 1, workspaceFolder: 'E:/blocked' },
  { id: 'done', name: 'Done', paneCount: 1, createdAt: 2, workspaceFolder: 'E:/done' },
  { id: 'working', name: 'Working', paneCount: 1, createdAt: 3, workspaceFolder: 'E:/working' },
  { id: 'idle', name: 'Idle', paneCount: 1, createdAt: 4, workspaceFolder: 'E:/idle' },
]

describe('StartupWorkspaceDialog', () => {
  test('preserves the shared derived order instead of pinning the last active workspace', () => {
    render(<StartupWorkspaceDialog sessions={sessions} lastActiveSessionId="idle" onOpen={vi.fn()} onCreate={vi.fn()} />)

    expect(screen.getAllByRole('button').slice(0, 4).map((button) => button.textContent)).toEqual([
      expect.stringContaining('Blocked'),
      expect.stringContaining('Done'),
      expect.stringContaining('Working'),
      expect.stringContaining('Idle'),
    ])
    expect(screen.getByText('Last').closest('button')).toHaveTextContent('Idle')
  })
})
