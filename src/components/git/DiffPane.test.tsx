// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-diff-viewer-continued', () => ({
  default: ({ oldValue, newValue }: { oldValue: string; newValue: string }) => (
    <div data-testid="diff-viewer" data-old-value={oldValue} data-new-value={newValue} />
  ),
}))

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

  it('normalizes checkout line endings before rendering changed lines', () => {
    render(
      <DiffPane
        files={[]}
        selectedPath="changed.txt"
        onSelect={vi.fn()}
        contents={{ old: 'same\nbefore\nend\n', new: 'same\r\nafter\r\nend\r\n', binary: false }}
        loading={false}
        splitView
        hideFileList
      />,
    )

    const viewer = screen.getByTestId('diff-viewer')
    expect(viewer.getAttribute('data-old-value')).toBe('same\nbefore\nend\n')
    expect(viewer.getAttribute('data-new-value')).toBe('same\nafter\nend\n')
  })

  it('does not render every line as changed when only checkout line endings differ', () => {
    render(
      <DiffPane
        files={[]}
        selectedPath="line-endings.txt"
        onSelect={vi.fn()}
        contents={{ old: 'one\ntwo\n', new: 'one\r\ntwo\r\n', binary: false }}
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

  it('avoids rendering pathological diffs that can exhaust the Workbench WebView', () => {
    const oversized = 'line\n'.repeat(10_001)
    render(
      <DiffPane
        files={[]}
        selectedPath="large.ts"
        onSelect={vi.fn()}
        contents={{ old: oversized, new: oversized.replaceAll('line', 'changed'), binary: false }}
        loading={false}
        splitView
        hideFileList
      />,
    )

    expect(screen.getByText('Diff is too large to render safely. Narrow the comparison or open the file from Explorer.')).toBeTruthy()
    expect(screen.queryByTestId('diff-viewer')).toBeNull()
  })
})
