import { useEffect, useRef } from 'react'
import type { IDockviewPanelProps } from 'dockview-react'
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
    <div className="terminal-panel-shell" data-pane-id={paneId}>
      <div ref={hostRef} className="dock-terminal-host" />
    </div>
  )
}

export function PlaceholderPanel() {
  return <div className="placeholder-panel">Select or create a workspace.</div>
}
