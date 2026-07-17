// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WorkspaceActionsContext, type WorkspaceActions } from '../layout/actions'
import { normalizeSettings, defaultSettings } from '../state/profiles'
import { useWorkspaceStore } from '../state/store'
const exitRemoteWideMock = vi.hoisted(() => vi.fn())
vi.mock('../terminal/TerminalManager', () => ({
  TerminalManager: { exitRemoteWide: exitRemoteWideMock },
}))

import { TerminalTab } from './TerminalTab'

const actions: WorkspaceActions = {
  activatePane: vi.fn(),
  splitPane: vi.fn(async () => undefined),
  closePane: vi.fn(async () => undefined),
  toggleMaximize: vi.fn(),
  renamePaneTitle: vi.fn(async () => undefined),
  swapPaneLocations: vi.fn(async () => undefined),
  movePaneToPosition: vi.fn(async () => undefined),
}

const api = {
  title: 'Hermes CLI',
  onDidTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
  close: vi.fn(),
  maximize: vi.fn(),
  exitMaximized: vi.fn(),
  isMaximized: vi.fn(() => false),
}

function renderTerminalTab() {
  useWorkspaceStore.setState({
    settings: normalizeSettings(defaultSettings),
    paneReviewMarkers: {},
    remoteWidePanes: {},
  })

  return renderToStaticMarkup(
    <WorkspaceActionsContext.Provider value={actions}>
      <TerminalTab api={api as never} containerApi={{} as never} tabLocation="header" params={{ paneId: 'pane-1', title: 'Hermes CLI', icon: 'terminal' }} />
    </WorkspaceActionsContext.Provider>,
  )
}

afterEach(() => cleanup())

describe('TerminalTab', () => {
  test('uses the whole tab chrome as the pane drag source', () => {
    const html = renderTerminalTab()

    expect(html).toContain('class="terminal-tab"')
    expect(html).toContain('data-pane-id="pane-1"')
    expect(html).toContain('draggable="true"')
    expect(html).toContain('class="terminal-tab-actions" data-pane-drag-disabled="true"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('Mark as reviewed (Alt+Q)')
  })

  test('does not leave the title text as a competing nested drag source', () => {
    const html = renderTerminalTab()

    expect(html.match(/draggable=/g)).toHaveLength(1)
    expect(html).toContain('class="terminal-tab-title"')
  })


  test('renders the remote wide badge and restores the pane on click', () => {
    useWorkspaceStore.setState({
      settings: normalizeSettings(defaultSettings),
      paneReviewMarkers: {},
      remoteWidePanes: { 'pane-1': 160 },
    })
    render(
      <WorkspaceActionsContext.Provider value={actions}>
        <TerminalTab api={api as never} containerApi={{} as never} tabLocation="header" params={{ paneId: 'pane-1', title: 'Hermes CLI', icon: 'terminal' }} />
      </WorkspaceActionsContext.Provider>,
    )

    fireEvent.click(screen.getByTitle('모바일 와이드 뷰 사용 중 — 클릭하면 원래 크기로 복원'))
    expect(exitRemoteWideMock).toHaveBeenCalledWith('pane-1')
  })
})
