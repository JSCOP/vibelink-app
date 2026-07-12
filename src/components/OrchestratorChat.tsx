import { invoke } from '@tauri-apps/api/core'
import { type ButtonHTMLAttributes, type ComponentType, useEffect, useMemo, useState } from 'react'
import { Archive, Bot, ChevronLeft, ChevronRight, FileText, KeyRound, MessageSquare, Play, Plus, RefreshCw, RotateCcw, Search, Settings2, Sparkles, Square, Trash2, Wrench, type LucideProps } from 'lucide-react'
import { ensureHermesWorkspace, hermesNewSession, hermesRefreshSessions, hermesResumeSession, setHermesModel, startHermesAgent, startHermesOutputStream } from '../ipc/hermes'
import { installHermesRuntime } from '../ipc/hermesSetup'
import type { HermesRuntimeStatus, HermesWorkspaceState, SkillApplyInput, SkillEntry } from '../ipc/types'
import type { HermesSessionInfo, HermesTurn, PendingPermission } from '../state/hermes'
import { useWorkspaceStore } from '../state/store'
import { HermesMessage } from './HermesMessage'
import { HermesPermissionPrompt } from './HermesPermissionPrompt'
import { HermesGatewayForm } from './HermesGatewayForm'

type AgentSection = 'chat' | 'skills' | 'messaging' | 'artifacts'

const EMPTY_TRANSCRIPT: HermesTurn[] = []
const EMPTY_PERMISSIONS: PendingPermission[] = []
const EMPTY_HERMES_SESSIONS: HermesSessionInfo[] = []

