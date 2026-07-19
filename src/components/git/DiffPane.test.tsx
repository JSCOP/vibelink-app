// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-diff-viewer-continued', () => ({ default: () => <div data-testid="diff-viewer" /> }))

import { DiffPane } from './DiffPane'

describe('DiffPane', () => {
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
