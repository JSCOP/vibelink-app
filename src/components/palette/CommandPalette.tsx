import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { AppWindow, FolderKanban, SquareTerminal } from 'lucide-react'
import { getOpenContentSnapshot, subscribeOpenContent } from '../../layout/openContentRegistry'
import type { WorkspaceContentActions } from '../../layout/contentActions'
import { useWorkspaceStore } from '../../state/store'
import { buildAttentionByWorkspace, deriveVisibleWorkspaceOrder } from '../../state/worktreeAttention'
import { filterPaletteItems, orderWithRecents, paletteCategoryTitle, type PaletteCategory, type PaletteItem } from './paletteModel'
import { closePalette, paletteStore, readPaletteRecents, recordPaletteRecent } from './paletteStore'
import { ProfileIcon } from '../ProfileIcon'
import { profileIconForPane } from '../../state/profiles'
import './palette.css'

export type CommandPaletteProps = {
  contentActions: WorkspaceContentActions | null
  /** App-level commands (open settings, capture, resource monitor…). */
  commands?: PaletteItem[]
}

const MAX_VISIBLE = 12

export function CommandPaletteHost({ contentActions, commands = [] }: CommandPaletteProps) {
  const { open } = useSyncExternalStore(paletteStore.subscribe, paletteStore.getSnapshot, paletteStore.getSnapshot)
  const sessions = useWorkspaceStore((state) => state.sessions)
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const settings = useWorkspaceStore((state) => state.settings)
  const worktrees = useWorkspaceStore((state) => state.worktreeProjections)
  const attentionSnapshot = useWorkspaceStore((state) => state.attentionSnapshot)
  const hermesStatus = useWorkspaceStore((state) => state.hermesStatus)
  const hermesPermissions = useWorkspaceStore((state) => state.hermesPermissions)
  const paneCompletionHighlights = useWorkspaceStore((state) => state.paneCompletionHighlights)
  const paneReviewMarkers = useWorkspaceStore((state) => state.paneReviewMarkers)
  const openSession = useWorkspaceStore((state) => state.openSession)
  const openContent = useSyncExternalStore(subscribeOpenContent, getOpenContentSnapshot, getOpenContentSnapshot)

  const items = useMemo<PaletteItem[]>(() => {
    if (!open) return []
    const attentionByWorkspace = buildAttentionByWorkspace(sessions, worktrees, attentionSnapshot, {
      completionHighlights: paneCompletionHighlights,
      hermesStatus,
      hermesPermissions,
      reviewedPaneIds: new Set(Object.keys(paneReviewMarkers)),
      conflictSessionIds: new Set(worktrees.flatMap((projection) => projection.native?.hasConflicts && projection.record?.sessionId ? [projection.record.sessionId] : [])),
    })
    const ordered = deriveVisibleWorkspaceOrder(
      sessions,
      settings.workspaceGroups,
      settings.workspaceGroupIds,
      worktrees,
      settings.workspaceSortMode,
      attentionByWorkspace,
      settings.workspaceOrder,
    ).sessions

    const workspaces: PaletteItem[] = ordered.map((session) => ({
      id: `ws:${session.id}`,
      category: 'workspace',
      label: session.name,
      detail: session.workspaceFolder ?? undefined,
      icon: FolderKanban,
      run: () => {
        if (session.id === activeSessionId) return
        void openSession(session.id).catch(() => undefined)
      },
    }))

    const content: PaletteItem[] = openContent
      .filter((item) => !item.active)
      .map((item) => ({
        id: `content:${item.panelId}`,
        category: 'content',
        label: item.title,
        detail: item.kind,
        iconName: item.icon,
        run: () => contentActions?.activateContent(item.panelId),
      }))

    const terminals: PaletteItem[] = settings.profiles.map((profile) => ({
      id: `term:${profile.id}`,
      category: 'terminal',
      label: profile.name,
      detail: profile.command || profile.shell || 'Terminal',
      iconName: profileIconForPane(profile),
      run: () => { void contentActions?.openContent({ kind: 'terminal', profileId: profile.id }) },
    }))

    return [...workspaces, ...content, ...terminals, ...commands]
  }, [open, sessions, activeSessionId, settings, worktrees, attentionSnapshot, hermesStatus, hermesPermissions, paneCompletionHighlights, paneReviewMarkers, openSession, openContent, contentActions, commands])

  if (!open) return null
  return <PaletteSurface items={items} />
}

function PaletteSurface({ items }: { items: PaletteItem[] }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [recents, setRecents] = useState<string[]>(() => readPaletteRecents())
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const { recents: recentItems, rest } = useMemo(() => orderWithRecents(filterPaletteItems(items, query), query.trim() ? [] : recents), [items, query, recents])
  const visible = useMemo(() => [...recentItems, ...rest].slice(0, MAX_VISIBLE * 3), [recentItems, rest])
  const selectedItem = visible[Math.min(selected, Math.max(visible.length - 1, 0))]

  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selectedItem?.id])

  const runItem = (item: PaletteItem) => {
    closePalette()
    recordPaletteRecent(item.id)
    setRecents(readPaletteRecents())
    void item.run()
  }

  let lastCategory: PaletteCategory | null = null
  const rows = visible.map((item, index) => {
    const category: PaletteCategory = recentItems.includes(item) ? 'recent' : item.category
    const header = category !== lastCategory ? <p key={`h-${category}`} className="command-palette-heading">{paletteCategoryTitle[category]}</p> : null
    lastCategory = category
    return (
      <div key={item.id}>
        {header}
        <button
          type="button"
          className="command-palette-item"
          data-selected={index === selected || undefined}
          onMouseEnter={() => setSelected(index)}
          onClick={() => runItem(item)}
        >
          <span className="command-palette-item-icon">
            {item.iconName
              ? <ProfileIcon name={item.iconName} size={15} />
              : item.icon
                ? <item.icon size={15} aria-hidden="true" />
                : <SquareTerminal size={15} aria-hidden="true" />}
          </span>
          <span className="command-palette-item-label">{item.label}</span>
          {item.detail ? <span className="command-palette-item-detail">{item.detail}</span> : null}
        </button>
      </div>
    )
  })
  if (visible.length === 0) {
    rows.push(<p key="empty" className="command-palette-empty">No matching workspaces, tabs, or commands.</p>)
  }

  return createPortal(
    <div className="command-palette-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) closePalette() }}>
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={inputRef}
          type="text"
          className="command-palette-input"
          placeholder="Switch workspace, open content, run a command…"
          aria-label="Command palette"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelected(0)
          }}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setSelected((current) => Math.min(current + 1, visible.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setSelected((current) => Math.max(current - 1, 0))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              if (selectedItem) runItem(selectedItem)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              closePalette()
            }
          }}
        />
        <div ref={listRef} className="command-palette-list" role="listbox" aria-label="Results">
          {rows}
        </div>
        <p className="command-palette-hint"><AppWindow size={12} aria-hidden="true" /> ↑↓ choose · Enter run · Esc close</p>
      </div>
    </div>,
    document.body,
  )
}
