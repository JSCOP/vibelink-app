import { useEffect, useMemo, useState } from 'react'
import type { DockviewApi } from 'dockview-core'
import { SquareTerminal, LayoutGrid } from 'lucide-react'
import type { WorkspaceContentActions } from './contentActions'

type WorkspaceEmptyStateProps = {
  api: DockviewApi | null
  actions: WorkspaceContentActions | null
}

/** Only the shortcuts that actually work with no window open. Both are handled
 *  in `WorkspaceView`'s keydown listener ahead of the panel-scoped bindings. */
const shortcuts: Array<{ label: string; keys: string[] }> = [
  { label: 'New terminal', keys: ['Ctrl', 'N'] },
  { label: 'Open file', keys: ['Ctrl', 'P'] },
]

/** Closing the last window left the centre area completely inert: the `+` lives
 * in a group header, and with no groups there is no header, so nothing but a
 * keyboard shortcut could open anything again. This is the way back.
 *
 * It is positioned INSIDE the dock but inset past the sidebar rails, which are
 * Dockview edge groups Dockview owns — the overlay is ours, so insetting it is
 * safe, but it must never reach into their geometry. */
function edgeInsets(api: DockviewApi): { left: number; right: number } {
  const width = (position: 'left' | 'right') => {
    const edgeId = api.getEdgeGroup(position)?.id
    const edge = edgeId ? api.groups.find((group) => group.id === edgeId) : undefined
    return edge ? Math.round(edge.element.getBoundingClientRect().width) : 0
  }
  return { left: width('left'), right: width('right') }
}

export function WorkspaceEmptyState({ api, actions }: WorkspaceEmptyStateProps) {
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!api) return
    const bump = () => setRevision((value) => value + 1)
    const disposables = [api.onDidLayoutChange(bump), api.onDidAddPanel(bump), api.onDidRemovePanel(bump)]
    bump()
    return () => { for (const disposable of disposables) disposable.dispose() }
  }, [api])

  const state = useMemo(() => {
    if (!api) return null
    const hasWindow = api.groups.some((group) => group.api.location.type === 'grid' && group.panels.length > 0)
    return hasWindow ? null : edgeInsets(api)
    // `revision` IS the dependency: Dockview mutates its group list in place,
    // so nothing else changes identity when the last window closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, revision])

  if (!state) return null

  return (
    <div className="workspace-empty-state" style={{ left: state.left, right: state.right }}>
      <div className="workspace-empty-state-card">
        <h2>No windows open</h2>
        <p>Open a terminal or another window to start working in this workspace.</p>
        <div className="workspace-empty-state-actions">
          <button type="button" disabled={!actions} onClick={() => void actions?.openContent({ kind: 'terminal' })}>
            <SquareTerminal size={15} aria-hidden="true" /> New terminal
          </button>
          <button type="button" disabled={!actions} onClick={() => void actions?.openContent({ kind: 'terminalWindow' })}>
            <LayoutGrid size={15} aria-hidden="true" /> New terminal window
          </button>
        </div>
        <dl className="workspace-empty-state-shortcuts">
          {shortcuts.map((shortcut) => (
            <div key={shortcut.label}>
              <dt>{shortcut.label}</dt>
              <dd>{shortcut.keys.map((key) => <kbd key={key}>{key}</kbd>)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
