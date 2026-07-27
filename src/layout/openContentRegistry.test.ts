// @vitest-environment jsdom
import type { DockviewApi, IDockviewPanel } from 'dockview-react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  clearOpenContentSnapshot,
  getOpenContentSnapshot,
  publishOpenContentSnapshot,
  publishOpenContentFromDockview,
  subscribeOpenContent,
  type OpenContentItem,
} from './openContentRegistry'
import { useWorkspaceStore } from '../state/store'
import { registerTerminalWindow } from './terminalWindowRegistry'
import { workspaceContentPanelId } from './workspaceContentModel'

const browserItem: OpenContentItem = {
  panelId: 'content:browser:page-1',
  kind: 'browser',
  title: 'Browser',
  icon: 'globe',
  active: true,
}

afterEach(() => {
  clearOpenContentSnapshot()
})

describe('openContentRegistry', () => {
  test('does not notify subscribers for an identical serialized snapshot', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeOpenContent(listener)

    expect(publishOpenContentSnapshot([browserItem])).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)

    expect(publishOpenContentSnapshot([{ ...browserItem }])).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getOpenContentSnapshot()).toEqual([browserItem])

    expect(publishOpenContentSnapshot([{ ...browserItem, active: false }])).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  test('projects outer panels followed by each terminal window pane', () => {
    const previousState = useWorkspaceStore.getState()
    const paneId = 'pane-registry'
    const panePanelId = workspaceContentPanelId({ kind: 'terminal', instanceId: paneId })
    useWorkspaceStore.setState({
      activePaneId: paneId,
      panes: {
        [paneId]: {
          id: paneId,
          alive: true,
          config: {
            paneId,
            args: [],
            env: [],
            cols: 120,
            rows: 40,
            title: null,
            icon: null,
            profileId: 'registry-profile',
          },
        },
      },
      settings: {
        ...previousState.settings,
        profiles: [
          ...previousState.settings.profiles,
          { ...previousState.settings.profiles[0], id: 'registry-profile', name: 'Registry Agent', icon: 'bot' },
        ],
      },
    })
    const unregister = registerTerminalWindow({
      windowId: 'window-1',
      getInnerApi: () => ({ activePanel: { id: panePanelId } }) as DockviewApi,
      addPane: () => null,
      removePane: vi.fn(),
      settle: vi.fn(async () => undefined),
      persist: vi.fn(),
      setGridCreationPending: vi.fn(),
      paneIds: () => [paneId],
      focusFirst: vi.fn(),
    })
    const browser = {
      id: 'content:browser:page-1',
      params: { schema: 1, kind: 'browser', instanceId: 'page-1', pageId: 'page-1', profileId: 'default', title: 'Docs', icon: 'terminal' },
    } as unknown as IDockviewPanel
    const terminalWindow = {
      id: 'content:terminalWindow:window-1',
      params: { schema: 1, kind: 'terminalWindow', instanceId: 'window-1', title: 'Terminal window', icon: 'terminal', inner: null, titlesHidden: false },
    } as unknown as IDockviewPanel

    try {
      publishOpenContentFromDockview({ panels: [browser, terminalWindow], activePanel: terminalWindow } as DockviewApi)
      expect(getOpenContentSnapshot()).toEqual([
        { panelId: browser.id, kind: 'browser', title: 'Docs', icon: 'globe', active: false, parentPanelId: null },
        { panelId: terminalWindow.id, kind: 'terminalWindow', title: 'Terminal window', icon: 'terminal', active: false, parentPanelId: null },
        { panelId: panePanelId, kind: 'terminal', title: 'Registry Agent', icon: 'bot', active: true, parentPanelId: terminalWindow.id },
      ])
    } finally {
      unregister()
      useWorkspaceStore.setState({
        activePaneId: previousState.activePaneId,
        panes: previousState.panes,
        settings: previousState.settings,
      })
    }
  })
})
