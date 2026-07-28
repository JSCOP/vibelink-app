import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  ArrowLeft,
  CalendarClock,
  CirclePause,
  CirclePlay,
  Clock3,
  Download,
  ExternalLink,
  FileCheck2,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Square,
  Trash2,
} from 'lucide-react'
import { confirmDialog } from './appDialogStore'
import { useWorkspaceStore } from '../state/store'
import {
  cancelAutomationRun,
  createAutomation,
  deleteAutomation,
  listAutomationRuns,
  listAutomations,
  normalizeAutomationRpcError,
  precheckAutomation,
  runAutomation,
  updateAutomation,
  type AutomationPrecheckResult,
  type AutomationRecord,
  type AutomationRunRecord,
} from '../ipc/automations'
import { AutomationEditorDialog, type AutomationEditorSaveInput } from './automations/AutomationEditorDialog'
import { AutomationImportDialog } from './automations/AutomationImportDialog'
import { automationAgentEntry } from './automations/agentCatalog'
import { ProfileIcon } from './ProfileIcon'
import {
  clearAutomationNavigation,
  getAutomationNavigationRequest,
  subscribeAutomationNavigation,
} from './automations/navigation'
import '../styles/automations.css'

type AutomationPanelProps = {
  active?: boolean
}

type DetailTab = 'overview' | 'runs'

const ACTIVE_RUN_STATUSES = new Set(['pending', 'dispatching', 'dispatched'])

