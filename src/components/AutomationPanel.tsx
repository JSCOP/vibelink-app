import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { CirclePlay, ListPlus, RefreshCw, Trash2 } from 'lucide-react'
import { useWorkspaceStore } from '../state/store'

type ScheduleKind = 'once' | 'interval' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'cron' | 'rrule'

type AutomationRecord = {
  id: string
  name: string
  scheduleKind: ScheduleKind
  scheduleValue: string
  timezone: string
  enabled: boolean
  workspaceMode: 'reuse' | 'worktree'
  precheck: Record<string, unknown>
  policy: { goal?: string; maxConcurrent?: number }
}

type AutomationRun = {
  id: string
  automationId: string
  orchestrationRunId?: string | null
  status: string
  outputSummary?: string | null
  outputTruncated: boolean
  worktreePath?: string | null
  branch?: string | null
  createdAt: number
}

const DEFAULT_VALUES: Record<ScheduleKind, string> = {
  once: new Date(Date.now() + 3_600_000).toISOString(),
  interval: '3600',
  hourly: '0',
  daily: '09:00',
  weekdays: '09:00',
  weekly: 'MON@09:00',
  cron: '0 9 * * 1-5',
  rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MON,FRI',
}

export function AutomationPanel() {
  const sessionId = useWorkspaceStore((state) => state.activeSessionId)
  const [records, setRecords] = useState<AutomationRecord[]>([])
  const [runs, setRuns] = useState<Record<string, AutomationRun[]>>({})
  const [name, setName] = useState('Daily workspace mission')
  const [goal, setGoal] = useState('Review this workspace and report actionable issues')
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>('daily')
  const [scheduleValue, setScheduleValue] = useState(DEFAULT_VALUES.daily)
  const [workspaceMode, setWorkspaceMode] = useState<'reuse' | 'worktree'>('worktree')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!sessionId) return
    const next = await invoke<AutomationRecord[]>('cli_request', {
      args: ['automation', 'list', '--workspace', sessionId],
    })
    setRecords(next)
    const histories = await Promise.all(next.map(async (record) => [
      record.id,
      await invoke<AutomationRun[]>('cli_request', { args: ['automation', 'runs', record.id, '--limit', '10'] }),
    ] as const))
    setRuns(Object.fromEntries(histories))
  }, [sessionId])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
    }, 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  const execute = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (!sessionId) return <div className="orchestration-empty">Open a workspace to schedule automations.</div>

  return (
    <div className="orchestration-run-panel">
      <header className="orchestration-run-header">
        <div>
          <h3>Durable mission automations</h3>
          <small>Prechecks are bounded; successful runs create coordinator missions instead of arbitrary command records.</small>
        </div>
        <button type="button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</button>
      </header>
      <form className="orchestration-task-form" onSubmit={(event) => {
        event.preventDefault()
        if (!name.trim() || !goal.trim()) return
        void execute(async () => {
          await invoke('cli_request', {
            args: [
              'automation', 'create', '--workspace', sessionId,
              '--name', name.trim(), '--schedule-kind', scheduleKind,
              '--schedule-value', scheduleValue, '--timezone', 'UTC',
              '--workspace-mode', workspaceMode, '--command', goal.trim(), '--goal', goal.trim(),
            ],
          })
        })
      }}>
        <input value={name} onChange={(event) => setName(event.target.value)} aria-label="Automation name" />
        <input value={goal} onChange={(event) => setGoal(event.target.value)} aria-label="Automation mission goal" />
        <select value={scheduleKind} onChange={(event) => {
          const kind = event.target.value as ScheduleKind
          setScheduleKind(kind)
          setScheduleValue(DEFAULT_VALUES[kind])
        }} aria-label="Schedule kind">
          <option value="once">One shot</option>
          <option value="interval">Interval seconds</option>
          <option value="hourly">Hourly</option>
          <option value="daily">Daily</option>
          <option value="weekdays">Weekdays</option>
          <option value="weekly">Weekly</option>
          <option value="cron">Five-field cron</option>
          <option value="rrule">RRULE</option>
        </select>
        <input value={scheduleValue} onChange={(event) => setScheduleValue(event.target.value)} aria-label="Schedule value" />
        <select value={workspaceMode} onChange={(event) => setWorkspaceMode(event.target.value as 'reuse' | 'worktree')} aria-label="Automation workspace mode">
          <option value="reuse">Existing workspace</option>
          <option value="worktree">New isolated worktree</option>
        </select>
        <button type="submit" disabled={busy || !name.trim() || !goal.trim()}><ListPlus size={14} /> Create mission</button>
      </form>

      <section className="orchestration-message-feed" aria-label="Automations">
        {records.length === 0 ? <p>No automations yet.</p> : records.map((record) => (
          <article key={record.id}>
            <header><strong>{record.name}</strong><span>{record.enabled ? 'enabled' : 'disabled'}</span></header>
            <p>{record.scheduleKind} {record.scheduleValue} · {record.workspaceMode}</p>
            <p>{record.policy.goal}</p>
            <div className="orchestration-run-actions">
              <button type="button" disabled={busy} onClick={() => void execute(async () => {
                await invoke('cli_request', { args: ['automation', 'run', record.id] })
              })}><CirclePlay size={14} /> Run mission</button>
              <button type="button" disabled={busy} onClick={() => void execute(async () => {
                await invoke('cli_request', { args: ['automation', 'delete', record.id] })
              })}><Trash2 size={14} /> Delete</button>
            </div>
            {(runs[record.id] ?? []).map((run) => (
              <div key={run.id} className="orchestration-agent-card">
                <strong>{run.status}</strong>
                {run.orchestrationRunId ? <span>Run {run.orchestrationRunId.slice(0, 8)}</span> : null}
                {run.branch ? <span>{run.branch}</span> : null}
                {run.worktreePath ? <small title={run.worktreePath}>{run.worktreePath}</small> : null}
                {run.outputSummary ? <p>{run.outputSummary}</p> : null}
              </div>
            ))}
          </article>
        ))}
      </section>
      {error ? <div className="orchestration-error">{error}</div> : null}
    </div>
  )
}
