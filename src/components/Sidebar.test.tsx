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

const sessions = [
  { id: 'alpha', name: 'Alpha', paneCount: 2, createdAt: 1 },
  { id: 'beta', name: 'Beta', paneCount: 1, createdAt: 2 },
]

describe('Sidebar workspace navigation', () => {
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

  test('shows 1-based workspace order and Ctrl shortcuts before each folder icon', () => {
    const markup = renderToStaticMarkup(<Sidebar {...baseProps} sessions={sessions} isPinned />)

    expect(markup).toContain('<span class="session-order" title="Ctrl+1">1</span><span class="session-icon">')
    expect(markup).toContain('<span class="session-order" title="Ctrl+2">2</span><span class="session-icon">')
  })
})