function formatDate(value: number | null): string {
  if (value === null) return 'Never'
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function formatSchedule(record: AutomationRecord): string {
  switch (record.scheduleKind) {
    case 'once': return `Once · ${formatDate(Number(record.scheduleValue))}`
    case 'interval': return `Every ${record.scheduleValue}`
    case 'hourly': return `Hourly at :${record.scheduleValue.padStart(2, '0')}`
    case 'daily': return `Daily · ${record.scheduleValue}`
    case 'weekdays': return `Weekdays · ${record.scheduleValue}`
    case 'weekly': return `Weekly · ${record.scheduleValue}`
    case 'cron': return `Cron · ${record.scheduleValue}`
  }
}

function statusLabel(status: AutomationRunRecord['status']): string {
  return status.replaceAll('_', ' ')
}

function runSummary(run: AutomationRunRecord): string {
  const finalResponse = run.outputSnapshot?.finalResponse?.trim()
  if (finalResponse) return finalResponse
  if (run.error?.trim()) return run.error
  if (run.precheckResult && !run.precheckResult.ok) return run.precheckResult.error || run.precheckResult.stderr || 'Precheck failed.'
  return 'No output captured.'
}

export function AutomationPanel({ active = true }: AutomationPanelProps) {
  const sessionId = useWorkspaceStore((state) => state.activeSessionId)
  const workspaceName = useWorkspaceStore((state) => state.sessions.find((session) => session.id === state.activeSessionId)?.name ?? 'Workspace')
  const [records, setRecords] = useState<AutomationRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [runs, setRuns] = useState<AutomationRunRecord[]>([])
  const [filter, setFilter] = useState('')
  const [detailTab, setDetailTab] = useState<DetailTab>('overview')
  const [editor, setEditor] = useState<'create' | AutomationRecord | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [precheckResult, setPrecheckResult] = useState<AutomationPrecheckResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyKeys, setBusyKeys] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const navigationRequest = useSyncExternalStore(
    subscribeAutomationNavigation,
    getAutomationNavigationRequest,
    () => null,
  )

  const selected = useMemo(() => records.find((record) => record.id === selectedId) ?? null, [records, selectedId])
  const filteredRecords = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase()
    if (!query) return records
    return records.filter((record) => `${record.name}\n${record.prompt}\n${record.scheduleValue}`.toLocaleLowerCase().includes(query))
  }, [filter, records])
  const busy = busyKeys.size > 0
  const hasActiveRun = runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))

  const refresh = useCallback(async (showSpinner = false) => {
    if (!sessionId) return
    if (showSpinner) setLoading(true)
    try {
      const next = await listAutomations(sessionId)
      setRecords(next)
      setSelectedId((current) => current && next.some((record) => record.id === current) ? current : null)
      setError(null)
    } catch (cause) {
      setError(normalizeAutomationRpcError(cause).message)
    } finally {
      if (showSpinner) setLoading(false)
    }
  }, [sessionId])

  const refreshRuns = useCallback(async (automationId: string) => {
    try {
      setRuns(await listAutomationRuns(automationId, 50))
    } catch (cause) {
      setError(normalizeAutomationRpcError(cause).message)
    }
  }, [])

  useEffect(() => {
    if (!sessionId) {
      // Clearing on session teardown: external sync, not a derived-state cascade.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRecords([])
      setSelectedId(null)
      setRuns([])
      return
    }
    void refresh(true)
  }, [refresh, sessionId])

  useEffect(() => {
    if (!navigationRequest || navigationRequest.sessionId !== sessionId) return
    // Applies a one-shot external navigation request, then consumes it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedId(navigationRequest.automationId)
    setDetailTab(navigationRequest.runId ? 'runs' : 'overview')
    clearAutomationNavigation(navigationRequest)
  }, [navigationRequest, sessionId])

  useEffect(() => {
    if (!selectedId) {
      // Clearing run history when nothing is selected.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRuns([])
      setPrecheckResult(null)
      return
    }
    void refreshRuns(selectedId)
  }, [refreshRuns, selectedId])

  useEffect(() => {
    if (!sessionId || !active) return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void refresh(false)
      if (selectedId) void refreshRuns(selectedId)
    }, 8_000)
    return () => window.clearInterval(timer)
  }, [active, refresh, refreshRuns, selectedId, sessionId])

  const perform = async (key: string, action: () => Promise<void>) => {
    setBusyKeys((current) => new Set(current).add(key))
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(normalizeAutomationRpcError(cause).message)
    } finally {
      setBusyKeys((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }

  const saveEditor = async (input: AutomationEditorSaveInput) => {
    if (!sessionId) return
    if (editor === 'create') {
      const created = await createAutomation(sessionId, input)
      await refresh(false)
      setSelectedId(created.id)
      setDetailTab('overview')
      return
    }
    if (editor) {
      await updateAutomation(editor.id, input)
      await refresh(false)
      setSelectedId(editor.id)
    }
  }

  const removeSelected = async () => {
    if (!selected) return
    const confirmed = await confirmDialog({
      title: 'Delete automation',
      message: `Delete “${selected.name}” and its retained run history?`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!confirmed) return
    await perform(`delete:${selected.id}`, async () => {
      await deleteAutomation(selected.id)
      setSelectedId(null)
      setRuns([])
      await refresh(false)
    })
  }

  if (!sessionId) return <div className="automation-centered-state">Open a workspace to schedule automations.</div>

  return (
    <div className="automation-panel">
      {!selected ? (
        <>
          <div className="automation-toolbar">
            <button type="button" className="primary" onClick={() => setEditor('create')}><Plus size={14} /> New</button>
            <button type="button" onClick={() => setImportOpen(true)}><Download size={14} /> Import</button>
            <button type="button" aria-label="Refresh automations" disabled={loading} onClick={() => void refresh(true)}>{loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}</button>
          </div>
          <label className="automation-search"><Search size={14} /><input aria-label="Filter automations" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter automations" /></label>
          <div className="automation-list" aria-label="Scheduled automations">
            {filteredRecords.length === 0 && !loading ? (
              <div className="automation-empty-list"><CalendarClock size={28} /><strong>{records.length === 0 ? 'No automations yet' : 'No matching automations'}</strong><span>Create a reviewed Hermes schedule or import matching Cron jobs.</span></div>
            ) : filteredRecords.map((record) => (
              <button key={record.id} type="button" className="automation-list-card" onClick={() => { setSelectedId(record.id); setDetailTab('overview') }}>
                <span className={`automation-state-dot ${record.enabled ? 'enabled' : 'paused'}`} />
                <ProfileIcon name={automationAgentEntry(record.agent).icon} size={15} className="automation-agent-icon" />
                <span className="automation-list-card-body"><strong>{record.name}</strong><span>{formatSchedule(record)}</span><small>{record.nextRunAt ? `Next ${formatDate(record.nextRunAt)}` : record.requiresReview ? 'Review required' : 'Paused'}</small></span>
                {record.source ? <span className="automation-source-mark" role="img" aria-label="Imported from Hermes" title="Imported from Hermes"><ProfileIcon name="hermes" size={13} /></span> : null}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="automation-detail">
          <header className="automation-detail-header">
            <button type="button" className="icon" aria-label="Back to automations" onClick={() => setSelectedId(null)}><ArrowLeft size={15} /></button>
            <div><strong>{selected.name}</strong><span>{automationAgentEntry(selected.agent).label} · {workspaceName}</span></div>
            <span className={`automation-status-pill ${selected.enabled ? 'enabled' : 'paused'}`}>{selected.enabled ? 'Enabled' : selected.requiresReview ? 'Review' : 'Paused'}</span>
          </header>
          <div className="automation-detail-actions">
            <button type="button" className="primary" disabled={busy || hasActiveRun || selected.requiresReview} title={selected.requiresReview ? 'Edit and save this imported job before running it.' : hasActiveRun ? 'This automation already has an active run.' : undefined} onClick={() => {
              setDetailTab('runs')
              void perform(`run:${selected.id}`, async () => {
                const execution = runAutomation(selected.id)
                window.setTimeout(() => void refreshRuns(selected.id), 150)
                await execution
                await refresh(false)
                await refreshRuns(selected.id)
              })
            }}><CirclePlay size={14} /> Run now</button>
            <button type="button" disabled={busy || selected.requiresReview} onClick={() => void perform(`toggle:${selected.id}`, async () => { await updateAutomation(selected.id, { enabled: !selected.enabled }); await refresh(false) })}>{selected.enabled ? <CirclePause size={14} /> : <CirclePlay size={14} />}{selected.enabled ? 'Pause' : 'Resume'}</button>
            <button type="button" disabled={hasActiveRun} aria-label="Edit automation" onClick={() => setEditor(selected)}><Pencil size={14} /></button>
            <button type="button" disabled={hasActiveRun} className="danger" aria-label="Delete automation" onClick={() => void removeSelected()}><Trash2 size={14} /></button>
          </div>
          {selected.requiresReview ? <div className="automation-callout warning">Imported job is locked until you review and save it. The original Hermes Cron job remains unchanged.</div> : null}
          <nav className="automation-detail-tabs" aria-label="Automation details"><button type="button" aria-selected={detailTab === 'overview'} onClick={() => setDetailTab('overview')}>Overview</button><button type="button" aria-selected={detailTab === 'runs'} onClick={() => setDetailTab('runs')}>Runs <span>{runs.length}</span></button></nav>

          {detailTab === 'overview' ? (
            <div className="automation-detail-scroll">
              <dl className="automation-metrics">
                <div><dt>Schedule</dt><dd>{formatSchedule(selected)}</dd></div>
                <div><dt>Next run</dt><dd>{selected.enabled ? formatDate(selected.nextRunAt) : 'Paused'}</dd></div>
                <div><dt>Workspace</dt><dd>{selected.workspaceMode === 'new_per_run' ? 'New worktree per run' : 'Existing workspace'}</dd></div>
                <div><dt>Grace</dt><dd>{selected.missedRunGraceMinutes} min</dd></div>
                <div><dt>Model</dt><dd>{selected.useAgentDefaultModel ? `${automationAgentEntry(selected.agent).label} default` : `${selected.provider ?? ''} ${selected.model ?? ''}`.trim()}</dd></div>
                <div><dt>Timeout</dt><dd>{selected.timeoutSeconds}s · {selected.maxTurns} turns</dd></div>
              </dl>
              <section className="automation-detail-section"><header><strong>Prompt</strong></header><p>{selected.prompt}</p></section>
              <section className="automation-detail-section"><header><strong>Precheck</strong><button type="button" disabled={busy} onClick={() => void perform(`precheck:${selected.id}`, async () => setPrecheckResult(await precheckAutomation(selected.id)))}><FileCheck2 size={13} /> Test</button></header><p>{selected.precheck.command || 'No command configured.'}</p>{precheckResult ? <pre className={precheckResult.ok ? 'ok' : 'failed'}>{precheckResult.ok ? precheckResult.stdout || 'Passed' : precheckResult.error || precheckResult.stderr || 'Failed'}</pre> : null}</section>
              {automationAgentEntry(selected.agent).supportsToolsets ? <section className="automation-detail-section"><header><strong>Agent access</strong></header><p>Toolsets: {selected.toolsets.join(', ') || 'default'}</p><p>Skills: {selected.skills.join(', ') || 'none'}</p></section> : null}
              {selected.source ? <section className="automation-detail-section"><header><strong>Imported source</strong></header><p>Hermes Cron · {selected.source.sourceId}</p><small>Read-only snapshot retained for review and duplicate detection.</small></section> : null}
            </div>
          ) : (
            <div className="automation-run-list">
              {runs.length === 0 ? <div className="automation-centered-state"><Clock3 size={24} /> No retained runs.</div> : runs.map((run) => (
                <article key={run.id} className="automation-run-card">
                  <header><span className={`automation-run-status ${run.status}`}>{statusLabel(run.status)}</span><time>{formatDate(run.createdAt)}</time></header>
                  <p>{runSummary(run)}</p>
                  {run.worktree ? <button type="button" title={run.worktree.path} onClick={() => void invoke('reveal_path', { path: run.worktree!.path })}><ExternalLink size={13} /> {run.worktree.disposition === 'retained' ? 'Open retained worktree' : 'Reveal worktree'}</button> : null}
                  {ACTIVE_RUN_STATUSES.has(run.status) ? <button type="button" className="danger" disabled={busyKeys.has(`cancel:${run.id}`)} onClick={() => void perform(`cancel:${run.id}`, async () => { await cancelAutomationRun(run.id); await refreshRuns(selected.id) })}><Square size={12} /> Cancel run</button> : null}
                  {run.precheckResult ? <details><summary>Precheck</summary><pre>{run.precheckResult.stdout || run.precheckResult.stderr || run.precheckResult.error || (run.precheckResult.ok ? 'Passed' : 'Failed')}</pre></details> : null}
                  {run.outputSnapshot?.stderr ? <details><summary>Hermes stderr</summary><pre>{run.outputSnapshot.stderr}</pre></details> : null}
                  {run.usage ? <details><summary>Usage</summary><pre>{JSON.stringify(run.usage, null, 2)}</pre></details> : null}
                </article>
              ))}
            </div>
          )}
        </div>
      )}
      {error ? <div className="automation-panel-error" role="alert">{error}</div> : null}
      {editor ? <AutomationEditorDialog sessionId={sessionId} automation={editor === 'create' ? null : editor} onClose={() => setEditor(null)} onSave={saveEditor} onTestPrecheck={editor === 'create' ? null : precheckAutomation} /> : null}
      {importOpen ? <AutomationImportDialog sessionId={sessionId} onClose={() => setImportOpen(false)} onImported={() => refresh(false)} /> : null}
    </div>
  )
}
