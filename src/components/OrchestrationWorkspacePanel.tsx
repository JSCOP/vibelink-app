import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, CirclePlay, ListPlus, MessageSquareText, RefreshCw, RotateCcw, Send, Square, Workflow, X } from 'lucide-react'
import {
  launchReadyOrchestrationTasks,
  orchestrationRequest,
  OrchestrationRpcError,
  type DecisionGate,
  type DispatchLaunchResult,
  type DispatchLaunchRequest,
  type DispatchResource,
  type OrchestrationMessage,
  type OrchestrationRun,
  type OrchestrationTask,
} from '../ipc/orchestration'
import { useWorkspaceStore } from '../state/store'
import { OrchestratorChat } from './OrchestratorChat'
import '../styles/orchestration.css'

type PanelTab = 'run' | 'agent'
type Dispatch = {
  id: string
  taskId: string
  attempt: number
  agentInstanceId?: string | null
  status: string
  paneId?: string | null
  worktree?: { baseRevision: string; branch: string; worktreePath: string } | null
  launchClaim?: { operationId: string; commandDigest: string; profile?: string | null; worktreeMode: 'reuse' | 'worktree' } | null
  resources?: DispatchResource | null
  failureCode?: string | null
}
type Agent = {
  id: string
  provider: 'hermes_acp' | 'pty_cli'
  profile?: string | null
  status: string
  runtimeIdentity?: string | null
  generation: number
  lastHeartbeatAt?: number | null
  worktreePath?: string | null
}
type RunEvent = { sequence: number; eventType: string; entityId?: string | null; payload: Record<string, unknown> }
type EventCatchup = { events: RunEvent[]; acknowledgedSequence: number; latestSequence: number; hasMore: boolean }
type PendingLaunchOperation = { operationId: string; sessionId: string; request: DispatchLaunchRequest }

const TASK_COLUMNS: Array<{ status: OrchestrationTask['status']; label: string }> = [
  { status: 'pending', label: 'Pending' },
  { status: 'ready', label: 'Ready' },
  { status: 'dispatched', label: 'Active' },
  { status: 'completed', label: 'Done' },
  { status: 'failed', label: 'Failed' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'cancelled', label: 'Cancelled' },
]

export function OrchestrationWorkspacePanel() {
  const [tab, setTab] = useState<PanelTab>('run')
  return (
    <section className="orchestration-workspace-panel">
      <div className="orchestration-tabs" role="tablist" aria-label="Orchestrator views">
        <button type="button" role="tab" aria-selected={tab === 'run'} onClick={() => setTab('run')}><Workflow size={14} /> Runs</button>
        <button type="button" role="tab" aria-selected={tab === 'agent'} onClick={() => setTab('agent')}><MessageSquareText size={14} /> Agent</button>
      </div>
      <div className="orchestration-tab-content">
        {tab === 'run' ? <OrchestrationRunPanel /> : <OrchestratorChat />}
      </div>
    </section>
  )
}

