import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, MemoryStick, RefreshCw, RotateCcw, SquareTerminal, Trash2, X } from 'lucide-react'
import type { ResourcePane, ResourceProc, ResourceProcess, ResourceSnapshot, SessionMeta } from '../ipc/types'
import { confirmDialog, isAppDialogOpen } from './appDialogStore'
import { useWorkspaceStore } from '../state/store'
import './ResourceMonitorDialog.css'

type ResourceMonitorDialogProps = {
  onClose: () => void
  onStopWorkspaceTerminals: () => Promise<void> | void
  onAfterRestart: () => Promise<void> | void
}

type BusyAction = 'refresh' | 'stopWorkspace' | 'restartDaemon' | `pane:${string}` | null

export function ResourceMonitorDialog({ onClose, onStopWorkspaceTerminals, onAfterRestart }: ResourceMonitorDialogProps) {
  const sessions = useWorkspaceStore((state) => state.sessions)
  const panes = useWorkspaceStore((state) => state.panes)
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const closePane = useWorkspaceStore((state) => state.closePane)
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<BusyAction>(null)
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(new Set())
  const [runtimeCollapsed, setRuntimeCollapsed] = useState(true)

  const loadSnapshot = useCallback(async () => {
    try {
      const next = await invoke<ResourceSnapshot>('resource_snapshot', { includeDetails: true })
      setSnapshot(next)
      setError('')
    } catch (caught) {
      setError(String(caught))
    }
  }, [])

  useEffect(() => {
    const poll = () => {
      if (document.visibilityState !== 'visible') return
      void loadSnapshot()
    }
    void poll()
    const intervalId = window.setInterval(poll, 2000)
    window.addEventListener('focus', poll)
    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener('focus', poll)
    }
  }, [loadSnapshot])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isAppDialogOpen()) return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  const groups = useMemo(() => groupResourcePanes(snapshot?.panes ?? [], sessions), [sessions, snapshot?.panes])
  const totalProcessCount = snapshot
    ? snapshot.app.processCount + snapshot.daemon.processCount + snapshot.panes.reduce((total, pane) => total + pane.processCount, 0)
    : 0
  const runtimeCpu = snapshot ? snapshot.app.cpuPercentX10 + snapshot.daemon.cpuPercentX10 : 0
  const runtimeMemory = snapshot ? snapshot.app.memBytes + snapshot.daemon.memBytes : 0
  const runtimeProcesses = snapshot ? snapshot.app.processCount + snapshot.daemon.processCount : 0

  const toggleSession = (sessionId: string) => {
    setCollapsedSessions((current) => {
      const next = new Set(current)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  const refresh = async () => {
    setBusy('refresh')
    await loadSnapshot()
    setBusy(null)
  }

  const stopWorkspace = async () => {
    if (!activeSessionId) return
    const confirmed = await confirmDialog({
      title: 'Stop active workspace terminals?',
      message: 'Every terminal process in the active workspace will be stopped. Unsaved terminal work is lost.',
      confirmLabel: 'Stop terminals',
      danger: true,
    })
    if (!confirmed) return
    setBusy('stopWorkspace')
    try {
      await onStopWorkspaceTerminals()
      await loadSnapshot()
    } catch (caught) {
      setError(String(caught))
    } finally {
      setBusy(null)
    }
  }

  const stopPane = async (pane: ResourcePane, label: string) => {
    const confirmed = await confirmDialog({
      title: `Stop ${label}?`,
      message: 'The terminal and its entire process tree will be stopped. This cannot be undone.',
      confirmLabel: 'Stop terminal',
      danger: true,
    })
    if (!confirmed) return
    setBusy(`pane:${pane.paneId}`)
    try {
      await closePane(pane.paneId, pane.sessionId)
      await loadSnapshot()
    } catch (caught) {
      setError(String(caught))
    } finally {
      setBusy(null)
    }
  }

  const restartDaemon = async () => {
    const confirmed = await confirmDialog({
      title: 'Restart daemon?',
      message: 'Running terminal processes will stop. Restorable panes reopen with new processes after the daemon restarts.',
      confirmLabel: 'Restart daemon',
      danger: true,
    })
    if (!confirmed) return
    setBusy('restartDaemon')
    try {
      await invoke('restart_daemon')
      await onAfterRestart()
      await loadSnapshot()
    } catch (caught) {
      setError(String(caught))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="resource-manager-layer" role="presentation" onMouseDown={() => { if (!isAppDialogOpen()) onClose() }}>
      <section className="resource-manager" role="dialog" aria-modal="false" aria-labelledby="resource-manager-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="resource-manager-header">
          <div className="resource-manager-title">
            <MemoryStick size={13} aria-hidden="true" />
            <strong id="resource-manager-title">Resource manager</strong>
          </div>
          <div className="resource-manager-header-actions">
            <button type="button" title="Refresh resource snapshot" aria-label="Refresh resource snapshot" disabled={busy !== null} onClick={() => void refresh()}>
              <RefreshCw className={busy === 'refresh' ? 'spin' : undefined} size={13} aria-hidden="true" />
            </button>
            <button type="button" title="Stop active workspace terminals" aria-label="Stop active workspace terminals" disabled={!activeSessionId || busy !== null} onClick={() => void stopWorkspace()}>
              <Trash2 size={13} aria-hidden="true" />
            </button>
          </div>
        </header>

        {error ? <div className="resource-manager-error" role="status">Resource snapshot unavailable: {error}</div> : null}

        <div className="resource-manager-summary">
          <span>{snapshot ? <><strong>{formatCpu(snapshot.totalCpuPercentX10)}</strong><i>·</i><strong>{formatBytes(snapshot.totalMemBytes)} <small>WS</small></strong></> : 'Loading…'}</span>
          <span>{snapshot ? `${snapshot.panes.length} terminal${snapshot.panes.length === 1 ? '' : 's'} · ${totalProcessCount} process${totalProcessCount === 1 ? '' : 'es'}` : 'Collecting processes'}</span>
        </div>

        <div className="resource-manager-columns" aria-hidden="true">
          <span />
          <span>Name</span>
          <span>CPU</span>
          <span>WS</span>
          <span />
        </div>

        <div className="resource-manager-tree">
          {groups.map((group) => {
            const collapsed = collapsedSessions.has(group.id)
            return (
              <section className="resource-manager-group" key={group.id}>
                <ResourceGroupHeader
                  label={group.label}
                  collapsed={collapsed}
                  cpuPercentX10={group.cpuPercentX10}
                  memBytes={group.memBytes}
                  processCount={group.processCount}
                  onToggle={() => toggleSession(group.id)}
                />
                {!collapsed ? group.panes.map((pane, index) => {
                  const livePane = panes[pane.paneId]
                  const label = pane.title?.trim() || livePane?.config.title?.trim() || livePane?.config.shell?.trim() || `Terminal ${index + 1}`
                  const role = pane.role?.trim() || livePane?.config.role?.trim() || ''
                  return <TerminalResourceRow key={pane.paneId} pane={pane} label={label} role={role} busy={busy === `pane:${pane.paneId}`} onStop={() => void stopPane(pane, label)} />
                }) : null}
              </section>
            )
          })}

          {snapshot && groups.length === 0 ? <div className="resource-manager-empty">No terminal processes are running.</div> : null}

          {snapshot ? (
            <section className="resource-manager-group resource-manager-runtime">
              <ResourceGroupHeader
                label="VibeLink runtime"
                collapsed={runtimeCollapsed}
                cpuPercentX10={runtimeCpu}
                memBytes={runtimeMemory}
                processCount={runtimeProcesses}
                onToggle={() => setRuntimeCollapsed((value) => !value)}
              />
              {!runtimeCollapsed ? <>
                <RuntimeResourceRow label="App / WebView" resource={snapshot.app} />
                <RuntimeResourceRow label="Daemon" resource={snapshot.daemon} />
              </> : null}
            </section>
          ) : null}
        </div>

        <footer className="resource-manager-footer">
          <button type="button" disabled={busy !== null} onClick={() => void restartDaemon()}>
            <RotateCcw className={busy === 'restartDaemon' ? 'spin' : undefined} size={13} aria-hidden="true" />
            {busy === 'restartDaemon' ? 'Restarting daemon…' : 'Restart daemon'}
          </button>
        </footer>
      </section>
    </div>
  )
}

type ResourceSessionGroup = {
  id: string
  label: string
  panes: ResourcePane[]
  cpuPercentX10: number
  memBytes: number
  processCount: number
}

function groupResourcePanes(panes: ResourcePane[], sessions: SessionMeta[]): ResourceSessionGroup[] {
  const sessionNames = new Map(sessions.map((session, index) => [session.id, { name: session.name, index }]))
  const groups = new Map<string, ResourceSessionGroup>()
  for (const pane of panes) {
    const session = sessionNames.get(pane.sessionId)
    const group = groups.get(pane.sessionId) ?? {
      id: pane.sessionId,
      label: session?.name || pane.sessionId.slice(0, 8),
      panes: [],
      cpuPercentX10: 0,
      memBytes: 0,
      processCount: 0,
    }
    group.panes.push(pane)
    group.cpuPercentX10 += pane.cpuPercentX10
    group.memBytes += pane.memBytes
    group.processCount += pane.processCount
    groups.set(pane.sessionId, group)
  }
  return [...groups.values()]
    .sort((left, right) => (sessionNames.get(left.id)?.index ?? Number.MAX_SAFE_INTEGER) - (sessionNames.get(right.id)?.index ?? Number.MAX_SAFE_INTEGER))
    .map((group) => ({ ...group, panes: [...group.panes].sort((left, right) => right.memBytes - left.memBytes) }))
}

function ResourceGroupHeader({ label, collapsed, cpuPercentX10, memBytes, processCount, onToggle }: { label: string; collapsed: boolean; cpuPercentX10: number; memBytes: number; processCount: number; onToggle: () => void }) {
  return (
    <div className="resource-manager-row resource-manager-group-row">
      <button type="button" className="resource-manager-toggle" title={`${collapsed ? 'Expand' : 'Collapse'} ${label}`} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${label}`} onClick={onToggle}>
        {collapsed ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
      </button>
      <strong title={`${processCount} processes`}>{label}</strong>
      <Metric value={formatCpu(cpuPercentX10)} />
      <Metric value={formatBytes(memBytes)} />
      <span />
    </div>
  )
}

function TerminalResourceRow({ pane, label, role, busy, onStop }: { pane: ResourcePane; label: string; role: string; busy: boolean; onStop: () => void }) {
  const processes = pane.processes.length > 0
    ? pane.processes
    : pane.rootPid ? [{ pid: pane.rootPid, name: '', cpuPercentX10: pane.cpuPercentX10, memBytes: pane.memBytes }] : []
  return (
    <div className="resource-manager-terminal">
      <div className="resource-manager-row resource-manager-terminal-row">
        <SquareTerminal size={11} aria-hidden="true" />
        <span className="resource-manager-name" title={role ? `${label} · ${role}` : label}><strong>{label}</strong>{role ? <small>{role}</small> : null}</span>
        <Metric value={formatCpu(pane.cpuPercentX10)} />
        <Metric value={formatBytes(pane.memBytes)} />
        <button type="button" className="resource-manager-kill" title={`Stop ${label}`} aria-label={`Stop ${label}`} disabled={busy} onClick={onStop}>
          <X className={busy ? 'spin' : undefined} size={11} aria-hidden="true" />
        </button>
      </div>
      {processes.map((process) => <ProcessResourceRow key={process.pid} process={process} />)}
    </div>
  )
}

function RuntimeResourceRow({ label, resource }: { label: string; resource: ResourceProc }) {
  return (
    <div className="resource-manager-terminal">
      <div className="resource-manager-row resource-manager-terminal-row">
        <span className="resource-manager-runtime-dot" aria-hidden="true" />
        <span className="resource-manager-name"><strong>{label}</strong><small>PID {resource.pid}</small></span>
        <Metric value={formatCpu(resource.cpuPercentX10)} />
        <Metric value={formatBytes(resource.memBytes)} />
        <span />
      </div>
      {resource.processes.map((process) => <ProcessResourceRow key={process.pid} process={process} />)}
    </div>
  )
}

function ProcessResourceRow({ process }: { process: ResourceProcess }) {
  return (
    <div className="resource-manager-row resource-manager-process-row" title={process.name || `PID ${process.pid}`}>
      <span className="resource-manager-process-dot" aria-hidden="true" />
      <span className="resource-manager-name"><span>pid {process.pid}</span>{process.name ? <small>{process.name}</small> : null}</span>
      <Metric value={formatCpu(process.cpuPercentX10)} />
      <Metric value={formatBytes(process.memBytes)} />
      <span />
    </div>
  )
}

function Metric({ value }: { value: string }) {
  return <span className="resource-manager-metric">{value}</span>
}

function formatCpu(percentX10: number) {
  return `${(percentX10 / 10).toFixed(1)}%`
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
