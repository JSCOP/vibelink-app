import { PanelLeftClose } from 'lucide-react'
import type { ReactNode } from 'react'

export type WorkspaceSidebarPanelState =
  | { kind: 'loading'; message: string; detail?: string }
  | { kind: 'empty'; message: string; detail?: string }
  | { kind: 'error'; message: string; detail?: string }

export type WorkspaceSidebarPanelShellProps = {
  title: string
  icon: ReactNode
  actions?: ReactNode
  filter?: ReactNode
  children: ReactNode
  footer?: ReactNode
  onCollapse?: () => void
  collapsed?: boolean
  active?: boolean
  state?: WorkspaceSidebarPanelState | null
  className?: string
  ariaLabel?: string
  collapseLabel?: string
}

export function WorkspaceSidebarPanelShell({
  title,
  icon,
  actions,
  filter,
  children,
  footer,
  onCollapse,
  collapsed = false,
  active = false,
  state = null,
  className,
  ariaLabel,
  collapseLabel = `Collapse ${title}`,
}: WorkspaceSidebarPanelShellProps) {
  const shellClassName = ['workspace-sidebar-panel-shell', active ? 'is-active' : '', className ?? ''].filter(Boolean).join(' ')
  const body = state ? (
    <div
      className={`workspace-sidebar-panel-state workspace-sidebar-panel-state-${state.kind}`}
      role={state.kind === 'error' ? 'alert' : 'status'}
      aria-live={state.kind === 'error' ? 'assertive' : 'polite'}
    >
      <strong>{state.message}</strong>
      {state.detail ? <span>{state.detail}</span> : null}
    </div>
  ) : children

  return (
    <section className={shellClassName} aria-label={ariaLabel ?? title} aria-busy={state?.kind === 'loading' || undefined}>
      <header className="workspace-sidebar-panel-header">
        <span className="workspace-sidebar-panel-icon" aria-hidden="true">{icon}</span>
        <h2 title={title}>{title}</h2>
        {actions ? <div className="workspace-sidebar-panel-actions">{actions}</div> : null}
        {onCollapse ? (
          <button
            type="button"
            className="workspace-sidebar-panel-collapse"
            title={collapseLabel}
            aria-label={collapseLabel}
            aria-expanded={!collapsed}
            onClick={onCollapse}
          >
            <PanelLeftClose size={14} aria-hidden="true" />
          </button>
        ) : null}
      </header>
      {filter ? <div className="workspace-sidebar-panel-filter">{filter}</div> : null}
      <div className="workspace-sidebar-panel-body">{body}</div>
      {footer ? <footer className="workspace-sidebar-panel-footer">{footer}</footer> : null}
    </section>
  )
}
