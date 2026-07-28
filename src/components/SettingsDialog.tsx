import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ALargeSmall,
  Archive,
  ArrowUpDown,
  Baseline,
  Bell,
  Blocks,
  Bot,
  Box,
  Braces,
  Camera,
  Check,
  ChevronRight,
  CircleCheck,
  CircleUser,
  CircleX,
  Clapperboard,
  Contrast,
  Cpu,
  Database,
  Eye,
  FileCode2,
  Film,
  FolderCog,
  FolderOpen,
  GitBranch,
  Hash,
  HardDrive,
  Highlighter,
  Info,
  Keyboard,
  KeyRound,
  Layers,
  LayoutGrid,
  LogIn,
  MessageSquare,
  Mic,
  MonitorCog,
  MousePointer,
  Package,
  Palette,
  PanelsTopLeft,
  PanelTop,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Rows3,
  Save,
  Scaling,
  ScrollText,
  Search,
  Send,
  Server,
  Settings2,
  Shield,
  Sparkles,
  SquareTerminal,
  StickyNote,
  Tag,
  Terminal,
  Trash2,
  TriangleAlert,
  Type,
  Upload,
  Users,
  Volume2,
  Wrench,
  X,
} from 'lucide-react'
import { LicenseSettings } from './LicenseSettings'
import { RemoteSettings } from './RemoteSettings'
import { ProfileIcon } from './ProfileIcon'
import { defaultKeybindings, eventToKeyChord, keybindingDefinitions, type KeybindingActionId } from '../state/keybindings'
import { normalizeFontChoices, terminalFontStack } from '../state/fonts'
import { canDeleteProfile, createProfile, joinCommandLine, splitCommandLine, type ChatImageAttachmentMode, type ChatPersonality, type GitStatusPresentation, type Profile, type ProfileKind, type Settings } from '../state/profiles'
import { profileIconNames, profileIcons } from '../state/profileIcons'
import { terminalThemeDefinitionById, terminalThemeGroups, type TerminalThemeId } from '../state/terminalThemes'
import { applyThemeToDocument } from '../state/themePreview'
import { TerminalManager } from '../terminal/TerminalManager'
import { ThemePicker } from './ThemePicker'
import { FontPicker } from './FontPicker'
import { useWorkspaceStore } from '../state/store'
import type { HermesRuntimeStatus, HermesWorkspaceState, WorktreeStorage, WorktreeStorageOptions, WorktreeStorageResolution } from '../ipc/types'
import { runMcpSelfCheck, type McpCheckReport } from '../ipc/mcp'
import { HermesInstallGuidance } from './HermesInstallGuidance'
import { GitHostingSettings } from './GitHostingSettings'
import { ProviderIntegrationsPanel } from './ProviderIntegrationsPanel'
import { AndroidDeviceLabPanel } from './AndroidDeviceLabPanel'
import { addCustomCompletionSound, builtInCompletionSounds, defaultCompletionSoundId, listCustomCompletionSounds, playCompletionSound, removeCustomCompletionSound, type CompletionSoundId, type CustomCompletionSound } from '../notifications/completionSounds'
import { agentHookStatus, setAgentHookEnabled, type AgentHookStatus } from '../ipc/agentHooks'
import { agentStatusLabel } from '../ipc/agents'
import {
  SettingsButton,
  SettingsCard,
  SettingsIconButton,
  SettingsMessage,
  SettingsNumber,
  SettingsPill,
  SettingsRow,
  SettingsSegmented,
  SettingsSelect,
  SettingsSwitch,
  SettingsText,
  SettingsValue,
  type SettingsIcon,
} from './settings/controls'
import { agentIconName } from './settings/agentBrand'
import { filterSettingsSections, settingsSectionById, type SettingsSectionId } from './settings/sections'

type SettingsDialogProps = {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onClose: () => void
  onRunSetupWizard: () => void
}

type WorktreeStorageChoice = 'sameDrive' | 'specificDrive' | 'appData' | 'custom'

const fontWeightOptions = [100, 200, 300, 400, 500, 600, 700, 800, 900]
/** Hermes owns this section, so its card wears the real Hermes mark. */
const hermesBrandIcon = profileIcons.hermes as SettingsIcon


const profileKindLabels: Record<ProfileKind, string> = {
  local: 'Local',
  ssh: 'SSH',
  command: 'Command',
}

