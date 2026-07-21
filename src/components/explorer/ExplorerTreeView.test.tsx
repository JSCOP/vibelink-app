// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { ExplorerTreeView } from './ExplorerTreeView'
import type { ExplorerNode } from '../../state/explorer'

const node: ExplorerNode = {
  path: 'src',
  parentPath: '',
  name: 'src',
  depth: 0,
  entry: { name: 'src', isDir: true, isSymlink: false, size: 0, modifiedAt: null },
  expanded: false,
  ignored: false,
  decoration: null,
  changeSummary: null,
  gitOnly: false,
  repositoryRef: null,
}

const changedNode: ExplorerNode = {
  ...node,
  path: 'file.ts',
  name: 'file.ts',
  entry: { ...node.entry, name: 'file.ts', isDir: false },
  decoration: {
    staged: null,
    unstaged: 'modified',
    untracked: false,
    conflicted: false,
    directory: false,
    repoKind: null,
    repoRoot: '',
    submoduleState: null,
  },
}

const noop = vi.fn()

afterEach(cleanup)

describe('ExplorerTreeView', () => {
  test('portals the context menu to the viewport instead of a transformed Dockview panel', () => {
    render(
      <div style={{ transform: 'translate3d(100px, 200px, 0)' }}>
        <ExplorerTreeView
          nodes={[node]}
          selectedPath="src"
          loading={false}
          statusSummary={null}
          statusPresentation="letters"
          previewVisible
          onTogglePreview={noop}
          error={null}
          renamingPath={null}
          renameValue=""
          contextMenu={{ x: 120, y: 140, path: 'src', actions: [{ id: 'open', label: 'Open', onClick: noop }] }}
          dragOverPath={null}
          onSelect={noop}
          onOpen={noop}
          onToggle={noop}
          onKeyDown={noop}
          onRenameValueChange={noop}
          onCommitRename={noop}
          onCancelRename={noop}
          onContextMenu={noop}
          onCloseContextMenu={noop}
          onDragStart={noop}
          onDragOver={noop}
          onDragLeave={noop}
          onDrop={noop}
        />
      </div>,
    )

    const menu = screen.getByRole('menu')
    expect(menu.parentElement).toBe(document.body)
    expect(menu.style.left).toBe('120px')
    expect(menu.style.top).toBe('140px')
  })

  test('renders Git states as icons, letters, or plain words', () => {
    const props = {
      nodes: [changedNode],
      selectedPath: 'file.ts',
      loading: false,
      statusSummary: null,
      error: null,
      previewVisible: true,
      onTogglePreview: noop,
      renamingPath: null,
      renameValue: '',
      contextMenu: null,
      dragOverPath: null,
      onSelect: noop,
      onOpen: noop,
      onToggle: noop,
      onKeyDown: noop,
      onRenameValueChange: noop,
      onCommitRename: noop,
      onCancelRename: noop,
      onContextMenu: noop,
      onCloseContextMenu: noop,
      onDragStart: noop,
      onDragOver: noop,
      onDragLeave: noop,
      onDrop: noop,
    }
    const { rerender } = render(<ExplorerTreeView {...props} statusPresentation="letters" />)
    const explanation = 'Modified — tracked file content changed; not staged for the next commit.'
    expect(screen.getByLabelText(explanation).textContent).toBe('M')

    rerender(<ExplorerTreeView {...props} statusPresentation="icons" />)
    expect(screen.getByLabelText(explanation).querySelector('svg')).toBeTruthy()

    rerender(<ExplorerTreeView {...props} statusPresentation="words" />)
    expect(screen.getByLabelText(explanation).textContent).toBe('Modified')
  })

  test('exposes navigator-first and visible preview toggle states in the tree header', () => {
    const onTogglePreview = vi.fn()
    const props = {
      nodes: [node],
      selectedPath: 'src',
      loading: false,
      statusSummary: null,
      statusPresentation: 'letters' as const,
      onTogglePreview,
      error: null,
      renamingPath: null,
      renameValue: '',
      contextMenu: null,
      dragOverPath: null,
      onSelect: noop,
      onOpen: noop,
      onToggle: noop,
      onKeyDown: noop,
      onRenameValueChange: noop,
      onCommitRename: noop,
      onCancelRename: noop,
      onContextMenu: noop,
      onCloseContextMenu: noop,
      onDragStart: noop,
      onDragOver: noop,
      onDragLeave: noop,
      onDrop: noop,
    }
    const { rerender } = render(<ExplorerTreeView {...props} previewVisible={false} />)

    const showPreview = screen.getByRole('button', { name: 'Show file preview' })
    expect(showPreview.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(showPreview)
    expect(onTogglePreview).toHaveBeenCalledTimes(1)

    rerender(<ExplorerTreeView {...props} previewVisible />)
    expect(screen.getByRole('button', { name: 'Hide file preview' }).getAttribute('aria-pressed')).toBe('true')
  })
})
