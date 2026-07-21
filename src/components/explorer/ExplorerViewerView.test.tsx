// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ExplorerViewerView } from './ExplorerViewerView'

const entry = { name: 'changed.ts', isDir: false, isSymlink: false, size: 12, modifiedAt: null }

describe('ExplorerViewerView', () => {
  it('offers the shared Git diff for a changed file', () => {
    const onOpenDiff = vi.fn()
    render(
      <ExplorerViewerView
        path="src/changed.ts"
        entry={entry}
        textFile={{ content: 'changed', truncated: false, binary: false }}
        imageSrc={null}
        loading={false}
        error={null}
        imageFit
        canOpenVibeLinkEditor={false}
        canOpenExternalEditor={false}
        canOpenDiff
        workingTreePresent
        onToggleImageFit={vi.fn()}
        onOpenVibeLinkEditor={vi.fn()}
        onOpenExternalEditor={vi.fn()}
        onOpenDiff={onOpenDiff}
        onOpenTerminal={vi.fn()}
        onReveal={vi.fn()}
        onCopyPath={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTitle('View diff in Git'))
    expect(onOpenDiff).toHaveBeenCalledOnce()
  })
})
