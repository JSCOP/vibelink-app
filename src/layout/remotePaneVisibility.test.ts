import { describe, expect, it, vi } from 'vitest'
import type { DockviewApi } from 'dockview-react'
import { hideRemoteLeasedPane, restoreRemoteLeasedPane } from './remotePaneVisibility'

type FakeGroup = {
  id: string
  panels: FakePanel[]
  api: {
    isVisible: boolean
    setVisible(visible: boolean): void
  }
}

type FakePanel = {
  id: string
  group: FakeGroup
  api: {
    moveTo(options: { group: FakeGroup; index?: number }): void
    setActive(): void
  }
}

function fakeDock(groupsWithPanelIds: string[][], activePanelId: string) {
  const groups: FakeGroup[] = []
  const panels: FakePanel[] = []
  const api = {
    groups,
    panels,
    activePanel: undefined as FakePanel | undefined,
    getPanel: (id: string) => panels.find((panel) => panel.id === id),
    getGroup: (id: string) => groups.find((group) => group.id === id),
    addGroup: ({ id }: { id: string }) => {
      const group = makeGroup(id)
      groups.push(group)
      return group
    },
    removeGroup: vi.fn((group: FakeGroup) => {
      const index = groups.indexOf(group)
      if (index >= 0) groups.splice(index, 1)
    }),
  }

  function makeGroup(id: string): FakeGroup {
    const group: FakeGroup = {
      id,
      panels: [],
      api: {
        isVisible: true,
        setVisible(visible) { group.api.isVisible = visible },
      },
    }
    return group
  }

  function makePanel(id: string, group: FakeGroup): FakePanel {
    const panel: FakePanel = {
      id,
      group,
      api: {
        moveTo({ group: destination, index }) {
          const sourceIndex = panel.group.panels.indexOf(panel)
          if (sourceIndex >= 0) panel.group.panels.splice(sourceIndex, 1)
          panel.group = destination
          destination.panels.splice(index ?? destination.panels.length, 0, panel)
        },
        setActive() { api.activePanel = panel },
      },
    }
    return panel
  }

  groupsWithPanelIds.forEach((ids, groupIndex) => {
    const group = makeGroup(`group-${groupIndex + 1}`)
    groups.push(group)
    for (const id of ids) {
      const panel = makePanel(id, group)
      group.panels.push(panel)
      panels.push(panel)
    }
  })
  api.activePanel = panels.find((panel) => panel.id === activePanelId)
  return { api: api as unknown as DockviewApi, groups, panels, removeGroup: api.removeGroup }
}

describe('remote pane visibility', () => {
  it('hides and restores a single-pane group without removing the panel', () => {
    const { api, groups } = fakeDock([['pane-a'], ['pane-b']], 'pane-a')
    const state = hideRemoteLeasedPane(api, 'pane-a')

    expect(state).toEqual({ kind: 'group', paneId: 'pane-a', groupId: 'group-1', wasActive: true })
    expect(groups[0].api.isVisible).toBe(false)
    expect(api.activePanel?.id).toBe('pane-b')

    expect(restoreRemoteLeasedPane(api, state!)).toBe(true)
    expect(groups[0].api.isVisible).toBe(true)
    expect(api.activePanel?.id).toBe('pane-a')
  })

  it('temporarily detaches one tab and restores its original group index', () => {
    const { api, groups, removeGroup } = fakeDock([['pane-a', 'pane-b']], 'pane-b')
    const state = hideRemoteLeasedPane(api, 'pane-a')

    expect(state?.kind).toBe('detached')
    expect(groups[0].panels.map((panel) => panel.id)).toEqual(['pane-b'])
    expect(groups[1].panels.map((panel) => panel.id)).toEqual(['pane-a'])
    expect(groups[1].api.isVisible).toBe(false)

    expect(restoreRemoteLeasedPane(api, state!)).toBe(true)
    expect(groups[0].panels.map((panel) => panel.id)).toEqual(['pane-a', 'pane-b'])
    expect(removeGroup).toHaveBeenCalledOnce()
  })
})
