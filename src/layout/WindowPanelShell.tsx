import type { ReactNode } from 'react'

type WindowPanelShellProps = {
  panelId: string
  className?: string
  children: ReactNode
}

/** Content shell only. Dockview owns all drag, drop, tab-group, and split
 * movement authority for the one-tree workspace. */
export function WindowPanelShell({ panelId, className, children }: WindowPanelShellProps) {
  return (
    <div
      className={`workspace-window-panel${className ? ` ${className}` : ''}`}
      data-content-panel-id={panelId}
    >
      {children}
    </div>
  )
}
