import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { Sidebar } from './Sidebar'

const baseProps = {
  isOpen: true,
  sessions: [],
  onSelect: vi.fn(),
  onCreate: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onReorder: vi.fn(),
  onTogglePin: vi.fn(),
  onPointerEnter: vi.fn(),
  onPointerLeave: vi.fn(),
}

describe('Sidebar pin control', () => {
  test('offers pinning while the workspace sidebar is floating', () => {
    const markup = renderToStaticMarkup(<Sidebar {...baseProps} isPinned={false} />)

    expect(markup).toContain('title="Pin workspace sidebar"')
    expect(markup).toContain('aria-pressed="false"')
  })

  test('offers unpinning while the workspace sidebar is fixed', () => {
    const markup = renderToStaticMarkup(<Sidebar {...baseProps} isPinned />)

    expect(markup).toContain('title="Unpin workspace sidebar"')
    expect(markup).toContain('aria-pressed="true"')
  })
})
