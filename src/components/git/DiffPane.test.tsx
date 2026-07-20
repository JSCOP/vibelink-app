// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-diff-viewer-continued', () => ({ default: () => <div data-testid="diff-viewer" /> }))

import { DiffPane } from './DiffPane'

beforeEach(cleanup)

describe('DiffPane', () => {
  it('uses a one-column grid when Explorer owns the file list', () => {
    const { container } = render(
      <DiffPane
        files={[]}
        selectedPath="changed.txt"
        onSelect={vi.fn()}
        contents={{ old: 'before', new: 'after', binary: false }}
        loading={false}
        splitView
        hideFileList
      />,
    )

    expect(container.querySelector('.git-diff-pane')?.getAttribute('data-file-list-hidden')).toBe('true')
  })

  it('hides the diff renderer when both sides are identical and empty', () => {
    render(
      <DiffPane
        files={[]}
        selectedPath="clean.txt"
        onSelect={vi.fn()}
        contents={{ old: '', new: '', binary: false }}
        loading={false}
        splitView
        hideFileList
      />,
    )

    expect(screen.getByText('No differences to show.')).toBeTruthy()
    expect(screen.queryByTestId('diff-viewer')).toBeNull()
  })

  it('offers the editor fallback from a diff error', () => {
    const onOpenInEditor = vi.fn()
    render(
      <DiffPane
        files={[]}
        selectedPath="large.txt"
        onSelect={vi.fn()}
        contents={null}
        loading={false}
        splitView
        error="file too large for diff"
        onOpenInEditor={onOpenInEditor}
        hideFileList
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open in editor' }))
    expect(onOpenInEditor).toHaveBeenCalledOnce()
  })
})
