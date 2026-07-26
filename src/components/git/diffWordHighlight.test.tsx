// @vitest-environment jsdom
// Renders the real `react-diff-viewer-continued` (no mock) so the intra-line
// highlight overlay this file asserts on is the one the Workbench paints.
import { cleanup, render, waitFor } from '@testing-library/react'
import { beforeEach, expect, test } from 'vitest'

import { DiffPane } from './DiffPane'

beforeEach(cleanup)

function highlightedFragments(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.task-diff-content ins, .task-diff-content del')]
    .map((node) => node.textContent ?? '')
    .filter((text) => text.trim().length > 0)
}

function renderDiff(path: string, old: string, next: string) {
  return render(
    <DiffPane
      files={[]}
      selectedPath={path}
      onSelect={() => {}}
      contents={{ old, new: next, binary: false }}
      loading={false}
      splitView={false}
      hideFileList
    />,
  )
}

test('highlights whole changed tokens instead of the letters shared by unrelated identifiers', async () => {
  const { container } = renderDiff(
    'panels.ts',
    "if (removed.kind === 'browser') {\n",
    "if (removed.kind === 'editor') {\n",
  )

  // The character-level default matched the shared `brows`/`e`/`r` runs and
  // painted boxes inside both words; every fragment must now be a whole token.
  await waitFor(() => {
    const fragments = highlightedFragments(container)
    expect(fragments).toContain('browser')
    expect(fragments).toContain('editor')
    expect(fragments.filter((fragment) => !['browser', 'editor'].includes(fragment))).toEqual([])
  })
})

test('keeps a renamed identifier in one highlight rather than its unchanged suffix letters', async () => {
  const { container } = renderDiff(
    'state.ts',
    'const [firewallReady, setFirewallReady] = useState(null)\n',
    'const [firewall, setFirewall] = useState(null)\n',
  )

  await waitFor(() => {
    const fragments = highlightedFragments(container)
    expect(fragments).toEqual(expect.arrayContaining(['firewallReady', 'firewall', 'setFirewallReady', 'setFirewall']))
    expect(fragments).not.toContain('Ready')
  })
})

test('leaves an unchanged tab-indented line untouched and highlights only the changed token beside it', async () => {
  const { container } = renderDiff(
    'indent.ts',
    '\tconst kept = 1\n\tconst changed = alpha\n',
    '\tconst kept = 1\n\tconst changed = beta\n',
  )

  // A raw tab counted as one character against Monaco's expanded columns, which
  // dragged the overlay onto the wrong offsets; nothing but the token changes.
  await waitFor(() => {
    const fragments = highlightedFragments(container)
    expect(fragments).toEqual(expect.arrayContaining(['alpha', 'beta']))
    expect(fragments.filter((fragment) => !['alpha', 'beta'].includes(fragment))).toEqual([])
  })
})
