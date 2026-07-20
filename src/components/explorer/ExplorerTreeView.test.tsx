// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

import { ExplorerTreeView } from './ExplorerTreeView'

const node = {
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
}

const noop = vi.fn()

describe('ExplorerTreeView', () => {
  test('portals the context menu to the viewport instead of a transformed Dockview panel', () => {
    render(
      <div style={{ transform: 'translate3d(100px, 200px, 0)' }}>
        <ExplorerTreeView
          nodes={[node]}
          selectedPath="src"
          loading={false}
          statusSummary={null}
          error={null}
          renamingPath={null}
          renameValue=""
          contextMenu={{ x: 120, y: 140, path: 'src', actions: [{ id: 'open', label: 'Open', onClick: noop }] }}
          dragOverPath={null}
          onSelect={noop}
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
})
