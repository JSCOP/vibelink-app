import { open } from '@tauri-apps/plugin-dialog'
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, Folder, FolderPlus, Pencil, Plus, Trash2 } from 'lucide-react'
import type { SessionMeta } from '../../ipc/types'
import { paneCompletionCountsBySession, useWorkspaceStore } from '../../state/store'
import { flattenWorkspaceRows, workspaceRows, type WorkspaceGroup } from '../../state/workspaceGroups'
import { WorkspaceSidebarPanelShell } from '../WorkspaceSidebarPanelShell'
import { OpenWorkspaceItems } from './OpenWorkspaceItems'

export type WorkspacesSidebarIntegration = {
  onCreateWorkspaceRequested?: () => void
  onImportReposRequested?: () => void
  onDeleteWorkspaceRequested?: (sessionId: string) => void | Promise<void>
  onEditWorkspaceRequested?: (sessionId: string) => void
}

export type WorkspacesSidebarProps = {
  active?: boolean
  collapsed?: boolean
  onCollapse?: () => void
  integration: WorkspacesSidebarIntegration
}

// Drag past this many pixels before a press becomes a reorder (below it, the
// gesture stays a click that selects the workspace).
const DRAG_THRESHOLD_PX = 4

type DragState = {
  id: string
  pointerId: number
  startY: number
  active: boolean
}

type DropTarget = { id: string; place: 'before' | 'after' }

type MembershipDropTarget =
  | { kind: 'group'; groupId: string }
  | { kind: 'ungrouped' }

function reorderIds(ids: string[], sourceId: string, targetId: string, place: 'before' | 'after'): string[] {
  if (sourceId === targetId) return ids
  const without = ids.filter((id) => id !== sourceId)
  const targetIndex = without.indexOf(targetId)
  if (targetIndex === -1) return ids
  const insertAt = place === 'before' ? targetIndex : targetIndex + 1
  without.splice(insertAt, 0, sourceId)
  return without
}

// Hit-test the pointer against the rendered rows to find the drop slot: which
// row the pointer is over and whether it sits in that row's top or bottom half.
function dropTargetFromPoint(list: HTMLElement, clientY: number, draggingId: string): DropTarget | null {
  const rows = [...list.querySelectorAll<HTMLElement>('[data-session-id]')]
  for (const row of rows) {
    const id = row.dataset.sessionId
    if (!id || id === draggingId) continue
    const rect = row.getBoundingClientRect()
    if (clientY < rect.top || clientY > rect.bottom) continue
    return { id, place: clientY < rect.top + rect.height / 2 ? 'before' : 'after' }
  }
  // Past the last row → drop after the last non-dragging row.
  const last = rows.reverse().find((row) => row.dataset.sessionId && row.dataset.sessionId !== draggingId)
  if (last && clientY > last.getBoundingClientRect().bottom) {
    return { id: last.dataset.sessionId as string, place: 'after' }
  }
  return null
}

function membershipDropTargetFromPoint(clientX: number, clientY: number): MembershipDropTarget | null {
  const element = document.elementFromPoint(clientX, clientY)
  if (!(element instanceof HTMLElement)) return null
  const groupRow = element.closest<HTMLElement>('[data-workspace-group-row]')
  const groupId = groupRow?.dataset.workspaceGroupRow
  if (groupId) return { kind: 'group', groupId }
  const ungrouped = element.closest<HTMLElement>('[data-workspace-ungrouped]')
  return ungrouped && !element.closest('[data-session-id]') ? { kind: 'ungrouped' } : null
}

function workspaceFolderBasename(workspaceFolder: string | null | undefined): string {
  const normalized = workspaceFolder?.replace(/[\\/]+$/, '') ?? ''
  if (!normalized) return ''
  const separator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return normalized.slice(separator + 1)
}

