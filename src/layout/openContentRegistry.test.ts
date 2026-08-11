// @vitest-environment jsdom
import type { DockviewApi, IDockviewPanel } from 'dockview-react'
import { afterEach, describe, expect, it, test, vi } from 'vitest'
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
        { panelId: browser.id, kind: 'browser', title: 'Docs', icon: 'globe', active: false, parentPanelId: null, split: false },
        { panelId: terminalWindow.id, kind: 'terminalWindow', title: 'Terminal window', icon: 'terminal', active: false, parentPanelId: null, split: false },
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

  test('projects every central panel of one flat workspace grid', () => {
    const editor = {
      id: 'content:editor:AGENTS.md',
      params: { schema: 1, kind: 'editor', instanceId: 'AGENTS.md', title: 'AGENTS.md', icon: 'file-code', relPath: 'AGENTS.md' },
    } as unknown as IDockviewPanel
    const browser = {
      id: 'content:browser:page-grouped',
      params: { schema: 1, kind: 'browser', instanceId: 'page-grouped', pageId: 'page-grouped', profileId: 'default', title: 'Docs', icon: 'globe' },
    } as unknown as IDockviewPanel
    const api = {
      panels: [editor, browser],
      activePanel: editor,
      groups: [
        { api: { location: { type: 'grid' } }, panels: [editor] },
        { api: { location: { type: 'grid' } }, panels: [browser] },
      ],
    } as unknown as DockviewApi

    publishOpenContentFromDockview(api)
    expect(getOpenContentSnapshot()).toEqual([
      { panelId: editor.id, kind: 'editor', title: 'AGENTS.md', icon: 'file-code', active: true, parentPanelId: null, split: true },
      { panelId: browser.id, kind: 'browser', title: 'Docs', icon: 'globe', active: false, parentPanelId: null, split: true },
    ])
  })
})

describe('open content split grouping', () => {
  it('marks top-level windows as split exactly when more than one grid group is on screen', () => {
    const gridGroup = (panels: number) => ({ api: { location: { type: 'grid' } }, panels: Array.from({ length: panels }, () => ({})) })
    const edgeGroup = () => ({ api: { location: { type: 'edge' } }, panels: [{}] })
    const browser = {
      id: 'content:browser:split-page',
      params: { schema: 1, kind: 'browser', instanceId: 'split-page', pageId: 'split-page', profileId: 'default', title: 'Docs', icon: 'terminal' },
    } as unknown as IDockviewPanel

    const publish = (groups: unknown[]) => {
      clearOpenContentSnapshot()
      publishOpenContentFromDockview({ panels: [browser], activePanel: undefined, groups } as unknown as DockviewApi)
      return getOpenContentSnapshot()[0]?.split
    }

    // One window on screen, plus the always-present sidebars: not a split.
    expect(publish([gridGroup(1), edgeGroup(), edgeGroup()])).toBe(false)
    // An empty grid group is a leftover, not a visible window.
    expect(publish([gridGroup(1), gridGroup(0)])).toBe(false)
    expect(publish([gridGroup(1), gridGroup(1)])).toBe(true)
  })
})
