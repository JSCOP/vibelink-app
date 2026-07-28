import { invoke } from '@tauri-apps/api/core'
import { CheckCircle2, Circle, Loader2, RefreshCw, XCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { agentStatusLabel, type AgentCliStatus } from '../ipc/agents'
import { getHermesRuntimeStatus, setHermesModel, startHermesAgent } from '../ipc/hermes'
import { runMcpSelfCheck, type McpCheckReport } from '../ipc/mcp'
import type { HermesRuntimeStatus } from '../ipc/types'
import { useWorkspaceStore } from '../state/store'
import { AccountSignIn } from './AccountSignIn'
import { HermesInstallGuidance } from './HermesInstallGuidance'
import { ProfileIcon } from './ProfileIcon'
import { agentIconName } from './settings/agentBrand'
import { setupStepAutoPass, setupStepIds, setupStepTitle } from './setupWizardSteps'

type SetupWizardProps = {
  onComplete: () => void
}


export function SetupWizard({ onComplete }: SetupWizardProps) {
  const settings = useWorkspaceStore((state) => state.settings)
  const license = useWorkspaceStore((state) => state.license)
  const sessions = useWorkspaceStore((state) => state.sessions)
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const agentClis = useWorkspaceStore((state) => state.agentClis)
  const hermesModels = useWorkspaceStore((state) => state.hermesModels)
  const refreshAgentClis = useWorkspaceStore((state) => state.refreshAgentClis)
  const attachSession = useWorkspaceStore((state) => state.attachSession)
  const spawnPane = useWorkspaceStore((state) => state.spawnPane)
  const updateSettings = useWorkspaceStore((state) => state.updateSettings)
  const [stepIndex, setStepIndex] = useState(0)
  const [skippedSteps, setSkippedSteps] = useState<string[]>(settings.setupWizard.skippedSteps)
  const [runtime, setRuntime] = useState<HermesRuntimeStatus | null>(null)
  const [runtimeMessage, setRuntimeMessage] = useState('')
  const [modelBusy, setModelBusy] = useState(false)
  const [modelMessage, setModelMessage] = useState('')
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpReport, setMcpReport] = useState<McpCheckReport | null>(null)
  const [agentBusy, setAgentBusy] = useState(false)
  const entitled = Boolean(license.status?.entitled)
  const developmentMode = license.status?.state === 'development'
  const step = setupStepIds[stepIndex]
  const models = activeSessionId ? hermesModels[activeSessionId] : undefined
  const autoPass = useMemo(() => setupStepAutoPass({
    entitled,
    runtimeDetected: Boolean(runtime?.detected),
    agentClis,
    mcp: mcpReport,
  }), [agentClis, entitled, mcpReport, runtime?.detected])

  useEffect(() => {
    void getHermesRuntimeStatus(settings.hermesCommand)
      .then(setRuntime)
      .catch((error) => setRuntimeMessage(String(error)))
  }, [settings.hermesCommand])

  useEffect(() => {
    if (step !== 'agents' && step !== 'model') return
    const recheck = () => { void refreshAgentClis().catch(() => undefined) }
    window.addEventListener('focus', recheck)
    return () => window.removeEventListener('focus', recheck)
  }, [refreshAgentClis, step])

  const ensureActiveSession = async () => {
    const sessionId = useWorkspaceStore.getState().activeSessionId ?? sessions[0]?.id
    if (!sessionId) throw new Error('No workspace is available')
    if (useWorkspaceStore.getState().activeSessionId !== sessionId) await attachSession(sessionId)
    return sessionId
  }

  const skipCurrent = () => {
    if (!skippedSteps.includes(step)) setSkippedSteps((current) => [...current, step])
    if (step === 'finish') finish()
    else setStepIndex((index) => Math.min(setupStepIds.length - 1, index + 1))
  }

  const next = () => {
    let nextIndex = Math.min(setupStepIds.length - 1, stepIndex + 1)
    while (nextIndex < setupStepIds.length - 1 && autoPass[setupStepIds[nextIndex]]) nextIndex += 1
    setStepIndex(nextIndex)
  }

  const finish = () => {
    updateSettings({
      setupWizard: {
        ...settings.setupWizard,
        completedAt: new Date().toISOString(),
        skippedSteps,
      },
    })
    onComplete()
  }

  const skipEverything = () => {
    updateSettings({
      setupWizard: {
        ...settings.setupWizard,
        completedAt: new Date().toISOString(),
        skippedSteps: setupStepIds.filter((id) => id !== 'finish'),
      },
    })
    onComplete()
  }

  const openAgentLogin = async (status: AgentCliStatus) => {
    setAgentBusy(true)
    try {
      const sessionId = await ensureActiveSession()
      const session = sessions.find((item) => item.id === sessionId)
      const script = `${status.loginHint}; Write-Host 'Return to VibeLink and choose Re-check when login is complete.'`
      await spawnPane(sessionId, {
        shell: 'pwsh.exe',
        args: ['-NoLogo', '-NoExit', '-Command', script],
        cwd: session?.workspaceFolder ?? null,
        title: `${status.displayName} login`,
        icon: agentIconName(status.id),
      })
    } finally {
      setAgentBusy(false)
    }
  }


  const prepareModel = async () => {
    if (!entitled || !runtime?.detected) return
    setModelBusy(true)
    setModelMessage('Starting Hermes and loading available models…')
    try {
      const sessionId = await ensureActiveSession()
      const session = sessions.find((item) => item.id === sessionId)
      await withSetupTimeout(startHermesAgent({
        sessionId,
        commandOverride: settings.hermesCommand || null,
        workspaceFolder: session?.workspaceFolder ?? null,
      }))
      setModelMessage('Hermes is ready. Choose a provider-qualified model below.')
    } catch (error) {
      setModelMessage(String(error))
    } finally {
      setModelBusy(false)
    }
  }

  const openHermesCli = async (verb: 'auth' | 'model') => {
    const sessionId = await ensureActiveSession()
    const session = sessions.find((item) => item.id === sessionId)
    const command = await invoke<string>('hermes_cli_command', { commandOverride: settings.hermesCommand || null })
    const action = verb === 'auth' ? 'auth' : 'model'
    const script = `& ${quotePowerShell(command)} ${action}`
    await spawnPane(sessionId, {
      shell: 'pwsh.exe',
      args: ['-NoLogo', '-NoExit', '-Command', script],
      cwd: session?.workspaceFolder ?? null,
      title: verb === 'auth' ? 'Hermes auth CLI' : 'Hermes model setup',
      icon: 'hermes',
    })
  }

  const runMcpCheck = async () => {
    if (!entitled) return
    setMcpBusy(true)
    setMcpReport(null)
    try {
      const sessionId = await ensureActiveSession()
      const report = await withSetupTimeout(runMcpSelfCheck(sessionId))
      setMcpReport(report)
    } catch (error) {
      setMcpReport({ spawnOk: false, initializeOk: false, toolCount: 0, error: String(error) })
    } finally {
      setMcpBusy(false)
    }
  }

  return (
    <div className="setup-wizard-backdrop" role="presentation">
      <section className="setup-wizard" role="dialog" aria-modal="true" aria-labelledby="setup-wizard-title">
        <aside className="setup-wizard-steps" aria-label="Setup progress">
          <p className="settings-eyebrow">First-run setup</p>
          {setupStepIds.map((id, index) => {
            const complete = index < stepIndex || Boolean(autoPass[id])
            return (
              <div key={id} className={index === stepIndex ? 'active' : undefined}>
                {complete ? <CheckCircle2 size={15} /> : <Circle size={15} />}
                <span>{setupStepTitle(id)}</span>
              </div>
            )
          })}
        </aside>
        <main className="setup-wizard-content">
          <header>
            <div>
              <p className="settings-eyebrow">Step {stepIndex + 1} of {setupStepIds.length}</p>
              <h2 id="setup-wizard-title">{setupStepTitle(step)}</h2>
            </div>
            {step !== 'finish' ? <button type="button" className="setup-skip-link" onClick={skipCurrent}>Skip setup</button> : null}
          </header>

          {step === 'welcome' ? (
            <div className="setup-wizard-panel">
              <h3>One workspace for terminals, agents, and durable work.</h3>
              <p>VibeLink can detect your coding agents, connect to your Hermes Agent, verify MCP, and keep Kanban tasks synchronized without manual wiring.</p>
              <div className="setup-wizard-actions">
                <button type="button" className="primary-action" onClick={next}>Start setup</button>
                <button type="button" onClick={skipEverything}>Skip everything</button>
              </div>
            </div>
          ) : null}

          {step === 'license' ? (
            <div className="setup-wizard-panel">
              {developmentMode ? (
                <>
                  <h3>Development entitlement is active.</h3>
                  <p>Account and trial checks are skipped only in this debug build. Release builds still require a Moobang account entitlement.</p>
                </>
              ) : (
                <>
                  <AccountSignIn onActivated={next} />
                  <p>Sign in with your Moobang account to start your 7-day free trial. Every feature is unlocked during the trial.</p>
                </>
              )}
              <div className="setup-wizard-actions">
                <button type="button" className="primary-action" disabled={!entitled} onClick={next}>Continue</button>
              </div>
            </div>
          ) : null}

          {step === 'agents' ? (
            <div className="setup-wizard-panel">
              <div className="setup-agent-list">
                {agentClis.map((status) => (
                  <div key={status.id} className="setup-agent-row">
                    <ProfileIcon name={agentIconName(status.id)} size={20} className="setup-agent-icon" />
                    <div>
                      <strong>{status.displayName}</strong>
                      <span>{status.version ?? agentStatusLabel(status)}</span>
                    </div>
                    <span>{agentStatusLabel(status)}</span>
                    {status.installed && status.auth !== 'loggedIn' ? <button type="button" disabled={agentBusy} onClick={() => void openAgentLogin(status)}>Log in…</button> : null}
                  </div>
                ))}
              </div>
              {agentClis.every((status) => !status.installed) ? <p>You can add agent CLIs later; the terminal works without them.</p> : null}
              <div className="setup-wizard-actions">
                <button type="button" disabled={agentBusy} onClick={() => void refreshAgentClis()}><RefreshCw size={14} /> Re-check</button>
                <button type="button" className="primary-action" onClick={next}>Continue</button>
              </div>
            </div>
          ) : null}

          {step === 'runtime' ? (
            <div className="setup-wizard-panel">
              {!entitled ? <ProNotice /> : null}
              <HermesInstallGuidance
                runtime={runtime}
                commandOverride={settings.hermesCommand || null}
                sessionId={activeSessionId ?? sessions[0]?.id}
                workspaceFolder={sessions.find((item) => item.id === (activeSessionId ?? sessions[0]?.id))?.workspaceFolder ?? null}
                onStatus={setRuntime}
              />
              {runtimeMessage ? <p className="setup-inline-message">{runtimeMessage}</p> : null}
              <div className="setup-wizard-actions">
                <button type="button" className="primary-action" onClick={next}>Continue</button>
              </div>
            </div>
          ) : null}

          {step === 'model' ? (
            <div className="setup-wizard-panel">
              {!entitled ? <ProNotice /> : null}
              {entitled && !runtime?.detected ? <p>Install Hermes Agent first, or skip this step.</p> : null}
              <div className="setup-wizard-actions">
                <button type="button" disabled={!entitled || !runtime?.detected || modelBusy} onClick={() => void prepareModel()}>{modelBusy ? <Loader2 className="spin" size={14} /> : null}Start / refresh Hermes</button>
                <button type="button" disabled={!entitled || !runtime?.detected} onClick={() => void openHermesCli('auth')}>Hermes auth</button>
                <button type="button" disabled={!entitled || !runtime?.detected} onClick={() => void openHermesCli('model')}>Hermes model</button>
              </div>
              {models?.available.length ? (
                <label>
                  Model
                  <select value={models.current} onChange={(event) => { if (activeSessionId) void setHermesModel(activeSessionId, event.target.value) }}>
                    {models.available.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
                  </select>
                </label>
              ) : <p>No provider-qualified model reported yet. Use Hermes auth/model, then return and refresh.</p>}
              {modelMessage ? <p className="setup-inline-message">{modelMessage}</p> : null}
              <div className="setup-wizard-actions"><button type="button" className="primary-action" onClick={next}>Continue</button></div>
            </div>
          ) : null}

          {step === 'mcp' ? (
            <div className="setup-wizard-panel">
              {!entitled ? <ProNotice /> : null}
              <button type="button" disabled={!entitled || mcpBusy} onClick={() => void runMcpCheck()}>{mcpBusy ? <Loader2 className="spin" size={14} /> : null}Run MCP self-check</button>
              {mcpReport ? (
                <div className="setup-check-result" data-ok={mcpReport.initializeOk ? 'true' : 'false'}>
                  {mcpReport.initializeOk ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                  <span>Spawn {mcpReport.spawnOk ? 'OK' : 'failed'} · Initialize {mcpReport.initializeOk ? 'OK' : 'failed'} · {mcpReport.toolCount} tools</span>
                  {mcpReport.error ? <pre>{mcpReport.error}</pre> : null}
                </div>
              ) : null}
              <div className="setup-wizard-actions"><button type="button" className="primary-action" onClick={next}>Continue</button></div>
            </div>
          ) : null}

          {step === 'finish' ? (
            <div className="setup-wizard-panel">
              <h3>VibeLink is ready.</h3>
              <ul>
                <li>{developmentMode ? 'Development entitlement active' : license.status?.plan === 'pro' ? 'Pro account connected' : license.status?.plan === 'trial' ? '7-day trial active' : 'Account connected'}</li>
                <li>{agentClis.filter((status) => status.installed).length} agent CLI(s) detected</li>
                <li>Hermes Agent {runtime?.detected ? 'detected' : 'not detected'}</li>
                <li>MCP {mcpReport?.initializeOk ? `verified with ${mcpReport.toolCount} tools` : 'not verified'}</li>
              </ul>
              <div className="setup-wizard-actions"><button type="button" className="primary-action" onClick={finish}>Finish</button></div>
            </div>
          ) : null}
        </main>
      </section>
    </div>
  )
}

function ProNotice() {
  return <p className="setup-pro-notice">A Moobang account with VibeLink Pro is required. Read-only checks remain available.</p>
}


function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function withSetupTimeout<T>(operation: Promise<T>): Promise<T> {
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => globalThis.setTimeout(() => reject(new Error('Still running after 60 seconds. You can skip this step and retry later.')), 60_000)),
  ])
}
