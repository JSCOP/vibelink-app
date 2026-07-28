import { invoke } from '@tauri-apps/api/core'
import { ExternalLink, RefreshCw, Terminal, Upload } from 'lucide-react'
import { useState } from 'react'
import { getHermesRuntimeStatus } from '../ipc/hermes'
import type { HermesRuntimeStatus } from '../ipc/types'
import { useWorkspaceStore } from '../state/store'

const installGuideUrl = 'https://hermes-agent.nousresearch.com/'
const installCommand = 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)'

type HermesInstallGuidanceProps = {
  runtime: HermesRuntimeStatus | null
  commandOverride?: string | null
  sessionId?: string | null
  workspaceFolder?: string | null
  onStatus: (status: HermesRuntimeStatus) => void
}

export function HermesInstallGuidance({ runtime, commandOverride = null, sessionId, workspaceFolder, onStatus }: HermesInstallGuidanceProps) {
  const spawnPane = useWorkspaceStore((state) => state.spawnPane)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const launch = async (script: string, title: string) => {
    if (!sessionId) return
    setBusy(true)
    setMessage('')
    try {
      await spawnPane(sessionId, {
        shell: 'pwsh.exe',
        args: ['-NoLogo', '-NoExit', '-Command', script],
        cwd: workspaceFolder ?? null,
        title,
        icon: 'hermes',
      })
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  const recheck = async () => {
    setBusy(true)
    setMessage('Checking for Hermes Agent…')
    try {
      const status = await getHermesRuntimeStatus(commandOverride)
      onStatus(status)
      setMessage(status.detected ? 'Hermes Agent detected.' : 'Hermes Agent was not detected.')
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  if (runtime?.detected) {
    const label = `Hermes ${runtime.version ?? 'version unknown'} · ${runtime.command ?? 'hermes-acp'}`
    return (
      <div className="hermes-runtime-guidance">
        <strong>{label}</strong>
        <button
          type="button"
          disabled={busy || !sessionId || !runtime.cliCommand}
          onClick={() => void launch(`& ${quotePowerShell(runtime.cliCommand ?? 'hermes')} update`, 'Hermes update')}
        >
          <Upload size={14} /> Update (hermes update)
        </button>
        {message ? <p className="hermes-form-message">{message}</p> : null}
      </div>
    )
  }

  return (
    <div className="hermes-runtime-guidance">
      <strong>Hermes Agent not detected</strong>
      <p>VibeLink connects to the Hermes Agent installed on your system. Install it once, then every workspace can use it.</p>
      <div className="vibelink-settings-actions">
        <button type="button" disabled={busy || !sessionId} onClick={() => void launch(installCommand, 'Install Hermes Agent')}>
          <Terminal size={14} /> Install in terminal
        </button>
        <button type="button" disabled={busy} onClick={() => void invoke('open_path', { path: installGuideUrl })}>
          <ExternalLink size={14} /> Open install guide
        </button>
        <button type="button" disabled={busy} onClick={() => void recheck()}>
          <RefreshCw size={14} /> Re-check
        </button>
      </div>
      {message ? <p className="hermes-form-message">{message}</p> : null}
    </div>
  )
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
