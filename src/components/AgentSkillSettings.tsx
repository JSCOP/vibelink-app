import { useCallback, useEffect, useState } from 'react'
import { Bot, CircleCheck, CircleX, Download, Info, RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import {
  SettingsButton,
  SettingsCard,
  SettingsIconButton,
  SettingsMessage,
  SettingsPill,
  type SettingsIcon,
} from './settings/controls'
import {
  fetchAgentSkillStatus,
  installAgentSkill,
  uninstallAgentSkill,
  type AgentSkillState,
  type AgentSkillStatus,
} from '../ipc/agentSkills'

const stateBadges: Record<AgentSkillState, { label: string; tone?: 'ok' | 'warn'; icon: SettingsIcon }> = {
  installed: { label: 'Installed', tone: 'ok', icon: CircleCheck },
  stale: { label: 'Update available', tone: 'warn', icon: RefreshCw },
  missing: { label: 'Not installed', icon: CircleX },
  agentAbsent: { label: 'Agent not found', icon: CircleX },
}

/**
 * Installs the `vibelink-memory` skill into each agent's own home skills
 * directory. Targets are opt-in per row because the write lands in a directory
 * the user owns; agents whose home directory is missing start unchecked so a
 * bare machine does not collect config folders for agents it never had.
 */
export function AgentSkillSettings() {
  const [status, setStatus] = useState<AgentSkillStatus | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await fetchAgentSkillStatus()
      setStatus(next)
      setSelected(new Set(next.targets.filter((target) => target.state !== 'agentAbsent').map((target) => target.id)))
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }, [])
  useEffect(() => {
    // Fetch once on mount. `load` owns its own busy/error state; there is no
    // derived-state cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  /** Selection survives a mutation so the user can install and then undo the same rows. */
  const run = async (operation: () => Promise<AgentSkillStatus>) => {
    setBusy(true)
    setError(null)
    try { setStatus(await operation()) }
    catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }

  const targets = status?.targets ?? []
  const selectedTargets = targets.filter((target) => selected.has(target.id))
  const staleTargets = targets.filter((target) => target.state === 'stale')
  const installing = selectedTargets.some((target) => target.state === 'stale') ? 'Update' : 'Install'
  const removable = selectedTargets.some((target) => target.state === 'installed' || target.state === 'stale')

  return (
    <SettingsCard
      icon={Bot}
      title="Agent memory skill"
      hint="Install writes <root>/vibelink-memory/SKILL.md into the selected agents' home skills directories. VibeLink never modifies an agent's own config file."
      status={<SettingsIconButton icon={RefreshCw} label="Re-check skill status" disabled={busy} onClick={() => void load()} />}
    >
      <p className="vl-set-card-note">
        Installing this skill lets Claude Code, Codex, omp and other agents search and record this workspace's memory on their own.
      </p>

      {status && staleTargets.length > 0 ? (
        <div className="vl-set-message vl-set-message-action" data-tone="ok" role="status">
          <RefreshCw size={13} strokeWidth={1.9} aria-hidden="true" />
          <span>Skill update available (revision {status.revision}) — {staleTargets.length} of {targets.length} targets run an older copy.</span>
          <SettingsButton
            icon={RefreshCw}
            tone="accent"
            label="Update all"
            disabled={busy}
            onClick={() => void run(() => installAgentSkill(staleTargets.map((target) => target.id)))}
          />
        </div>
      ) : null}

      {!status ? (
        <SettingsMessage icon={Info}>Reading skill status…</SettingsMessage>
      ) : targets.length === 0 ? (
        <SettingsMessage icon={Info}>No agent skill directories are known on this machine.</SettingsMessage>
      ) : targets.map((target) => {
        const badge = stateBadges[target.state]
        return (
          <label key={target.id} className="vl-set-agent">
            <input
              type="checkbox"
              className="vl-set-agent-check"
              aria-label={target.label}
              checked={selected.has(target.id)}
              disabled={busy}
              onChange={(event) => {
                const checked = event.target.checked
                setSelected((current) => {
                  const next = new Set(current)
                  if (checked) next.add(target.id)
                  else next.delete(target.id)
                  return next
                })
              }}
            />
            <span className="vl-set-agent-name">
              <strong>{target.label}</strong>
              <span className="mono" title={target.path}>{target.path}</span>
              {target.state === 'agentAbsent' ? <span>This agent is not installed on this machine.</span> : null}
            </span>
            <SettingsPill tone={badge.tone} icon={badge.icon}>{badge.label}</SettingsPill>
            <span />
          </label>
        )
      })}

      <div className="vl-set-actions vl-set-actions-bordered">
        <SettingsButton
          icon={installing === 'Update' ? RefreshCw : Download}
          tone="accent"
          label={installing}
          title={`${installing} the skill for ${selectedTargets.length} selected target(s)`}
          disabled={busy || selectedTargets.length === 0}
          onClick={() => void run(() => installAgentSkill(selectedTargets.map((target) => target.id)))}
        />
        <SettingsButton
          icon={Trash2}
          tone="danger"
          label="Remove"
          title="Delete the skill from the selected targets"
          disabled={busy || !removable}
          onClick={() => void run(() => uninstallAgentSkill(selectedTargets.map((target) => target.id)))}
        />
      </div>

      {error ? <SettingsMessage tone="danger" icon={TriangleAlert}>{error}</SettingsMessage> : null}
    </SettingsCard>
  )
}