export function WorkspacesSidebar({ active = true, collapsed = false, onCollapse, integration }: WorkspacesSidebarProps) {
  const sessions = useWorkspaceStore((state) => state.sessions)
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const paneCompletionHighlights = useWorkspaceStore((state) => state.paneCompletionHighlights)
  const groups = useWorkspaceStore((state) => state.settings.workspaceGroups)
  const groupIds = useWorkspaceStore((state) => state.settings.workspaceGroupIds)
  const order = useWorkspaceStore((state) => state.settings.workspaceOrder)
  const defaultProfileId = useWorkspaceStore((state) => state.settings.defaultProfileId)
  const openSession = useWorkspaceStore((state) => state.openSession)
  const createSession = useWorkspaceStore((state) => state.createSession)
  const reorderWorkspaces = useWorkspaceStore((state) => state.reorderWorkspaces)
  const renameWorkspaceGroup = useWorkspaceStore((state) => state.renameWorkspaceGroup)
  const deleteWorkspaceGroup = useWorkspaceStore((state) => state.deleteWorkspaceGroup)
  const setWorkspaceGroup = useWorkspaceStore((state) => state.setWorkspaceGroup)
  const setWorkspaceGroupRootFolder = useWorkspaceStore((state) => state.setWorkspaceGroupRootFolder)
  const toggleWorkspaceGroupCollapsed = useWorkspaceStore((state) => state.toggleWorkspaceGroupCollapsed)
  const setError = useWorkspaceStore((state) => state.setError)
  const rows = useMemo(() => workspaceRows(sessions, groups, groupIds, order), [groupIds, groups, order, sessions])
  const flattenedSessions = useMemo(() => flattenWorkspaceRows(rows), [rows])
  const orderBySessionId = useMemo(() => new Map(flattenedSessions.map((session, index) => [session.id, index + 1])), [flattenedSessions])
  const completionCounts = useMemo(() => paneCompletionCountsBySession(paneCompletionHighlights), [paneCompletionHighlights])
  const groupedRows = rows.flatMap((row) => row.kind === 'group' ? [row] : [])
  const ungroupedSessions = rows.flatMap((row) => row.kind === 'session' ? [row.session] : [])
  const listRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const openingGroupIdsRef = useRef(new Set<string>())
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [membershipDropTarget, setMembershipDropTarget] = useState<MembershipDropTarget | null>(null)

  const selectWorkspace = async (sessionId: string) => {
    if (sessionId === activeSessionId) return
    await openSession(sessionId)
  }

  const onRowPointerDown = (event: ReactPointerEvent<HTMLDivElement>, sessionId: string) => {
    // Only a primary (left) button press starts a reorder; ignore the small
    // action buttons so rename/delete keep working.
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('.session-small-action')) return
    dragRef.current = { id: sessionId, pointerId: event.pointerId, startY: event.clientY, active: false }
    // Capture immediately so a fast drag that leaves the source row before the
    // first move still routes its pointer events here and can activate.
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onRowPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.active) {
      if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return
      drag.active = true
      setDraggingId(drag.id)
    }
    const list = listRef.current
    if (!list) return
    const membershipTarget = membershipDropTargetFromPoint(event.clientX, event.clientY)
    setMembershipDropTarget(membershipTarget)
    setDropTarget(membershipTarget ? null : dropTargetFromPoint(list, event.clientY, drag.id))
  }

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const target = dropTarget
    const membershipTarget = membershipDropTarget
    setDraggingId(null)
    setDropTarget(null)
    setMembershipDropTarget(null)
    // A press that never crossed the threshold is a plain click → select.
    if (!drag.active) {
      void selectWorkspace(drag.id)
      return
    }
    if (membershipTarget) {
      setWorkspaceGroup(drag.id, membershipTarget.kind === 'group' ? membershipTarget.groupId : null)
      return
    }
    if (!target) return
    const next = reorderIds(flattenedSessions.map((session) => session.id), drag.id, target.id, target.place)
    if (next.some((id, index) => id !== flattenedSessions[index]?.id)) reorderWorkspaces(next)
    const targetGroupId = groupIds[target.id] ?? null
    if ((groupIds[drag.id] ?? null) !== targetGroupId) setWorkspaceGroup(drag.id, targetGroupId)
  }

  const onRowPointerCancel = () => {
    dragRef.current = null
    setDraggingId(null)
    setDropTarget(null)
    setMembershipDropTarget(null)
  }

  const openGroupRoot = async (group: WorkspaceGroup) => {
    const rootFolder = group.rootFolder?.trim()
    if (!rootFolder || openingGroupIdsRef.current.has(group.id)) return
    openingGroupIdsRef.current.add(group.id)
    try {
      const normalizedRootFolder = rootFolder.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      const existing = sessions.find((session) => {
        const workspaceFolder = session.workspaceFolder
        if (typeof workspaceFolder !== 'string') return false
        return workspaceFolder.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === normalizedRootFolder
      })
      if (existing) {
        await selectWorkspace(existing.id)
        return
      }
      const created = await createSession(group.name, rootFolder, defaultProfileId)
      setWorkspaceGroup(created.id, group.id)
      await selectWorkspace(created.id)
    } catch (caught) {
      setError(String(caught))
    } finally {
      openingGroupIdsRef.current.delete(group.id)
    }
  }

  const chooseGroupRoot = async (group: WorkspaceGroup) => {
    try {
      const selected = await open({ directory: true, multiple: false, title: 'Select workspace group root folder' })
      if (typeof selected === 'string') setWorkspaceGroupRootFolder(group.id, selected)
    } catch (caught) {
      setError(String(caught))
    }
  }

  const renameGroup = (group: WorkspaceGroup) => {
    const name = window.prompt('Rename workspace group', group.name)
    if (name?.trim()) renameWorkspaceGroup(group.id, name.trim())
  }

  const deleteWorkspace = (sessionId: string) => {
    if (!integration.onDeleteWorkspaceRequested) return
    void Promise.resolve(integration.onDeleteWorkspaceRequested(sessionId)).catch((caught) => setError(String(caught)))
  }

  const renderSession = (session: SessionMeta) => {
    const position = orderBySessionId.get(session.id) ?? 0
    const completionCount = completionCounts[session.id] ?? 0
    const folderName = workspaceFolderBasename(session.workspaceFolder)
    const isDropTarget = dropTarget?.id === session.id
    const rowClass = [
      'session-row',
      session.id === activeSessionId ? 'active' : '',
      completionCount > 0 ? 'has-completions' : '',
      draggingId === session.id ? 'dragging' : '',
      isDropTarget ? `drop-${dropTarget.place}` : '',
    ].filter(Boolean).join(' ')
    return (
      <div
        key={session.id}
        className={rowClass}
        data-session-id={session.id}
        data-completion-count={completionCount || undefined}
        role="button"
        tabIndex={0}
        aria-current={session.id === activeSessionId ? 'true' : undefined}
        onPointerDown={(event) => onRowPointerDown(event, session.id)}
        onPointerMove={onRowPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={onRowPointerCancel}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
          event.preventDefault()
          void selectWorkspace(session.id)
        }}
      >
        <div className="session-main">
          <span className="session-order" title={position > 0 && position <= 9 ? `Ctrl+${position}` : undefined}>{position}</span>
          <span className={`workspaces-session-status${session.id === activeSessionId ? ' is-active' : ''}`} title={session.id === activeSessionId ? 'Active workspace' : 'Inactive workspace'} aria-label={session.id === activeSessionId ? 'Active workspace' : 'Inactive workspace'} />
          <span className="workspaces-session-copy">
            <strong className="session-name">{session.name}</strong>
            {folderName ? <span className="workspaces-session-folder" title={session.workspaceFolder ?? undefined}>{folderName}</span> : null}
          </span>
          {completionCount > 0 ? (
            <span className="session-completion-badge" title={`${completionCount} AI coding agent ${completionCount === 1 ? 'pane needs' : 'panes need'} attention`} aria-label={`${completionCount} AI coding agent ${completionCount === 1 ? 'pane needs' : 'panes need'} attention`}>
              <CheckCircle2 size={11} strokeWidth={2.2} aria-hidden="true" />
              {completionCount}
            </span>
          ) : null}
          <span className="session-badge" title={`${session.paneCount} terminal panes`}>{session.paneCount}</span>
        </div>
        <div className="workspaces-row-actions">
          <button type="button" title="Edit workspace details" aria-label={`Edit ${session.name}`} className="session-small-action" disabled={!integration.onEditWorkspaceRequested} onClick={() => integration.onEditWorkspaceRequested?.(session.id)}>
            <Pencil size={13} strokeWidth={1.7} aria-hidden="true" />
          </button>
          <button type="button" title="Delete workspace" aria-label={`Delete ${session.name}`} className="session-small-action danger" disabled={!integration.onDeleteWorkspaceRequested} onClick={() => deleteWorkspace(session.id)}>
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
        {session.id === activeSessionId ? <OpenWorkspaceItems completionHighlights={paneCompletionHighlights} /> : null}
      </div>
    )
  }

  const headerActions = (
    <>
      <button type="button" title="Import repos from folder" aria-label="Import repos from folder" disabled={!integration.onImportReposRequested} onClick={() => integration.onImportReposRequested?.()}>
        <FolderPlus size={13} aria-hidden="true" />
      </button>
      <button type="button" title="New workspace" aria-label="New workspace" disabled={!integration.onCreateWorkspaceRequested} onClick={() => integration.onCreateWorkspaceRequested?.()}>
        <Plus size={13} aria-hidden="true" />
      </button>
    </>
  )

  return (
    <WorkspaceSidebarPanelShell
      title="Workspaces"
      icon={<Folder size={15} aria-hidden="true" />}
      actions={headerActions}
      active={active}
      collapsed={collapsed}
      onCollapse={onCollapse}
      collapseLabel="Collapse Workspaces"
      ariaLabel="Workspaces"
      className="workspaces-sidebar"
    >
      <div className="workspaces-list session-list" ref={listRef}>
        {groupedRows.map(({ group, sessions: groupSessions }) => {
          const dropInside = membershipDropTarget?.kind === 'group' && membershipDropTarget.groupId === group.id
          const rootFolder = group.rootFolder?.trim() || null
          const rootFolderName = workspaceFolderBasename(rootFolder)
          return (
            <div key={group.id} className={`workspaces-group${dropInside ? ' is-drop-target' : ''}`}>
              <div
                className="workspaces-group-row"
                data-workspace-group-row={group.id}
                role="button"
                tabIndex={0}
                aria-expanded={!group.collapsed}
                onClick={() => {
                  if (rootFolder) void openGroupRoot(group)
                  else toggleWorkspaceGroupCollapsed(group.id)
                }}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
                  event.preventDefault()
                  toggleWorkspaceGroupCollapsed(group.id)
                }}
              >
                <span
                  className="workspaces-group-chevron"
                  title={`${group.collapsed ? 'Expand' : 'Collapse'} ${group.name} group`}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggleWorkspaceGroupCollapsed(group.id)
                  }}
                >
                  {group.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </span>
                <Folder size={14} strokeWidth={1.7} aria-hidden="true" />
                <span className="workspaces-session-copy">
                  <strong className="session-name">{group.name}</strong>
                  {rootFolderName ? <span className="workspaces-session-folder" title={rootFolder ?? undefined}>{rootFolderName}</span> : null}
                </span>
                <div className="workspaces-row-actions">
                  {!rootFolder ? (
                    <button type="button" title="Set group root folder" aria-label={`Set root folder for ${group.name} group`} className="session-small-action" onClick={(event) => { event.stopPropagation(); void chooseGroupRoot(group) }}>
                      <FolderPlus size={12} strokeWidth={1.7} aria-hidden="true" />
                    </button>
                  ) : null}
                  <button type="button" title="Rename group" aria-label={`Rename ${group.name} group`} className="session-small-action" onClick={(event) => { event.stopPropagation(); renameGroup(group) }}>
                    <Pencil size={12} strokeWidth={1.7} aria-hidden="true" />
                  </button>
                  <button type="button" title="Delete group (keep workspaces)" aria-label={`Delete ${group.name} group and keep its workspaces`} className="session-small-action danger" onClick={(event) => { event.stopPropagation(); deleteWorkspaceGroup(group.id) }}>
                    <Trash2 size={12} aria-hidden="true" />
                  </button>
                </div>
              </div>
              {(() => {
                // Collapsing hides a group's members, but never the workspace
                // you are standing in: otherwise the active row and its open
                // items vanish and the panel cannot say where you are.
                const visible = group.collapsed
                  ? groupSessions.filter((session) => session.id === activeSessionId)
                  : groupSessions
                if (visible.length === 0) return null
                return <div className="workspaces-group-members" role="group" aria-label={`${group.name} workspaces`}>{visible.map(renderSession)}</div>
              })()}
            </div>
          )
        })}
        <div className={`workspaces-ungrouped-region${draggingId ? ' is-dragging' : ''}${membershipDropTarget?.kind === 'ungrouped' ? ' is-drop-target' : ''}`} data-workspace-ungrouped="true">
          {ungroupedSessions.map(renderSession)}
          {draggingId && ungroupedSessions.length === 0 ? <span className="workspaces-ungrouped-drop-hint">Drop here to ungroup</span> : null}
        </div>
      </div>
    </WorkspaceSidebarPanelShell>
  )
}
