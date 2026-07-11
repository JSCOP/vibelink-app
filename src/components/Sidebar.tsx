import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { CheckCircle2, Folder, Pencil, Pin, PinOff, Plus, Trash2 } from 'lucide-react'
import type { SessionMeta } from '../ipc/types'

type SidebarProps = {
  isOpen: boolean
  isPinned: boolean
  sessions: SessionMeta[]
  activeSessionId?: string
  completionCounts: Record<string, number>
  onSelect: (sessionId: string) => void
  onCreate: () => void
  onRename: (sessionId: string, name: string) => void
  onDelete: (sessionId: string) => void
  onReorder: (orderedIds: string[]) => void
  onTogglePin: () => void
  onPointerEnter: () => void
  onPointerLeave: () => void
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

export function Sidebar({ sessions, activeSessionId, completionCounts, isOpen, isPinned, onPointerEnter, onPointerLeave, onTogglePin, onSelect, onCreate, onRename, onDelete, onReorder }: SidebarProps) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)

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
    setDropTarget(dropTargetFromPoint(list, event.clientY, drag.id))
  }

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const target = dropTarget
    setDraggingId(null)
    setDropTarget(null)
    // A press that never crossed the threshold is a plain click → select.
    if (!drag.active) {
      onSelect(drag.id)
      return
    }
    if (!target) return
    const next = reorderIds(sessions.map((session) => session.id), drag.id, target.id, target.place)
    if (next.some((id, index) => id !== sessions[index]?.id)) onReorder(next)
  }

  const onRowPointerCancel = () => {
    dragRef.current = null
    setDraggingId(null)
    setDropTarget(null)
  }

  return (
    <aside className={`sidebar ${isOpen ? 'open' : ''}`} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      <div className="sidebar-heading">
        <span>Workspaces</span>
        <div className="sidebar-heading-actions">
          <button type="button" title={isPinned ? 'Unpin workspace sidebar' : 'Pin workspace sidebar'} aria-pressed={isPinned} onClick={onTogglePin}>
            {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
          <button type="button" title="New workspace" onClick={onCreate}>
            <Plus size={14} />
          </button>
        </div>
      </div>
      <div className="session-list" ref={listRef}>
        {sessions.map((session, index) => {
          const isDropTarget = dropTarget?.id === session.id
          const completionCount = completionCounts[session.id] ?? 0
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
              onPointerDown={(event) => onRowPointerDown(event, session.id)}
              onPointerMove={onRowPointerMove}
              onPointerUp={finishDrag}
              onPointerCancel={onRowPointerCancel}
            >
              <div className="session-main">
                <span className="session-order" title={index < 9 ? `Ctrl+${index + 1}` : undefined}>{index + 1}</span>
                <span className="session-icon"><Folder size={14} strokeWidth={1.7} /></span>
                <span className="session-name">{session.name}</span>
                {completionCount > 0 ? (
                  <span className="session-completion-badge" title={`${completionCount} AI coding agent ${completionCount === 1 ? 'pane needs' : 'panes need'} attention`} aria-label={`${completionCount} AI coding agent ${completionCount === 1 ? 'pane needs' : 'panes need'} attention`}>
                    <CheckCircle2 size={11} strokeWidth={2.2} aria-hidden="true" />
                    {completionCount}
                  </span>
                ) : null}
                <span className="session-badge" title={`${session.paneCount} terminal panes`}>{session.paneCount}</span>
              </div>
              <button
                type="button"
                title="Rename workspace"
                className="session-small-action"
                onClick={() => {
                  const name = window.prompt('Rename workspace', session.name)
                  if (name?.trim()) onRename(session.id, name.trim())
                }}
              >
                <Pencil size={13} strokeWidth={1.7} />
              </button>
              <button
                type="button"
                title="Delete workspace"
                className="session-small-action danger"
                onClick={() => onDelete(session.id)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
