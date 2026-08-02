import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Bell, GitBranch, MemoryStick, SquareTerminal } from 'lucide-react'
import { useGitStore } from '../../state/git'
import { useWorkspaceStore } from '../../state/store'
import type { ResourceSnapshot } from '../../ipc/types'
import './statusbar.css'

const RESOURCE_POLL_MS = 15_000

export type StatusBarProps = {
  onOpenResourceMonitor: () => void
  onOpenCompletionHistory: () => void
}

const formatMemory = (bytes: number) => bytes >= 1024 * 1024 * 1024
  ? `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  : `${(bytes / (1024 * 1024)).toFixed(0)} MB`

/** Bottom status strip: workspace context on the left and one Orca-style
 *  resource trigger on the right. Full process details are returned only when open. */
export function StatusBar({ onOpenResourceMonitor, onOpenCompletionHistory }: StatusBarProps) {
  const session = useWorkspaceStore((state) => state.sessions.find((entry) => entry.id === state.activeSessionId))
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const activeLivePaneCount = useWorkspaceStore((state) => Object.values(state.panes).filter((pane) => pane.alive).length)
  const completionHistoryCount = useWorkspaceStore((state) => state.completionHistory.length)
  const unreadCompletionCount = useWorkspaceStore((state) => state.completionHistory.filter((entry) => !entry.read).length)
  const repoInfo = useGitStore((state) => (activeSessionId ? state.sessions[activeSessionId]?.repositories['']?.repoInfo ?? null : null))
  const [resources, setResources] = useState<ResourceSnapshot | null>(null)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      if (document.visibilityState === 'hidden') return
      try {
        const snapshot = await invoke<ResourceSnapshot>('resource_snapshot', { includeDetails: false })
        if (!cancelled) setResources(snapshot)
      } catch {
        if (!cancelled) setResources(null)
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), RESOURCE_POLL_MS)
    window.addEventListener('focus', poll)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', poll)
    }
  }, [])

  const terminalCount = resources?.panes.length ?? activeLivePaneCount
  const terminalLabel = `${terminalCount} terminal${terminalCount === 1 ? '' : 's'}`
  const memoryLabel = resources ? formatMemory(resources.totalMemBytes) : '—'
  const processCount = resources ? resources.app.processCount + resources.daemon.processCount + resources.panes.reduce((total, pane) => total + pane.processCount, 0) : null
  const processLabel = processCount === null ? null : `${processCount} process${processCount === 1 ? '' : 'es'}`
  const resourceTitle = resources
    ? `Open resource manager · ${memoryLabel} · ${terminalLabel} · ${processLabel}`
    : `Open resource manager · ${terminalLabel}`

  return (
    <footer className="statusbar" aria-label="Status bar">
      <span className="statusbar-segment statusbar-workspace" title={session?.workspaceFolder ?? undefined}>
        {repoInfo?.branch ? <GitBranch size={12} aria-hidden="true" /> : null}
        <span className="statusbar-workspace-name">{session?.name ?? 'No workspace'}</span>
        {repoInfo?.branch ? <span className="statusbar-branch">{repoInfo.branch}</span> : null}
        {repoInfo && (repoInfo.ahead > 0 || repoInfo.behind > 0) ? (
          <span className="statusbar-sync">{repoInfo.ahead > 0 ? `↑${repoInfo.ahead}` : ''}{repoInfo.behind > 0 ? `↓${repoInfo.behind}` : ''}</span>
        ) : null}
      </span>
      <span className="statusbar-spacer" />
      {completionHistoryCount > 0 ? <button type="button" className="statusbar-segment" title="Open completion history" onClick={onOpenCompletionHistory}><Bell size={12} aria-hidden="true" />{unreadCompletionCount}</button> : null}
      <button type="button" className="statusbar-segment statusbar-resources" title={resourceTitle} aria-label={resourceTitle} onClick={onOpenResourceMonitor}>
        <MemoryStick size={12} aria-hidden="true" />
        <span>{memoryLabel}</span>
        <span className="statusbar-resource-separator" aria-hidden="true">·</span>
        <SquareTerminal size={12} aria-hidden="true" />
        <span className="statusbar-resource-count">{terminalCount}</span>
      </button>
    </footer>
  )
}
