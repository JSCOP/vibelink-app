import { useCallback, useEffect, useState } from 'react'
import { Bot, ChevronRight, CircleCheck, CircleX, Download, Info, RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import {
  SettingsButton,
  SettingsCard,
  SettingsIconButton,
  SettingsMessage,
  SettingsPill,
  SettingsRow,
  SettingsSwitch,
  type SettingsIcon,
} from './settings/controls'
import { agentIconName } from './settings/agentBrand'
import { ProfileIcon } from './ProfileIcon'
import { useWorkspaceStore } from '../state/store'
import {
  fetchAgentSkillStatus,
  installAgentSkill,
  syncAgentSkill,
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
 * Fronts the `vibelink-memory` skill with a single switch: leave it on and every
 * agent already present on this machine keeps a current copy, refreshed at each
 * launch. The per-target list is the escape hatch, not the main control, because
 * picking install locations out of ten rows is a decision nobody wants to make.
 */
export function AgentSkillSettings() {
  const autoInstall = useWorkspaceStore((state) => state.settings.autoInstallAgentSkill)
  const updateSettings = useWorkspaceStore((state) => state.updateSettings)
  const [status, setStatus] = useState<AgentSkillStatus | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (operation: () => Promise<AgentSkillStatus>) => {
    setBusy(true)
    setError(null)
    try { setStatus(await operation()) }
    catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }, [])

  useEffect(() => {
    // Scan once on mount. `run` owns its own busy/error state; there is no
    // derived-state cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void run(fetchAgentSkillStatus)
  }, [run])

  const targets = status?.targets ?? []
  const installed = targets.filter((target) => target.state === 'installed' || target.state === 'stale')
  const absent = targets.filter((target) => target.state === 'agentAbsent')
  const staleTargets = targets.filter((target) => target.state === 'stale')
  const notInstalled = targets.length - installed.length - absent.length

  const summary = status
    ? [
        `Installed for ${installed.length} ${installed.length === 1 ? 'agent' : 'agents'}`,
        notInstalled > 0 ? `${notInstalled} not installed` : null,
        absent.length > 0 ? `${absent.length} not on this machine` : null,
      ].filter(Boolean).join(' · ')
    : 'Reading skill status…'

  return (
    <SettingsCard
      icon={Bot}
      title="Agent memory skill"
      hint="VibeLink writes one file per agent — <agent home>/skills/vibelink-memory/SKILL.md — and never edits an agent's own config file."
      status={<SettingsIconButton icon={RefreshCw} label="Re-check skill status" disabled={busy} onClick={() => void run(fetchAgentSkillStatus)} />}
    >
      <p className="vl-set-card-note">
        Leave this on and Claude Code, Codex, omp and your other agents can search and record this workspace&apos;s memory on
        their own. VibeLink only drops the skill file into each agent&apos;s own skills folder — it never edits their config.
      </p>

      <SettingsRow
        icon={Bot}
        label="Keep the memory skill installed for my agents"
        sub={summary}
        control={(
          <SettingsSwitch
            label="Keep the memory skill installed for my agents"
            checked={autoInstall}
            disabled={busy}
            onChange={(next) => {
              updateSettings({ autoInstallAgentSkill: next })
              // Switching on should not wait for the next launch to mean anything.
              if (next) void run(syncAgentSkill)
            }}
          />
        )}
      />

      {/* With auto-install on, the app already refreshed every copy at launch,
          so a stale revision is not the user's problem to act on. */}
      {status && !autoInstall && staleTargets.length > 0 ? (
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

      <button
        type="button"
        className="vl-set-disclosure"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        <ChevronRight size={13} strokeWidth={2} aria-hidden="true" />
        <span>{expanded ? 'Hide details' : 'Show details'}</span>
      </button>

      {!expanded ? null : targets.length === 0 ? (
        <SettingsMessage icon={Info}>No agent skill directories are known on this machine.</SettingsMessage>
      ) : targets.map((target) => {
        const badge = stateBadges[target.state]
        const present = target.state === 'installed' || target.state === 'stale'
        return (
          <div key={target.id} className="vl-set-agent" data-installed={target.state === 'agentAbsent' ? 'false' : 'true'}>
            <span className="vl-set-agent-icon">
              <ProfileIcon name={agentIconName(target.id)} size={20} />
            </span>
            <span className="vl-set-agent-name">
              <strong>{target.label}</strong>
              <span className="mono" title={target.path}>{target.path}</span>
            </span>
            <SettingsPill tone={badge.tone} icon={badge.icon}>{badge.label}</SettingsPill>
            {present ? (
              <SettingsButton
                icon={Trash2}
                tone="danger"
                label="Remove"
                title={`Delete the skill from ${target.path}`}
                disabled={busy}
                onClick={() => void run(() => uninstallAgentSkill([target.id]))}
              />
            ) : (
              <SettingsButton
                icon={Download}
                label="Install"
                title={`Write the skill into ${target.path}`}
                disabled={busy}
                onClick={() => void run(() => installAgentSkill([target.id]))}
              />
            )}
          </div>
        )
      })}

      {error ? <SettingsMessage tone="danger" icon={TriangleAlert}>{error}</SettingsMessage> : null}
    </SettingsCard>
  )
}
