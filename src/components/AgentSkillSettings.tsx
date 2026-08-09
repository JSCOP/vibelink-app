import { useCallback, useEffect, useState } from 'react'
import { Bot, Brain, ChevronRight, CircleCheck, CircleX, ClipboardCopy, Download, Globe, Info, RefreshCw, Terminal, Trash2, TriangleAlert } from 'lucide-react'
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
import { writeClipboardText } from '../ipc/clipboard'
import {
  agentSkillCliCommand,
  fetchAgentSkillStatus,
  installAgentSkill,
  refreshAgentSkill,
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

const isSkillPresent = (state: AgentSkillState) => state === 'installed' || state === 'stale'

// What each bundled skill actually buys the user, in their words rather than the
// trigger blob the agent reads. Keyed by the backend's skill name so a skill this
// build does not know about still renders instead of vanishing.
const skillCopy: Record<string, { label: string; icon: SettingsIcon; sub: string }> = {
  'vibelink-memory': {
    label: 'Memory',
    icon: Brain,
    sub: 'Search and record this workspace\u2019s durable facts — one shared store every agent reads and writes.',
  },
  'vibelink-browser': {
    label: 'Browser use',
    icon: Globe,
    sub: 'Drive your own running Chrome with your profile and signed-in sessions, or a VibeLink in-pane page.',
  },
}

// The 75 `--agent` keys the standard `skills` CLI accepts, split so the nine
// most-used ones are visible and the rest sit behind a disclosure. This list
// only decides what the checkboxes offer and in which order — validation is the
// backend's job, and so is building the command string.
const featuredAgentKeys = ['claude-code', 'codex', 'cursor', 'opencode', 'gemini-cli', 'github-copilot', 'windsurf', 'zed', 'universal']
const otherAgentKeys = [
  'adal', 'aider-desk', 'amp', 'antigravity', 'antigravity-cli', 'astrbot', 'augment', 'autohand-code', 'bob', 'cline',
  'codearts-agent', 'codebuddy', 'codemaker', 'codestudio', 'command-code', 'continue', 'cortex', 'crush', 'deepagents',
  'devin', 'dexto', 'droid', 'eve', 'firebender', 'forgecode', 'goose', 'grok', 'hermes-agent', 'iflow-cli',
  'inference-sh', 'jazz', 'junie', 'kilo', 'kimchi', 'kimi-code-cli', 'kiro-cli', 'kode', 'lingma', 'loaf', 'mcpjam',
  'mistral-vibe', 'moxby', 'mux', 'neovate', 'ona', 'openclaw', 'openhands', 'pi', 'pochi', 'promptscript', 'qoder',
  'qoder-cn', 'qwen-code', 'reasonix', 'replit', 'roo', 'rovodev', 'tabnine-cli', 'terramind', 'tinycloud', 'trae',
  'trae-cn', 'warp', 'zcode', 'zencoder', 'zenflow',
]
const allAgentKeys = [...featuredAgentKeys, ...otherAgentKeys]

/**
 * Three blocks, in the order a user meets them: per-skill install state and
 * explicit install actions, per-skill maintenance, and a copyable
 * `npx skills add` command for agents VibeLink cannot write to itself.
 */
export function AgentSkillSettings() {
  const autoUpdate = useWorkspaceStore((state) => state.settings.autoUpdateAgentSkill)
  const updateSettings = useWorkspaceStore((state) => state.updateSettings)
  const [status, setStatus] = useState<AgentSkillStatus | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cliOpen, setCliOpen] = useState(false)
  const [allKeysOpen, setAllKeysOpen] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  // Carries the keys it was built for, so a command is never shown next to a
  // selection it does not match while the next one is in flight.
  const [command, setCommand] = useState<{ keys: string[]; text: string } | null>(null)
  const [cliError, setCliError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const run = useCallback(async (operation: () => Promise<AgentSkillStatus>) => {
    setBusy(true)
    setError(null)
    try { setStatus(await operation()) }
    catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }, [])

  // Selection is rebuilt in canonical key order so the generated command reads
  // the same regardless of the order the boxes were ticked in.
  const toggleKey = useCallback((key: string) => {
    setSelectedKeys((keys) => keys.includes(key)
      ? keys.filter((current) => current !== key)
      : allAgentKeys.filter((current) => current === key || keys.includes(current)))
  }, [])

  useEffect(() => {
    // Scan once on mount. `run` owns its own busy/error state; there is no
    // derived-state cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void run(fetchAgentSkillStatus)
  }, [run])

  useEffect(() => {
    if (selectedKeys.length === 0) return
    let cancelled = false
    agentSkillCliCommand(selectedKeys).then((text) => {
      if (cancelled) return
      setCommand({ keys: selectedKeys, text })
      setCliError(null)
    }).catch((reason) => {
      if (!cancelled) setCliError(String(reason))
    })
    return () => { cancelled = true }
  }, [selectedKeys])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1200)
    return () => window.clearTimeout(timer)
  }, [copied])

  const targets = status?.targets ?? []
  const installed = targets.filter((target) => target.skills.some((skill) => isSkillPresent(skill.state)))
  const absent = targets.filter((target) => target.skills.every((skill) => skill.state === 'agentAbsent'))
  const staleTargets = targets.filter((target) => target.skills.some((skill) => skill.state === 'stale'))
  const partialTargets = targets.filter((target) =>
    target.skills.some((skill) => isSkillPresent(skill.state))
      && target.skills.some((skill) => skill.state === 'missing'))
  const installable = targets.filter((target) =>
    target.skills.some((skill) => skill.state === 'missing' || skill.state === 'stale'))
  const notInstalled = targets.length - installed.length - absent.length

  const summary = !status
    ? 'Reading skill status…'
    : installed.length > 0
      ? [
          `Installed for ${installed.length} ${installed.length === 1 ? 'agent' : 'agents'}`,
          notInstalled > 0 ? `${notInstalled} not installed` : null,
          absent.length > 0 ? `${absent.length} not on this machine` : null,
        ].filter(Boolean).join(' · ')
      : installable.length > 0
        ? `Not installed yet · ${installable.length} ${installable.length === 1 ? 'agent' : 'agents'} found on this machine`
        : 'Not installed yet · no supported agents found on this machine'

  const shownCommand = command && command.keys === selectedKeys ? command.text : null

  return (
    <SettingsCard
      icon={Bot}
      title="Agent skills"
      hint="VibeLink writes one folder per skill under <agent home>/skills/ — vibelink-memory and vibelink-browser — and never edits an agent's own config file."
      status={<SettingsIconButton icon={RefreshCw} label="Re-check skill status" disabled={busy} onClick={() => void run(fetchAgentSkillStatus)} />}
    >
      <p className="vl-set-card-note">
        Install these and Claude Code, Codex, omp and your other agents can search and record this workspace&apos;s memory,
        and drive your real browser, on their own. VibeLink only drops the skill files into each agent&apos;s own skills
        folder — it never edits their config.
      </p>

      {(status?.skills ?? []).map((skill) => {
        const copy = skillCopy[skill]
        const state: AgentSkillState = targets.some((target) =>
          target.skills.some((targetSkill) => targetSkill.name === skill && targetSkill.state === 'stale'))
          ? 'stale'
          : targets.some((target) =>
              target.skills.some((targetSkill) => targetSkill.name === skill && targetSkill.state === 'installed'))
            ? 'installed'
            : targets.length > 0 && targets.every((target) =>
                target.skills.some((targetSkill) => targetSkill.name === skill && targetSkill.state === 'agentAbsent'))
              ? 'agentAbsent'
              : 'missing'
        const badge = stateBadges[state]
        return (
          <SettingsRow
            key={skill}
            icon={copy?.icon ?? Bot}
            label={copy?.label ?? skill}
            sub={copy?.sub ?? `Bundled skill ${skill}.`}
            control={<SettingsPill tone={badge.tone} icon={badge.icon}>{badge.label}</SettingsPill>}
          />
        )
      })}

      <SettingsRow
        icon={Bot}
        label="Installed on this machine"
        sub={summary}
        control={installed.length > 0
          ? <SettingsPill tone="ok" icon={CircleCheck}>{`${installed.length} of ${targets.length}`}</SettingsPill>
          : <SettingsPill icon={CircleX}>None</SettingsPill>}
      />

      {/* Nothing is written to the user's home until this button is pressed —
          which is why the promise is stated right next to it. */}
      {status && installed.length === 0 ? (
        <div className="vl-set-message vl-set-message-action" data-tone="ok" role="status">
          <Download size={13} strokeWidth={1.9} aria-hidden="true" />
          <span>
            VibeLink has not written anything to your home folder. Installing drops the skill files into the skills folder of
            each of the {installable.length} {installable.length === 1 ? 'agent' : 'agents'} found here.
          </span>
          <SettingsButton
            icon={Download}
            tone="accent"
            label={installable.length === 1 ? 'Install for 1 agent' : `Install for ${installable.length} agents`}
            title="Write the skill files into every agent skills folder found on this machine"
            disabled={busy || installable.length === 0}
            onClick={() => void run(() => installAgentSkill(installable.map((target) => target.id)))}
          />
        </div>
      ) : null}

      {status && partialTargets.length > 0 ? (
        <div className="vl-set-message vl-set-message-action" data-tone="ok" role="status">
          <Download size={13} strokeWidth={1.9} aria-hidden="true" />
          <span>
            One or more newly bundled skills are ready for agents that already have another VibeLink skill. Auto-update will not install them.
          </span>
          <SettingsButton
            icon={Download}
            tone="accent"
            label="Install missing skills"
            title="Explicitly install the missing bundled skills"
            disabled={busy}
            onClick={() => void run(() => installAgentSkill(partialTargets.map((target) => target.id)))}
          />
        </div>
      ) : null}

      <SettingsRow
        icon={RefreshCw}
        label="Keep the installed skill up to date"
        sub="Refreshes each skill already installed. New skills and agent homes require an explicit install."
        control={(
          <SettingsSwitch
            label="Keep the installed skill up to date"
            checked={autoUpdate}
            disabled={busy}
            onChange={(next) => {
              updateSettings({ autoUpdateAgentSkill: next })
              // Switching on should not wait for the next launch to mean anything.
              if (next) void run(refreshAgentSkill)
            }}
          />
        )}
      />

      {/* With auto-update on, launch already refreshed every installed copy, so
          a stale revision is not the user's problem to act on. */}
      {status && !autoUpdate && staleTargets.length > 0 ? (
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
        const present = target.skills.some((skill) => isSkillPresent(skill.state))
        const missing = target.skills.some((skill) => skill.state === 'missing')
        const stale = target.skills.some((skill) => skill.state === 'stale')
        const badge = present && missing
          ? { label: 'Needs install', tone: 'warn' as const, icon: Download }
          : stateBadges[target.state]
        const installAction = missing || stale || !present
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
            {installAction ? (
              <SettingsButton
                icon={stale && !missing ? RefreshCw : Download}
                label={stale && !missing ? 'Update' : 'Install'}
                title={`Write the bundled skills into ${target.path}`}
                disabled={busy}
                onClick={() => void run(() => installAgentSkill([target.id]))}
              />
            ) : (
              <SettingsButton
                icon={Trash2}
                tone="danger"
                label="Remove"
                title={`Delete the skill from ${target.path}`}
                disabled={busy}
                onClick={() => void run(() => uninstallAgentSkill([target.id]))}
              />
            )}
          </div>
        )
      })}

      <button
        type="button"
        className="vl-set-disclosure"
        aria-expanded={cliOpen}
        onClick={() => setCliOpen((open) => !open)}
      >
        <ChevronRight size={13} strokeWidth={2} aria-hidden="true" />
        <span>{cliOpen ? 'Hide command for other agents' : 'Command for other agents'}</span>
      </button>

      {cliOpen ? (
        <>
          <p className="vl-set-card-note">
            For agents VibeLink cannot write to directly, pick them here and run the copied command once in a terminal. It
            uses the standard <span className="mono">skills</span> CLI and installs only for the agents you tick.
          </p>

          <AgentKeyPicker keys={featuredAgentKeys} selected={selectedKeys} onToggle={toggleKey} />

          <button
            type="button"
            className="vl-set-disclosure"
            aria-expanded={allKeysOpen}
            onClick={() => setAllKeysOpen((open) => !open)}
          >
            <ChevronRight size={13} strokeWidth={2} aria-hidden="true" />
            <span>{allKeysOpen ? 'Hide the other agents' : `Show ${otherAgentKeys.length} more agents`}</span>
          </button>

          {allKeysOpen ? (
            <AgentKeyPicker keys={otherAgentKeys} selected={selectedKeys} onToggle={toggleKey} />
          ) : null}

          {selectedKeys.length === 0 ? (
            <SettingsMessage icon={Info}>
              Pick at least one agent. A command without an explicit agent lets the CLI guess, and it scatters config folders
              through your home directory for agents you never installed.
            </SettingsMessage>
          ) : cliError ? (
            <SettingsMessage tone="danger" icon={TriangleAlert}>{cliError}</SettingsMessage>
          ) : shownCommand ? (
            <div className="vl-set-message vl-set-message-action" data-tone="ok">
              <Terminal size={13} strokeWidth={1.9} aria-hidden="true" />
              <code>{shownCommand}</code>
              <SettingsButton
                icon={ClipboardCopy}
                label={copied ? 'Copied' : 'Copy'}
                title="Copy the install command"
                onClick={() => { void writeClipboardText(shownCommand); setCopied(true) }}
              />
            </div>
          ) : null}
        </>
      ) : null}

      {error ? <SettingsMessage tone="danger" icon={TriangleAlert}>{error}</SettingsMessage> : null}
    </SettingsCard>
  )
}

function AgentKeyPicker({ keys, selected, onToggle }: { keys: string[]; selected: string[]; onToggle: (key: string) => void }) {
  return (
    <div className="vl-set-keys">
      {keys.map((key) => (
        <label key={key}>
          <input type="checkbox" checked={selected.includes(key)} onChange={() => onToggle(key)} />
          <span className="mono">{key}</span>
        </label>
      ))}
    </div>
  )
}
