import { Bot, Check, FolderTree, GitBranch, GitCompare, Globe, LayoutGrid, ListTodo, PanelsTopLeft, Workflow } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { WorkspaceContentKind } from '../layout/workspaceContentModel'

export type WorkspaceLauncherKind = 'explorer' | 'browser' | 'workbench' | 'orchestration' | 'agent' | 'kanban' | 'todo' | 'diff'

type WorkspaceViewLauncherProps = {
  isOpen: boolean
  disabled?: boolean
  activeKind: WorkspaceContentKind | null
  onToggle: () => void
  onClose: () => void
  onOpen: (kind: WorkspaceLauncherKind) => void
}

const viewItems = [
  { kind: 'explorer', label: 'Explorer', icon: FolderTree },
  { kind: 'browser', label: 'Browser', icon: Globe },
  { kind: 'workbench', label: 'Workbench', icon: GitBranch },
  { kind: 'orchestration', label: 'Orchestration', icon: Workflow },
  { kind: 'agent', label: 'Agent', icon: Bot },
  { kind: 'kanban', label: 'Kanban', icon: LayoutGrid },
  { kind: 'todo', label: 'Todo', icon: ListTodo },
  { kind: 'diff', label: 'Diff', icon: GitCompare },
] as const satisfies ReadonlyArray<{ kind: WorkspaceLauncherKind; label: string; icon: typeof FolderTree }>

export function WorkspaceViewLauncher({ isOpen, disabled, activeKind, onToggle, onClose, onOpen }: WorkspaceViewLauncherProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [popoverPosition, setPopoverPosition] = useState({ top: 42, left: 12 })

  useEffect(() => {
    if (!isOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node | null)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
      buttonRef.current?.focus()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    const frame = window.requestAnimationFrame(() => {
      const activeIndex = viewItems.findIndex((item) => item.kind === activeKind)
      itemRefs.current[Math.max(0, activeIndex)]?.focus()
    })
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [activeKind, isOpen, onClose])

  useLayoutEffect(() => {
    if (!isOpen) return
    const updatePosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (!rect) return
      setPopoverPosition({
        top: Math.round(rect.bottom + 5),
        left: Math.max(8, Math.min(Math.round(rect.left), window.innerWidth - 208)),
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    return () => window.removeEventListener('resize', updatePosition)
  }, [isOpen])

  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const currentIndex = itemRefs.current.findIndex((item) => item === document.activeElement)
    if (event.key === 'Tab') {
      onClose()
      return
    }
    let nextIndex: number
    if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1 + viewItems.length) % viewItems.length
    else if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + viewItems.length) % viewItems.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = viewItems.length - 1
    else return
    event.preventDefault()
    itemRefs.current[nextIndex]?.focus()
  }

  const stopTitlebarDrag = (event: { stopPropagation: () => void }) => event.stopPropagation()

  return (
    <div ref={rootRef} className="workspace-view-launcher" onMouseDown={stopTitlebarDrag} onPointerDown={stopTitlebarDrag}>
      <button
        ref={buttonRef}
        type="button"
        className="topbar-text-button"
        disabled={disabled}
        title="Open workspace view"
        aria-label="Open workspace view"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? 'workspace-view-menu' : undefined}
        onClick={onToggle}
      >
        <PanelsTopLeft size={14} aria-hidden="true" /> <span>View</span>
      </button>
      {isOpen ? (
        <div
          id="workspace-view-menu"
          className="workspace-view-menu"
          role="menu"
          aria-label="Workspace views"
          style={popoverPosition}
          onKeyDown={moveFocus}
        >
          {viewItems.map((item, index) => {
            const Icon = item.icon
            const active = activeKind === item.kind
            return (
              <button
                ref={(element) => { itemRefs.current[index] = element }}
                key={item.kind}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={active ? 'active' : undefined}
                onClick={() => { onClose(); onOpen(item.kind) }}
              >
                <Icon size={14} aria-hidden="true" />
                <span>{item.label}</span>
                {active ? <Check className="workspace-view-menu-check" size={13} aria-hidden="true" /> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
