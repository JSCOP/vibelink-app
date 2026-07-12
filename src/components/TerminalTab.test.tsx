import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { WorkspaceActionsContext, type WorkspaceActions } from '../layout/actions'
import { normalizeSettings, defaultSettings } from '../state/profiles'
import { useWorkspaceStore } from '../state/store'
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
  })

  return renderToStaticMarkup(
    <WorkspaceActionsContext.Provider value={actions}>
      <TerminalTab api={api as never} containerApi={{} as never} tabLocation="header" params={{ paneId: 'pane-1', title: 'Hermes CLI', icon: 'terminal' }} />
    </WorkspaceActionsContext.Provider>,
  )
}

describe('TerminalTab', () => {
  test('uses the whole tab chrome as the pane drag source', () => {
    const html = renderTerminalTab()

    expect(html).toContain('class="terminal-tab"')
    expect(html).toContain('data-pane-id="pane-1"')
    expect(html).toContain('draggable="true"')
    expect(html).toContain('class="terminal-tab-actions" data-pane-drag-disabled="true"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('Mark as reviewed (Alt+Shift+C)')
  })

  test('does not leave the title text as a competing nested drag source', () => {
    const html = renderTerminalTab()

    expect(html.match(/draggable=/g)).toHaveLength(1)
    expect(html).toContain('class="terminal-tab-title"')
  })

})
