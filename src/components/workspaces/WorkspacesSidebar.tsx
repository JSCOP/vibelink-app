import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, ChevronDown, ChevronRight, Folder, FolderGit2, FolderOpen, FolderPlus, GitBranch, Loader2, Pencil, Plus, RotateCcw, Trash2, TriangleAlert, X } from 'lucide-react'
import type { SessionMeta } from '../../ipc/types'
import type { PendingWorktreeCreation } from '../../state/worktrees'
import { projectionLabel, worktreePathOf } from '../../state/worktrees'
import { paneCompletionCountsBySession, useWorkspaceStore } from '../../state/store'
import { buildAttentionByWorkspace, deriveVisibleWorkspaceOrder, type WorkspaceAttention } from '../../state/worktreeAttention'
import { flattenWorktreeNodes, workspaceGroupRootNode, workspaceRootSessions, type WorkspaceGroup, type WorkspaceSessionNode, type WorkspaceWorktreeNode } from '../../state/workspaceGroups'
import { WorkspaceSidebarPanelShell } from '../WorkspaceSidebarPanelShell'
import { promptDialog } from '../appDialogStore'
import { OpenWorkspaceItems } from './OpenWorkspaceItems'
import { WorktreeCreateDialog } from './WorktreeCreateDialog'
import { WorktreeManageDialog } from './WorktreeManageDialog'
import { runWorktreeRemovalFlow } from './worktreeRemovalFlow'