function OrchestrationRunPanel() {
  const sessionId = useWorkspaceStore((state) => state.activeSessionId)
  const [runs, setRuns] = useState<OrchestrationRun[]>([])
  const [run, setRun] = useState<OrchestrationRun | null>(null)
  const [tasks, setTasks] = useState<OrchestrationTask[]>([])
  const [dispatches, setDispatches] = useState<Dispatch[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [messages, setMessages] = useState<OrchestrationMessage[]>([])
  const [gates, setGates] = useState<DecisionGate[]>([])
  const [events, setEvents] = useState<RunEvent[]>([])
  const [goal, setGoal] = useState('Coordinate this workspace')
  const [taskTitle, setTaskTitle] = useState('')
  const [dependencyIds, setDependencyIds] = useState('')
  const [chatText, setChatText] = useState('')
  const [launchCommand, setLaunchCommand] = useState('')
  const [launchProfile, setLaunchProfile] = useState('')
  const [worktreeMode, setWorktreeMode] = useState<'reuse' | 'worktree'>('worktree')
  const [launchResult, setLaunchResult] = useState<DispatchLaunchResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingLaunch, setPendingLaunch] = useState<PendingLaunchOperation | null>(null)
  const pendingLaunchesRef = useRef(new Map<string, PendingLaunchOperation>())
  const activeSessionRef = useRef(sessionId)
  const runsGenerationRef = useRef(0)
  const detailGenerationRef = useRef(0)
  const activeRunRef = useRef(run?.id)
  useLayoutEffect(() => {
    activeSessionRef.current = sessionId
    activeRunRef.current = run?.id
  }, [run?.id, sessionId])

  const refreshRuns = useCallback(async () => {
    const capturedSessionId = sessionId
    if (!capturedSessionId) return
    const generation = ++runsGenerationRef.current
    const next = await orchestrationRequest<OrchestrationRun[]>('runs.list', { id: capturedSessionId })
    if (activeSessionRef.current !== capturedSessionId || generation !== runsGenerationRef.current) return
    const scopedRuns = next.filter((candidate) => candidate.sessionId === capturedSessionId)
    setRuns(scopedRuns)
    setRun((current) => {
      const pendingRunId = pendingLaunchesRef.current.get(capturedSessionId)?.request.runId
      const selected = scopedRuns.find((candidate) => candidate.id === current?.id)
        ?? scopedRuns.find((candidate) => candidate.id === pendingRunId)
        ?? scopedRuns[0]
        ?? null
      activeRunRef.current = selected?.id
      return selected
    })
  }, [sessionId])

  const refresh = useCallback(async (runId: string) => {
    const capturedSessionId = sessionId
    if (!capturedSessionId) return
    const generation = ++detailGenerationRef.current
    const consumerId = `desktop:${capturedSessionId}`
    const [nextRun, nextTasks, nextDispatches, nextAgents, nextMessages, nextGates, catchup] = await Promise.all([
      orchestrationRequest<OrchestrationRun>('run.get', { id: runId }),
      orchestrationRequest<OrchestrationTask[]>('tasks.list', { id: runId }),
      orchestrationRequest<Dispatch[]>('dispatches.list', { id: runId }),
      orchestrationRequest<Agent[]>('agents.list', { id: runId }),
      orchestrationRequest<OrchestrationMessage[]>('messages.list', { id: runId }),
      orchestrationRequest<DecisionGate[]>('gates.list', { id: runId }),
      orchestrationRequest<EventCatchup>('events.catchup', { runId, consumerId, limit: 300 }),
    ])
    if (
      activeSessionRef.current !== capturedSessionId
      || activeRunRef.current !== runId
      || generation !== detailGenerationRef.current
      || nextRun.sessionId !== capturedSessionId
      || nextRun.id !== runId
    ) return
    setRun(nextRun)
    setTasks(nextTasks)
    setDispatches(nextDispatches)
    setAgents(nextAgents)
    setMessages(nextMessages)
    setGates(nextGates)
    setEvents(catchup.events)
    if (catchup.latestSequence > catchup.acknowledgedSequence) {
      await orchestrationRequest('events.acknowledge', { consumerId, runId, sequence: catchup.latestSequence })
    }
  }, [sessionId])

  useEffect(() => {
    runsGenerationRef.current += 1
    detailGenerationRef.current += 1
    const capturedSessionId = sessionId
    const timer = window.setTimeout(() => {
      if (activeSessionRef.current !== capturedSessionId) return
      setRun(null)
      activeRunRef.current = undefined
      setRuns([])
      setTasks([])
      setDispatches([])
      setAgents([])
      setMessages([])
      setGates([])
      setEvents([])
      setError(null)
      setLaunchResult(null)
      setPendingLaunch(capturedSessionId ? pendingLaunchesRef.current.get(capturedSessionId) ?? null : null)
      void refreshRuns().catch((cause) => {
        if (activeSessionRef.current === capturedSessionId) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [refreshRuns, sessionId])

  const runId = run?.id
  useEffect(() => {
    if (!runId) return
    const capturedSessionId = sessionId
    const reportError = (cause: unknown) => {
      if (activeSessionRef.current === capturedSessionId) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    const initialTimer = window.setTimeout(() => {
      void refresh(runId).catch(reportError)
    }, 0)
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void Promise.all([refresh(runId), refreshRuns()]).catch(reportError)
    }, 5_000)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(timer)
    }
  }, [refresh, refreshRuns, runId, sessionId])

  const tasksByStatus = useMemo<Record<OrchestrationTask['status'], OrchestrationTask[]>>(() => {
    const grouped: Record<OrchestrationTask['status'], OrchestrationTask[]> = { pending: [], ready: [], dispatched: [], completed: [], failed: [], blocked: [], cancelled: [] }
    for (const task of tasks) grouped[task.status].push(task)
    return grouped
  }, [tasks])

  const execute = useCallback(async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }, [])

  if (!sessionId) return <div className="orchestration-empty">Open a workspace to coordinate agents.</div>

  const createRun = (
    <div className="orchestration-empty orchestration-create-run">
      <Workflow size={26} />
      <h3>Start a durable agent run</h3>
      <p>Runs, dispatches, messages, gates, worktrees, events, and restart recovery live in the daemon.</p>
      <input value={goal} onChange={(event) => setGoal(event.target.value)} aria-label="Run goal" />
      <button type="button" disabled={busy || !goal.trim()} onClick={() => void execute(async () => {
        const capturedSessionId = sessionId
        const created = await orchestrationRequest<OrchestrationRun>('run.create', { sessionId: capturedSessionId, goal: goal.trim(), policy: { maxConcurrent: 4 } })
        if (activeSessionRef.current !== capturedSessionId || created.sessionId !== capturedSessionId) return
        activeRunRef.current = created.id
        setRun(created)
        await refreshRuns()
        await refresh(created.id)
      })}><CirclePlay size={15} /> Create run</button>
      {error ? <div className="orchestration-error">{error}</div> : null}
    </div>
  )

  if (!run) return createRun
  const pendingGates = gates.filter((gate) => gate.status === 'pending')
  const filesByDispatch = new Map(messages.filter((message) => message.messageType === 'worker_done').map((message) => [message.dispatchId, Array.isArray(message.payload.filesModified) ? message.payload.filesModified : []]))

  return (
    <div className="orchestration-run-panel">
      <header className="orchestration-run-header">
        <div>
          <select disabled={Boolean(pendingLaunch)} value={run.id} onChange={(event) => {
            const selected = runs.find((candidate) => candidate.id === event.target.value) ?? run
            activeRunRef.current = selected.id
            setRun(selected)
            setLaunchResult(null)
          }} aria-label="Durable run">
            {runs.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.goal} · {candidate.status}</option>)}
          </select>
          <span className={`orchestration-status status-${run.status}`}>{run.status}</span>
          <h3>{run.goal}</h3>
          <small>Revision {run.revision} · max {run.policy.maxConcurrent} agents · event {events.at(-1)?.sequence ?? 0}</small>
        </div>
        <div className="orchestration-run-actions">
          <button type="button" disabled={busy} onClick={() => void refresh(run.id)}><RefreshCw size={14} /> Refresh</button>
          {run.status === 'queued' ? <button type="button" disabled={busy} onClick={() => void execute(async () => { await orchestrationRequest('run.start', { runId: run.id, expectedRunRevision: run.revision }); await refresh(run.id) })}><CirclePlay size={14} /> Start</button> : null}
          {['planning', 'running', 'waiting', 'paused'].includes(run.status) ? <button type="button" disabled={busy || Boolean(pendingLaunch)} onClick={() => void execute(async () => { await orchestrationRequest('run.cancel', { runId: run.id, expectedRunRevision: run.revision }); setLaunchResult(null); await refresh(run.id) })}><Square size={14} /> Cancel</button> : null}
          {run.status === 'completed' ? <button type="button" disabled={busy || Boolean(pendingLaunch)} onClick={() => void execute(async () => { await orchestrationRequest('run.accept', { runId: run.id, expectedRunRevision: run.revision, payload: { source: 'desktop' } }); await refresh(run.id) })}><Check size={14} /> Accept</button> : null}
          {!['cancelled'].includes(run.status) ? <button type="button" disabled={busy || Boolean(pendingLaunch)} onClick={() => void execute(async () => { await orchestrationRequest('run.reject', { runId: run.id, expectedRunRevision: run.revision, payload: { source: 'desktop' } }); setLaunchResult(null); await refresh(run.id) })}><X size={14} /> Reject</button> : null}
          <button type="button" disabled={busy || Boolean(pendingLaunch)} onClick={() => { setRun(null); setGoal('Coordinate this workspace') }}><ListPlus size={14} /> New</button>
        </div>
      </header>

      <form className="orchestration-task-form" onSubmit={(event) => {
        event.preventDefault()
        if (!launchCommand.trim()) return
        void execute(async () => {
          if (run.sessionId !== sessionId || activeSessionRef.current !== sessionId) {
            throw new Error('This run belongs to a workspace that is no longer active.')
          }
          const existingOperation = pendingLaunch?.sessionId === sessionId
            && pendingLaunch.request.runId === run.id
            ? pendingLaunch
            : null
          const operation: PendingLaunchOperation = existingOperation ?? {
            operationId: crypto.randomUUID(),
            sessionId,
            request: {
              runId: run.id,
              expectedRunRevision: run.revision,
              command: launchCommand.trim(),
              profile: launchProfile.trim() || undefined,
              worktreeMode,
            },
          }
          if (!existingOperation) {
            pendingLaunchesRef.current.set(operation.sessionId, operation)
            setPendingLaunch(operation)
          }
          try {
            const result = await launchReadyOrchestrationTasks(operation.request, operation.operationId)
            pendingLaunchesRef.current.delete(operation.sessionId)
            setPendingLaunch((current) => current?.operationId === operation.operationId ? null : current)
            if (
              activeSessionRef.current !== operation.sessionId
              || activeRunRef.current !== operation.request.runId
              || result.run.sessionId !== operation.sessionId
            ) return
            setLaunchResult(result)
            setRun(result.run)
            await refresh(operation.request.runId)
          } catch (cause) {
            if (cause instanceof OrchestrationRpcError && isDefinitiveLaunchError(cause)) {
              pendingLaunchesRef.current.delete(operation.sessionId)
              setPendingLaunch((current) => current?.operationId === operation.operationId ? null : current)
            }
            throw cause
          }
        })
      }} aria-label="Launch ready orchestration tasks">
        <input disabled={Boolean(pendingLaunch)} value={launchCommand} onChange={(event) => setLaunchCommand(event.target.value)} placeholder="Command for each ready task" aria-label="Orchestration launch command" />
        <input disabled={Boolean(pendingLaunch)} value={launchProfile} onChange={(event) => setLaunchProfile(event.target.value)} placeholder="Profile label (optional)" aria-label="Orchestration profile label" />
        <select disabled={Boolean(pendingLaunch)} value={worktreeMode} onChange={(event) => setWorktreeMode(event.target.value as 'reuse' | 'worktree')} aria-label="Orchestration worktree mode">
          <option value="worktree">Managed worktree per dispatch</option>
          <option value="reuse">Reuse workspace</option>
        </select>
        <button type="submit" disabled={busy || (!pendingLaunch && (!launchCommand.trim() || !['running', 'waiting'].includes(run.status)))}><CirclePlay size={14} /> {pendingLaunch ? 'Retry launch result' : 'Launch ready tasks'}</button>
      </form>
      {pendingLaunch ? <p>Launch outcome is unknown. Retrying reuses operation {pendingLaunch.operationId.slice(0, 8)} without duplicating workers.</p> : null}
      {launchResult ? <section className="orchestration-message-feed" aria-label="Launch results">
        <h4>Launch results</h4>
        {launchResult.launches.length === 0 ? <p>No ready dispatches were available.</p> : launchResult.launches.map((launch) => <article key={launch.dispatchId}>
          <header><strong>Attempt {launch.attempt} · {launch.status}</strong><span>{launch.failureCode ?? launch.resources?.paneDisposition ?? ''}</span></header>
          <p>Task {launch.taskId.slice(0, 8)} · dispatch {launch.dispatchId.slice(0, 8)}</p>
          {launch.agentInstanceId ? <p>Agent {launch.agentInstanceId.slice(0, 8)} · runtime {launch.runtimeIdentity ?? 'pending'} · generation {launch.processGeneration ?? 0}</p> : null}
          <DispatchResourceDetails resource={launch.resources} />
          {launch.error ? <p>{launch.error}</p> : null}
          {resourceNeedsCleanup(launch.resources) ? <button type="button" disabled={busy} onClick={() => void execute(async () => { await orchestrationRequest('dispatch.cleanup', { id: launch.dispatchId }); setLaunchResult(null); await refresh(run.id) })}><RotateCcw size={13} /> Retry cleanup</button> : null}
        </article>)}
      </section> : null}

      <form className="orchestration-task-form" onSubmit={(event) => {
        event.preventDefault()
        if (!taskTitle.trim()) return
        void execute(async () => {
          await orchestrationRequest('task.create', { runId: run.id, title: taskTitle.trim(), description: '', dependencies: dependencyIds.split(',').map((value) => value.trim()).filter(Boolean), expectedRunRevision: run.revision })
          setTaskTitle(''); setDependencyIds(''); await refresh(run.id)
        })
      }}>
        <input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="New task" aria-label="New orchestration task" />
        <input value={dependencyIds} onChange={(event) => setDependencyIds(event.target.value)} placeholder="Dependency IDs (optional)" aria-label="Task dependency IDs" />
        <button type="submit" disabled={busy || !taskTitle.trim()}><ListPlus size={14} /> Add</button>
      </form>

      <div className="orchestration-task-board">
        {TASK_COLUMNS.map(({ status, label }) => {
          const columnTasks = tasksByStatus[status]
          if (columnTasks.length === 0 && ['failed', 'blocked', 'cancelled'].includes(status)) return null
          return <section key={status} className="orchestration-task-column" data-status={status}>
            <header><span>{label}</span><strong>{columnTasks.length}</strong></header>
            {columnTasks.map((task) => <article key={task.id} className="orchestration-task-card">
              <strong>{task.title}</strong><small title={task.id}>{task.id.slice(0, 8)} · r{task.revision}</small>
              {task.dependencies.length ? <span>Depends on {task.dependencies.length}</span> : null}
              {task.result ? <pre>{JSON.stringify(task.result, null, 2)}</pre> : null}
              {['failed', 'blocked', 'cancelled'].includes(task.status) ? <button type="button" disabled={busy} onClick={() => void execute(async () => { await orchestrationRequest('task.retry', { runId: run.id, taskId: task.id, expectedRunRevision: run.revision, expectedTaskRevision: task.revision }); await refresh(run.id) })}><RotateCcw size={13} /> Retry</button> : null}
            </article>)}
          </section>
        })}
      </div>

      <section className="orchestration-message-feed" aria-label="Live agents and worktrees">
        <h4>Agents, worktrees, and comparison</h4>
        {agents.length === 0 ? <p>No bound agents yet.</p> : agents.map((agent) => {
          const dispatch = dispatches.find((candidate) => candidate.agentInstanceId === agent.id)
          const files = dispatch ? filesByDispatch.get(dispatch.id) : []
          return <article key={agent.id} className="orchestration-agent-card">
            <header><strong>{agent.provider} {agent.profile ?? ''}</strong><span>{agent.status}</span></header>
            <p>Generation {agent.generation} · {agent.runtimeIdentity ?? 'not started'}</p>
            {dispatch ? <p>Attempt {dispatch.attempt} · {dispatch.status}{dispatch.failureCode ? ` · ${dispatch.failureCode}` : ''}</p> : null}
            {dispatch?.launchClaim ? <p>Launch {dispatch.launchClaim.operationId.slice(0, 8)} · {dispatch.launchClaim.worktreeMode} · spec {dispatch.launchClaim.commandDigest.slice(0, 12)}</p> : null}
            <DispatchResourceDetails resource={dispatch?.resources} />
            {!dispatch?.resources && dispatch?.worktree ? <><p>{dispatch.worktree.branch}</p><small title={dispatch.worktree.worktreePath}>{dispatch.worktree.worktreePath}</small><p>Base {dispatch.worktree.baseRevision.slice(0, 12)}</p></> : null}
            {files?.length ? <ul>{files.map((file) => <li key={String(file)}>{String(file)}</li>)}</ul> : null}
            {dispatch && resourceNeedsCleanup(dispatch.resources) ? <button type="button" disabled={busy} onClick={() => void execute(async () => { await orchestrationRequest('dispatch.cleanup', { id: dispatch.id }); setLaunchResult(null); await refresh(run.id) })}><RotateCcw size={13} /> Retry cleanup</button> : null}
          </article>
        })}
      </section>
      {dispatches.some((dispatch) => !dispatch.agentInstanceId && dispatch.resources) ? <section className="orchestration-message-feed" aria-label="Unbound dispatch resources">
        <h4>Unbound and retained resources</h4>
        {dispatches.filter((dispatch) => !dispatch.agentInstanceId && dispatch.resources).map((dispatch) => <article key={dispatch.id} className="orchestration-agent-card">
          <header><strong>Unbound dispatch {dispatch.id.slice(0, 8)}</strong><span>{dispatch.status}</span></header>
          <DispatchResourceDetails resource={dispatch.resources} />
          {resourceNeedsCleanup(dispatch.resources) ? <button type="button" disabled={busy} onClick={() => void execute(async () => { await orchestrationRequest('dispatch.cleanup', { id: dispatch.id }); setLaunchResult(null); await refresh(run.id) })}><RotateCcw size={13} /> Retry cleanup</button> : null}
        </article>)}
      </section> : null}

      {pendingGates.length ? <section className="orchestration-gates" aria-label="Decision gates">{pendingGates.map((gate) => <article key={gate.id}>
        <strong>{gate.prompt}</strong><div>{(gate.options.length ? gate.options : ['approve']).map((option) => <button key={option} type="button" disabled={busy} onClick={() => void execute(async () => { await orchestrationRequest('gate.resolve', { gateId: gate.id, resolution: { decision: option }, expectedRunRevision: run.revision }); setLaunchResult(null); await refresh(run.id) })}><Check size={13} /> {option}</button>)}</div>
      </article>)}</section> : null}

      <section className="orchestration-message-feed" aria-label="Run messages">
        {messages.length === 0 ? <p>No run messages yet.</p> : messages.map((message) => <article key={message.id}><header><strong>{message.senderKind}</strong><span>{message.messageType}</span></header><p>{messagePayloadText(message.payload)}</p></article>)}
      </section>
      <form className="orchestration-chat-form" onSubmit={(event) => { event.preventDefault(); if (!chatText.trim()) return; void execute(async () => { await orchestrationRequest('message.post', { runId: run.id, taskId: null, dispatchId: null, parentId: null, senderKind: 'user', messageType: 'chat', payload: { text: chatText.trim() } }); setChatText(''); await refresh(run.id) }) }}>
        <input value={chatText} onChange={(event) => setChatText(event.target.value)} placeholder="Message the run" aria-label="Run message" /><button type="submit" disabled={busy || !chatText.trim()}><Send size={14} /></button>
      </form>
      {error ? <div className="orchestration-error">{error}</div> : null}
    </div>
  )
}

