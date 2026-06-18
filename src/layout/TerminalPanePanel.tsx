import { useEffect, useRef } from 'react'
import type { IDockviewPanelProps } from 'dockview-react'
import { PaneHeader } from '../components/PaneHeader'
import { TerminalManager } from '../terminal/TerminalManager'

type TerminalPanelParams = {
  paneId: string
  title?: string | null
}

export function TerminalPanePanel(props: IDockviewPanelProps<TerminalPanelParams>) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const paneId = props.params.paneId

  useEffect(() => {
    if (hostRef.current) {
      TerminalManager.attach(paneId, hostRef.current)
    }
  }, [paneId])

  return (
    <div className="terminal-panel-shell">
      <PaneHeader paneId={paneId} title={props.params.title} />
      <div ref={hostRef} className="dock-terminal-host" />
      <div className="pane-status-line">{props.params.title ?? 'Shell'} · live daemon session</div>
    </div>
  )
}

export function PlaceholderPanel() {
  return <div className="placeholder-panel">Select or create a workspace.</div>
}
