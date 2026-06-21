import { invoke } from '@tauri-apps/api/core'
import { type ButtonHTMLAttributes, type ComponentType, useEffect, useMemo, useState } from 'react'
import { KeyRound, Play, RefreshCw, RotateCcw, Settings2, Square, type LucideProps } from 'lucide-react'
import { startHermesOutputStream } from '../ipc/hermes'
import type { HermesRuntimeStatus, HermesWorkspaceState } from '../ipc/types'
import { useWorkspaceStore } from '../state/store'
import { HermesMessage } from './HermesMessage'
import { HermesPermissionPrompt } from './HermesPermissionPrompt'

export function OrchestratorChat() {
  const sessionId = useWorkspaceStore((state) => state.activeSessionId)
  const sessions = useWorkspaceStore((state) => state.sessions)
  const settings = useWorkspaceStore((state) => state.settings)
  const hermesStatusRecord = useWorkspaceStore((state) => state.hermesStatus)
  const hermesTranscriptRecord = useWorkspaceStore((state) => state.hermesTranscript)
  const hermesPermissionsRecord = useWorkspaceStore((state) => state.hermesPermissions)
  const hermesUsageRecord = useWorkspaceStore((state) => state.hermesUsage)
  const hermesModelsRecord = useWorkspaceStore((state) => state.hermesModels)
  const error = useWorkspaceStore((state) => state.error)
  const setHermesStatus = useWorkspaceStore((state) => state.setHermesStatus)
  const addHermesUserMessage = useWorkspaceStore((state) => state.addHermesUserMessage)
  const spawnPane = useWorkspaceStore((state) => state.spawnPane)
  const setViewMode = useWorkspaceStore((state) => state.setViewMode)
  const [message, setMessage] = useState('')
  const [runtime, setRuntime] = useState<HermesRuntimeStatus | null>(null)
  const [runtimeBusy, setRuntimeBusy] = useState(false)
  const [runtimeMessage, setRuntimeMessage] = useState('')
  const [workspace, setWorkspace] = useState<HermesWorkspaceState | null>(null)
  const [authList, setAuthList] = useState('')
  const [authListBusy, setAuthListBusy] = useState(false)
  const [authListError, setAuthListError] = useState('')
  const [hermesCli, setHermesCli] = useState('')
  const [hermesHome, setHermesHome] = useState('')
  const [activeSince, setActiveSince] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const session = useMemo(() => sessions.find((item) => item.id === sessionId), [sessions, sessionId])
  const status = sessionId ? hermesStatusRecord[sessionId] ?? 'idle' : 'idle'
  const transcript = useMemo(() => sessionId ? hermesTranscriptRecord[sessionId] ?? [] : [], [hermesTranscriptRecord, sessionId])
  const permissions = useMemo(() => sessionId ? hermesPermissionsRecord[sessionId] ?? [] : [], [hermesPermissionsRecord, sessionId])
  const usage = sessionId ? hermesUsageRecord[sessionId] : undefined
  const models = sessionId ? hermesModelsRecord[sessionId] : undefined
  const workspaceFolderLabel = session?.workspaceFolder?.trim() || workspace?.workspaceFolder || 'none (using HERMES_HOME)'
  const statusLabel = status === 'busy' ? 'waiting for response' : status
  const canSend = status === 'running' && Boolean(message.trim())
  const activeElapsed = activeSince ? formatElapsed(now - activeSince) : '0s'
  const assistantTurns = transcript.filter((turn) => turn.role === 'assistant')
  const activeToolCalls = assistantTurns.flatMap((turn) => turn.toolCalls).filter((call) => call.status !== 'completed')
  const toolCallCount = assistantTurns.reduce((count, turn) => count + turn.toolCalls.length, 0)
  const thoughtCount = assistantTurns.filter((turn) => turn.thoughts.trim()).length
  const liveState = status === 'starting'
    ? 'Starting ACP session'
    : status === 'busy'
      ? activeToolCalls.length ? `Running ${activeToolCalls.length} tool call${activeToolCalls.length === 1 ? '' : 's'}` : 'Waiting for model response'
      : status === 'running'
        ? 'Ready'
        : status === 'error'
          ? 'Error'
          : 'Idle'

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
    if (status === 'starting' || status === 'busy') {
      setActiveSince((value) => value ?? Date.now())
      return
    }
    setActiveSince(null)
  }, [status])

  useEffect(() => {
    if (!activeSince) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [activeSince])

  if (!sessionId) return <div className="orchestrator-chat hermes-chat">Open a workspace.</div>

  const installRuntime = async () => {
    setRuntimeBusy(true)
    setRuntimeMessage('Installing Hermes runtime…')
    try {
      const command = await invoke<string>('hermes_install_runtime')
      const status = await invoke<HermesRuntimeStatus>('hermes_runtime_status', { commandOverride: settings.hermesCommand || null })
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
    await startHermesOutputStream({ force: true })
    setHermesStatus(sessionId, 'starting')
    try {
      await invoke('hermes_start', {
        sessionId,
        commandOverride: settings.hermesCommand || null,
        workspaceFolder: session?.workspaceFolder ?? null,
      })
    } catch (error) {
      setHermesStatus(sessionId, 'error')
      useWorkspaceStore.getState().setError(String(error))
    }
  }

  const openHermesTerminal = async (verb: 'auth' | 'model' | 'shell') => {
    try {
      let currentWorkspace = workspace
      if (!currentWorkspace) {
        currentWorkspace = await invoke<HermesWorkspaceState>('hermes_ensure_workspace', { sessionId, workspaceFolder: session?.workspaceFolder ?? null })
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
      setViewMode(sessionId, 'terminal')
    } catch (error) {
      useWorkspaceStore.getState().setError(String(error))
    }
  }

  const send = async () => {
    const text = message.trim()
    if (!text || status !== 'running') return
    try {
      await startHermesOutputStream({ force: true })
      addHermesUserMessage(sessionId, text)
      setMessage('')
      setHermesStatus(sessionId, 'busy')
      await invoke('hermes_send', { sessionId, text })
    } catch (error) {
      const message = `Hermes error: ${String(error)}`
      setHermesStatus(sessionId, 'error')
      useWorkspaceStore.getState().appendHermesText(sessionId, 'message', message)
      useWorkspaceStore.getState().setError(message)
    }
  }

  const cancel = async () => {
    if (status !== 'busy') return
    await startHermesOutputStream({ force: true })
    await invoke('hermes_cancel', { sessionId })
  }

  const restart = async () => {
    await invoke('hermes_stop', { sessionId }).catch(() => undefined)
    await start()
  }

  const setModel = async (modelId: string) => {
    if (!modelId) return
    await invoke('hermes_set_model', { sessionId, modelId })
  }

  const refreshAuthList = async () => {
    setAuthListBusy(true)
    setAuthListError('')
    try {
      setAuthList(await invoke<string>('hermes_auth_list', { sessionId, commandOverride: settings.hermesCommand || null }))
    } catch (error) {
      setAuthListError(String(error))
    } finally {
      setAuthListBusy(false)
    }
  }

  if (!runtime?.installed && !settings.hermesCommand) {
    return (
      <div className="orchestrator-chat hermes-chat hermes-empty-state">
        <h3>Hermes runtime is not installed</h3>
        <p>Install the managed uv-bundled Hermes runtime, or set a hermes-acp override in Settings.</p>
        <button type="button" onClick={() => void installRuntime()} disabled={runtimeBusy}>{runtimeBusy ? 'Installing…' : 'Install Hermes runtime'}</button>
        {runtimeMessage ? <p>{runtimeMessage}</p> : null}
      </div>
    )
  }

  if (!workspace?.model) {
    return (
      <div className="orchestrator-chat hermes-chat hermes-empty-state">
        <h3>Configure this workspace&apos;s Hermes agent</h3>
        <p>Provider, login, and model selection come from the native Hermes CLI. Run <code>hermes model</code>, complete login if prompted, then Refresh.</p>
        {status === 'error' ? <p className="hermes-form-message" title={error || undefined}>Agent failed to start. See the top banner for the exact error. If it mentions the workspace folder, open or recreate that folder; if it mentions auth, run Configure model &amp; login.</p> : null}
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
    <div className="orchestrator-chat hermes-chat">
      <header className="hermes-chat-header">
        <div>
          <h3>Hermes Agent</h3>
          <p>{workspace.model.provider} / {workspace.model.model} · {statusLabel}</p>
        </div>
        {status === 'error' ? <p className="hermes-form-message" title={error || undefined}>Agent failed. Check the transcript/top banner, then re-auth or restart.</p> : null}
        <div className="hermes-chat-controls">
          <HeaderButton icon={KeyRound} label="Auth" title="Open Hermes auth CLI" onClick={() => void openHermesTerminal('auth')} />
          <HeaderButton icon={Settings2} label="Model" title="Configure model and login" onClick={() => void openHermesTerminal('model')} />
          <HeaderButton icon={RefreshCw} label="Refresh" title="Refresh Hermes workspace state" onClick={() => void refreshWorkspace()} />
          {models?.available.length ? (
            <select value={models.current} onChange={(event) => void setModel(event.target.value)} title="Hermes models">
              {models.available.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
            </select>
          ) : <span className="hermes-model-pill" title="Hermes did not return a selectable model list; using the configured workspace model.">{workspace.model.model}</span>}
          {status === 'busy' ? <HeaderButton icon={Square} label="Cancel" title="Cancel active Hermes response" onClick={() => void cancel()} /> : status === 'running' ? <HeaderButton icon={RotateCcw} label="Restart" title="Restart Hermes agent after model/auth changes" onClick={() => void restart()} /> : <HeaderButton icon={Play} label={status === 'starting' ? 'Starting' : 'Start'} title="Start Hermes agent" disabled={status === 'starting'} onClick={() => void start()} />}
        </div>
      </header>
      <details className="hermes-runtime-details">
        <summary>Runtime</summary>
        <div className="hermes-runtime-note">
          <small>Hermes CLI: {hermesCli || 'resolving…'}</small>
          <small>Workspace folder: {workspaceFolderLabel}</small>
          <small>Workspace HERMES_HOME: {hermesHome || 'resolving…'}</small>
          <small>ACP: {runtime?.command ?? 'hermes-acp'}</small>
        </div>
      </details>

      <details className="hermes-auth-list">
        <summary>Credentials</summary>
        <button type="button" onClick={() => void refreshAuthList()} disabled={authListBusy}>{authListBusy ? 'Refreshing…' : 'Refresh'}</button>
        {authListError ? <p className="hermes-form-message">{authListError}</p> : null}
        {authList ? <pre>{authList}</pre> : <p className="hermes-form-message">Refresh checks this workspace HERMES_HOME only. A listed user does not prove the token is still accepted by the provider.</p>}
      </details>

      {usage ? (
        <div className="hermes-usage-bar" aria-label="Hermes context usage">
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
        {transcript.length === 0 ? <p className="hermes-empty-state">Ask Hermes to plan, inspect panes, or create board tasks.</p> : null}
        {transcript.map((turn, index) => <HermesMessage key={`${index}:${turn.role}:${turn.text.slice(0, 16)}`} turn={turn} />)}
      </div>

      {permissions.map((permission) => <HermesPermissionPrompt key={permission.requestId} sessionId={sessionId} permission={permission} />)}

      <footer className="hermes-composer">
        <textarea
          value={message}
          rows={4}
          placeholder="Message Hermes…"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            if (message.trim() && status === 'running') void send()
          }}
        />
        <button type="button" disabled={!canSend} onClick={() => void send()}>Send</button>
      </footer>
    </div>
  )
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