function isDefinitiveLaunchError(error: OrchestrationRpcError) {
  return error.code === 'conflict'
    || error.code === 'identity_mismatch'
    || error.code === 'invalid_argument'
    || error.code === 'invalid_transition'
    || error.code === 'not_found'
    || error.code === 'stale_revision'
}

function resourceNeedsCleanup(resource?: DispatchResource | null) {
  return resource?.paneDisposition === 'cleanup_failed'
    || resource?.worktreeDisposition === 'cleanup_failed'
}

function DispatchResourceDetails({ resource }: { resource?: DispatchResource | null }) {
  if (!resource) return null
  const paneIdentity = resource.paneId ? ` · pane ${resource.paneId.slice(0, 8)}` : ''
  const worktreeIdentity = resource.worktree ? ` · ${resource.worktree.branch}` : ''
  return <>
    <p>Pane resource: {resource.paneDisposition}{paneIdentity}</p>
    <p>Worktree resource: {resource.worktreeDisposition}{worktreeIdentity}</p>
    {resource.repositoryRoot ? <small title={resource.repositoryRoot}>Git root: {resource.repositoryRoot}</small> : null}
    {resource.relativePrefix ? <p>Workspace prefix: {resource.relativePrefix}</p> : null}
    {resource.launchPath ? <small title={resource.launchPath}>Launch scope: {resource.launchPath}</small> : null}
    {resource.cleanupReason ? <p>Cleanup owner: {resource.cleanupReason}</p> : null}
    {resource.cleanupError ? <p>{resource.cleanupError}</p> : null}
  </>
}

function messagePayloadText(payload: Record<string, unknown>): string {
  if (typeof payload.text === 'string') return payload.text
  if (typeof payload.prompt === 'string') return payload.prompt
  return JSON.stringify(payload)
}