export function OrchestratorChat() {
  const sessionId = useWorkspaceStore((state) => state.activeSessionId)
  const sessions = useWorkspaceStore((state) => state.sessions)
  const settings = useWorkspaceStore((state) => state.settings)
  const status = useWorkspaceStore((state) => sessionId ? state.hermesStatus[sessionId] ?? 'idle' : 'idle')
  const transcript = useWorkspaceStore((state) => sessionId ? state.hermesTranscript[sessionId] ?? EMPTY_TRANSCRIPT : EMPTY_TRANSCRIPT)
  const permissions = useWorkspaceStore((state) => sessionId ? state.hermesPermissions[sessionId] ?? EMPTY_PERMISSIONS : EMPTY_PERMISSIONS)
  const usage = useWorkspaceStore((state) => sessionId ? state.hermesUsage[sessionId] : undefined)
  const models = useWorkspaceStore((state) => sessionId ? state.hermesModels[sessionId] : undefined)
  const pendingCount = useWorkspaceStore((state) => sessionId ? state.hermesPendingPrompts[sessionId]?.length ?? 0 : 0)
  const currentSession = useWorkspaceStore((state) => sessionId ? state.hermesCurrentSession[sessionId] : undefined)
  const sessionList = useWorkspaceStore((state) => sessionId ? state.hermesSessions[sessionId] ?? EMPTY_HERMES_SESSIONS : EMPTY_HERMES_SESSIONS)
  const error = useWorkspaceStore((state) => state.error)
  const setHermesStatus = useWorkspaceStore((state) => state.setHermesStatus)
  const addHermesUserMessage = useWorkspaceStore((state) => state.addHermesUserMessage)
  const enqueueHermesPrompt = useWorkspaceStore((state) => state.enqueueHermesPrompt)
  const takeHermesPrompt = useWorkspaceStore((state) => state.takeHermesPrompt)
  const spawnPane = useWorkspaceStore((state) => state.spawnPane)
  const [message, setMessage] = useState('')
  const [runtime, setRuntime] = useState<HermesRuntimeStatus | null>(null)
  const [runtimeBusy, setRuntimeBusy] = useState(false)
  const [runtimeMessage, setRuntimeMessage] = useState('')
  const [workspace, setWorkspace] = useState<HermesWorkspaceState | null>(null)
  const [hermesCli, setHermesCli] = useState('')
  const [hermesHome, setHermesHome] = useState('')
  const [activeSince, setActiveSince] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [agentSection, setAgentSection] = useState<AgentSection>('chat')
  const [sessionSearch, setSessionSearch] = useState('')
  const [isSidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('vibelink:agentSidebarCollapsed') === '1'
  })

  const session = useMemo(() => sessions.find((item) => item.id === sessionId), [sessions, sessionId])
  const sessionOptions = useMemo(() => {
    if (!currentSession || sessionList.some((item) => item.id === currentSession)) return sessionList
    return [{ id: currentSession, title: null, source: 'current', model: null, startedAt: null, endedAt: null, messageCount: 0, archived: false }, ...sessionList]
  }, [currentSession, sessionList])
  const filteredSessionOptions = useMemo(() => {
    const needle = sessionSearch.trim().toLowerCase()
    if (!needle) return sessionOptions
    return sessionOptions.filter((item) => sessionLabel(item).toLowerCase().includes(needle))
  }, [sessionOptions, sessionSearch])
  const workspaceFolderLabel = session?.workspaceFolder?.trim() || workspace?.workspaceFolder || 'none (using HERMES_HOME)'
  const statusLabel = status === 'busy' ? 'waiting for response' : status
  const canSend = Boolean(message.trim())
  const activeElapsed = activeSince ? formatElapsed(now - activeSince) : '0s'
  const assistantTurns = transcript.filter((turn) => turn.role === 'assistant')
  const activeToolCalls = assistantTurns.flatMap((turn) => turn.toolCalls).filter((call) => call.status !== 'completed')
  const toolCallCount = assistantTurns.reduce((count, turn) => count + turn.toolCalls.length, 0)
  const thoughtCount = assistantTurns.filter((turn) => turn.thoughts.trim()).length
  const liveState = status === 'starting'
    ? 'Starting ACP session'
    : status === 'busy'
      ? activeToolCalls.length ? `Working — ${activeToolCalls.length} tool call${activeToolCalls.length === 1 ? '' : 's'}` : 'Working'
      : status === 'running'
        ? 'Ready'
        : status === 'error'
          ? 'Error (chat still available)'
          : 'Idle — type to start'

  useEffect(() => {
    let cancelled = false
    void invoke<HermesRuntimeStatus>('hermes_runtime_status', { commandOverride: settings.hermesCommand || null })
      .then((status) => {
        if (!cancelled) setRuntime(status)
      })
      .catch((error) => {
        if (!cancelled) setRuntime({ installed: false, command: settings.hermesCommand || 'hermes-acp', version: String(error) })
      })
    void invoke<string>('hermes_cli_command', { commandOverride: settings.hermesCommand || null })
      .then((command) => { if (!cancelled) setHermesCli(command) })
      .catch((error) => { if (!cancelled) setHermesCli(String(error)) })
    if (sessionId) {
      void invoke<HermesWorkspaceState>('hermes_ensure_workspace', { sessionId, workspaceFolder: session?.workspaceFolder ?? null })
        .then((state) => {
          if (!cancelled) {
            setWorkspace(state)
            setHermesHome(state.home)
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setWorkspace(null)
            setHermesHome(String(error))
          }
        })
    }
    return () => { cancelled = true }
  }, [settings.hermesCommand, sessionId, session?.workspaceFolder])

  useEffect(() => {
    if (!sessionId || (status !== 'running' && status !== 'busy' && status !== 'starting')) return
    void startHermesOutputStream().catch((error) => useWorkspaceStore.getState().setError(String(error)))
  }, [sessionId, status])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (status === 'starting' || status === 'busy') {
        setActiveSince((value) => value ?? Date.now())
      } else {
        setActiveSince(null)
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [status])

  useEffect(() => {
    if (!activeSince) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [activeSince])

  useEffect(() => {
    if (!sessionId || status !== 'running' || pendingCount === 0) return
    const next = takeHermesPrompt(sessionId)
    if (next === undefined) return
    setHermesStatus(sessionId, 'busy')
    void (async () => {
      try {
        await startHermesOutputStream({ force: true })
        await invoke('hermes_send', { sessionId, text: next })
      } catch (error) {
        const message = `VibeLink Agent error: ${String(error)}`
        setHermesStatus(sessionId, 'error')
        useWorkspaceStore.getState().appendHermesText(sessionId, 'message', message)
        useWorkspaceStore.getState().setError(message)
      }
    })()
  }, [sessionId, status, pendingCount, takeHermesPrompt, setHermesStatus])

  useEffect(() => {
    if (!sessionId) return
    void hermesRefreshSessions(sessionId).catch(() => undefined)
  }, [sessionId, status])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('vibelink:agentSidebarCollapsed', isSidebarCollapsed ? '1' : '0')
  }, [isSidebarCollapsed])

  if (!sessionId) return <div className="orchestrator-chat hermes-chat">Open a workspace.</div>

  const installRuntime = async () => {
    setRuntimeBusy(true)
    setRuntimeMessage('Installing VibeLink Agent runtime…')
    try {
      const installed = await installHermesRuntime(settings.hermesCommand)
      const { command, status } = installed
      setRuntime(status)
      setRuntimeMessage(`Installed: ${command}`)
    } catch (error) {
      setRuntimeMessage(String(error))
    } finally {
      setRuntimeBusy(false)
    }
  }

  const refreshWorkspace = async () => {
    try {
      const state = await invoke<HermesWorkspaceState>('hermes_workspace_state', { sessionId })
      setWorkspace(state)
      setHermesHome(state.home)
    } catch (error) {
      useWorkspaceStore.getState().setError(String(error))
    }
  }

  const start = async () => {
    try {
      await startHermesAgent({
        sessionId,
        commandOverride: settings.hermesCommand || null,
        workspaceFolder: session?.workspaceFolder ?? null,
      })
    } catch (error) {
      setHermesStatus(sessionId, 'error')
      useWorkspaceStore.getState().setError(String(error))
    }
  }

  const switchHermesSession = async (acpSessionId: string) => {
    if (!acpSessionId || acpSessionId === currentSession) return
    try {
      await hermesResumeSession({
        sessionId,
        commandOverride: settings.hermesCommand || null,
        workspaceFolder: session?.workspaceFolder ?? null,
      }, acpSessionId)
    } catch (error) {
      useWorkspaceStore.getState().setError(String(error))
    }
  }

  const createHermesSession = async () => {
    try {
      await hermesNewSession({
        sessionId,
        commandOverride: settings.hermesCommand || null,
        workspaceFolder: session?.workspaceFolder ?? null,
      })
    } catch (error) {
      useWorkspaceStore.getState().setError(String(error))
    }
  }

  const archiveHermesSession = async () => {
    if (!currentSession) return
    if (typeof window !== 'undefined' && !window.confirm('Remove this Hermes thread from the session list?')) return
    try {
      await invoke('hermes_archive_session', { sessionId, acpSessionId: currentSession })
      const remaining = await invoke<typeof sessionList>('hermes_list_sessions', { sessionId })
      useWorkspaceStore.getState().setHermesSessions(sessionId, remaining)
      const replacement = remaining.find((item) => item.id !== currentSession)
      if (replacement) await switchHermesSession(replacement.id)
      else await createHermesSession()
    } catch (error) {
      useWorkspaceStore.getState().setError(String(error))
    }
  }

  const openHermesTerminal = async (verb: 'auth' | 'model' | 'shell') => {
    try {
      let currentWorkspace = workspace
      if (!currentWorkspace) {
        currentWorkspace = await ensureHermesWorkspace(sessionId, session?.workspaceFolder)
        setWorkspace(currentWorkspace)
        setHermesHome(currentWorkspace.home)
      }
      const home = currentWorkspace.home
      const hermesCommand = await invoke<string>('hermes_cli_command', { commandOverride: settings.hermesCommand || null })
      const action = verb === 'auth'
        ? `& ${quotePowerShellString(hermesCommand)} auth`
        : verb === 'model'
          ? `& ${quotePowerShellString(hermesCommand)} model`
          : `Write-Host ${quotePowerShellString('Use this terminal for Hermes CLI commands, e.g. hermes auth, hermes model, hermes status.')}`
      const script = [
        `$env:HERMES_HOME=${quotePowerShellString(home)}`,
        `Write-Host ${quotePowerShellString(`HERMES_HOME: ${home}`)}`,
        `Write-Host ${quotePowerShellString(`Hermes CLI: ${hermesCommand}`)}`,
        action,
      ].join('; ')
      await spawnPane(sessionId, {
        shell: 'pwsh.exe',
        args: ['-NoLogo', '-NoExit', '-Command', script],
        cwd: session?.workspaceFolder ?? null,
        title: verb === 'model' ? 'Hermes model setup' : verb === 'auth' ? 'Hermes auth CLI' : 'Hermes CLI',
        icon: 'sparkles',
      })
    } catch (error) {
      useWorkspaceStore.getState().setError(String(error))
    }
  }

  const send = async () => {
    const text = message.trim()
    if (!text) return
    addHermesUserMessage(sessionId, text)
    setMessage('')
    enqueueHermesPrompt(sessionId, text)
    if (status !== 'running' && status !== 'busy') {
      void startHermesAgent({
        sessionId,
        commandOverride: settings.hermesCommand || null,
        workspaceFolder: session?.workspaceFolder ?? null,
      }).catch(() => {})
    }
  }

  const cancel = async () => {
    if (status !== 'busy') return
    await startHermesOutputStream({ force: true })
    await invoke('hermes_cancel', { sessionId })
  }

  const restart = async () => {
    await invoke('hermes_stop', { sessionId }).catch(() => undefined)
    await startHermesAgent({ sessionId, commandOverride: settings.hermesCommand || null, workspaceFolder: session?.workspaceFolder ?? null })
  }

  const setModel = async (modelId: string) => {
    if (!modelId) return
    await setHermesModel(sessionId, modelId)
  }


  if (!runtime?.installed && !settings.hermesCommand) {
    return (
      <div className="orchestrator-chat hermes-chat hermes-empty-state">
        <h3>VibeLink Agent runtime is not installed</h3>
        <p>Install the managed uv-bundled agent runtime, or set a hermes-acp override in Settings.</p>
        <button type="button" onClick={() => void installRuntime()} disabled={runtimeBusy}>{runtimeBusy ? 'Installing…' : 'Install VibeLink Agent runtime'}</button>
        {runtimeMessage ? <p>{runtimeMessage}</p> : null}
      </div>
    )
  }

  if (!workspace?.model) {
    return (
      <div className="orchestrator-chat hermes-chat hermes-empty-state">
        <h3>Configure this workspace&apos;s VibeLink Agent</h3>
        <p>Provider, login, and model selection come from the native Hermes CLI. Run <code>hermes model</code>, complete login if prompted, then Refresh.</p>
        {status === 'error' ? <p className="hermes-form-message" title={error || undefined}>Agent failed to start — this workspace has no provider/model configured yet. Use Model below to run <code>hermes model</code>, complete login if prompted, then Refresh.</p> : null}
        <div className="hermes-runtime-note">
          <small>Hermes CLI: {hermesCli || 'resolving…'}</small>
          <small>Workspace folder: {workspaceFolderLabel}</small>
          <small>Workspace HERMES_HOME: {hermesHome || 'resolving…'}</small>
          <small>ACP: {runtime?.command ?? 'hermes-acp'}</small>
        </div>
        <HeaderButton icon={Settings2} label="Model" title="Configure model and login" onClick={() => void openHermesTerminal('model')} />
        <HeaderButton icon={KeyRound} label="Auth" title="Open Hermes auth CLI" onClick={() => void openHermesTerminal('auth')} />
        <HeaderButton icon={RefreshCw} label="Refresh" title="Refresh Hermes workspace state" onClick={() => void refreshWorkspace()} />
      </div>
    )
  }

  return (
    <div className={`orchestrator-chat hermes-chat vibelink-agent-shell${isSidebarCollapsed ? ' vibelink-agent-sidebar-collapsed' : ''}`}>
      {!isSidebarCollapsed ? (
        <aside className="vibelink-agent-sidebar" aria-label="VibeLink Agent sidebar">
          <div className="vibelink-agent-sidebar-toolbar">
            <span>Agent menu</span>
          </div>
          <nav className="vibelink-agent-nav" aria-label="VibeLink Agent sections">
            <button
              type="button"
              className={agentSection === 'chat' ? 'active' : undefined}
              disabled={status === 'busy' || status === 'starting'}
              title="Start a new VibeLink Agent session"
              onClick={() => {
                setAgentSection('chat')
                void createHermesSession()
              }}
            >
              <Bot size={14} /> New session
            </button>
            <button type="button" className={agentSection === 'skills' ? 'active' : undefined} onClick={() => setAgentSection('skills')}>
              <Wrench size={14} /> Skills & Tools
            </button>
            <button type="button" className={agentSection === 'messaging' ? 'active' : undefined} onClick={() => setAgentSection('messaging')}>
              <MessageSquare size={14} /> Messaging
            </button>
            <button type="button" className={agentSection === 'artifacts' ? 'active' : undefined} onClick={() => setAgentSection('artifacts')}>
              <FileText size={14} /> Artifacts
            </button>
          </nav>
          <div className="vibelink-agent-session-search">
            <Search size={13} />
            <input value={sessionSearch} placeholder="Search sessions..." onChange={(event) => setSessionSearch(event.target.value)} />
          </div>
          <div className="vibelink-agent-session-list">
            <div className="vibelink-agent-session-heading">Sessions {filteredSessionOptions.length}/{sessionOptions.length}</div>
            {filteredSessionOptions.map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.id === currentSession ? 'active' : undefined}
                disabled={status === 'busy'}
                onClick={() => void switchHermesSession(item.id)}
              >
                <span>{item.title?.trim() || `Session ${item.id.slice(0, 8)}`}</span>
                <small>{item.messageCount} msg · {item.source || 'native'}</small>
              </button>
            ))}
          </div>
        </aside>
      ) : null}

      <section className="vibelink-agent-main">
        <header className="hermes-chat-header vibelink-agent-header">
          <div className="vibelink-agent-title">
            <button
              type="button"
              className="vibelink-agent-header-menu-toggle"
              aria-label={isSidebarCollapsed ? 'Open VibeLink Agent menu' : 'Collapse VibeLink Agent menu'}
              aria-expanded={!isSidebarCollapsed}
              title={isSidebarCollapsed ? 'Open agent menu' : 'Collapse agent menu'}
              onClick={() => setSidebarCollapsed((value) => !value)}
            >
              {isSidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
            </button>
            <h3>VibeLink Agent</h3>
            <p>{workspace.model.provider} / {workspace.model.model} · {statusLabel}</p>
          </div>
          {status === 'error' ? <p className="hermes-form-message" title={error || undefined}>Agent failed. Check the transcript/top banner, then re-auth or restart.</p> : null}
          <div className="hermes-chat-controls">
            <HeaderButton icon={KeyRound} label="Auth" title="Open Hermes auth CLI" onClick={() => void openHermesTerminal('auth')} />
            <HeaderButton icon={Settings2} label="Model" title="Configure model and login" onClick={() => void openHermesTerminal('model')} />
            <HeaderButton icon={RefreshCw} label="Refresh" title="Refresh agent workspace state" onClick={() => void refreshWorkspace()} />
            {currentSession ? <HeaderButton icon={Trash2} label="Remove" title="Remove selected VibeLink Agent thread" disabled={status === 'busy'} onClick={() => void archiveHermesSession()} /> : null}
            <HeaderButton icon={Plus} label="New" title="Start a new VibeLink Agent session" disabled={status === 'busy' || status === 'starting'} onClick={() => void createHermesSession()} />
            {models?.available.length ? (
              <select value={models.current} onChange={(event) => void setModel(event.target.value)} title="Agent models">
                {models.available.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
              </select>
            ) : <span className="hermes-model-pill" title="Hermes did not return a selectable model list; using the configured workspace model.">{workspace.model.model}</span>}
            {status === 'busy' ? <HeaderButton icon={Square} label="Cancel" title="Cancel active agent response" onClick={() => void cancel()} /> : status === 'running' ? <HeaderButton icon={RotateCcw} label="Restart" title="Restart VibeLink Agent after model/auth changes" onClick={() => void restart()} /> : <HeaderButton icon={Play} label={status === 'starting' ? 'Starting' : 'Start'} title="Start VibeLink Agent" disabled={status === 'starting'} onClick={() => void start()} />}
          </div>
        </header>

        {agentSection === 'chat' ? (
          <>
            {usage ? (
              <div className="hermes-usage-bar" aria-label="Agent context usage">
                <span style={{ width: `${usage.size > 0 ? Math.min(100, (usage.used / usage.size) * 100) : 0}%` }} />
                <small>{usage.used}/{usage.size}</small>
              </div>
            ) : null}

            <div className="hermes-live-status" aria-live="polite">
              <strong>{liveState}</strong>
              <span>Elapsed {activeSince ? activeElapsed : '—'}</span>
              <span>Thoughts {thoughtCount}</span>
              <span>Tool calls {toolCallCount}</span>
              {usage ? <span>Context {usage.used}/{usage.size}</span> : null}
            </div>

            <div className="hermes-transcript">
              {transcript.length === 0 ? (
                <div className="vibelink-agent-empty">
                  <Sparkles size={24} />
                  <h2>VibeLink Agent</h2>
                  <p>Paste a task, bug, or file path and VibeLink Agent will work through the current workspace.</p>
                </div>
              ) : null}
              {transcript.map((turn, index) => (
                <HermesMessage
                  key={`${index}:${turn.role}:${turn.text.slice(0, 16)}`}
                  turn={turn}
                  showThoughts={settings.chatReasoningBlocks}
                  showToolCalls={settings.chatToolCalls}
                  showToolCallContent={settings.chatToolCallContent}
                />
              ))}
            </div>

            {permissions.map((permission) => <HermesPermissionPrompt key={permission.requestId} sessionId={sessionId} permission={permission} />)}

            <footer className="hermes-composer">
              <textarea
                value={message}
                rows={2}
                placeholder="Message VibeLink Agent..."
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
                  event.preventDefault()
                  if (message.trim()) void send()
                }}
              />
              <button type="button" disabled={!canSend} onClick={() => void send()}>Send</button>
            </footer>
          </>
        ) : null}

        {agentSection === 'skills' ? <AgentSkillsPanel sessionId={sessionId} /> : null}
        {agentSection === 'messaging' ? <AgentMessagingPanel sessionId={sessionId} /> : null}
        {agentSection === 'artifacts' ? <AgentArtifactsPanel transcript={transcript} permissions={permissions.length} /> : null}
      </section>
    </div>
  )
}

