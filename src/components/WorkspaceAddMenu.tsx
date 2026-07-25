import { Bot, FileCode2, GitBranch, GitCompare, Globe, LayoutGrid, ListTodo, Plus, Search, Workflow, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { AgentCliStatus } from '../ipc/agents'
import type { OpenContentRequest, WorkspaceContentActions } from '../layout/contentActions'
import type { Profile } from '../state/profiles'
import { useWorkspaceStore } from '../state/store'
import { ProfileIcon } from './ProfileIcon'
import { steppedPickerId, type PickerEntry } from './pickerModel'

type WorkspaceWindowKind = 'browser' | 'agent' | 'orchestration' | 'workbench' | 'kanban' | 'todo' | 'diff'
type WorkspaceAddMenuItem =
  | { id: string; section: 'Terminals'; label: string; profile: Profile; disabled: boolean; hint?: string }
  | { id: string; section: 'Windows'; label: string; icon: LucideIcon; kind: WorkspaceWindowKind | 'editor'; disabled: false }

type WorkspaceAddMenuProps = {
  actions: WorkspaceContentActions | null
  targetGroupId: string
  disabled?: boolean
  overlayId: string
  openFilePicker?: (targetGroupId?: string) => void
  setWorkspaceOverlayOpen?: (overlayId: string, open: boolean) => void
}

const windowItems: Array<{ kind: WorkspaceWindowKind | 'editor'; label: string; icon: LucideIcon }> = [
  { kind: 'browser', label: 'Browser', icon: Globe },
  { kind: 'editor', label: 'Editor', icon: FileCode2 },
  { kind: 'agent', label: 'VibeLink Agent', icon: Bot },
  { kind: 'orchestration', label: 'Orchestration', icon: Workflow },
  { kind: 'workbench', label: 'Workbench', icon: GitBranch },
  { kind: 'kanban', label: 'Kanban', icon: LayoutGrid },
  { kind: 'todo', label: 'Todo List', icon: ListTodo },
  { kind: 'diff', label: 'Task Diff', icon: GitCompare },
]

function profileInstallHint(profile: Profile, statusById: Record<string, AgentCliStatus>): string | undefined {
  const status = statusById[profile.id.toLowerCase()]
  return status && !status.installed ? `Install ${status.displayName} or pick another profile` : undefined
}

function selectableEntries(items: WorkspaceAddMenuItem[]): PickerEntry<string>[] {
  return items.flatMap((item) => item.disabled ? [] : [{ kind: 'item' as const, id: item.id, name: item.label }])
}

export function WorkspaceAddMenu({ actions, targetGroupId, disabled, overlayId, openFilePicker, setWorkspaceOverlayOpen }: WorkspaceAddMenuProps) {
  const profiles = useWorkspaceStore((state) => state.settings.profiles)
  const agentClis = useWorkspaceStore((state) => state.agentClis)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(null)
  const [filter, setFilter] = useState('')
  const menuId = useId()
  const statusById = useMemo(
    () => Object.fromEntries(agentClis.map((status) => [status.id.toLowerCase(), status])),
    [agentClis],
  )
  const items = useMemo<WorkspaceAddMenuItem[]>(() => [
    ...profiles.map((profile) => {
      const hint = profileInstallHint(profile, statusById)
      return {
        id: `terminal:${profile.id}`,
        section: 'Terminals' as const,
        label: `New Terminal: ${profile.name}`,
        profile,
        disabled: Boolean(hint),
        hint,
      }
    }),
    ...windowItems.map((item) => ({
      id: `window:${item.kind}`,
      section: 'Windows' as const,
      label: item.label,
      icon: item.icon,
      kind: item.kind,
      disabled: false as const,
    })),
  ], [profiles, statusById])
  const filteredItems = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase()
    return query ? items.filter((item) => item.label.toLocaleLowerCase().includes(query)) : items
  }, [filter, items])
  const [activeId, setActiveId] = useState<string | null>(() => steppedPickerId(selectableEntries(items), null, 1))
  const terminalItems = filteredItems.filter((item) => item.section === 'Terminals')
  const workspaceWindowItems = filteredItems.filter((item) => item.section === 'Windows')

  useEffect(() => {
    setWorkspaceOverlayOpen?.(overlayId, open)
    return () => {
      if (open) setWorkspaceOverlayOpen?.(overlayId, false)
    }
  }, [open, overlayId, setWorkspaceOverlayOpen])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [activeId, filteredItems])

  const closeMenu = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  const activateItem = (id: string | null) => {
    if (!id || !actions) return
    const item = items.find((candidate) => candidate.id === id)
    if (!item || item.disabled) return
    closeMenu()
    if (item.section === 'Terminals') {
      void actions.openContent({ kind: 'terminal', targetGroupId, profileId: item.profile.id })
      return
    }
    if (item.kind === 'editor') {
      openFilePicker?.(targetGroupId)
      return
    }
    void actions.openContent({ kind: item.kind, targetGroupId } as OpenContentRequest)
  }

  const highlight = (id: string | null) => {
    if (!id) return
    const item = filteredItems.find((candidate) => candidate.id === id)
    if (!item || item.disabled) return
    setActiveId(id)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      highlight(steppedPickerId(selectableEntries(filteredItems), activeId, event.key === 'ArrowDown' ? 1 : -1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      activateItem(activeId)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu(true)
    }
  }

  const renderItem = (item: WorkspaceAddMenuItem) => {
    const isActive = item.id === activeId
    const Icon = item.section === 'Windows' ? item.icon : null
    const hint = item.section === 'Terminals' ? item.hint : undefined
    return (
      <button
        key={item.id}
        id={`${menuId}-${item.id}`}
        type="button"
        className="workspace-add-menu-item"
        data-active={isActive ? 'true' : undefined}
        disabled={item.disabled}
        title={hint}
        aria-label={item.label}
        onMouseEnter={() => highlight(item.id)}
        onClick={() => activateItem(item.id)}
      >
        <span className="workspace-add-menu-icon" aria-hidden="true">
          {item.section === 'Terminals'
            ? <ProfileIcon name={item.profile.icon} color={item.profile.color} size={15} />
            : Icon ? <Icon size={15} /> : null}
        </span>
        <span className="workspace-add-menu-item-copy">
          <span>{item.label}</span>
          {hint ? <small>{hint}</small> : null}
        </span>
      </button>
    )
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="workspace-group-new"
        title="Add terminal or window"
        aria-label="Add terminal or window"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled || !actions}
        onClick={(event) => {
          if (open) {
            closeMenu()
            return
          }
          const rect = event.currentTarget.getBoundingClientRect()
          setAnchor({ right: rect.right, bottom: rect.bottom })
          setFilter('')
          setActiveId(steppedPickerId(selectableEntries(items), null, 1))
          setOpen(true)
        }}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
      {open && anchor && typeof document !== 'undefined' ? createPortal(
        <>
          <div className="workspace-group-menu-backdrop" role="presentation" onMouseDown={() => closeMenu()} />
          <div
            id={menuId}
            className="workspace-group-menu workspace-add-menu"
            role="dialog"
            aria-label="Add terminal or window"
            aria-activedescendant={activeId ? `${menuId}-${activeId}` : undefined}
            style={{ right: Math.max(8, window.innerWidth - anchor.right), top: anchor.bottom + 2 }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={onKeyDown}
          >
            <label className="workspace-add-menu-search">
              <Search size={15} aria-hidden="true" />
              <input
                autoFocus
                value={filter}
                aria-label="Filter add commands"
                placeholder="Open a file, URL, or agent…"
                onChange={(event) => {
                  const nextFilter = event.target.value
                  const query = nextFilter.trim().toLocaleLowerCase()
                  const nextItems = query ? items.filter((item) => item.label.toLocaleLowerCase().includes(query)) : items
                  setFilter(nextFilter)
                  if (!nextItems.some((item) => !item.disabled && item.id === activeId)) {
                    setActiveId(steppedPickerId(selectableEntries(nextItems), null, 1))
                  }
                }}
              />
            </label>
            <div className="workspace-add-menu-list" ref={listRef}>
              {terminalItems.length > 0 ? (
                <section className="workspace-add-menu-section" aria-label="Terminals">
                  <div className="workspace-add-menu-section-title">Terminals</div>
                  {terminalItems.map(renderItem)}
                </section>
              ) : null}
              {terminalItems.length > 0 && workspaceWindowItems.length > 0 ? <div className="workspace-group-menu-separator" role="separator" /> : null}
              {workspaceWindowItems.length > 0 ? (
                <section className="workspace-add-menu-section" aria-label="Windows">
                  <div className="workspace-add-menu-section-title">Windows</div>
                  {workspaceWindowItems.map(renderItem)}
                </section>
              ) : null}
              {filteredItems.length === 0 ? <div className="workspace-add-menu-empty">No commands match “{filter}”.</div> : null}
            </div>
          </div>
        </>,
        document.body,
      ) : null}
    </>
  )
}