export function SettingsDialog({ settings, onChange, onClose, onRunSetupWizard }: SettingsDialogProps) {
  const [draft, setDraft] = useState(settings)
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('account')
  const [search, setSearch] = useState('')
  const [installedFonts, setInstalledFonts] = useState<string[]>([])
  const [defaultCaptureDir, setDefaultCaptureDir] = useState('')
  const [workspaceState, setWorkspaceState] = useState<HermesWorkspaceState | null>(null)
  const [runtime, setRuntime] = useState<HermesRuntimeStatus | null>(null)
  const [authList, setAuthList] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [ffmpegStatus, setFfmpegStatus] = useState('')
  const [terminalMessage, setTerminalMessage] = useState('')
  const [mcpCheckBusy, setMcpCheckBusy] = useState(false)
  const [mcpCheck, setMcpCheck] = useState<McpCheckReport | null>(null)
  const [rolePresetDraft, setRolePresetDraft] = useState('')
  const [expandedProfileId, setExpandedProfileId] = useState<string | null>(null)
  const [isThemePickerOpen, setThemePickerOpen] = useState(false)
  const [isFontPickerOpen, setFontPickerOpen] = useState(false)
  const [customCompletionSounds, setCustomCompletionSounds] = useState<CustomCompletionSound[]>([])
  const [completionSoundMessage, setCompletionSoundMessage] = useState('')
  const completionSoundInputRef = useRef<HTMLInputElement | null>(null)
  const [agentHooks, setAgentHooks] = useState<AgentHookStatus[]>([])
  const [agentHookMessage, setAgentHookMessage] = useState('')
  const [agentBusy, setAgentBusy] = useState(false)
  const [worktreeStorageOptions, setWorktreeStorageOptions] = useState<WorktreeStorageOptions>({ drives: [], appDataRoot: '' })
  const [worktreeResolution, setWorktreeResolution] = useState<WorktreeStorageResolution | null>(null)
  const [worktreeResolutionError, setWorktreeResolutionError] = useState('')
  const worktreeResolutionRequestRef = useRef(0)
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const sessions = useWorkspaceStore((state) => state.sessions)
  const spawnPane = useWorkspaceStore((state) => state.spawnPane)
  const agentClis = useWorkspaceStore((state) => state.agentClis)
  const refreshAgentClis = useWorkspaceStore((state) => state.refreshAgentClis)
  const activeSession = activeSessionId ? sessions.find((session) => session.id === activeSessionId) : undefined
  const activeWorkspaceFolder = activeSession?.workspaceFolder?.trim() ?? ''
  const worktreeStorageChoice: WorktreeStorageChoice = draft.worktreeStorage.mode === 'drive'
    ? draft.worktreeStorage.drive ? 'specificDrive' : 'sameDrive'
    : draft.worktreeStorage.mode
  const worktreeDriveOptions = [...new Set([draft.worktreeStorage.drive, ...worktreeStorageOptions.drives].filter(Boolean))]
  const checkMcp = async () => {
    if (!activeSessionId) return
    setMcpCheckBusy(true)
    setMcpCheck(null)
    try {
      setMcpCheck(await runMcpSelfCheck(activeSessionId))
    } catch (error) {
      setMcpCheck({ spawnOk: false, initializeOk: false, toolCount: 0, error: String(error) })
    } finally {
      setMcpCheckBusy(false)
    }
  }
  const addRolePreset = () => {
    const role = rolePresetDraft.trim()
    if (!role || draft.rolePresets.some((existing) => existing.toLowerCase() === role.toLowerCase())) return
    patchDraft({ rolePresets: [...draft.rolePresets, role] })
    setRolePresetDraft('')
  }
  const fontChoices = useMemo(() => normalizeFontChoices(installedFonts, draft.fontFamily), [draft.fontFamily, installedFonts])
  const selectedTheme = terminalThemeDefinitionById(draft.terminalThemeId)
  const navGroups = useMemo(() => filterSettingsSections(search), [search])
  const section = settingsSectionById(activeSection)
  const SectionIcon = section.icon
  /** Hook rows and CLI rows describe the same agents; merge them into one list. */
  const agentRows = useMemo(() => {
    const cliById = new Map(agentClis.map((cli) => [cli.id.toLowerCase(), cli]))
    const rows: { id: string; displayName: string; cli?: typeof agentClis[number]; hook?: AgentHookStatus }[] = agentHooks.map((hook) => ({
      id: hook.id,
      displayName: hook.displayName,
      cli: cliById.get(hook.id.toLowerCase()),
      hook,
    }))
    const hookedIds = new Set(agentHooks.map((hook) => hook.id.toLowerCase()))
    for (const cli of agentClis) {
      if (!hookedIds.has(cli.id.toLowerCase())) rows.push({ id: cli.id, displayName: cli.displayName, cli, hook: undefined })
    }
    return rows
  }, [agentClis, agentHooks])

  useEffect(() => {
    let cancelled = false
    void invoke<string[]>('list_installed_fonts')
      .then((fonts) => { if (!cancelled) setInstalledFonts(fonts) })
      .catch(() => { if (!cancelled) setInstalledFonts([]) })
    void invoke<string>('default_capture_dir')
      .then((dir) => { if (!cancelled) setDefaultCaptureDir(dir) })
      .catch(() => { if (!cancelled) setDefaultCaptureDir('') })
    void invoke<WorktreeStorageOptions>('git_worktree_storage_options')
      .then((options) => { if (!cancelled) setWorktreeStorageOptions(options) })
      .catch(() => { if (!cancelled) setWorktreeStorageOptions({ drives: [], appDataRoot: '' }) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    void invoke<HermesRuntimeStatus>('hermes_runtime_status', { commandOverride: draft.hermesCommand || null })
      .then((next) => { if (!cancelled) setRuntime(next) })
      .catch(() => { if (!cancelled) setRuntime({ detected: false, command: null, cliCommand: null, version: null, home: null, source: null, configuredModel: null }) })
    if (activeSessionId) {
      void invoke<HermesWorkspaceState>('hermes_workspace_state', { sessionId: activeSessionId, workspaceFolder: activeSession?.workspaceFolder ?? null })
        .then((state) => { if (!cancelled) setWorkspaceState(state) })
        .catch(() => { if (!cancelled) setWorkspaceState(null) })
    }
    return () => { cancelled = true }
  }, [activeSection, activeSession?.workspaceFolder, activeSessionId, draft.hermesCommand])

  useEffect(() => {
    if (activeSection !== 'notifications') return
    let cancelled = false
    void listCustomCompletionSounds()
      .then((sounds) => { if (!cancelled) setCustomCompletionSounds(sounds) })
      .catch((error) => { if (!cancelled) setCompletionSoundMessage(String(error)) })
    return () => { cancelled = true }
  }, [activeSection])

  // Hook state is on-disk truth about files the user owns, so it is re-read
  // whenever the Agents page is opened rather than cached for the dialog run.
  useEffect(() => {
    if (activeSection !== 'agents') return
    let cancelled = false
    void agentHookStatus()
      .then((hooks) => { if (!cancelled) setAgentHooks(hooks) })
      .catch((error) => { if (!cancelled) setAgentHookMessage(String(error)) })
    return () => { cancelled = true }
  }, [activeSection])

  useEffect(() => {
    const requestId = ++worktreeResolutionRequestRef.current
    if (activeSection !== 'worktrees' || !activeWorkspaceFolder) return
    const timer = window.setTimeout(() => {
      if (worktreeResolutionRequestRef.current !== requestId) return
      void invoke<WorktreeStorageResolution>('git_worktree_resolve_root', {
        workspaceFolder: activeWorkspaceFolder,
        storage: draft.worktreeStorage,
        name: 'example',
      })
        .then((resolution) => {
          if (worktreeResolutionRequestRef.current !== requestId) return
          setWorktreeResolution(resolution)
          setWorktreeResolutionError('')
        })
        .catch((error) => {
          if (worktreeResolutionRequestRef.current !== requestId) return
          setWorktreeResolution(null)
          setWorktreeResolutionError(String(error))
        })
    }, 150)
    return () => {
      window.clearTimeout(timer)
      if (worktreeResolutionRequestRef.current === requestId) worktreeResolutionRequestRef.current += 1
    }
  }, [activeSection, activeWorkspaceFolder, draft.worktreeStorage])

  const patchDraft = (patch: Partial<Settings>) => setDraft((current) => ({ ...current, ...patch }))
  const patchWorktreeStorage = (patch: Partial<WorktreeStorage>) => patchDraft({ worktreeStorage: { ...draft.worktreeStorage, ...patch } })
  const previewHighlightColors = (patch: Partial<Pick<Settings, 'selectedPaneHighlightColor' | 'alarmHighlightColor' | 'reviewedPaneHighlightColor'>>) => {
    const selectedPaneHighlightColor = patch.selectedPaneHighlightColor ?? draft.selectedPaneHighlightColor
    const alarmHighlightColor = patch.alarmHighlightColor ?? draft.alarmHighlightColor
    const reviewedPaneHighlightColor = patch.reviewedPaneHighlightColor ?? draft.reviewedPaneHighlightColor
    patchDraft(patch)
    applyThemeToDocument(draft.terminalThemeId, selectedPaneHighlightColor, alarmHighlightColor, reviewedPaneHighlightColor)
  }
  const updateKeybinding = (id: KeybindingActionId, chord: string) => patchDraft({ keybindings: { ...draft.keybindings, [id]: chord } })
  const updateProfile = (profileId: string, patch: Partial<Profile>) => {
    setDraft((current) => ({
      ...current,
      profiles: current.profiles.map((profile) => profile.id === profileId ? { ...profile, ...patch } : profile),
    }))
  }
  const addProfile = () => {
    const profile = createProfile(draft)
    patchDraft({ profiles: [...draft.profiles, profile] })
    setExpandedProfileId(profile.id)
  }
  const deleteProfile = (profileId: string) => {
    setDraft((current) => {
      if (!canDeleteProfile(current, profileId)) return current
      const profiles = current.profiles.filter((profile) => profile.id !== profileId)
      const workspaceProfileIds = Object.fromEntries(Object.entries(current.workspaceProfileIds).filter(([, boundProfileId]) => boundProfileId !== profileId))
      return {
        ...current,
        profiles,
        defaultProfileId: current.defaultProfileId === profileId ? profiles[0].id : current.defaultProfileId,
        workspaceProfileIds,
      }
    })
    setExpandedProfileId((current) => current === profileId ? null : current)
  }
  const changeProfileType = (profile: Profile, type: ProfileKind) => {
    if (profile.type === type) return
    const defaults = createProfile({ ...draft, profiles: draft.profiles.filter((candidate) => candidate.id !== profile.id) }, { type, id: profile.id, name: profile.name })
    const patch: Partial<Profile> = { type }
    if (type === 'local') {
      patch.shell = profile.shell ?? defaults.shell
      patch.args = profile.args.length > 0 ? profile.args : defaults.args
    } else if (type === 'command') {
      patch.command = profile.command.trim().length > 0 ? profile.command : defaults.command
    } else {
      patch.shell = null
      patch.args = []
      if (profile.icon === 'terminal') patch.icon = defaults.icon
    }
    updateProfile(profile.id, patch)
  }
  const updateSshPort = (profileId: string, value: string) => {
    if (value.trim().length === 0) {
      updateProfile(profileId, { sshPort: null })
      return
    }
    const port = Number(value)
    updateProfile(profileId, { sshPort: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null })
  }
  const refreshAuthList = async () => {
    if (!activeSessionId) return
    setAuthBusy(true)
    try {
      const output = await invoke<string>('hermes_auth_list', { sessionId: activeSessionId, commandOverride: draft.hermesCommand || null })
      setAuthList(output)
    } catch (error) {
      setAuthList(String(error))
    } finally {
      setAuthBusy(false)
    }
  }
  const refreshHermesState = async () => {
    setTerminalMessage('')
    try {
      const status = await invoke<HermesRuntimeStatus>('hermes_runtime_status', { commandOverride: draft.hermesCommand || null })
      setRuntime(status)
      if (activeSessionId) {
        const state = await invoke<HermesWorkspaceState>('hermes_workspace_state', { sessionId: activeSessionId, workspaceFolder: activeSession?.workspaceFolder ?? null })
        setWorkspaceState(state)
      }
    } catch (error) {
      setTerminalMessage(String(error))
    }
  }
  const openHermesTerminal = async (mode: 'model' | 'custom-provider' | 'auth' | 'status') => {
    if (!activeSessionId) return
    setTerminalMessage('Opening Hermes CLI terminal...')
    try {
      const hermesCommand = await invoke<string>('hermes_cli_command', { commandOverride: draft.hermesCommand || null })
      const intro = mode === 'custom-provider'
        ? 'Custom provider setup is owned by Hermes. Use the model setup flow and choose or add the custom provider there.'
        : mode === 'model'
          ? 'Use Hermes model setup to select provider, model, and provider-specific options.'
          : mode === 'auth'
            ? 'Use Hermes auth for provider login and credential refresh.'
            : 'Use Hermes status commands for the global installation.'
      const action = mode === 'auth'
        ? `& ${quotePowerShellString(hermesCommand)} auth`
        : mode === 'status'
          ? `& ${quotePowerShellString(hermesCommand)} status`
          : `& ${quotePowerShellString(hermesCommand)} model`
      const script = [`Write-Host ${quotePowerShellString(intro)}`, action].join('; ')
      await spawnPane(activeSessionId, {
        shell: 'pwsh.exe',
        args: ['-NoLogo', '-NoExit', '-Command', script],
        cwd: activeSession?.workspaceFolder ?? null,
        title: mode === 'auth' ? 'Hermes auth CLI' : mode === 'status' ? 'Hermes status CLI' : 'Hermes model setup',
        icon: 'hermes',
      })
      setTerminalMessage('Hermes CLI terminal opened.')
    } catch (error) {
      setTerminalMessage(String(error))
    }
  }
  const openHermesGateway = async (action: 'setup' | 'status' | 'run') => {
    if (!activeSessionId || !runtime?.detected) return
    setTerminalMessage('Opening Hermes gateway terminal...')
    try {
      const hermesCommand = await invoke<string>('hermes_cli_command', { commandOverride: draft.hermesCommand || null })
      await spawnPane(activeSessionId, {
        shell: 'pwsh.exe',
        args: ['-NoLogo', '-NoExit', '-Command', `& ${quotePowerShellString(hermesCommand)} gateway ${action}`],
        cwd: activeSession?.workspaceFolder ?? null,
        title: `Hermes gateway ${action}`,
        icon: 'hermes',
      })
      setTerminalMessage('Hermes gateway terminal opened.')
    } catch (error) {
      setTerminalMessage(String(error))
    }
  }
  /** Runs the agent's own login command in a real pane; VibeLink never stores agent credentials. */
  const openAgentLogin = async (agentId: string, displayName: string, loginHint: string) => {
    if (!activeSessionId) return
    setAgentBusy(true)
    setAgentHookMessage('')
    try {
      await spawnPane(activeSessionId, {
        shell: 'pwsh.exe',
        args: ['-NoLogo', '-NoExit', '-Command', `${loginHint}; Write-Host 'Return to VibeLink and refresh when login is complete.'`],
        cwd: activeSession?.workspaceFolder ?? null,
        title: `${displayName} login`,
        icon: agentIconName(agentId),
      })
    } catch (error) {
      setAgentHookMessage(String(error))
    } finally {
      setAgentBusy(false)
    }
  }
  const browseCaptureDir = async () => {
    const selected = await open({ directory: true, multiple: false, title: 'Select capture folder' })
    if (typeof selected === 'string') patchDraft({ captureDir: selected })
  }
  const browseWorktreeRoot = async () => {
    const selected = await open({ directory: true, multiple: false, title: 'Select worktree folder' })
    if (typeof selected === 'string') patchWorktreeStorage({ customRoot: selected })
  }
  const previewCompletionSound = async (soundId: CompletionSoundId = draft.completionSoundId) => {
    setCompletionSoundMessage('')
    try {
      const played = await playCompletionSound({
        completionSoundEnabled: true,
        completionSoundId: soundId,
        completionSoundVolume: draft.completionSoundVolume,
      })
      setCompletionSoundMessage(played ? 'Sound preview played.' : 'This sound is unavailable.')
    } catch (error) {
      setCompletionSoundMessage(String(error))
    }
  }
  const setAgentHook = async (agentId: string, enabled: boolean) => {
    setAgentHookMessage('')
    try {
      const next = await setAgentHookEnabled(agentId, enabled)
      setAgentHooks((current) => current.map((hook) => hook.id === next.id ? next : hook))
      setAgentHookMessage(
        next.installed
          ? `${next.displayName} will now report completions to VibeLink.`
          : `${next.displayName} hook removed. Nothing was left behind.`,
      )
    } catch (error) {
      setAgentHookMessage(String(error))
      // The install/uninstall failed, so the on-screen toggle would otherwise
      // lie about the real on-disk state. Re-read it.
      void agentHookStatus().then(setAgentHooks).catch(() => {})
    }
  }
  const importCompletionSound = async (file: File) => {
    setCompletionSoundMessage('Adding sound...')
    try {
      const sound = await addCustomCompletionSound(file)
      setCustomCompletionSounds((current) => [...current.filter((entry) => entry.id !== sound.id), sound])
      patchDraft({ completionSoundId: sound.id })
      setCompletionSoundMessage(`${sound.name} added and selected.`)
    } catch (error) {
      setCompletionSoundMessage(String(error))
    }
  }
  const deleteCompletionSound = async (sound: CustomCompletionSound) => {
    setCompletionSoundMessage('')
    try {
      await removeCustomCompletionSound(sound.id)
      setCustomCompletionSounds((current) => current.filter((entry) => entry.id !== sound.id))
      if (draft.completionSoundId === sound.id) patchDraft({ completionSoundId: defaultCompletionSoundId })
      setCompletionSoundMessage(`${sound.name} removed.`)
    } catch (error) {
      setCompletionSoundMessage(String(error))
    }
  }
  const testFfmpeg = async () => {
    setFfmpegStatus('Checking...')
    try {
      await invoke('check_ffmpeg', { ffmpegPath: draft.captureFfmpegPath })
      setFfmpegStatus('OK')
    } catch (error) {
      setFfmpegStatus(String(error))
    }
  }
  const apply = () => onChange(draft)
  const ok = () => {
    onChange(draft)
    onClose()
  }

  // Theme and highlight changes preview live on the whole app but only commit
  // on Apply/OK; closing without committing restores the saved palette.
  const previewTheme = (themeId: TerminalThemeId) => {
    applyThemeToDocument(themeId, draft.selectedPaneHighlightColor, draft.alarmHighlightColor, draft.reviewedPaneHighlightColor)
    TerminalManager.previewTheme(themeId)
  }
  const closeSettings = () => {
    applyThemeToDocument(settings.terminalThemeId, settings.selectedPaneHighlightColor, settings.alarmHighlightColor, settings.reviewedPaneHighlightColor)
    TerminalManager.previewTheme(null)
    TerminalManager.previewFont(null)
    onClose()
  }
  const openThemePicker = () => {
    previewTheme(draft.terminalThemeId)
    setThemePickerOpen(true)
  }
  const openFontPicker = () => {
    TerminalManager.previewFont(draft.fontFamily)
    setFontPickerOpen(true)
  }

  return (
    <div className={`settings-backdrop vibelink-settings-backdrop${isThemePickerOpen || isFontPickerOpen ? ' vibelink-settings-backdrop-hidden' : ''}`} role="presentation" onMouseDown={closeSettings}>
      <section className="settings-dialog vl-set-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <aside className="vl-set-nav">
          <div className="vl-set-search">
            <Search size={13} strokeWidth={1.9} aria-hidden="true" />
            <input aria-label="Search settings" value={search} placeholder="Search settings" onChange={(event) => setSearch(event.target.value)} />
          </div>
          <div className="vl-set-nav-scroll">
            {navGroups.length === 0 ? <p className="vl-set-nav-empty">No matching settings.</p> : null}
            {navGroups.map((group) => (
              <nav key={group.id} className="vl-set-nav-group" aria-label={group.label}>
                <h3>{group.label}</h3>
                {group.sections.map((entry) => {
                  const Icon = entry.icon
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      className="vl-set-nav-item"
                      aria-current={activeSection === entry.id}
                      onClick={() => setActiveSection(entry.id)}
                    >
                      <Icon size={14} strokeWidth={1.9} aria-hidden="true" />
                      <span>{entry.label}</span>
                    </button>
                  )
                })}
              </nav>
            ))}
          </div>
        </aside>

        <main className="vl-set-main">
          <header className="vl-set-header">
            <SectionIcon size={16} strokeWidth={1.9} aria-hidden="true" />
            <h2 id="settings-title">{section.label}</h2>
            <button type="button" className="vl-set-icon-button" title="Close settings" aria-label="Close settings" onClick={closeSettings}>
              <X size={15} strokeWidth={1.9} aria-hidden="true" />
            </button>
          </header>

          <div className="vl-set-body">
            {activeSection === 'account' ? <LicenseSettings /> : null}

            {activeSection === 'agents' ? (
              <>
                <SettingsCard
                  icon={Sparkles}
                  title="AI coding agents"
                  hint="17 completion integrations use each agent's native hook or extension API. VibeLink preserves user-owned config and removes only its own entries."
                  status={<SettingsIconButton icon={RefreshCw} label="Re-check installed agents" disabled={agentBusy} onClick={() => { setAgentBusy(true); void Promise.all([refreshAgentClis(), agentHookStatus().then(setAgentHooks)]).catch((error) => setAgentHookMessage(String(error))).finally(() => setAgentBusy(false)) }} />}
                >
                  {agentRows.length === 0 ? (
                    <SettingsMessage icon={Info}>Reading agent status…</SettingsMessage>
                  ) : agentRows.map((agent) => (
                    <div key={agent.id} className="vl-set-agent" data-installed={agent.cli ? String(agent.cli.installed) : 'true'}>
                      <span className="vl-set-agent-icon">
                        <ProfileIcon name={agentIconName(agent.id)} size={20} />
                      </span>
                      <span className="vl-set-agent-name">
                        <strong>{agent.displayName}</strong>
                        <span title={agent.hook?.blockedReason ?? agent.hook?.configPath ?? undefined}>
                          {agent.cli ? agentStatusLabel(agent.cli) : 'Completion hook only'}
                        </span>
                      </span>
                      {!agent.cli ? (
                        <SettingsPill icon={Sparkles}>Hook available</SettingsPill>
                      ) : !agent.cli.installed ? (
                        <SettingsPill icon={CircleX}>Not found</SettingsPill>
                      ) : agent.cli.auth !== 'loggedIn' ? (
                        <SettingsButton icon={LogIn} label="Log in" title={`Run ${agent.cli.loginHint} in a terminal`} disabled={agentBusy || !activeSessionId} onClick={() => void openAgentLogin(agent.id, agent.displayName, agent.cli?.loginHint ?? agent.id)} />
                      ) : (
                        <SettingsPill tone="ok" icon={CircleCheck}>Ready</SettingsPill>
                      )}
                      {agent.hook ? (
                        <SettingsSwitch
                          label={`${agent.displayName} completion hook`}
                          checked={agent.hook.installed}
                          disabled={Boolean(agent.hook.blockedReason)}
                          onChange={(checked) => void setAgentHook(agent.id, checked)}
                        />
                      ) : <span />}
                    </div>
                  ))}
                  {agentHookMessage ? <SettingsMessage icon={Info}>{agentHookMessage}</SettingsMessage> : null}
                </SettingsCard>
                <SettingsCard icon={Bell} title="Completion detection" hint="Hooks are exact and work even when you start an agent by typing its name in a plain shell. Terminal-output detection is the fallback.">
                  <SettingsRow icon={Volume2} label="Completion sound" control={<SettingsSwitch label="Completion sound" checked={draft.completionSoundEnabled} onChange={(checked) => patchDraft({ completionSoundEnabled: checked })} />} />
                  <SettingsRow icon={Bell} label="More sound options" control={<SettingsButton icon={ChevronRight} label="Notifications" onClick={() => setActiveSection('notifications')} />} />
                </SettingsCard>
              </>
            ) : null}

            {activeSection === 'model' ? (
              <>
                <SettingsCard
                  icon={hermesBrandIcon}
                  title="Hermes runtime"
                  hint="Hermes owns provider, login, and model configuration. VibeLink reads the global installation without modifying it."
                  status={runtime?.detected ? <SettingsPill tone="ok" icon={CircleCheck}>Detected</SettingsPill> : <SettingsPill tone="warn" icon={TriangleAlert}>Missing</SettingsPill>}
                >
                  <SettingsRow icon={Package} label="Version" control={<SettingsValue value={runtime?.version ?? 'Not detected'} />} />
                  <SettingsRow icon={Terminal} label="Command" control={<SettingsValue mono value={runtime?.command ?? 'Not detected'} />} />
                  <SettingsRow icon={FolderCog} label="HERMES_HOME" control={<SettingsValue mono value={runtime?.home ?? workspaceState?.home ?? 'Not resolved'} />} />
                  <SettingsRow icon={Wrench} label="Command override" hint="Point VibeLink at a specific hermes-acp binary." stacked control={<SettingsText label="hermes-acp override" value={draft.hermesCommand} placeholder="hermes-acp" onChange={(value) => patchDraft({ hermesCommand: value })} />} />
                  <HermesInstallGuidance
                    runtime={runtime}
                    commandOverride={draft.hermesCommand || null}
                    sessionId={activeSessionId}
                    workspaceFolder={activeSession?.workspaceFolder ?? null}
                    onStatus={setRuntime}
                  />
                </SettingsCard>
                <SettingsCard icon={Cpu} title="Model" status={<SettingsIconButton icon={RefreshCw} label="Refresh model status" onClick={() => void refreshHermesState()} />}>
                  <SettingsRow icon={Server} label="Provider" control={<SettingsValue value={workspaceState?.model?.provider || runtime?.configuredModel?.provider || 'Hermes default'} />} />
                  <SettingsRow icon={Bot} label="Model" control={<SettingsValue value={workspaceState?.model?.model ?? runtime?.configuredModel?.model ?? 'Not configured'} />} />
                  <SettingsRow icon={Braces} label="Base URL" control={<SettingsValue mono value={workspaceState?.model?.baseUrl || runtime?.configuredModel?.baseUrl || 'Provider default'} />} />
                  <div className="vl-set-actions vl-set-actions-bordered">
                    <SettingsButton icon={Settings2} label="Configure" title="Open Hermes model setup in a terminal" disabled={!activeSessionId || !runtime?.detected} onClick={() => void openHermesTerminal('model')} />
                    <SettingsButton icon={Server} label="Custom provider" disabled={!activeSessionId || !runtime?.detected} onClick={() => void openHermesTerminal('custom-provider')} />
                    <SettingsButton icon={KeyRound} label="Login" disabled={!activeSessionId || !runtime?.detected} onClick={() => void openHermesTerminal('auth')} />
                    <SettingsButton icon={Terminal} label="Status CLI" disabled={!activeSessionId || !runtime?.detected} onClick={() => void openHermesTerminal('status')} />
                  </div>
                  {terminalMessage ? <SettingsMessage icon={Info}>{terminalMessage}</SettingsMessage> : null}
                </SettingsCard>
              </>
            ) : null}

            {activeSection === 'chat' ? (
              <SettingsCard icon={MessageSquare} title="Agent chat" hint="Applies to new VibeLink Agent chats in this app only.">
                <SettingsRow
                  icon={Type}
                  label="Personality"
                  control={(
                    <SettingsSegmented
                      label="Personality"
                      value={draft.chatPersonality}
                      options={[
                        { value: 'direct', label: 'Direct' },
                        { value: 'balanced', label: 'Balanced' },
                        { value: 'concise', label: 'Concise' },
                        { value: 'exploratory', label: 'Explore' },
                      ]}
                      onChange={(value) => patchDraft({ chatPersonality: value as ChatPersonality })}
                    />
                  )}
                />
                <SettingsRow icon={Eye} label="Show thinking" control={<SettingsSwitch label="Show thinking / reasoning" checked={draft.chatReasoningBlocks} onChange={(checked) => patchDraft({ chatReasoningBlocks: checked })} />} />
                <SettingsRow icon={Wrench} label="Show tool calls" control={<SettingsSwitch label="Show tool calls" checked={draft.chatToolCalls} onChange={(checked) => patchDraft({ chatToolCalls: checked })} />} />
                <SettingsRow icon={Braces} label="Tool call contents" control={<SettingsSwitch label="Show tool call contents" checked={draft.chatToolCallContent} disabled={!draft.chatToolCalls} onChange={(checked) => patchDraft({ chatToolCallContent: checked })} />} />
                <SettingsRow
                  icon={Camera}
                  label="Image attachments"
                  control={(
                    <SettingsSegmented
                      label="Image attachments"
                      value={draft.chatImageAttachments}
                      options={[
                        { value: 'auto', label: 'Auto' },
                        { value: 'always', label: 'Always' },
                        { value: 'never', label: 'Never' },
                      ]}
                      onChange={(value) => patchDraft({ chatImageAttachments: value as ChatImageAttachmentMode })}
                    />
                  )}
                />
                <SettingsRow icon={Hash} label="Timezone" control={<SettingsValue value={Intl.DateTimeFormat().resolvedOptions().timeZone || 'System'} />} />
              </SettingsCard>
            ) : null}

            {activeSection === 'appearance' ? (
              <>
                <SettingsCard
                  icon={Type}
                  title="Font"
                  hint="Font family previews live on terminal panes; size, weight, and scale apply after Apply or OK."
                  status={<SettingsButton icon={Search} label="Browse" title="Browse fonts with live preview" onClick={openFontPicker} />}
                >
                  <SettingsRow
                    icon={Baseline}
                    label="Family"
                    control={(
                      <SettingsSelect
                        label="Font family"
                        value={draft.fontFamily}
                        onChange={(value) => {
                          patchDraft({ fontFamily: value })
                          TerminalManager.previewFont(value)
                        }}
                      >
                        {fontChoices.map((font) => <option key={font} value={font}>{font}</option>)}
                      </SettingsSelect>
                    )}
                  />
                  <SettingsRow icon={ALargeSmall} label="Size" control={<SettingsNumber label="Font size" value={draft.fontSize} min={8} max={32} onChange={(value) => patchDraft({ fontSize: value })} />} />
                  <SettingsRow
                    icon={Contrast}
                    label="Weight"
                    control={(
                      <SettingsSelect label="Font weight" value={String(draft.terminalFontWeight)} onChange={(value) => patchDraft({ terminalFontWeight: Number(value) })}>
                        {fontWeightOptions.map((weight) => <option key={weight} value={weight}>{weight}</option>)}
                      </SettingsSelect>
                    )}
                  />
                  <SettingsRow
                    icon={MousePointer}
                    label="Cursor"
                    control={(
                      <SettingsSegmented
                        label="Cursor style"
                        value={draft.cursorStyle}
                        options={[
                          { value: 'bar', label: 'Bar' },
                          { value: 'block', label: 'Block' },
                          { value: 'underline', label: 'Under' },
                        ]}
                        onChange={(value) => patchDraft({ cursorStyle: value as Settings['cursorStyle'] })}
                      />
                    )}
                  />
                  <SettingsRow icon={Scaling} label="UI scale" control={<SettingsNumber label="UI scale" value={draft.uiScale} min={0.85} max={1.2} step={0.05} onChange={(value) => patchDraft({ uiScale: value })} />} />
                  <div className="vl-set-preview" style={{ fontFamily: terminalFontStack(draft.fontFamily), fontWeight: draft.terminalFontWeight }}>PS E:\repo&gt; VibeLink Agent ready</div>
                </SettingsCard>

                <SettingsCard
                  icon={Palette}
                  title="Theme"
                  hint="One palette drives app chrome, tabs, and terminal colors. Changes preview live and commit on Apply or OK."
                  status={<SettingsButton icon={Search} label="Browse" title="Browse themes with live preview" onClick={openThemePicker} />}
                >
                  <SettingsRow
                    icon={Palette}
                    label="Palette"
                    control={(
                      <SettingsSelect
                        label="Theme"
                        value={draft.terminalThemeId}
                        onChange={(value) => {
                          const themeId = value as TerminalThemeId
                          patchDraft({ terminalThemeId: themeId })
                          previewTheme(themeId)
                        }}
                      >
                        {terminalThemeGroups.map((group) => (
                          <optgroup key={group.category} label={group.category}>
                            {group.themes.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
                          </optgroup>
                        ))}
                      </SettingsSelect>
                    )}
                  />
                  <SettingsRow icon={Highlighter} label="Selected pane" control={<input className="vl-set-color" type="color" aria-label="Selected pane highlight" value={draft.selectedPaneHighlightColor} onChange={(event) => previewHighlightColors({ selectedPaneHighlightColor: event.target.value })} />} />
                  <SettingsRow icon={Bell} label="Completion alert" control={<input className="vl-set-color" type="color" aria-label="Alarm highlight" value={draft.alarmHighlightColor} onChange={(event) => previewHighlightColors({ alarmHighlightColor: event.target.value })} />} />
                  <SettingsRow icon={Check} label="Reviewed pane" control={<input className="vl-set-color" type="color" aria-label="Reviewed pane highlight" value={draft.reviewedPaneHighlightColor} onChange={(event) => previewHighlightColors({ reviewedPaneHighlightColor: event.target.value })} />} />
                  <div className="vl-set-theme-preview" style={{ background: selectedTheme.terminal.background, color: selectedTheme.terminal.foreground }}>
                    <span>{selectedTheme.name}</span>
                    <small>{selectedTheme.description}</small>
                  </div>
                </SettingsCard>

                <SettingsCard icon={FileCode2} title="Editor">
                  <SettingsRow icon={ScrollText} label="Word wrap" control={<SettingsSwitch label="Word wrap" checked={draft.editorWordWrap} onChange={(checked) => patchDraft({ editorWordWrap: checked })} />} />
                  <SettingsRow icon={LayoutGrid} label="Minimap" control={<SettingsSwitch label="Minimap" checked={draft.editorMinimap} onChange={(checked) => patchDraft({ editorMinimap: checked })} />} />
                </SettingsCard>

                <SettingsCard icon={GitBranch} title="Git status labels" hint="Every mode keeps a plain-language hover explanation. Words is clearest; letters is most compact.">
                  <SettingsRow
                    icon={Tag}
                    label="Presentation"
                    control={(
                      <SettingsSegmented
                        label="Git status presentation"
                        value={draft.gitStatusPresentation}
                        options={[
                          { value: 'icons', label: 'Icons', hint: 'Symbols with explanations on hover' },
                          { value: 'letters', label: 'Letters', hint: 'S, M, U, P' },
                          { value: 'words', label: 'Words', hint: 'Staged, Modified, Untracked, Pointer' },
                        ]}
                        onChange={(value) => patchDraft({ gitStatusPresentation: value as GitStatusPresentation })}
                      />
                    )}
                  />
                </SettingsCard>
              </>
            ) : null}

            {activeSection === 'notifications' ? (
              <>
                <SettingsCard
                  icon={Volume2}
                  title="Completion sound"
                  hint="Plays when an AI agent response or assigned task finishes. Pane and workspace highlights stay on independently."
                  status={<SettingsSwitch label="Play completion sound" checked={draft.completionSoundEnabled} onChange={(checked) => patchDraft({ completionSoundEnabled: checked })} />}
                >
                  <SettingsRow
                    icon={Bell}
                    label="Sound"
                    sub={builtInCompletionSounds.find((sound) => sound.id === draft.completionSoundId)?.description}
                    control={(
                      <SettingsSelect label="Completion sound" value={draft.completionSoundId} disabled={!draft.completionSoundEnabled} onChange={(value) => patchDraft({ completionSoundId: value as CompletionSoundId })}>
                        <optgroup label="Built-in">
                          {builtInCompletionSounds.map((sound) => <option key={sound.id} value={sound.id}>{sound.name}</option>)}
                        </optgroup>
                        {customCompletionSounds.length > 0 ? (
                          <optgroup label="Custom">
                            {customCompletionSounds.map((sound) => <option key={sound.id} value={sound.id}>{sound.name}</option>)}
                          </optgroup>
                        ) : null}
                        {draft.completionSoundId.startsWith('custom:') && !customCompletionSounds.some((sound) => sound.id === draft.completionSoundId) ? (
                          <option value={draft.completionSoundId}>Missing custom sound</option>
                        ) : null}
                      </SettingsSelect>
                    )}
                  />
                  <SettingsRow
                    icon={ArrowUpDown}
                    label={`Volume · ${Math.round(draft.completionSoundVolume * 100)}%`}
                    control={(
                      <input
                        className="vl-set-range"
                        aria-label="Completion sound volume"
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={draft.completionSoundVolume}
                        disabled={!draft.completionSoundEnabled}
                        onChange={(event) => patchDraft({ completionSoundVolume: Number(event.target.value) })}
                      />
                    )}
                  />
                  <div className="vl-set-actions vl-set-actions-bordered">
                    {/* Preview stays enabled while the toggle is off so the sound
                        can always be auditioned before committing to it. */}
                    <SettingsButton icon={Play} label="Preview" onClick={() => void previewCompletionSound()} />
                    <SettingsButton icon={Upload} label="Add file" title="Add a custom MP3, WAV, OGG, M4A, AAC, or FLAC up to 10 MB" onClick={() => completionSoundInputRef.current?.click()} />
                    <input
                      ref={completionSoundInputRef}
                      hidden
                      aria-label="Add custom notification sound"
                      type="file"
                      accept=".mp3,.wav,.ogg,.m4a,.aac,.flac,audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/aac,audio/flac"
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0]
                        event.currentTarget.value = ''
                        if (file) void importCompletionSound(file)
                      }}
                    />
                  </div>
                  {customCompletionSounds.map((sound) => (
                    <div key={sound.id} className="vl-set-sound-row">
                      <Volume2 size={13} strokeWidth={1.9} aria-hidden="true" />
                      <span>
                        <strong>{sound.name}</strong>
                        <small>{Math.max(1, Math.round(sound.size / 1024))} KB</small>
                      </span>
                      <div>
                        <SettingsIconButton icon={Play} label={`Preview ${sound.name}`} onClick={() => void previewCompletionSound(sound.id)} />
                        <SettingsIconButton icon={Trash2} tone="danger" label={`Remove ${sound.name}`} onClick={() => void deleteCompletionSound(sound)} />
                      </div>
                    </div>
                  ))}
                  {completionSoundMessage ? <SettingsMessage icon={Info}>{completionSoundMessage}</SettingsMessage> : null}
                </SettingsCard>
                <SettingsCard icon={Sparkles} title="Agent completion hooks" hint="Each agent reports its own turn end. Configure them on the Agents page.">
                  <SettingsRow icon={Sparkles} label="Manage agent hooks" control={<SettingsButton icon={ChevronRight} label="Agents" onClick={() => setActiveSection('agents')} />} />
                </SettingsCard>
              </>
            ) : null}

            {activeSection === 'workspace' ? (
              <>
                <SettingsCard icon={Info} title="Scope" hint="These are defaults for every workspace. Per-workspace name, folder, profile, links, notes, and group live in each workspace's own settings dialog.">
                  <SettingsRow
                    icon={PanelsTopLeft}
                    label={activeSession ? `This workspace · ${activeSession.name}` : 'No workspace open'}
                    sub={activeWorkspaceFolder || undefined}
                    subMono
                    control={<SettingsPill icon={Info}>Right-click a workspace → Edit</SettingsPill>}
                  />
                </SettingsCard>
                <SettingsCard icon={LayoutGrid} title="Layout">
                  <SettingsRow icon={PanelTop} label="Pane header height" control={<SettingsNumber label="Pane header height" value={draft.paneHeaderHeight} min={24} max={56} onChange={(value) => patchDraft({ paneHeaderHeight: value })} />} />
                  <SettingsRow icon={Scaling} label="Resize snap" hint="Pixel tolerance for snapping a divider to a neighbouring edge." control={<SettingsNumber label="Resize snap" value={draft.resizeSnapTolerance} min={0} max={128} onChange={(value) => patchDraft({ resizeSnapTolerance: value })} />} />
                  <SettingsRow icon={Rows3} label="Scrollback" hint="Lines of terminal history kept per pane." control={<SettingsNumber label="Scrollback" value={draft.scrollback} min={100} max={200000} step={100} onChange={(value) => patchDraft({ scrollback: value })} />} />
                </SettingsCard>
                <SettingsCard icon={MonitorCog} title="Startup and exit" hint="Closing VibeLink is a real quit. Terminals only survive when you ask them to.">
                  <SettingsRow
                    icon={MonitorCog}
                    label="When reopening"
                    hint="Resume reattaches the same terminals and agent sessions. Start fresh stops them on exit and opens an initialized screen; a crash still restores your work."
                    control={<SettingsSegmented
                      label="When reopening"
                      value={draft.sessionRestore}
                      options={[
                        { value: 'resume', label: 'Resume', hint: 'Keep terminals running in the background and reattach them.' },
                        { value: 'clean', label: 'Start fresh', hint: 'Stop every terminal on exit and open an initialized screen.' },
                      ]}
                      onChange={(value) => patchDraft({ sessionRestore: value })}
                    />}
                  />
                  <SettingsRow
                    icon={PanelTop}
                    label="Close button minimizes to tray"
                    hint="Keeps VibeLink running in the notification area instead of quitting. Reopen it from the tray icon."
                    control={<SettingsSwitch label="Minimize to the tray instead of quitting" checked={draft.minimizeToTrayOnClose} onChange={(checked) => patchDraft({ minimizeToTrayOnClose: checked })} />}
                  />
                  <SettingsRow
                    icon={Info}
                    label="Ask before stopping busy agents"
                    hint="Only asks when Start fresh would interrupt an agent that is still working."
                    control={<SettingsSwitch label="Confirm when agents are still working" checked={draft.confirmExitWithRunningAgents} disabled={draft.sessionRestore !== 'clean'} onChange={(checked) => patchDraft({ confirmExitWithRunningAgents: checked })} />}
                  />
                </SettingsCard>
                <SettingsCard icon={Users} title="Agent roles" hint="Reusable responsibility labels for task assignment and terminal orchestration.">
                  <div className="vl-set-actions">
                    <input
                      className="vl-set-input"
                      aria-label="New role preset"
                      value={rolePresetDraft}
                      placeholder="Add role"
                      onChange={(event) => setRolePresetDraft(event.target.value)}
                      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addRolePreset() } }}
                    />
                    <SettingsButton icon={Plus} label="Add" onClick={addRolePreset} />
                  </div>
                  <div className="vl-set-chips">
                    {draft.rolePresets.map((role) => (
                      <span key={role} className="vl-set-chip">
                        {role}
                        <button type="button" title={`Remove ${role}`} aria-label={`Remove ${role}`} onClick={() => patchDraft({ rolePresets: draft.rolePresets.filter((existing) => existing !== role) })}>
                          <X size={11} strokeWidth={2.2} aria-hidden="true" />
                        </button>
                      </span>
                    ))}
                  </div>
                </SettingsCard>
              </>
            ) : null}

            {activeSection === 'terminals' ? (
              <SettingsCard
                icon={SquareTerminal}
                title="Terminal profiles"
                hint="Local shell, command, and SSH launchers. Each workspace picks its default profile in its own settings dialog."
                status={<SettingsButton icon={Plus} label="Add" onClick={addProfile} />}
              >
                {draft.profiles.map((profile) => {
                  const isExpanded = expandedProfileId === profile.id
                  const isDefault = profile.id === draft.defaultProfileId
                  const deleteDisabled = !canDeleteProfile(draft, profile.id)
                  return (
                    <section key={profile.id} className="vl-set-profile">
                      <div className="vl-set-profile-row">
                        <button type="button" className="vl-set-profile-summary" aria-expanded={isExpanded} onClick={() => setExpandedProfileId(isExpanded ? null : profile.id)}>
                          <ChevronRight size={13} strokeWidth={2} aria-hidden="true" />
                          <span className="vl-set-profile-icon"><ProfileIcon name={profile.icon} color={profile.color} size={16} /></span>
                          <span>{profile.name || profile.id}</span>
                        </button>
                        <SettingsPill>{profileKindLabels[profile.type]}</SettingsPill>
                        {isDefault
                          ? <SettingsPill tone="ok" icon={Check}>Default</SettingsPill>
                          : <SettingsIconButton icon={Check} label={`Make ${profile.name || profile.id} the default profile`} onClick={() => patchDraft({ defaultProfileId: profile.id })} />}
                        <SettingsIconButton
                          icon={Trash2}
                          tone="danger"
                          label={deleteDisabled ? 'At least one profile is required' : `Delete ${profile.name || profile.id}`}
                          disabled={deleteDisabled}
                          onClick={() => deleteProfile(profile.id)}
                        />
                      </div>
                      {isExpanded ? (
                        <div className="vl-set-profile-editor">
                          <div className="vl-set-grid">
                            <label className="vl-set-field"><span>Name</span><input className="vl-set-input" value={profile.name} onChange={(event) => updateProfile(profile.id, { name: event.target.value })} /></label>
                            <label className="vl-set-field">
                              <span>Type</span>
                              <select className="vl-set-select" value={profile.type} onChange={(event) => changeProfileType(profile, event.target.value as ProfileKind)}>
                                <option value="local">{profileKindLabels.local}</option>
                                <option value="command">{profileKindLabels.command}</option>
                                <option value="ssh">{profileKindLabels.ssh}</option>
                              </select>
                            </label>
                            <label className="vl-set-field">
                              <span><ProfileIcon name={profile.icon} color={profile.color} size={14} /> Icon</span>
                              <select className="vl-set-select" value={profile.icon} onChange={(event) => updateProfile(profile.id, { icon: event.target.value })}>
                                {profileIconNames.map((iconName) => <option key={iconName} value={iconName}>{iconName}</option>)}
                              </select>
                            </label>
                            <label className="vl-set-field"><span>Color</span><input className="vl-set-color" type="color" value={profile.color} onChange={(event) => updateProfile(profile.id, { color: event.target.value })} /></label>
                          </div>
                          {profile.type === 'local' ? (
                            <div className="vl-set-grid">
                              <label className="vl-set-field"><span>Shell</span><input className="vl-set-input mono" value={profile.shell ?? ''} placeholder="pwsh.exe" onChange={(event) => updateProfile(profile.id, { shell: event.target.value || null })} /></label>
                              <label className="vl-set-field"><span>Arguments</span><input className="vl-set-input mono" value={joinCommandLine(profile.args)} placeholder="-NoLogo" onChange={(event) => updateProfile(profile.id, { args: splitCommandLine(event.target.value) })} /></label>
                              <label className="vl-set-field"><span>Working directory</span><input className="vl-set-input mono" value={profile.cwd ?? ''} placeholder="Optional" onChange={(event) => updateProfile(profile.id, { cwd: event.target.value || null })} /></label>
                            </div>
                          ) : null}
                          {profile.type === 'command' ? (
                            <div className="vl-set-grid">
                              <label className="vl-set-field vl-set-field-wide"><span>Command line</span><input className="vl-set-input mono" value={profile.command} placeholder="pnpm dev" onChange={(event) => updateProfile(profile.id, { command: event.target.value })} /></label>
                            </div>
                          ) : null}
                          {profile.type === 'ssh' ? (
                            <div className="vl-set-grid">
                              <label className="vl-set-field"><span>Host</span><input className="vl-set-input mono" value={profile.sshHost} placeholder="100.98.54.122" onChange={(event) => updateProfile(profile.id, { sshHost: event.target.value })} /></label>
                              <label className="vl-set-field"><span>User</span><input className="vl-set-input mono" value={profile.sshUser} placeholder="js" onChange={(event) => updateProfile(profile.id, { sshUser: event.target.value })} /></label>
                              <label className="vl-set-field"><span>Port</span><input className="vl-set-input" type="number" min="1" max="65535" value={profile.sshPort ?? ''} placeholder="22" onChange={(event) => updateSshPort(profile.id, event.target.value)} /></label>
                              <label className="vl-set-field"><span>Identity file</span><input className="vl-set-input mono" value={profile.sshIdentityFile ?? ''} placeholder="~/.ssh/id_ed25519" onChange={(event) => updateProfile(profile.id, { sshIdentityFile: event.target.value || null })} /></label>
                              <label className="vl-set-field"><span>Remote cwd</span><input className="vl-set-input mono" value={profile.sshRemoteCwd ?? ''} placeholder="/home/js/app" onChange={(event) => updateProfile(profile.id, { sshRemoteCwd: event.target.value || null })} /></label>
                              <label className="vl-set-field"><span>Remote command</span><input className="vl-set-input mono" value={profile.sshRemoteCommand} placeholder={'exec "${SHELL:-sh}" -l'} onChange={(event) => updateProfile(profile.id, { sshRemoteCommand: event.target.value })} /></label>
                              <label className="vl-set-field vl-set-field-wide"><span>Extra SSH options</span><input className="vl-set-input mono" value={profile.sshOptions} placeholder="-o ServerAliveInterval=30" onChange={(event) => updateProfile(profile.id, { sshOptions: event.target.value })} /></label>
                            </div>
                          ) : null}
                          {profile.type === 'ssh' ? (
                            <SettingsRow icon={Terminal} label="Allocate TTY (-t)" control={<SettingsSwitch label="Allocate TTY (-t)" checked={profile.sshAllocateTty} onChange={(checked) => updateProfile(profile.id, { sshAllocateTty: checked })} />} />
                          ) : null}
                        </div>
                      ) : null}
                    </section>
                  )
                })}
              </SettingsCard>
            ) : null}

            {activeSection === 'integrations' ? (
              <SettingsCard icon={Plug} title="External editor" hint="Explorer and large-diff actions append the selected absolute path to this command. Leave empty to hide Open in Editor actions.">
                <SettingsRow icon={FileCode2} label="Editor command" stacked control={<SettingsText label="Editor command" mono value={draft.externalEditorCommand} placeholder="code" onChange={(value) => patchDraft({ externalEditorCommand: value })} />} />
              </SettingsCard>
            ) : null}

            {activeSection === 'gitHosting' ? (
              <>
                <GitHostingSettings />
                <ProviderIntegrationsPanel />
              </>
            ) : null}

            {activeSection === 'remote' ? <RemoteSettings /> : null}

            {activeSection === 'safety' ? (
              <SettingsCard icon={Shield} title="Process safety" hint="VibeLink never kills a broad process image name; it proves exact workspace ownership first.">
                <SettingsRow icon={Shield} label="Scoped process cleanup" control={<SettingsPill tone="ok" icon={CircleCheck}>Enforced</SettingsPill>} />
                <SettingsRow icon={Cpu} label="Broad image-name kills" control={<SettingsPill tone="ok" icon={CircleX}>Blocked</SettingsPill>} />
              </SettingsCard>
            ) : null}

            {activeSection === 'memory' ? (
              <SettingsCard icon={Blocks} title="Memory & context" hint="Native Hermes manages durable memory and compression.">
                <SettingsRow icon={Database} label="Persistent memory" control={<SettingsPill tone="ok" icon={CircleCheck}>On</SettingsPill>} />
                <SettingsRow icon={Layers} label="Auto-compression" control={<SettingsPill tone="ok" icon={CircleCheck}>On</SettingsPill>} />
                <SettingsRow icon={Cpu} label="Context engine" control={<SettingsValue value="Native Hermes" />} />
              </SettingsCard>
            ) : null}

            {activeSection === 'voice' ? (
              <SettingsCard icon={Mic} title="Voice" hint="Reserved for a future VibeLink Agent provider.">
                <SettingsRow icon={Mic} label="Voice input" control={<SettingsSwitch label="Voice input" checked={false} disabled />} />
                <SettingsRow icon={Volume2} label="Voice output" control={<SettingsSwitch label="Voice output" checked={false} disabled />} />
              </SettingsCard>
            ) : null}

            {activeSection === 'advanced' ? (
              <>
                <SettingsCard icon={Camera} title="Capture" hint="Screenshots use the capture folder; recordings download ffmpeg on first use unless you set an override path.">
                  <SettingsRow
                    icon={FolderOpen}
                    label="Capture folder"
                    stacked
                    control={(
                      <>
                        <SettingsText label="Capture folder" mono value={draft.captureDir} placeholder={defaultCaptureDir || 'Default capture folder'} onChange={(value) => patchDraft({ captureDir: value })} />
                        <SettingsIconButton icon={FolderOpen} label="Browse for capture folder" onClick={() => void browseCaptureDir()} />
                      </>
                    )}
                  />
                  <SettingsRow
                    icon={Film}
                    label="ffmpeg path"
                    sub={ffmpegStatus || undefined}
                    stacked
                    control={(
                      <>
                        <SettingsText label="ffmpeg path" mono value={draft.captureFfmpegPath} placeholder="ffmpeg on PATH" onChange={(value) => patchDraft({ captureFfmpegPath: value })} />
                        <SettingsIconButton icon={Clapperboard} label="Test ffmpeg" onClick={() => void testFfmpeg()} />
                      </>
                    )}
                  />
                </SettingsCard>
                <SettingsCard
                  icon={Keyboard}
                  title="Keyboard shortcuts"
                  hint="Click a shortcut field and press the new combination."
                  status={<SettingsButton icon={RefreshCw} label="Reset" title="Reset all shortcuts to defaults" onClick={() => patchDraft({ keybindings: { ...defaultKeybindings } })} />}
                >
                  <div className="vl-set-keybinds">
                    {keybindingDefinitions.map((definition) => (
                      <SettingsRow
                        key={definition.id}
                        icon={Keyboard}
                        label={definition.label}
                        hint={definition.description}
                        control={(
                          <input
                            className="vl-set-input"
                            aria-label={definition.label}
                            value={draft.keybindings[definition.id]}
                            onChange={(event) => updateKeybinding(definition.id, event.target.value)}
                            onKeyDown={(event) => {
                              event.preventDefault()
                              event.stopPropagation()
                              updateKeybinding(definition.id, eventToKeyChord(event.nativeEvent))
                            }}
                          />
                        )}
                      />
                    ))}
                  </div>
                </SettingsCard>
                <AndroidDeviceLabPanel />
              </>
            ) : null}

            {activeSection === 'worktrees' ? (
              <SettingsCard icon={GitBranch} title="Worktree storage" hint="Where VibeLink creates managed Git worktrees for the active repository workspace.">
                <SettingsRow
                  icon={ArrowUpDown}
                  label="Workspace ordering"
                  sub="Smart prioritizes blocked, waiting, errored, and completed workspaces. Drag reordering is available only in Manual mode."
                  control={(
                    <SettingsSelect label="Workspace ordering" value={draft.workspaceSortMode} onChange={(workspaceSortMode) => patchDraft({ workspaceSortMode: workspaceSortMode as Settings['workspaceSortMode'] })}>
                      <option value="smart">Smart attention</option>
                      <option value="recent">Recent activity</option>
                      <option value="name">Name</option>
                      <option value="repository">Repository</option>
                      <option value="manual">Manual</option>
                    </SettingsSelect>
                  )}
                />
                <SettingsRow
                  icon={HardDrive}
                  label="Location"
                  control={(
                    <SettingsSelect
                      label="Storage mode"
                      value={worktreeStorageChoice}
                      onChange={(value) => {
                        const choice = value as WorktreeStorageChoice
                        if (choice === 'sameDrive') patchWorktreeStorage({ mode: 'drive', drive: '' })
                        else if (choice === 'specificDrive') patchWorktreeStorage({ mode: 'drive', drive: draft.worktreeStorage.drive || worktreeStorageOptions.drives[0] || '' })
                        else patchWorktreeStorage({ mode: choice })
                      }}
                    >
                      <option value="sameDrive">Same drive as repository</option>
                      <option value="specificDrive">Specific drive</option>
                      <option value="appData">App data folder</option>
                      <option value="custom">Custom folder</option>
                    </SettingsSelect>
                  )}
                />
                {worktreeStorageChoice === 'specificDrive' ? (
                  <SettingsRow
                    icon={HardDrive}
                    label="Drive"
                    control={(
                      <SettingsSelect label="Drive" value={draft.worktreeStorage.drive} onChange={(drive) => patchWorktreeStorage({ drive })}>
                        {worktreeDriveOptions.map((drive) => <option key={drive} value={drive}>{drive}</option>)}
                      </SettingsSelect>
                    )}
                  />
                ) : null}
                {draft.worktreeStorage.mode === 'drive' ? (
                  <SettingsRow icon={FolderCog} label="Root folder name" control={<SettingsText label="Root folder name" value={draft.worktreeStorage.folderName} onChange={(folderName) => patchWorktreeStorage({ folderName })} />} />
                ) : null}
                {draft.worktreeStorage.mode === 'custom' ? (
                  <SettingsRow
                    icon={FolderOpen}
                    label="Custom folder"
                    stacked
                    control={(
                      <>
                        <SettingsText label="Custom folder" mono value={draft.worktreeStorage.customRoot} onChange={(customRoot) => patchWorktreeStorage({ customRoot })} />
                        <SettingsIconButton icon={FolderOpen} label="Browse" onClick={() => void browseWorktreeRoot()} />
                      </>
                    )}
                  />
                ) : null}
                <SettingsRow icon={Layers} label="Group by repository" control={<SettingsSwitch label="Group by repository" checked={draft.worktreeStorage.groupByRepository} onChange={(groupByRepository) => patchWorktreeStorage({ groupByRepository })} />} />
                <SettingsRow
                  icon={FolderCog}
                  label="Resolved root"
                  control={<SettingsValue mono value={worktreeResolution?.root ?? (!activeWorkspaceFolder ? 'Open a repository workspace' : worktreeResolutionError ? 'Unavailable' : 'Resolving…')} />}
                />
                <SettingsRow icon={GitBranch} label="Example worktree" control={<SettingsValue mono value={worktreeResolution?.example ?? '—'} />} />
                {worktreeResolution?.fallbackReason ? <SettingsMessage tone="danger" icon={TriangleAlert}>{worktreeResolution.fallbackReason}</SettingsMessage> : null}
                {worktreeResolution && !worktreeResolution.writable && !worktreeResolution.fallbackReason ? <SettingsMessage tone="danger" icon={TriangleAlert}>The resolved worktree root is not writable.</SettingsMessage> : null}
                {worktreeResolutionError ? <SettingsMessage tone="danger" icon={TriangleAlert}>{worktreeResolutionError}</SettingsMessage> : null}
              </SettingsCard>
            ) : null}

            {activeSection === 'messaging' ? (
              <SettingsCard
                icon={Send}
                title="Messaging gateways"
                hint="Telegram, Discord, Slack, and WhatsApp gateways are owned by your Hermes install."
                status={runtime?.detected ? <SettingsPill tone="ok" icon={CircleCheck}>Hermes ready</SettingsPill> : <SettingsPill tone="warn" icon={TriangleAlert}>Install Hermes</SettingsPill>}
              >
                <div className="vl-set-actions">
                  <SettingsButton icon={Settings2} label="Set up" disabled={!activeSessionId || !runtime?.detected} onClick={() => void openHermesGateway('setup')} />
                  <SettingsButton icon={Info} label="Status" disabled={!activeSessionId || !runtime?.detected} onClick={() => void openHermesGateway('status')} />
                  <SettingsButton icon={Play} label="Run" disabled={!activeSessionId || !runtime?.detected} onClick={() => void openHermesGateway('run')} />
                </div>
              </SettingsCard>
            ) : null}

            {activeSection === 'apiKeys' ? (
              <SettingsCard
                icon={KeyRound}
                title="Provider auth"
                hint="VibeLink never stores provider API keys. Native Hermes auth remains the source of truth."
                status={<SettingsIconButton icon={RefreshCw} label="Refresh auth list" disabled={!activeSessionId || authBusy} onClick={() => void refreshAuthList()} />}
              >
                <pre className="vl-set-pre">{authList || 'No auth list loaded.'}</pre>
              </SettingsCard>
            ) : null}

            {activeSection === 'mcp' ? (
              <SettingsCard
                icon={Box}
                title="MCP bridge"
                hint="VibeLink registers its workspace MCP bridge per agent session over ACP; your Hermes config file is never modified."
                status={<SettingsButton icon={Play} label={mcpCheckBusy ? 'Checking…' : 'Self-check'} disabled={!activeSessionId || mcpCheckBusy} onClick={() => void checkMcp()} />}
              >
                <SettingsRow icon={Server} label="Server" control={<SettingsValue value="vibelink" />} />
                <SettingsRow icon={Terminal} label="Command" control={<SettingsValue mono value="vibelink.exe mcp serve" />} />
                <SettingsRow icon={Hash} label="Scope" control={<SettingsValue mono value={activeSessionId ? `VIBELINK_SESSION_ID=${activeSessionId}` : 'Open a workspace'} />} />
                {mcpCheck ? (
                  <>
                    <SettingsRow icon={Play} label="Spawn" control={mcpCheck.spawnOk ? <SettingsPill tone="ok" icon={CircleCheck}>OK</SettingsPill> : <SettingsPill tone="danger" icon={CircleX}>Failed</SettingsPill>} />
                    <SettingsRow icon={Plug} label="Initialize" control={mcpCheck.initializeOk ? <SettingsPill tone="ok" icon={CircleCheck}>OK</SettingsPill> : <SettingsPill tone="danger" icon={CircleX}>Failed</SettingsPill>} />
                    <SettingsRow icon={Wrench} label="Tools" control={<SettingsValue value={String(mcpCheck.toolCount)} />} />
                    {mcpCheck.error ? <pre className="vl-set-pre">{mcpCheck.error}</pre> : null}
                  </>
                ) : null}
              </SettingsCard>
            ) : null}

            {activeSection === 'archived' ? (
              <SettingsCard icon={Archive} title="Archived chats" hint="Archived agent chats remain owned by your Hermes installation.">
                <SettingsRow icon={StickyNote} label="Management" control={<SettingsValue value="Resume from the Agent session list" />} />
              </SettingsCard>
            ) : null}

            {activeSection === 'about' ? (
              <SettingsCard icon={Info} title="About VibeLink">
                <SettingsRow icon={Package} label="Product" control={<SettingsValue value="VibeLink" />} />
                <SettingsRow icon={Bot} label="Hermes runtime" control={<SettingsValue mono value={runtime?.version ?? 'Unknown'} />} />
                <SettingsRow icon={CircleUser} label="Account" control={<SettingsButton icon={ChevronRight} label="Open" onClick={() => setActiveSection('account')} />} />
                <div className="vl-set-actions vl-set-actions-bordered">
                  <SettingsButton icon={Settings2} label="Run setup wizard" onClick={onRunSetupWizard} />
                </div>
              </SettingsCard>
            ) : null}
          </div>

          <footer className="vl-set-footer">
            <span className="vl-set-footer-note">Changes are staged until Apply or OK.</span>
            <button type="button" onClick={closeSettings}>Cancel</button>
            <button type="button" onClick={apply}><Save size={13} strokeWidth={1.9} aria-hidden="true" /> Apply</button>
            <button type="button" className="vl-set-primary" onClick={ok}><Check size={13} strokeWidth={2.1} aria-hidden="true" /> OK</button>
          </footer>
        </main>
      </section>
      {isThemePickerOpen ? (
        <ThemePicker
          value={draft.terminalThemeId}
          onPreview={previewTheme}
          onSelect={(themeId) => {
            patchDraft({ terminalThemeId: themeId })
            previewTheme(themeId)
            setThemePickerOpen(false)
          }}
          onCancel={() => {
            previewTheme(draft.terminalThemeId)
            setThemePickerOpen(false)
          }}
        />
      ) : null}
      {isFontPickerOpen ? (
        <FontPicker
          value={draft.fontFamily}
          installedFonts={installedFonts}
          onPreview={(fontFamily) => TerminalManager.previewFont(fontFamily)}
          onSelect={(fontFamily) => {
            patchDraft({ fontFamily })
            TerminalManager.previewFont(fontFamily)
            setFontPickerOpen(false)
          }}
          onCancel={() => {
            TerminalManager.previewFont(draft.fontFamily)
            setFontPickerOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