export type WorkspacesSidebarIntegration = {
  onCreateWorkspaceRequested?: () => void
  onImportReposRequested?: () => void
  onDeleteWorkspaceRequested?: (sessionId: string) => void | Promise<void>
  onEditWorkspaceRequested?: (sessionId: string) => void
  setWorkspaceOverlayOpen?: (overlayId: string, open: boolean) => void
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

type WorkspaceContextMenu =
  | { kind: 'repository'; session: SessionMeta; x: number; y: number }
  | { kind: 'worktree'; session: SessionMeta; parentSession: SessionMeta; worktree: WorkspaceWorktreeNode['worktree']; x: number; y: number }
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
  const rows = [...list.querySelectorAll<HTMLElement>('[data-workspace-reorder-id]')]
  for (const row of rows) {
    const id = row.dataset.workspaceReorderId
    if (!id || id === draggingId) continue
    const rect = row.getBoundingClientRect()
    if (clientY < rect.top || clientY > rect.bottom) continue
    return { id, place: clientY < rect.top + rect.height / 2 ? 'before' : 'after' }
  }
  // Past the last row → drop after the last non-dragging row.
  const last = rows.reverse().find((row) => row.dataset.workspaceReorderId && row.dataset.workspaceReorderId !== draggingId)
  if (last && clientY > last.getBoundingClientRect().bottom) {
    return { id: last.dataset.workspaceReorderId as string, place: 'after' }
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

const worktreeStageDescriptions: Record<PendingWorktreeCreation['stage'], string> = {
  validating: 'Validating…',
  fetching: 'Fetching remote…',
  creating: 'Creating checkout…',
  copying: 'Copying linked files…',
  sparse: 'Applying sparse checkout…',
  setup: 'Running setup…',
  binding: 'Binding workspace…',
  launching: 'Opening terminal…',
  complete: 'Ready',
  rolling_back: 'Rolling back…',
  failed: 'Creation failed',
  cancelled: 'Cancelled',
}

function worktreeStageLabel(pending: PendingWorktreeCreation): string {
  if (pending.cancelRequested && pending.stage !== 'cancelled' && pending.stage !== 'failed' && pending.stage !== 'complete') {
    return 'Cancelling…'
  }
  return worktreeStageDescriptions[pending.stage]
}

function workspaceAttentionDescription(attention: WorkspaceAttention | undefined): string {
  if (!attention) return 'Idle'
  const label = attention.state === 'blocked' ? 'Needs attention' : attention.state === 'done' ? 'Done' : attention.state === 'working' ? 'Working' : 'Idle'
  const details = [label]
  if (attention.unreadCount > 0) details.push(`${attention.unreadCount} unread`)
  if (attention.completionCount > 0) details.push(`${attention.completionCount} ${attention.completionCount === 1 ? 'completion' : 'completions'}`)
  if (attention.source) details.push(`source ${attention.source}`)
  if (attention.cause) details.push(attention.cause)
  return details.join(' · ')
}


export function WorkspacesSidebar({ active = true, collapsed = false, onCollapse, integration }: WorkspacesSidebarProps) {
  const sessions = useWorkspaceStore((state) => state.sessions)
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const paneCompletionHighlights = useWorkspaceStore((state) => state.paneCompletionHighlights)
  const groups = useWorkspaceStore((state) => state.settings.workspaceGroups)
  const groupIds = useWorkspaceStore((state) => state.settings.workspaceGroupIds)
  const manualOrder = useWorkspaceStore((state) => state.settings.workspaceOrder)
  const defaultProfileId = useWorkspaceStore((state) => state.settings.defaultProfileId)
  const profiles = useWorkspaceStore((state) => state.settings.profiles)
  const worktrees = useWorkspaceStore((state) => state.worktreeProjections)
  const pendingWorktreeCreations = useWorkspaceStore((state) => state.pendingWorktreeCreations)
  const sortMode = useWorkspaceStore((state) => state.settings.workspaceSortMode)
  const attentionSnapshot = useWorkspaceStore((state) => state.attentionSnapshot)
  const hermesStatus = useWorkspaceStore((state) => state.hermesStatus)
  const hermesPermissions = useWorkspaceStore((state) => state.hermesPermissions)
  const paneReviewMarkers = useWorkspaceStore((state) => state.paneReviewMarkers)
  const workspaceProfileIds = useWorkspaceStore((state) => state.settings.workspaceProfileIds)
  const openSession = useWorkspaceStore((state) => state.openSession)
  const createSession = useWorkspaceStore((state) => state.createSession)
  const createWorktreeSession = useWorkspaceStore((state) => state.createWorktreeSession)
  const removeWorktreeSession = useWorkspaceStore((state) => state.removeWorktreeSession)
  const removeWorktreeById = useWorkspaceStore((state) => state.removeWorktreeById)
  const preflightWorktreeRemoval = useWorkspaceStore((state) => state.preflightWorktreeRemoval)
  const cancelPendingWorktreeCreation = useWorkspaceStore((state) => state.cancelPendingWorktreeCreation)
  const retryPendingWorktreeCreation = useWorkspaceStore((state) => state.retryPendingWorktreeCreation)
  const dismissPendingWorktreeCreation = useWorkspaceStore((state) => state.dismissPendingWorktreeCreation)
  const reorderWorkspaces = useWorkspaceStore((state) => state.reorderWorkspaces)
  const renameWorkspaceGroup = useWorkspaceStore((state) => state.renameWorkspaceGroup)
  const deleteWorkspaceGroup = useWorkspaceStore((state) => state.deleteWorkspaceGroup)
  const setWorkspaceGroup = useWorkspaceStore((state) => state.setWorkspaceGroup)
  const setWorkspaceGroupRootFolder = useWorkspaceStore((state) => state.setWorkspaceGroupRootFolder)
  const toggleWorkspaceGroupCollapsed = useWorkspaceStore((state) => state.toggleWorkspaceGroupCollapsed)
  const setError = useWorkspaceStore((state) => state.setError)
  const attentionByWorkspace = useMemo(() => buildAttentionByWorkspace(sessions, worktrees, attentionSnapshot, {
    completionHighlights: paneCompletionHighlights,
    hermesStatus,
    hermesPermissions,
    reviewedPaneIds: new Set(Object.keys(paneReviewMarkers)),
    conflictSessionIds: new Set(worktrees.flatMap((projection) => projection.native?.hasConflicts && projection.record?.sessionId ? [projection.record.sessionId] : [])),
  }), [attentionSnapshot, hermesPermissions, hermesStatus, paneCompletionHighlights, paneReviewMarkers, sessions, worktrees])
  const visibleWorkspaceOrder = useMemo(() => deriveVisibleWorkspaceOrder(
    sessions,
    groups,
    groupIds,
    worktrees,
    sortMode,
    attentionByWorkspace,
    manualOrder,
  ), [attentionByWorkspace, groupIds, groups, manualOrder, sessions, sortMode, worktrees])
  const rows = visibleWorkspaceOrder.rows
  const flattenedSessions = visibleWorkspaceOrder.sessions
  const rootSessions = useMemo(() => workspaceRootSessions(rows), [rows])
  const rootNodes = useMemo(() => rows.flatMap((row) => row.kind === 'group' ? row.sessions : [row.node]), [rows])
  const rootNodesById = useMemo(() => new Map(rootNodes.map((node) => [node.session.id, node])), [rootNodes])
  const orderBySessionId = useMemo(() => new Map(flattenedSessions.map((session, index) => [session.id, index + 1])), [flattenedSessions])
  const completionCounts = useMemo(() => paneCompletionCountsBySession(paneCompletionHighlights), [paneCompletionHighlights])
  const groupedRows = rows.flatMap((row) => row.kind === 'group' ? [row] : [])
  const ungroupedNodes = rows.flatMap((row) => row.kind === 'session' ? [row.node] : [])
  const listRef = useRef<HTMLDivElement | null>(null)
  const focusedSessionIdRef = useRef<string | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const openingGroupIdsRef = useRef(new Set<string>())
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [membershipDropTarget, setMembershipDropTarget] = useState<MembershipDropTarget | null>(null)
  const [worktreeSource, setWorktreeSource] = useState<SessionMeta | null>(null)
  const [worktreeManageSource, setWorktreeManageSource] = useState<SessionMeta | null>(null)
  const [contextMenu, setContextMenu] = useState<WorkspaceContextMenu | null>(null)

  useEffect(() => {
    const rememberFocusedWorkspace = (event: FocusEvent) => {
      const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-session-id]') : null
      focusedSessionIdRef.current = target?.dataset.sessionId ?? null
    }
    document.addEventListener('focusin', rememberFocusedWorkspace)
    return () => document.removeEventListener('focusin', rememberFocusedWorkspace)
  }, [])

  useLayoutEffect(() => {
    const sessionId = focusedSessionIdRef.current
    if (!sessionId || !listRef.current) return
    const row = [...listRef.current.querySelectorAll<HTMLElement>('[data-session-id]')]
      .find((candidate) => candidate.dataset.sessionId === sessionId)
    if (row && row !== document.activeElement && (!document.activeElement || document.activeElement === document.body)) row.focus()
  }, [flattenedSessions])

  useEffect(() => {
    integration.setWorkspaceOverlayOpen?.('worktree-create', Boolean(worktreeSource))
    return () => integration.setWorkspaceOverlayOpen?.('worktree-create', false)
  }, [integration, worktreeSource])

  useEffect(() => {
    integration.setWorkspaceOverlayOpen?.('worktree-manage', Boolean(worktreeManageSource))
    return () => integration.setWorkspaceOverlayOpen?.('worktree-manage', false)
  }, [integration, worktreeManageSource])

  const selectWorkspace = async (sessionId: string) => {
    if (sessionId === activeSessionId) return
    await openSession(sessionId)
  }

  const requestWorktree = async (session: SessionMeta) => {
    setContextMenu(null)
    const workspaceFolder = session.workspaceFolder?.trim()
    if (!workspaceFolder) {
      setError('This workspace needs a repository folder before it can create a worktree.')
      return
    }
    try {
      const available = await invoke<boolean>('git_is_available', { workspaceFolder })
      if (!available) throw new Error('The selected workspace folder is not inside a Git repository.')
      setWorktreeSource(session)
    } catch (caught) {
      setError(String(caught))
    }
  }

  const requestManageWorktrees = (session: SessionMeta) => {
    setContextMenu(null)
    if (!session.workspaceFolder?.trim()) {
      setError('This workspace needs a repository folder before it can manage worktrees.')
      return
    }
    setWorktreeManageSource(session)
  }

  const revealWorktree = async (session: SessionMeta) => {
    const path = session.workspaceFolder?.trim()
    if (!path) {
      setError('This worktree workspace has no checkout folder to reveal.')
      return
    }
    try {
      await invoke('reveal_path', { path })
    } catch (caught) {
      setError(String(caught))
    }
  }

  const removeWorktree = async (session: SessionMeta, worktree: WorkspaceWorktreeNode['worktree']) => {
    setContextMenu(null)
    try {
      const record = worktree.record
      if (!record) throw new Error('This worktree has no managed registry record.')
      await runWorktreeRemovalFlow(
        { worktreeId: record.id, branch: record.branch, worktreePath: record.worktreePath, displayName: session.name },
        {
          preflight: preflightWorktreeRemoval,
          execute: (options) => removeWorktreeSession(session.id, options),
        },
      )
    } catch (caught) {
      setError(String(caught))
    }
  }

  const removeDetachedWorktree = async (projection: WorkspaceSessionNode['detached'][number]) => {
    const record = projection.record
    if (!record) return
    try {
      await runWorktreeRemovalFlow(
        { worktreeId: record.id, branch: record.branch, worktreePath: record.worktreePath, displayName: projectionLabel(projection) },
        {
          preflight: preflightWorktreeRemoval,
          execute: (options) => removeWorktreeById(record.id, options),
        },
      )
    } catch (caught) {
      setError(String(caught))
    }
  }

  const pendingCreationsByParent = useMemo(() => {
    const byParent = new Map<string, PendingWorktreeCreation[]>()
    for (const pending of Object.values(pendingWorktreeCreations)) {
      const rows = byParent.get(pending.parentSessionId) ?? []
      rows.push(pending)
      byParent.set(pending.parentSessionId, rows)
    }
    for (const rows of byParent.values()) rows.sort((left, right) => left.startedAt - right.startedAt)
    return byParent
  }, [pendingWorktreeCreations])

  const onRowPointerDown = (event: ReactPointerEvent<HTMLDivElement>, sessionId: string) => {
    if (sortMode !== 'manual' || event.button !== 0) return
    dragRef.current = {
      id: sessionId,
      pointerId: event.pointerId,
      startY: event.clientY,
      active: false,
    }
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
    if (sortMode !== 'manual') return
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
    const nextRootIds = reorderIds(rootSessions.map((session) => session.id), drag.id, target.id, target.place)
    const next = nextRootIds.flatMap((sessionId) => {
      const node = rootNodesById.get(sessionId)
      return node ? [sessionId, ...flattenWorktreeNodes(node.worktrees).map((worktree) => worktree.session.id)] : [sessionId]
    })
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
        setWorkspaceGroup(existing.id, group.id)
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
    void promptDialog({ title: 'Rename workspace group', label: 'Group name', defaultValue: group.name, confirmLabel: 'Rename' })
      .then((name) => { if (name) renameWorkspaceGroup(group.id, name) })
  }


  const deleteWorkspace = (sessionId: string) => {
    if (!integration.onDeleteWorkspaceRequested) return
    void Promise.resolve(integration.onDeleteWorkspaceRequested(sessionId)).catch((caught) => setError(String(caught)))
  }

  const renderWorktree = ({ session, worktree, worktrees: childWorktrees }: WorkspaceWorktreeNode, parentSession: SessionMeta) => {
    const record = worktree.record
    if (!record) return null
    const position = orderBySessionId.get(session.id) ?? 0
    const completionCount = completionCounts[session.id] ?? 0
    const attention = attentionByWorkspace[session.id]
    const attentionDescription = workspaceAttentionDescription(attention)
    const attentionCount = (attention?.unreadCount ?? 0) + (attention?.completionCount ?? 0)
    const showAttention = (attention?.attentionClass ?? 4) < 4 || attentionCount > 0
    const folderName = workspaceFolderBasename(session.workspaceFolder)
    return (
      <div
        key={session.id}
        className={`session-row worktree-session-row${session.id === activeSessionId ? ' active' : ''}${completionCount > 0 ? ' has-completions' : ''}`}
        data-session-id={session.id}
        data-completion-count={completionCount || undefined}
        role="button"
        tabIndex={0}
        aria-current={session.id === activeSessionId ? 'true' : undefined}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setContextMenu({ kind: 'worktree', session, parentSession, worktree, x: event.clientX, y: event.clientY })
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); void selectWorkspace(session.id) }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          void selectWorkspace(session.id)
        }}
      >
        <div className="session-main">
          <span className="session-order" title={position > 0 && position <= 9 ? `Ctrl+${position}` : undefined}>{position}</span>
          <span className={`workspaces-session-status${session.id === activeSessionId ? ' is-active' : ''}`} title={session.id === activeSessionId ? 'Active worktree' : 'Inactive worktree'} aria-label={session.id === activeSessionId ? 'Active worktree' : 'Inactive worktree'} />
          <span className="workspaces-session-copy">
            <strong className="session-name worktree-session-name"><GitBranch size={11} strokeWidth={1.8} aria-hidden="true" />{session.name}</strong>
            <span className="workspaces-session-folder" title={`${record.branch} · ${session.workspaceFolder ?? ''}`}>{record.branch}{folderName ? ` · ${folderName}` : ''}</span>
          </span>
          {showAttention ? (
            <span className={`session-completion-badge attention-class-${attention?.attentionClass ?? 4}`} title={attentionDescription} aria-label={attentionDescription}>
              <CheckCircle2 size={11} strokeWidth={2.2} aria-hidden="true" />{attentionCount > 0 ? attentionCount : attention?.state}
            </span>
          ) : null}
          <span className="session-badge" title={`${session.paneCount} terminal panes`}>{session.paneCount}</span>
        </div>
        <div className="workspaces-row-actions">
          <button type="button" title="Reveal in File Explorer" aria-label={`Reveal ${session.name} in File Explorer`} className="session-small-action" disabled={!session.workspaceFolder} onClick={(event) => { event.stopPropagation(); void revealWorktree(session) }}>
            <FolderOpen size={13} strokeWidth={1.7} aria-hidden="true" />
          </button>
          <button type="button" title="Edit worktree workspace details" aria-label={`Edit ${session.name}`} className="session-small-action" disabled={!integration.onEditWorkspaceRequested} onClick={(event) => { event.stopPropagation(); integration.onEditWorkspaceRequested?.(session.id) }}>
            <Pencil size={13} strokeWidth={1.7} aria-hidden="true" />
          </button>
          <button type="button" title="Remove worktree" aria-label={`Remove worktree ${session.name}`} className="session-small-action danger" onClick={(event) => { event.stopPropagation(); void removeWorktree(session, worktree) }}>
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
        {session.id === activeSessionId ? <OpenWorkspaceItems completionHighlights={paneCompletionHighlights} /> : null}
        {childWorktrees.length > 0 ? (
          <div className="workspace-worktree-list nested" role="group" aria-label={`${session.name} child worktrees`}>
            {childWorktrees.map((child) => renderWorktree(child, session))}
          </div>
        ) : null}
      </div>
    )
  }

  const renderPendingCreation = (pending: PendingWorktreeCreation) => {
    const settled = pending.stage === 'complete' || pending.stage === 'failed' || pending.stage === 'cancelled'
    const failed = pending.stage === 'failed' || pending.stage === 'cancelled'
    return (
      <div
        key={pending.operationId}
        className={`session-row worktree-session-row worktree-pending-row${failed ? ' is-failed' : ''}`}
        data-pending-operation-id={pending.operationId}
        role="status"
        aria-live="polite"
      >
        <div className="session-main">
          <span className="session-order" aria-hidden="true">
            {failed ? <TriangleAlert size={12} strokeWidth={1.9} /> : <Loader2 size={12} strokeWidth={1.9} className="worktree-pending-spinner" />}
          </span>
          <span className="workspaces-session-copy">
            <strong className="session-name worktree-session-name"><GitBranch size={11} strokeWidth={1.8} aria-hidden="true" />{pending.name}</strong>
            <span className="workspaces-session-folder" title={pending.branch || undefined}>{worktreeStageLabel(pending)}</span>
          </span>
        </div>
        <div className="workspaces-row-actions">
          {settled ? (
            <>
              <button type="button" title="Retry worktree creation" aria-label={`Retry creating ${pending.name}`} className="session-small-action" onClick={() => void retryPendingWorktreeCreation(pending.operationId).catch((caught) => setError(String(caught)))}>
                <RotateCcw size={13} strokeWidth={1.7} aria-hidden="true" />
              </button>
              <button type="button" title="Dismiss" aria-label={`Dismiss ${pending.name} creation`} className="session-small-action" onClick={() => dismissPendingWorktreeCreation(pending.operationId)}>
                <X size={13} strokeWidth={1.7} aria-hidden="true" />
              </button>
            </>
          ) : (
            <button type="button" title="Cancel worktree creation" aria-label={`Cancel creating ${pending.name}`} className="session-small-action danger" disabled={pending.cancelRequested} onClick={() => void cancelPendingWorktreeCreation(pending.operationId).catch((caught) => setError(String(caught)))}>
              <X size={13} strokeWidth={1.7} aria-hidden="true" />
            </button>
          )}
        </div>
        {pending.error ? (
          <p className="worktree-pending-recovery" role="alert">{pending.error}</p>
        ) : null}
      </div>
    )
  }

  // Registry rows with no workspace session of their own. Rendering them keeps
  // a missing/stale/conflicted checkout visible instead of silently absent.
  const renderDetachedWorktree = (projection: WorkspaceSessionNode['detached'][number]) => {
    const label = projectionLabel(projection)
    const path = worktreePathOf(projection)
    return (
      <div key={projection.id} className="session-row worktree-session-row worktree-detached-row" data-worktree-id={projection.id}>
        <div className="session-main">
          <span className="session-order" aria-hidden="true"><TriangleAlert size={12} strokeWidth={1.9} /></span>
          <span className="workspaces-session-copy">
            <strong className="session-name worktree-session-name"><GitBranch size={11} strokeWidth={1.8} aria-hidden="true" />{label}</strong>
            <span className="workspaces-session-folder" title={path || undefined}>{projection.state} · no workspace</span>
          </span>
        </div>
        <div className="workspaces-row-actions">
          <button type="button" title="Remove worktree" aria-label={`Remove worktree ${label}`} className="session-small-action danger" onClick={(event) => { event.stopPropagation(); void removeDetachedWorktree(projection) }}>
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
      </div>
    )
  }

  const renderSession = (node: WorkspaceSessionNode) => {
    const session = node.session
    const position = orderBySessionId.get(session.id) ?? 0
    const completionCount = completionCounts[session.id] ?? 0
    const attention = attentionByWorkspace[session.id]
    const attentionDescription = workspaceAttentionDescription(attention)
    const attentionCount = (attention?.unreadCount ?? 0) + (attention?.completionCount ?? 0)
    const showAttention = (attention?.attentionClass ?? 4) < 4 || attentionCount > 0
    const folderName = workspaceFolderBasename(session.workspaceFolder)
    const isDropTarget = dropTarget?.id === session.id
    const hasActiveWorktree = flattenWorktreeNodes(node.worktrees).some((worktree) => worktree.session.id === activeSessionId)
    const rowClass = [
      'session-row',
      'repository-session-row',
      session.id === activeSessionId ? 'active' : '',
      hasActiveWorktree ? 'has-active-worktree' : '',
      completionCount > 0 ? 'has-completions' : '',
      draggingId === session.id ? 'dragging' : '',
      sortMode !== 'manual' ? 'reorder-disabled' : '',
      isDropTarget ? `drop-${dropTarget.place}` : '',
    ].filter(Boolean).join(' ')
    return (
      <div
        key={session.id}
        className={rowClass}
        data-session-id={session.id}
        data-workspace-reorder-id={sortMode === 'manual' ? session.id : undefined}
        data-completion-count={completionCount || undefined}
        role="button"
        tabIndex={0}
        aria-current={session.id === activeSessionId ? 'true' : undefined}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setContextMenu({ kind: 'repository', session, x: event.clientX, y: event.clientY })
        }}
        onPointerDown={(event) => onRowPointerDown(event, session.id)}
        onClick={(event) => {
          if (sortMode !== 'manual' && !(event.target instanceof Element && event.target.closest('button'))) void selectWorkspace(session.id)
        }}
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
          {showAttention ? (
            <span className={`session-completion-badge attention-class-${attention?.attentionClass ?? 4}`} title={attentionDescription} aria-label={attentionDescription}>
              <CheckCircle2 size={11} strokeWidth={2.2} aria-hidden="true" />{attentionCount > 0 ? attentionCount : attention?.state}
            </span>
          ) : null}
          <span className="session-badge" title={`${session.paneCount} terminal panes`}>{session.paneCount}</span>
        </div>
        <div className="workspaces-row-actions">
          <button type="button" title="Create Git worktree" aria-label={`Create worktree from ${session.name}`} className="session-small-action worktree-add-action" disabled={!session.workspaceFolder} onClick={() => void requestWorktree(session)}>
            <Plus size={13} strokeWidth={2} aria-hidden="true" />
          </button>
          <button type="button" title="Edit workspace details" aria-label={`Edit ${session.name}`} className="session-small-action" disabled={!integration.onEditWorkspaceRequested} onClick={() => integration.onEditWorkspaceRequested?.(session.id)}>
            <Pencil size={13} strokeWidth={1.7} aria-hidden="true" />
          </button>
          <button type="button" title="Delete workspace" aria-label={`Delete ${session.name}`} className="session-small-action danger" disabled={!integration.onDeleteWorkspaceRequested} onClick={() => deleteWorkspace(session.id)}>
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
        {session.id === activeSessionId ? <OpenWorkspaceItems completionHighlights={paneCompletionHighlights} /> : null}
        {node.worktrees.length > 0 || node.detached.length > 0 || (pendingCreationsByParent.get(session.id)?.length ?? 0) > 0 ? (
          <div className="workspace-worktree-list" role="group" aria-label={`${session.name} worktrees`}>
            {node.worktrees.map((worktree) => renderWorktree(worktree, session))}
            {(pendingCreationsByParent.get(session.id) ?? []).map(renderPendingCreation)}
            {node.detached.map(renderDetachedWorktree)}
          </div>
        ) : null}
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
    <>
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
          const groupRootNode = workspaceGroupRootNode(group, groupSessions)
          const groupRootSession = groupRootNode?.session ?? null
          const groupRootActive = groupRootSession?.id === activeSessionId
          const groupRootHasActiveWorktree = groupRootNode?.worktrees.some((worktree) => worktree.session.id === activeSessionId) ?? false
          const groupRootCompletionCount = groupRootSession ? completionCounts[groupRootSession.id] ?? 0 : 0
          const openOrToggleGroup = () => {
            if (!rootFolder) {
              toggleWorkspaceGroupCollapsed(group.id)
              return
            }
            if (group.collapsed) toggleWorkspaceGroupCollapsed(group.id)
            void openGroupRoot(group)
          }
          const visibleMembers = groupRootNode
            ? groupSessions.filter((node) => node.session.id !== groupRootNode.session.id)
            : groupSessions
          const visibleRootWorktrees = groupRootNode
            ? (group.collapsed ? groupRootNode.worktrees.filter((worktree) => worktree.session.id === activeSessionId) : groupRootNode.worktrees)
            : []
          const visibleSessions = group.collapsed
            ? visibleMembers.filter(({ session, worktrees }) => session.id === activeSessionId || worktrees.some((worktree) => worktree.session.id === activeSessionId))
            : visibleMembers
          const groupRowClass = [
            'workspaces-group-row',
            groupRootActive ? 'active' : '',
            groupRootHasActiveWorktree ? 'has-active-worktree' : '',
            groupRootCompletionCount > 0 ? 'has-completions' : '',
          ].filter(Boolean).join(' ')
          return (
            <div key={group.id} className={`workspaces-group${dropInside ? ' is-drop-target' : ''}`}>
              <div
                className={groupRowClass}
                data-workspace-group-row={group.id}
                data-session-id={groupRootSession?.id}
                data-completion-count={groupRootCompletionCount || undefined}
                role="button"
                tabIndex={0}
                aria-current={groupRootActive ? 'true' : undefined}
                aria-expanded={!group.collapsed}
                onClick={openOrToggleGroup}
                onContextMenu={(event) => {
                  if (!groupRootSession) return
                  event.preventDefault()
                  setContextMenu({ kind: 'repository', session: groupRootSession, x: event.clientX, y: event.clientY })
                }}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
                  event.preventDefault()
                  openOrToggleGroup()
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
                  <button type="button" title={groupRootSession ? `Create worktree from ${groupRootSession.name}` : 'Open the group repository before creating a worktree'} aria-label={`Create worktree in ${group.name} group`} className="session-small-action worktree-add-action" disabled={!groupRootSession} onClick={(event) => { event.stopPropagation(); if (groupRootSession) void requestWorktree(groupRootSession) }}>
                    <Plus size={12} strokeWidth={2} aria-hidden="true" />
                  </button>
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
              {groupRootActive && !group.collapsed ? <OpenWorkspaceItems completionHighlights={paneCompletionHighlights} /> : null}
              {visibleRootWorktrees.length > 0 || visibleSessions.length > 0 ? (
                <div className="workspaces-group-members" role="group" aria-label={`${group.name} workspaces`}>
                  {groupRootSession ? visibleRootWorktrees.map((worktree) => renderWorktree(worktree, groupRootSession)) : null}
                  {visibleSessions.map(renderSession)}
                </div>
              ) : null}
            </div>
          )
        })}
        <div className={`workspaces-ungrouped-region${draggingId ? ' is-dragging' : ''}${membershipDropTarget?.kind === 'ungrouped' ? ' is-drop-target' : ''}`} data-workspace-ungrouped="true">
          {ungroupedNodes.map(renderSession)}
          {draggingId && ungroupedNodes.length === 0 ? <span className="workspaces-ungrouped-drop-hint">Drop here to ungroup</span> : null}
        </div>
      </div>
    </WorkspaceSidebarPanelShell>
    {contextMenu && typeof document !== 'undefined' ? createPortal(
      <div className="workspace-context-menu-backdrop" role="presentation" onMouseDown={() => setContextMenu(null)} onContextMenu={(event) => { event.preventDefault(); setContextMenu(null) }}>
        <div
          className="workspace-context-menu"
          role="menu"
          aria-label={contextMenu.kind === 'repository' ? `${contextMenu.session.name} workspace actions` : `${contextMenu.session.name} worktree actions`}
          style={{
            left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 220)),
            top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - (contextMenu.kind === 'repository' ? 164 : 132))),
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {contextMenu.kind === 'repository' ? (
            <>
              <button type="button" role="menuitem" onClick={() => void requestWorktree(contextMenu.session)}>
                <GitBranch size={14} aria-hidden="true" />Create worktree
              </button>
              <button type="button" role="menuitem" onClick={() => requestManageWorktrees(contextMenu.session)}>
                <FolderGit2 size={14} aria-hidden="true" />Manage worktrees
              </button>
              <button type="button" role="menuitem" disabled={!integration.onEditWorkspaceRequested} onClick={() => { integration.onEditWorkspaceRequested?.(contextMenu.session.id); setContextMenu(null) }}>
                <Pencil size={14} aria-hidden="true" />Edit workspace
              </button>
              <button type="button" role="menuitem" className="danger" disabled={!integration.onDeleteWorkspaceRequested} onClick={() => { deleteWorkspace(contextMenu.session.id); setContextMenu(null) }}>
                <Trash2 size={14} aria-hidden="true" />Delete workspace
              </button>
            </>
          ) : (
            <>
              <button type="button" role="menuitem" disabled={!contextMenu.session.workspaceFolder} onClick={() => { const session = contextMenu.session; setContextMenu(null); void revealWorktree(session) }}>
                <FolderOpen size={14} aria-hidden="true" />Reveal in File Explorer
              </button>
              <button type="button" role="menuitem" onClick={() => requestManageWorktrees(contextMenu.parentSession)}>
                <FolderGit2 size={14} aria-hidden="true" />Manage worktrees
              </button>
              <button type="button" role="menuitem" className="danger" onClick={() => void removeWorktree(contextMenu.session, contextMenu.worktree)}>
                <Trash2 size={14} aria-hidden="true" />Remove worktree…
              </button>
            </>
          )}
        </div>
      </div>,
      document.body,
    ) : null}
    {worktreeSource && typeof document !== 'undefined' ? createPortal(
      <WorktreeCreateDialog
        sourceSession={worktreeSource}
        profiles={profiles}
        initialProfileId={workspaceProfileIds[worktreeSource.id] ?? defaultProfileId}
        onCreate={async (input) => {
          await createWorktreeSession(input)
          setWorktreeSource(null)
        }}
        onClose={() => setWorktreeSource(null)}
      />,
      document.body,
    ) : null}
    {worktreeManageSource && typeof document !== 'undefined' ? createPortal(
      <WorktreeManageDialog sourceSession={worktreeManageSource} onClose={() => setWorktreeManageSource(null)} />,
      document.body,
    ) : null}
    </>
  )
}