function AgentSkillsPanel({ sessionId }: { sessionId: string }) {
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [skillsLoading, setSkillsLoading] = useState(true)
  const [skillsApplying, setSkillsApplying] = useState(false)
  const [skillDraft, setSkillDraft] = useState('')
  const [skillsMessage, setSkillsMessage] = useState('')

  useEffect(() => {
    let cancelled = false
    void invoke<SkillEntry[]>('vibelink_skill_list', { sessionId })
      .then((nextSkills) => {
        if (cancelled) return
        setSkills(nextSkills)
        setSkillsMessage('')
      })
      .catch((error) => {
        if (!cancelled) setSkillsMessage(`Unable to load skills: ${String(error)}`)
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false)
      })
    return () => { cancelled = true }
  }, [sessionId])

  const refreshSkills = async () => {
    setSkillsLoading(true)
    try {
      setSkills(await invoke<SkillEntry[]>('vibelink_skill_list', { sessionId }))
      setSkillsMessage('')
    } catch (error) {
      setSkillsMessage(`Unable to load skills: ${String(error)}`)
    } finally {
      setSkillsLoading(false)
    }
  }

  const applySkill = async () => {
    const content = skillDraft.trim()
    if (!content) return
    setSkillsApplying(true)
    setSkillsMessage('')
    try {
      const input = buildWorkspaceSkillInput(content, sessionId)
      const applied = await invoke<SkillEntry | null>('vibelink_skill_apply', { input })
      setSkillDraft('')
      setSkills(await invoke<SkillEntry[]>('vibelink_skill_list', { sessionId }))
      setSkillsMessage(`Applied ${applied?.name || input.name || input.id}.`)
    } catch (error) {
      setSkillsMessage(`Unable to apply skill: ${String(error)}`)
    } finally {
      setSkillsApplying(false)
    }
  }

  return (
    <div className="vibelink-agent-section">
      <div className="vibelink-agent-section-title">
        <Wrench size={16} />
        <div>
          <h4>Skills & Tools</h4>
          <p>Built-in and workspace skills available to VibeLink Agent for this session.</p>
        </div>
      </div>
      <form className="vibelink-agent-skill-apply" onSubmit={(event) => { event.preventDefault(); void applySkill() }}>
        <label>
          <span>Apply workspace skill Markdown</span>
          <textarea
            value={skillDraft}
            rows={4}
            placeholder={'# Skill name\n\nInstructions VibeLink Agent should follow for this workspace...'}
            onChange={(event) => setSkillDraft(event.target.value)}
          />
        </label>
        <div className="vibelink-agent-skill-apply-actions">
          <button type="submit" disabled={!skillDraft.trim() || skillsApplying}>{skillsApplying ? 'Applying…' : 'Apply to workspace'}</button>
          <button type="button" disabled={skillsLoading || skillsApplying} onClick={() => void refreshSkills()}>Refresh</button>
        </div>
      </form>
      {skillsMessage ? <p className="hermes-form-message">{skillsMessage}</p> : null}
      <div className="vibelink-agent-skill-list" aria-busy={skillsLoading}>
        {skillsLoading && skills.length === 0 ? <p className="hermes-empty-state">Loading skills…</p> : null}
        {!skillsLoading && skills.length === 0 && !skillsMessage ? <p className="hermes-empty-state">No skills registered for this workspace yet.</p> : null}
        {skills.map((skill) => {
          const id = skill.id?.trim() || 'skill'
          const label = skill.name?.trim() || id
          const category = skill.category?.trim() || 'Uncategorized'
          const description = skill.description?.trim()
          const updatedAt = formatSkillUpdatedAt(skill.updatedAt)
          const enabled = skill.enabled !== false
          const scopeLabel = skill.scope === 'workspace' ? 'Workspace' : 'Global'
          const sourceLabel = skill.readOnly ? 'Built-in' : 'Persisted'
          return (
            <div key={`${skill.scope}:${id}`} className={`vibelink-agent-skill-row${enabled ? '' : ' vibelink-agent-skill-row-disabled'}`}>
              <div>
                <strong>{label}</strong>
                {description ? <span>{description}</span> : null}
                <div className="vibelink-agent-skill-meta">
                  <small>{scopeLabel}</small>
                  <small>{sourceLabel}</small>
                  <small>{category}</small>
                  <small>{enabled ? 'Enabled' : 'Disabled'}</small>
                  {updatedAt ? <small>Updated {updatedAt}</small> : null}
                </div>
                {skill.path ? <code className="vibelink-agent-skill-path" title={skill.path}>{skill.path}</code> : null}
              </div>
              <small>{id}</small>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function AgentMessagingPanel({ sessionId }: { sessionId: string }) {
  return (
    <div className="vibelink-agent-section">
      <div className="vibelink-agent-section-title">
        <MessageSquare size={16} />
        <div>
          <h4>Messaging</h4>
          <p>Connect messaging gateways that can deliver prompts to VibeLink Agent.</p>
        </div>
      </div>
      <HermesGatewayForm sessionId={sessionId} />
    </div>
  )
}

function AgentArtifactsPanel({ transcript, permissions }: { transcript: HermesTurn[]; permissions: number }) {
  const toolCalls = transcript.flatMap((turn) => turn.toolCalls)
  return (
    <div className="vibelink-agent-section">
      <div className="vibelink-agent-section-title">
        <Archive size={16} />
        <div>
          <h4>Artifacts</h4>
          <p>Generated outputs, tool results, and permission diffs from the current agent session.</p>
        </div>
      </div>
      <div className="vibelink-agent-artifact-grid">
        <div><strong>{transcript.length}</strong><span>Messages</span></div>
        <div><strong>{toolCalls.length}</strong><span>Tool calls</span></div>
        <div><strong>{permissions}</strong><span>Pending permissions</span></div>
      </div>
      <div className="vibelink-agent-skill-list">
        {toolCalls.length === 0 ? <p className="hermes-empty-state">No tool artifacts in this session yet.</p> : null}
        {toolCalls.map((call) => (
          <div key={call.id} className="vibelink-agent-skill-row">
            <div>
              <strong>{call.title || call.toolKind}</strong>
              <span>{call.content || call.status}</span>
            </div>
            <small>{call.status}</small>
          </div>
        ))}
      </div>
    </div>
  )
}

function buildWorkspaceSkillInput(content: string, sessionId: string): SkillApplyInput {
  const parsed = parseMarkdownSkill(content)
  return {
    content,
    id: parsed.id,
    name: parsed.name,
    category: parsed.category,
    description: parsed.description,
    scope: 'workspace',
    sessionId,
    enabled: true,
  }
}

function parseMarkdownSkill(content: string): { id: string; name: string; category: string; description: string } {
  const { attributes, body } = parseMarkdownAttributes(content)
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim()
  const name = attributes.name || heading || 'Workspace skill'
  const description = attributes.description || firstMarkdownParagraph(body) || 'Workspace skill instructions'
  const category = attributes.category || 'Workspace'
  const id = slugifySkillId(attributes.id || name)
  return { id, name, category, description }
}

function parseMarkdownAttributes(content: string): { attributes: Record<string, string>; body: string } {
  const normalized = content.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---')) return { attributes: {}, body: normalized }
  const frontmatterEnd = normalized.indexOf('\n---', 3)
  if (frontmatterEnd < 0) return { attributes: {}, body: normalized }
  const block = normalized.slice(3, frontmatterEnd)
  const bodyStart = normalized.indexOf('\n', frontmatterEnd + 4)
  const body = bodyStart >= 0 ? normalized.slice(bodyStart + 1) : ''
  const attributes: Record<string, string> = {}
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.+)$/)
    if (!match) continue
    const key = match[1].trim().toLowerCase()
    if (key === 'id' || key === 'name' || key === 'category' || key === 'description') {
      attributes[key] = match[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return { attributes, body }
}

function firstMarkdownParagraph(body: string): string {
  let inFence = false
  const paragraph: string[] = []
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence || !line || line.startsWith('#') || line.startsWith('---')) {
      if (paragraph.length > 0) break
      continue
    }
    paragraph.push(line.replace(/^[-*]\s+/, ''))
    if (paragraph.join(' ').length > 140) break
  }
  return paragraph.join(' ').slice(0, 180)
}

function slugifySkillId(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '')
  if (slug.length >= 2) return slug
  if (slug.length === 1) return `${slug}-skill`
  return 'workspace-skill'
}

function formatSkillUpdatedAt(value: SkillEntry['updatedAt']): string {
  if (value === undefined || value === null || value === '') return ''
  if (value === 0) return ''
  const timestamp = typeof value === 'number' ? (value < 10_000_000_000 ? value * 1000 : value) : Date.parse(value)
  if (!Number.isFinite(timestamp)) return String(value)
  return new Date(timestamp).toLocaleString()
}

function sessionLabel(session: { id: string; title: string | null; source: string; messageCount: number }): string {
  const title = session.title?.trim() || `Session ${session.id.slice(0, 8)}`
  const source = session.source.trim() || 'unknown'
  return `${title} · ${session.messageCount}msg · ${source}`
}

function HeaderButton({ icon: Icon, label, ...props }: { icon: ComponentType<LucideProps>; label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {

  return (
    <button type="button" {...props} aria-label={props['aria-label'] ?? props.title ?? label}>
      <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
      <span>{label}</span>
    </button>
  )
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
