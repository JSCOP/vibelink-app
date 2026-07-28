import { invoke } from '@tauri-apps/api/core'
import { useEffect, useMemo, useState } from 'react'
import { RotateCcw, Trash2, X } from 'lucide-react'
import type { ResourcePane, ResourceSnapshot } from '../ipc/types'
import { useWorkspaceStore } from '../state/store'

type ResourceMonitorDialogProps = {
  onClose: () => void
  onStopWorkspaceTerminals: () => Promise<void> | void
  onAfterRestart: () => Promise<void> | void
}

export function ResourceMonitorDialog({ onClose, onStopWorkspaceTerminals, onAfterRestart }: ResourceMonitorDialogProps) {
  const sessions = useWorkspaceStore((state) => state.sessions)
  const panes = useWorkspaceStore((state) => state.panes)
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'stop' | 'restart' | null>(null)
  const [confirmRestart, setConfirmRestart] = useState(false)

  useEffect(() => {
    let cancelled = false
    const intervalId = window.setInterval(() => { void load() }, 2000)

    const load = async () => {
      try {
        const next = await invoke<ResourceSnapshot>('resource_snapshot')
        if (!cancelled) {
          setSnapshot(next)
          setError('')
        }
      } catch (caught) {
        if (!cancelled) setError(String(caught))
      }
    }

    void load()
    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [])

  const panesBySession = useMemo(() => {
    const grouped = new Map<string, ResourcePane[]>()
    for (const pane of snapshot?.panes ?? []) {
      const group = grouped.get(pane.sessionId) ?? []
      group.push(pane)
      grouped.set(pane.sessionId, group)
    }
    return [...grouped.entries()]
  }, [snapshot?.panes])

  const stopWorkspace = async () => {
    setBusy('stop')
    try {
      await onStopWorkspaceTerminals()
      const next = await invoke<ResourceSnapshot>('resource_snapshot')
      setSnapshot(next)
      setError('')
    } catch (caught) {
      setError(String(caught))
    } finally {
      setBusy(null)
    }
  }

  const restartDaemon = async () => {
    setBusy('restart')
    try {
      await invoke('restart_daemon')
      await onAfterRestart()
      const next = await invoke<ResourceSnapshot>('resource_snapshot')
      setSnapshot(next)
      setError('')
    } catch (caught) {
      setError(String(caught))
    } finally {
      setConfirmRestart(false)
      setBusy(null)
    }
  }

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="resource-monitor-title" style={{ width: 'min(760px, calc(100vw - 48px))' }} onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-dialog-header">
          <div>
            <p className="settings-eyebrow">Resource monitor</p>
            <h2 id="resource-monitor-title">Terminal process memory</h2>
          </div>
          <button type="button" className="settings-close" title="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </header>

        <div className="settings-dialog-body" style={{ display: 'block' }}>
          <section className="settings-card">
            <div className="settings-card-heading">
              <div>
                <h3>Total: {snapshot ? formatBytes(snapshot.totalMemBytes) : 'Loading…'}</h3>
                <p>Working set memory by GUI, daemon, and pane process tree. Updates every 2 seconds.</p>
              </div>
            </div>
            {error ? <p className="daemon-banner-message">Resource snapshot unavailable: {error}</p> : null}
            {snapshot ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <ResourceRow label="Daemon" detail={`PID ${snapshot.daemon.pid}`} memBytes={snapshot.daemon.memBytes} processCount={snapshot.daemon.processCount} />
                <ResourceRow label="App / WebView" detail={`PID ${snapshot.app.pid}`} memBytes={snapshot.app.memBytes} processCount={snapshot.app.processCount} />
                {panesBySession.length === 0 ? <p>No live pane process trees.</p> : null}
                {panesBySession.map(([sessionId, group]) => {
                  const sessionName = sessions.find((session) => session.id === sessionId)?.name ?? sessionId.slice(0, 8)
                  return (
                    <div key={sessionId} style={{ display: 'grid', gap: 6 }}>
                      <strong>{sessionName}</strong>
                      {group.map((pane) => {
                        const paneMeta = panes[pane.paneId]
                        const title = paneMeta?.config.title || paneMeta?.config.shell || pane.paneId.slice(0, 8)
                        return (
                          <ResourceRow
                            key={pane.paneId}
                            label={title}
                            detail={pane.rootPid ? `root PID ${pane.rootPid}` : 'root PID unavailable'}
                            memBytes={pane.memBytes}
                            processCount={pane.processCount}
                          />
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            ) : null}
          </section>

          {confirmRestart ? (
            <section className="settings-card">
              <h3>Restart daemon?</h3>
              <p>실행 중인 명령과 프로세스는 중단됩니다. 복구 가능한 pane은 저장된 화면과 같은 profile의 새 프로세스로 다시 열리지만, 종료된 Codex/OMP/Claude 대화 자체의 자동 resume은 보장되지 않습니다.</p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setConfirmRestart(false)} disabled={busy === 'restart'}>Cancel</button>
                <button type="button" className="primary-action" onClick={() => void restartDaemon()} disabled={busy === 'restart'}>
                  {busy === 'restart' ? 'Restarting…' : 'Restart daemon'}
                </button>
              </div>
            </section>
          ) : null}
        </div>

        <footer className="settings-dialog-footer">
          <button type="button" onClick={() => void stopWorkspace()} disabled={!activeSessionId || busy !== null}>
            <Trash2 size={14} /> {busy === 'stop' ? 'Stopping…' : 'Stop workspace terminals'}
          </button>
          <button type="button" className="primary-action" onClick={() => setConfirmRestart(true)} disabled={busy !== null}>
            <RotateCcw size={14} /> Restart daemon
          </button>
        </footer>
      </section>
    </div>
  )
}

type ResourceRowProps = {
  label: string
  detail: string
  memBytes: number
  processCount: number
}

function ResourceRow({ label, detail, memBytes, processCount }: ResourceRowProps) {
  return (
    <div style={{ alignItems: 'center', border: '1px solid var(--vibelink-border-soft)', borderRadius: 8, display: 'grid', gap: 8, gridTemplateColumns: 'minmax(0, 1fr) auto auto', padding: '8px 10px' }}>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><strong>{label}</strong><small style={{ color: 'var(--vibelink-muted)', marginLeft: 8 }}>{detail}</small></span>
      <span>{formatBytes(memBytes)}</span>
      <small style={{ color: 'var(--vibelink-muted)' }}>{processCount} procs</small>
    </div>
  )
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
