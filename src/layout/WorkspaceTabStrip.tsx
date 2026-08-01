import { useEffect, useMemo, useRef, useState } from 'react'
import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from 'dockview-core'
import { WorkspaceContentTab } from '../components/WorkspaceContentTab'
import { parseWorkspaceContentParams, type WorkspaceContentParams } from './workspaceContentModel'

type WorkspaceTabStripProps = {
  api: DockviewApi | null
  renderActions: (group: DockviewGroupPanel) => React.ReactNode
}

type StripGroup = { group: DockviewGroupPanel; panels: IDockviewPanel[] }

/** Grid groups in reading order. Edge groups are the sidebars — they own their
 * own rails and never appear in the window strip. */
function readStripGroups(api: DockviewApi): StripGroup[] {
  return api.groups
    .filter((group) => group.api.location.type === 'grid' && group.panels.length > 0)
    .map((group) => ({ group, rect: group.element.getBoundingClientRect(), panels: group.panels }))
    .sort((left, right) => left.rect.top - right.rect.top || left.rect.left - right.rect.left)
    .map(({ group, panels }) => ({ group, panels }))
}

/** The strip must not sit above the sidebar rails. Those rails are Dockview
 * EDGE groups, so they cannot be lifted out of the dock — but the strip can be
 * inset to the centre grid's width, which leaves the rail columns untouched. */
function edgeInsets(api: DockviewApi): { marginLeft: number; marginRight: number } {
  const width = (position: 'left' | 'right') => {
    const edgeId = api.getEdgeGroup(position)?.id
    const edge = edgeId ? api.groups.find((group) => group.id === edgeId) : undefined
    return edge ? Math.round(edge.element.getBoundingClientRect().width) : 0
  }
  return { marginLeft: width('left'), marginRight: width('right') }
}

/** Dockview owns the drag: its `PointerDragSource` is bound to the real
 * `.dv-tab` element, which the strip hides rather than removes. Replay the
 * pointerdown onto that element so a strip tab starts Dockview's own drag
 * session — the ghost and every drop target then behave exactly as they do
 * when the native strip is visible. */
function forwardPointerDownToDockviewTab(api: DockviewApi, panelId: string, event: React.PointerEvent<HTMLElement>): void {
  if (event.button !== 0) return
  const panel = api.getPanel(panelId)
  const tab = panel?.group.element.querySelector<HTMLElement>(`.dv-tab[data-panel-id="${CSS.escape(panelId)}"]`)
    ?? panel?.group.element.querySelectorAll<HTMLElement>('.dv-tabs-container > .dv-tab')[panel.group.panels.indexOf(panel)]
  if (!tab) return
  tab.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    buttons: 1,
    clientX: event.clientX,
    clientY: event.clientY,
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    isPrimary: true,
  }))
}

/** One window strip for the whole workspace. Dockview renders a tab strip per
 * GROUP, so a split produced two disconnected strips; this renders every grid
 * group's panels in one ordered row instead, and wraps the row in a Chrome-style
 * split pill whenever more than one group is on screen at once — the pill is the
 * honest statement "these windows are visible side by side right now". */
export function WorkspaceTabStrip({ api, renderActions }: WorkspaceTabStripProps) {
  const [revision, setRevision] = useState(0)
  const frameRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!api) return
    const bump = () => {
      if (frameRef.current !== undefined) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = undefined
        setRevision((value) => value + 1)
      })
    }
    const disposables = [
      api.onDidLayoutChange(bump),
      api.onDidAddPanel(bump),
      api.onDidRemovePanel(bump),
      api.onDidMovePanel(bump),
      api.onDidActivePanelChange(bump),
      api.onDidActiveGroupChange(bump),
    ]
    bump()
    return () => {
      for (const disposable of disposables) disposable.dispose()
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current)
      frameRef.current = undefined
    }
  }, [api])

  // `revision` is the whole point of the dependency: Dockview mutates its group
  // list in place, so nothing else changes identity when a split appears.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const groups = useMemo(() => (api ? readStripGroups(api) : []), [api, revision])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const insets = useMemo(() => (api ? edgeInsets(api) : { marginLeft: 0, marginRight: 0 }), [api, revision])
  if (!api || groups.length === 0) return null

  const isSplit = groups.length > 1
  // New windows land in whichever group is focused, so the `+` targets that
  // group when it is one of the visible grid groups.
  const activeGroupId = api.activeGroup?.id
  const actionsGroup = groups.find(({ group }) => group.id === activeGroupId)?.group ?? groups[0]?.group

  return (
    <div className="workspace-window-strip" role="tablist" aria-label="Workspace windows" style={insets}>
      <div className={`workspace-window-strip-row${isSplit ? ' is-split' : ''}`}>
        {groups.map(({ group, panels }, groupIndex) => (
          <div className="workspace-window-strip-group" key={group.id} data-group-id={group.id}>
            {groupIndex > 0 ? <span className="workspace-window-strip-divider" aria-hidden="true" /> : null}
            {panels.map((panel) => {
              const params = parseWorkspaceContentParams(panel.params) as WorkspaceContentParams | null
              if (!params) return null
              return (
                <div
                  className="workspace-window-strip-tab"
                  key={panel.id}
                  data-active={panel.api.isActive ? 'true' : undefined}
                  onPointerDown={(event) => forwardPointerDownToDockviewTab(api, panel.id, event)}
                >
                  <WorkspaceContentTab api={panel.api} containerApi={api} params={params} tabLocation="header" />
                </div>
              )
            })}
          </div>
        ))}
      </div>
      {actionsGroup ? <div className="workspace-window-strip-actions">{renderActions(actionsGroup)}</div> : null}
    </div>
  )
}
