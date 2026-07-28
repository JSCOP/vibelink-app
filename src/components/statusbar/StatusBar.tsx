import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Activity, GitBranch, SquareTerminal } from 'lucide-react'
import { useGitStore } from '../../state/git'
import { useWorkspaceStore } from '../../state/store'
import type { ResourceSnapshot } from '../../ipc/types'
import './statusbar.css'

const RESOURCE_POLL_MS = 5_000

export type StatusBarProps = {
  onOpenResourceMonitor: () => void
}

const formatMiB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(0)} MB`

/** Bottom status strip: workspace + branch on the left, live pane count and a
 *  resource summary on the right. Read-only; the resource poll pauses while
 *  the window is hidden so the bar costs nothing in the background. */
export function StatusBar({ onOpenResourceMonitor }: StatusBarProps) {
  const session = useWorkspaceStore((state) => state.sessions.find((entry) => entry.id === state.activeSessionId))
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const livePaneCount = useWorkspaceStore((state) => Object.values(state.panes).filter((pane) => pane.alive).length)
  const repoInfo = useGitStore((state) => (activeSessionId ? state.sessions[activeSessionId]?.repositories['']?.repoInfo ?? null : null))
  const [resources, setResources] = useState<ResourceSnapshot | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer = 0
    const poll = async () => {
      if (document.visibilityState === 'hidden') return
      try {
        const snapshot = await invoke<ResourceSnapshot>('resource_snapshot')
        if (!cancelled) setResources(snapshot)
      } catch {
        if (!cancelled) setResources(null)
      }
    }
    void poll()
    timer = window.setInterval(() => void poll(), RESOURCE_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const processCount = resources ? resources.app.processCount + resources.daemon.processCount + resources.panes.reduce((total, pane) => total + pane.processCount, 0) : null

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
      <span className="statusbar-segment" title="Live terminal panes">
        <SquareTerminal size={12} aria-hidden="true" />
        {livePaneCount} {livePaneCount === 1 ? 'pane' : 'panes'}
      </span>
      <button type="button" className="statusbar-segment statusbar-resources" title="Open resource monitor" onClick={onOpenResourceMonitor}>
        <Activity size={12} aria-hidden="true" />
        {resources ? `${formatMiB(resources.totalMemBytes)} · ${processCount} processes` : 'Resources…'}
      </button>
    </footer>
  )
}
