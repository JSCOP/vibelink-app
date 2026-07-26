// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-diff-viewer-continued', () => ({
  DiffMethod: { WORDS_WITH_SPACE: 'diffWordsWithSpace' },
  default: ({ oldValue, newValue, compareMethod }: { oldValue: string; newValue: string; compareMethod: string }) => (
    <div data-testid="diff-viewer" data-old-value={oldValue} data-new-value={newValue} data-compare-method={compareMethod} />
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

  it('labels each changed file with a compact status letter and a distinguishable selection', () => {
    const { container } = render(
      <DiffPane
        files={[
          { path: 'src/layout/WorkspaceView.tsx', changeType: 'modified', additions: 3, deletions: 1, binary: false },
          { path: 'src/new.ts', changeType: 'added', additions: 9, deletions: 0, binary: false },
        ]}
        selectedPath="src/new.ts"
        onSelect={vi.fn()}
        contents={null}
        loading={false}
        splitView
      />,
    )

    const rows = [...container.querySelectorAll('.task-diff-files button')]
    expect(rows.map((row) => row.querySelector('.task-diff-file-badge')?.textContent)).toEqual(['M', 'A'])
    expect(rows.map((row) => row.querySelector('strong')?.textContent)).toEqual(['WorkspaceView.tsx', 'new.ts'])
    expect(rows.map((row) => row.querySelector('small')?.textContent)).toEqual(['src/layout', 'src'])
    expect(rows.map((row) => row.getAttribute('data-selected'))).toEqual([null, 'true'])
    expect(screen.getByLabelText('Modified: src/layout/WorkspaceView.tsx')).toBeTruthy()
  })

  it('diffs changed lines by word so shared letters inside unrelated identifiers stay unhighlighted', () => {
    render(
      <DiffPane
        files={[]}
        selectedPath="words.ts"
        onSelect={vi.fn()}
        contents={{ old: "kind === 'browser'\n", new: "kind === 'editor'\n", binary: false }}
        loading={false}
        splitView
        hideFileList
      />,
    )

    expect(screen.getByTestId('diff-viewer').getAttribute('data-compare-method')).toBe('diffWordsWithSpace')
  })

  it('expands tabs to rendered columns so the syntax overlay lines up with the word diff', () => {
    render(
      <DiffPane
        files={[]}
        selectedPath="tabs.ts"
        onSelect={vi.fn()}
        contents={{ old: '\tconst value = 1\n', new: '\t\tconst value = 2\n', binary: false }}
        loading={false}
        splitView
        hideFileList
      />,
    )

    const viewer = screen.getByTestId('diff-viewer')
    expect(viewer.getAttribute('data-old-value')).toBe('  const value = 1\n')
    expect(viewer.getAttribute('data-new-value')).toBe('    const value = 2\n')
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
