import { useCallback, useEffect, useRef } from 'react'
import type { IDockviewPanelProps } from 'dockview-react'
import { useWorkspaceStore } from '../state/store'
import { TerminalManager } from '../terminal/TerminalManager'

type TerminalPanelParams = {
  paneId: string
  title?: string | null
}

export function TerminalPanePanel(props: IDockviewPanelProps<TerminalPanelParams>) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const paneId = props.params.paneId
  const applyTerminalTitle = useWorkspaceStore((state) => state.applyTerminalTitle)
  const onTitleChange = useCallback((title: string) => {
    void applyTerminalTitle(paneId, title)
  }, [applyTerminalTitle, paneId])

  useEffect(() => {
    if (hostRef.current) {
      TerminalManager.attach(paneId, hostRef.current, { onTitleChange })
    }
  }, [onTitleChange, paneId])

  return (
    <div className="terminal-panel-shell" data-pane-id={paneId}>
      <div ref={hostRef} className="dock-terminal-host" />
    </div>
  )
}

export function PlaceholderPanel() {
  return <div className="placeholder-panel">Select or create a workspace.</div>
}
