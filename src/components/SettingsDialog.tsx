import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Archive, Bot, Box, ChevronDown, GitPullRequest, HardDrive, Info, KeyRound, MessageSquare, Mic, Monitor, Palette, Plug, RefreshCw, Search, Settings2, Shield, SlidersHorizontal, Smartphone, Terminal, X } from 'lucide-react'
import { LicenseSettings } from './LicenseSettings'
import { RemoteSettings } from './RemoteSettings'
import { ProfileIcon } from './ProfileIcon'
import { defaultKeybindings, eventToKeyChord, keybindingDefinitions, type KeybindingActionId } from '../state/keybindings'
import { normalizeFontChoices, terminalFontStack } from '../state/fonts'
import { canDeleteProfile, createProfile, joinCommandLine, splitCommandLine, type ChatImageAttachmentMode, type ChatPersonality, type Profile, type ProfileKind, type Settings } from '../state/profiles'
import { profileIconNames } from '../state/profileIcons'
import { terminalThemeDefinitionById, terminalThemeGroups, type TerminalThemeId } from '../state/terminalThemes'
import { applyThemeToDocument } from '../state/themePreview'
import { TerminalManager } from '../terminal/TerminalManager'
import { ThemePicker } from './ThemePicker'
import { FontPicker } from './FontPicker'
import { useWorkspaceStore } from '../state/store'
import type { HermesRuntimeStatus, HermesWorkspaceState } from '../ipc/types'
import { runMcpSelfCheck, type McpCheckReport } from '../ipc/mcp'
import { HermesInstallGuidance } from './HermesInstallGuidance'
import { GitHostingSettings } from './GitHostingSettings'

type SettingsDialogProps = {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onClose: () => void
  onRunSetupWizard: () => void
}

type SettingsSection =
  | 'account'
  | 'model'
  | 'chat'
  | 'appearance'
  | 'workspace'
  | 'integrations'
  | 'gitHosting'
  | 'remote'
  | 'safety'
  | 'memory'
  | 'voice'
  | 'advanced'
  | 'messaging'
  | 'apiKeys'
  | 'mcp'
  | 'archived'
  | 'about'

const sections: { id: SettingsSection; label: string; icon: typeof Settings2 }[] = [
  { id: 'account', label: 'Account', icon: KeyRound },
  { id: 'model', label: 'Model', icon: Bot },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'workspace', label: 'Workspace', icon: Monitor },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'gitHosting', label: 'Git Hosting', icon: GitPullRequest },
  { id: 'remote', label: 'Remote', icon: Smartphone },
  { id: 'safety', label: 'Safety', icon: Shield },
  { id: 'memory', label: 'Memory & Context', icon: HardDrive },
  { id: 'voice', label: 'Voice', icon: Mic },
  { id: 'advanced', label: 'Advanced', icon: SlidersHorizontal },
  { id: 'messaging', label: 'Messaging', icon: MessageSquare },
  { id: 'apiKeys', label: 'API Keys', icon: KeyRound },
  { id: 'mcp', label: 'MCP', icon: Box },
  { id: 'archived', label: 'Archived Chats', icon: Archive },
  { id: 'about', label: 'About', icon: Info },
]

const fontWeightOptions = [100, 200, 300, 400, 500, 600, 700, 800, 900]
const chatPersonalityOptions: { value: ChatPersonality; label: string }[] = [
  { value: 'direct', label: 'Direct' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'concise', label: 'Concise' },
  { value: 'exploratory', label: 'Exploratory' },
]
const imageAttachmentOptions: { value: ChatImageAttachmentMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'always', label: 'Always' },
  { value: 'never', label: 'Never' },
]
const cursorStyleOptions: { value: Settings['cursorStyle']; label: string }[] = [
  { value: 'bar', label: 'Bar' },
  { value: 'block', label: 'Block' },
  { value: 'underline', label: 'Underline' },
]

const profileKindLabels: Record<ProfileKind, string> = {
  local: 'Local',
  ssh: 'SSH',
  command: 'Command',
}
const profileKindOptions: { value: ProfileKind; label: string }[] = [
  { value: 'local', label: profileKindLabels.local },
  { value: 'ssh', label: profileKindLabels.ssh },
  { value: 'command', label: profileKindLabels.command },
]


export function SettingsDialog({ settings, onChange, onClose, onRunSetupWizard }: SettingsDialogProps) {
  const [draft, setDraft] = useState(settings)
  const [activeSection, setActiveSection] = useState<SettingsSection>('account')
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
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const sessions = useWorkspaceStore((state) => state.sessions)
  const spawnPane = useWorkspaceStore((state) => state.spawnPane)
  const activeSession = activeSessionId ? sessions.find((session) => session.id === activeSessionId) : undefined
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
  const removeRolePreset = (role: string) => {
    patchDraft({ rolePresets: draft.rolePresets.filter((existing) => existing !== role) })
  }
  const fontChoices = useMemo(() => normalizeFontChoices(installedFonts, draft.fontFamily), [draft.fontFamily, installedFonts])
  const selectedTheme = terminalThemeDefinitionById(draft.terminalThemeId)
  const filteredSections = sections.filter((section) => section.label.toLowerCase().includes(search.trim().toLowerCase()))

  useEffect(() => {
    let cancelled = false
    void invoke<string[]>('list_installed_fonts')
      .then((fonts) => { if (!cancelled) setInstalledFonts(fonts) })
      .catch(() => { if (!cancelled) setInstalledFonts([]) })
    void invoke<string>('default_capture_dir')
      .then((dir) => { if (!cancelled) setDefaultCaptureDir(dir) })
      .catch(() => { if (!cancelled) setDefaultCaptureDir('') })
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

  const patchDraft = (patch: Partial<Settings>) => setDraft((current) => ({ ...current, ...patch }))
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
        icon: 'sparkles',
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
        icon: 'message-square',
      })
      setTerminalMessage('Hermes gateway terminal opened.')
    } catch (error) {
      setTerminalMessage(String(error))
    }
  }
  const browseCaptureDir = async () => {
    const selected = await open({ directory: true, multiple: false, title: 'Select capture folder' })
    if (typeof selected === 'string') patchDraft({ captureDir: selected })
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
  const revertThemePreview = () => {
    applyThemeToDocument(settings.terminalThemeId, settings.selectedPaneHighlightColor, settings.alarmHighlightColor, settings.reviewedPaneHighlightColor)
    TerminalManager.previewTheme(null)
  }
  const closeSettings = () => {
    revertThemePreview()
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
      <section className="settings-dialog vibelink-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <aside className="vibelink-settings-nav">
          <div className="vibelink-settings-search">
            <Search size={14} />
            <input value={search} placeholder="Search settings..." onChange={(event) => setSearch(event.target.value)} />
          </div>
          <nav aria-label="Settings sections">
            {filteredSections.map((section) => {
              const Icon = section.icon
              return (
                <button key={section.id} type="button" className={activeSection === section.id ? 'selected' : undefined} onClick={() => setActiveSection(section.id)}>
                  <Icon size={15} />
                  {section.label}
                </button>
              )
            })}
          </nav>
        </aside>

        <main className="vibelink-settings-content">
          <header className="vibelink-settings-header">
            <h2 id="settings-title">{sections.find((section) => section.id === activeSection)?.label ?? 'Settings'}</h2>
            <button type="button" className="settings-close" title="Close settings" onClick={closeSettings}>
              <X size={15} />
            </button>
          </header>

          <div className="vibelink-settings-scroll">
            {activeSection === 'account' ? <LicenseSettings /> : null}

            {activeSection === 'model' ? (
              <SettingsGroup title="Main model" description="Hermes owns provider, login, and model configuration. VibeLink reads the global installation without modifying it.">
                <ReadonlyRow label="Workspace" value={activeSession?.name ?? 'No workspace'} />
                <ReadonlyRow label="Global HERMES_HOME" value={runtime?.home ?? workspaceState?.home ?? 'Not resolved'} mono />
                <ReadonlyRow label="Runtime command" value={runtime?.command ?? 'Not detected'} mono />
                <ReadonlyRow label="Version" value={runtime?.version ?? 'Not detected'} />
                <ReadonlyRow label="Provider" value={workspaceState?.model?.provider || runtime?.configuredModel?.provider || 'Hermes default'} />
                <ReadonlyRow label="Model" value={workspaceState?.model?.model ?? runtime?.configuredModel?.model ?? 'Not configured'} />
                <ReadonlyRow label="Base URL" value={workspaceState?.model?.baseUrl || runtime?.configuredModel?.baseUrl || 'Hermes provider default'} mono />
                <label>
                  hermes-acp override
                  <input value={draft.hermesCommand} placeholder="hermes-acp" onChange={(event) => patchDraft({ hermesCommand: event.target.value })} />
                </label>
                <HermesInstallGuidance
                  runtime={runtime}
                  commandOverride={draft.hermesCommand || null}
                  sessionId={activeSessionId}
                  workspaceFolder={activeSession?.workspaceFolder ?? null}
                  onStatus={setRuntime}
                />
                <div className="vibelink-settings-actions">
                  <button type="button" disabled={!activeSessionId || !runtime?.detected} onClick={() => void openHermesTerminal('model')}><Settings2 size={14} /> Configure model</button>
                  <button type="button" disabled={!activeSessionId || !runtime?.detected} onClick={() => void openHermesTerminal('custom-provider')}><Terminal size={14} /> Custom provider</button>
                  <button type="button" disabled={!activeSessionId || !runtime?.detected} onClick={() => void openHermesTerminal('auth')}><KeyRound size={14} /> Login / auth</button>
                  <button type="button" onClick={() => void refreshHermesState()}><RefreshCw size={14} /> Refresh</button>
                  <button type="button" disabled={!activeSessionId || !runtime?.detected} onClick={() => void openHermesTerminal('status')}><Terminal size={14} /> Open status CLI</button>
                </div>
                {terminalMessage ? <div className="vibelink-settings-note"><span>{terminalMessage}</span></div> : null}
              </SettingsGroup>
            ) : null}

            {activeSection === 'chat' ? (
              <SettingsGroup title="Chat" description="New VibeLink Agent chats use these local UI preferences.">
                <SettingsSelect label="Personality" value={draft.chatPersonality} options={chatPersonalityOptions} onChange={(value) => patchDraft({ chatPersonality: value as ChatPersonality })} />
                <ReadonlyRow label="Timezone" value={Intl.DateTimeFormat().resolvedOptions().timeZone || 'System'} />
                <SettingsToggle label="Show thinking / reasoning" checked={draft.chatReasoningBlocks} onChange={(checked) => patchDraft({ chatReasoningBlocks: checked })} />
                <SettingsToggle label="Show tool calls" checked={draft.chatToolCalls} onChange={(checked) => patchDraft({ chatToolCalls: checked })} />
                <SettingsToggle label="Show tool call contents" checked={draft.chatToolCallContent} disabled={!draft.chatToolCalls} onChange={(checked) => patchDraft({ chatToolCallContent: checked })} />
                <SettingsSelect label="Image attachments" value={draft.chatImageAttachments} options={imageAttachmentOptions} onChange={(value) => patchDraft({ chatImageAttachments: value as ChatImageAttachmentMode })} />
              </SettingsGroup>
            ) : null}

            {activeSection === 'appearance' ? (
              <>
                <SettingsGroup title="Font" description="Font family previews live on terminal panes and commits on Apply or OK. Size, weight, and scale apply after Apply or OK.">
                  <label>
                    Font family
                    <select
                      value={draft.fontFamily}
                      onChange={(event) => {
                        patchDraft({ fontFamily: event.target.value })
                        TerminalManager.previewFont(event.target.value)
                      }}
                    >
                      {fontChoices.map((font) => <option key={font} value={font}>{font}</option>)}
                    </select>
                  </label>
                  <div className="vibelink-settings-actions">
                    <button type="button" onClick={openFontPicker}>Browse fonts (live preview)</button>
                  </div>
                  <div className="vibelink-settings-grid">
                    <label>Font size<input type="number" min="8" max="32" value={draft.fontSize} onChange={(event) => patchDraft({ fontSize: Number(event.target.value) })} /></label>
                    <label>Font weight<select value={draft.terminalFontWeight} onChange={(event) => patchDraft({ terminalFontWeight: Number(event.target.value) })}>{fontWeightOptions.map((weight) => <option key={weight} value={weight}>{weight}</option>)}</select></label>
                    <label>Cursor style<select value={draft.cursorStyle} onChange={(event) => patchDraft({ cursorStyle: event.target.value as Settings['cursorStyle'] })}>{cursorStyleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                    <label>UI scale<input type="number" min="0.85" max="1.2" step="0.05" value={draft.uiScale} onChange={(event) => patchDraft({ uiScale: Number(event.target.value) })} /></label>
                  </div>
                  <div className="vibelink-settings-preview" style={{ fontFamily: terminalFontStack(draft.fontFamily), fontWeight: draft.terminalFontWeight }}>PS E:\repo&gt; VibeLink Agent ready</div>
                </SettingsGroup>
                <SettingsGroup title="Theme" description="One palette drives app chrome, settings, tabs, and terminal colors. Changes preview live and commit on Apply or OK.">
                  <label>
                    Theme
                    <select
                      value={draft.terminalThemeId}
                      onChange={(event) => {
                        const themeId = event.target.value as TerminalThemeId
                        patchDraft({ terminalThemeId: themeId })
                        previewTheme(themeId)
                      }}
                    >
                      {terminalThemeGroups.map((group) => (
                        <optgroup key={group.category} label={group.category}>
                          {group.themes.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                  <div className="vibelink-settings-actions">
                    <button type="button" onClick={openThemePicker}>Browse themes (live preview)</button>
                  </div>
                  <div className="vibelink-theme-preview" style={{ background: selectedTheme.terminal.background, color: selectedTheme.terminal.foreground }}>
                    <span>{selectedTheme.name}</span>
                    <small>{selectedTheme.description}</small>
                  </div>
                  <div className="vibelink-settings-grid">
                    <label>
                      Selected pane highlight
                      <input
                        type="color"
                        value={draft.selectedPaneHighlightColor}
                        onChange={(event) => previewHighlightColors({ selectedPaneHighlightColor: event.target.value })}
                      />
                    </label>
                    <label>
                      Alarm highlight
                      <input
                        type="color"
                        value={draft.alarmHighlightColor}
                        onChange={(event) => previewHighlightColors({ alarmHighlightColor: event.target.value })}
                      />
                    </label>
                    <label>
                      Reviewed pane highlight
                      <input
                        type="color"
                        value={draft.reviewedPaneHighlightColor}
                        onChange={(event) => previewHighlightColors({ reviewedPaneHighlightColor: event.target.value })}
                      />
                    </label>
                  </div>
                </SettingsGroup>
              </>
            ) : null}

            {activeSection === 'workspace' ? (
              <>
                <SettingsGroup title="Layout" description="Controls workspace window panes, tab height, and terminal restore behavior.">
                  <div className="vibelink-settings-grid">
                    <label>Pane header height<input type="number" min="24" max="56" value={draft.paneHeaderHeight} onChange={(event) => patchDraft({ paneHeaderHeight: Number(event.target.value) })} /></label>
                    <label>Resize snap<input type="number" min="0" max="128" value={draft.resizeSnapTolerance} onChange={(event) => patchDraft({ resizeSnapTolerance: Number(event.target.value) })} /></label>
                    <label>Scrollback<input type="number" min="100" max="200000" step="100" value={draft.scrollback} onChange={(event) => patchDraft({ scrollback: Number(event.target.value) })} /></label>
                  </div>
                  <SettingsToggle label="Show terminal scrollbars" checked={draft.terminalScrollbarVisible} onChange={(checked) => patchDraft({ terminalScrollbarVisible: checked })} />
                  <SettingsToggle label="Keep terminals alive after window close" checked={draft.keepTerminalsAliveOnClose} onChange={(checked) => patchDraft({ keepTerminalsAliveOnClose: checked })} />
                </SettingsGroup>
                <SettingsGroup title="Agent roles" description="Reusable responsibility labels for task assignment and terminal orchestration.">
                  <div className="vibelink-settings-actions">
                    <input
                      value={rolePresetDraft}
                      placeholder="Add role preset"
                      onChange={(event) => setRolePresetDraft(event.target.value)}
                      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addRolePreset() } }}
                    />
                    <button type="button" onClick={addRolePreset}>Add</button>
                  </div>
                  <div className="vibelink-role-presets">
                    {draft.rolePresets.map((role) => (
                      <span key={role}>
                        {role}
                        <button type="button" title={`Remove ${role}`} onClick={() => removeRolePreset(role)}>×</button>
                      </span>
                    ))}
                  </div>
                </SettingsGroup>
                <SettingsGroup title="Profiles" description="Create local shell, command, and SSH terminal profiles.">
                  <div className="vibelink-profile-toolbar">
                    <button type="button" onClick={addProfile}>Add profile</button>
                  </div>
                  <div className="vibelink-profile-list">
                    {draft.profiles.map((profile) => {
                      const isExpanded = expandedProfileId === profile.id
                      const isDefault = profile.id === draft.defaultProfileId
                      const deleteDisabled = !canDeleteProfile(draft, profile.id)
                      return (
                        <section key={profile.id} className="vibelink-profile-card">
                          <div className="vibelink-profile-row">
                            <button type="button" className="vibelink-profile-summary" aria-expanded={isExpanded} onClick={() => setExpandedProfileId(isExpanded ? null : profile.id)}>
                              <ProfileIcon name={profile.icon} color={profile.color} size={16} />
                              <span className="vibelink-profile-name">{profile.name || profile.id}</span>
                              <span className="vibelink-profile-type-badge">{profileKindLabels[profile.type]}</span>
                            </button>
                            <button type="button" onClick={() => patchDraft({ defaultProfileId: profile.id })} disabled={isDefault}>{isDefault ? 'Default' : 'Set default'}</button>
                            <button type="button" onClick={() => deleteProfile(profile.id)} disabled={deleteDisabled} title={deleteDisabled ? 'At least one profile is required' : 'Delete profile'}>Delete</button>
                          </div>
                          {isExpanded ? (
                            <div className="vibelink-profile-editor">
                              <div className="vibelink-settings-grid">
                                <label>Name<input value={profile.name} onChange={(event) => updateProfile(profile.id, { name: event.target.value })} /></label>
                                <label>
                                  Type
                                  <select value={profile.type} onChange={(event) => changeProfileType(profile, event.target.value as ProfileKind)}>
                                    {profileKindOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                                  </select>
                                </label>
                                <label>
                                  Icon
                                  <span className="vibelink-profile-icon-field">
                                    <ProfileIcon name={profile.icon} color={profile.color} size={16} />
                                    <select value={profile.icon} onChange={(event) => updateProfile(profile.id, { icon: event.target.value })}>
                                      {profileIconNames.map((iconName) => <option key={iconName} value={iconName}>{iconName}</option>)}
                                    </select>
                                  </span>
                                </label>
                                <label>Color<input type="color" value={profile.color} onChange={(event) => updateProfile(profile.id, { color: event.target.value })} /></label>
                              </div>
                              {profile.type === 'local' ? (
                                <div className="vibelink-settings-grid">
                                  <label>Shell<input value={profile.shell ?? ''} placeholder="pwsh.exe" onChange={(event) => updateProfile(profile.id, { shell: event.target.value || null })} /></label>
                                  <label>Arguments<input value={joinCommandLine(profile.args)} placeholder="-NoLogo" onChange={(event) => updateProfile(profile.id, { args: splitCommandLine(event.target.value) })} /></label>
                                  <label>Working directory<input value={profile.cwd ?? ''} placeholder="Optional local cwd" onChange={(event) => updateProfile(profile.id, { cwd: event.target.value || null })} /></label>
                                </div>
                              ) : null}
                              {profile.type === 'command' ? (
                                <label className="vibelink-profile-field-wide">Command line<input value={profile.command} placeholder="pnpm dev" onChange={(event) => updateProfile(profile.id, { command: event.target.value })} /></label>
                              ) : null}
                              {profile.type === 'ssh' ? (
                                <div className="vibelink-profile-editor-grid">
                                  <label>Host<input value={profile.sshHost} placeholder="100.98.54.122" onChange={(event) => updateProfile(profile.id, { sshHost: event.target.value })} /></label>
                                  <label>User<input value={profile.sshUser} placeholder="js" onChange={(event) => updateProfile(profile.id, { sshUser: event.target.value })} /></label>
                                  <label>Port<input type="number" min="1" max="65535" value={profile.sshPort ?? ''} placeholder="22" onChange={(event) => updateSshPort(profile.id, event.target.value)} /></label>
                                  <label>Identity file<input value={profile.sshIdentityFile ?? ''} placeholder="C:\\Users\\js\\.ssh\\id_ed25519" onChange={(event) => updateProfile(profile.id, { sshIdentityFile: event.target.value || null })} /></label>
                                  <label>Remote cwd default<input value={profile.sshRemoteCwd ?? ''} placeholder="/home/js/projects/app" onChange={(event) => updateProfile(profile.id, { sshRemoteCwd: event.target.value || null })} /></label>
                                  <label>Remote command<input value={profile.sshRemoteCommand} placeholder={'exec "${SHELL:-sh}" -l'} onChange={(event) => updateProfile(profile.id, { sshRemoteCommand: event.target.value })} /></label>
                                  <label className="vibelink-profile-field-wide">Extra SSH options<input value={profile.sshOptions} placeholder="-o ServerAliveInterval=30" onChange={(event) => updateProfile(profile.id, { sshOptions: event.target.value })} /></label>
                                  <label className="vibelink-settings-toggle vibelink-profile-toggle"><span>Allocate TTY (-t)</span><input type="checkbox" checked={profile.sshAllocateTty} onChange={(event) => updateProfile(profile.id, { sshAllocateTty: event.target.checked })} /></label>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </section>
                      )
                    })}
                  </div>
                </SettingsGroup>
              </>
            ) : null}

            {activeSection === 'integrations' ? (
              <SettingsGroup title="External editor" description="Explorer and large-diff actions append the selected absolute path to this command.">
                <label>
                  Editor command
                  <input value={draft.externalEditorCommand} placeholder="code" onChange={(event) => patchDraft({ externalEditorCommand: event.target.value })} />
                </label>
                <div className="vibelink-settings-note"><span>Leave empty to hide Open in Editor actions.</span></div>
              </SettingsGroup>
            ) : null}

            {activeSection === 'gitHosting' ? (
              <SettingsGroup title="GitHub & GitLab" description="Tokens stay in Windows Credential Manager and are scoped per host. Provider overrides support self-hosted instances.">
                <GitHostingSettings />
              </SettingsGroup>
            ) : null}

            {activeSection === 'remote' ? <RemoteSettings /> : null}

            {activeSection === 'safety' ? (
              <SettingsGroup title="Safety" description="VibeLink follows workspace-scoped process and agent safety rules.">
                <SettingsToggle label="Scoped process cleanup only" checked />
                <ReadonlyRow label="Policy" value="Never kill broad process image names; prove exact workspace ownership first." />
              </SettingsGroup>
            ) : null}

            {activeSection === 'memory' ? (
              <SettingsGroup title="Memory & Context" description="Native Hermes manages durable memory and compression.">
                <SettingsToggle label="Persistent memory" checked />
                <SettingsToggle label="Auto-compression" checked />
                <ReadonlyRow label="Context engine" value="Native Hermes / compressor" />
              </SettingsGroup>
            ) : null}

            {activeSection === 'voice' ? (
              <SettingsGroup title="Voice" description="Voice controls are reserved for a future VibeLink Agent provider.">
                <SettingsToggle label="Voice input" checked={false} disabled />
                <SettingsToggle label="Voice output" checked={false} disabled />
              </SettingsGroup>
            ) : null}

            {activeSection === 'advanced' ? (
              <>
                <SettingsGroup title="Capture" description="Screenshots use the capture folder; recordings auto-download ffmpeg on first use unless you set an override path.">
                  <label>Capture folder<input value={draft.captureDir} placeholder={defaultCaptureDir || 'Default capture folder'} onChange={(event) => patchDraft({ captureDir: event.target.value })} /></label>
                  <button type="button" onClick={() => void browseCaptureDir()}>Browse</button>
                  <label>ffmpeg path<input value={draft.captureFfmpegPath} placeholder="ffmpeg on PATH" onChange={(event) => patchDraft({ captureFfmpegPath: event.target.value })} /></label>
                  <button type="button" onClick={() => void testFfmpeg()}>Test ffmpeg</button>
                  {ffmpegStatus ? <ReadonlyRow label="ffmpeg" value={ffmpegStatus} /> : null}
                </SettingsGroup>
                <SettingsGroup title="Keybindings" description="Click a shortcut field and press the new combination.">
                  <button type="button" onClick={() => patchDraft({ keybindings: { ...defaultKeybindings } })}>Reset keybindings</button>
                  <div className="vibelink-keybinding-list">
                    {keybindingDefinitions.map((definition) => (
                      <label key={definition.id}>
                        {definition.label}
                        <input
                          value={draft.keybindings[definition.id]}
                          onChange={(event) => updateKeybinding(definition.id, event.target.value)}
                          onKeyDown={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            updateKeybinding(definition.id, eventToKeyChord(event.nativeEvent))
                          }}
                        />
                      </label>
                    ))}
                  </div>
                </SettingsGroup>
              </>
            ) : null}

            {activeSection === 'messaging' ? (
              <SettingsGroup title="Messaging" description="Messaging gateways (Telegram, Discord, Slack, WhatsApp…) are owned by your Hermes install.">
                <div className="vibelink-settings-actions">
                  <button type="button" disabled={!activeSessionId || !runtime?.detected} onClick={() => void openHermesGateway('setup')}>Set up gateway</button>
                  <button type="button" disabled={!activeSessionId || !runtime?.detected} onClick={() => void openHermesGateway('status')}>Gateway status</button>
                  <button type="button" disabled={!activeSessionId || !runtime?.detected} onClick={() => void openHermesGateway('run')}>Run gateway</button>
                </div>
                {!runtime?.detected ? <p>Install Hermes Agent to configure messaging.</p> : null}
              </SettingsGroup>
            ) : null}

            {activeSection === 'apiKeys' ? (
              <SettingsGroup title="API Keys" description="VibeLink does not store provider API keys. Native Hermes auth remains the source of truth.">
                <button type="button" disabled={!activeSessionId || authBusy} onClick={() => void refreshAuthList()}><RefreshCw size={14} /> Refresh auth list</button>
                <pre className="vibelink-settings-pre">{authList || 'No auth list loaded.'}</pre>
              </SettingsGroup>
            ) : null}

            {activeSection === 'mcp' ? (
              <SettingsGroup title="MCP servers" description="VibeLink registers its workspace MCP bridge per agent session over ACP; your Hermes config file is never modified.">
                <ReadonlyRow label="Server" value="vibelink" />
                <ReadonlyRow label="Command" value="app.exe mcp serve" mono />
                <ReadonlyRow label="Scope" value={activeSessionId ? `VIBELINK_SESSION_ID=${activeSessionId}` : 'Open a workspace'} mono />
                <div className="vibelink-settings-actions">
                  <button type="button" disabled={!activeSessionId || mcpCheckBusy} onClick={() => void checkMcp()}>
                    {mcpCheckBusy ? 'Checking…' : 'Run self-check'}
                  </button>
                </div>
                {mcpCheck ? (
                  <div className="setup-check-result" data-ok={mcpCheck.initializeOk ? 'true' : 'false'}>
                    <span>Spawn {mcpCheck.spawnOk ? 'OK' : 'failed'} · Initialize {mcpCheck.initializeOk ? 'OK' : 'failed'} · {mcpCheck.toolCount} tools</span>
                    {mcpCheck.error ? <pre>{mcpCheck.error}</pre> : null}
                  </div>
                ) : null}
              </SettingsGroup>
            ) : null}

            {activeSection === 'archived' ? (
              <SettingsGroup title="Archived Chats" description="Archived agent chats remain owned by your Hermes installation.">
                <ReadonlyRow label="Management" value="Use the VibeLink Agent session list to resume available sessions." />
              </SettingsGroup>
            ) : null}

            {activeSection === 'about' ? (
              <SettingsGroup title="About" description="VibeLink">
                <ReadonlyRow label="Product" value="VibeLink Agent / VibeLink" />
                <ReadonlyRow label="Runtime" value={runtime?.version ?? 'Unknown'} mono />
                <div className="vibelink-settings-actions">
                  <button type="button" onClick={onRunSetupWizard}>Run setup wizard again</button>
                </div>
              </SettingsGroup>
            ) : null}
          </div>

          <footer className="vibelink-settings-footer">
            <span>Changes are staged until Apply or OK.</span>
            <div>
              <button type="button" className="secondary-action" onClick={closeSettings}>Cancel</button>
              <button type="button" className="secondary-action" onClick={apply}>Apply</button>
              <button type="button" className="primary-action" onClick={ok}>OK</button>
            </div>
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

function SettingsGroup({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="vibelink-settings-group">
      <header>
        <h3>{title}</h3>
        <p>{description}</p>
      </header>
      <div className="vibelink-settings-group-body">{children}</div>
    </section>
  )
}

function ReadonlyRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="vibelink-settings-row">
      <span>{label}</span>
      <strong className={mono ? 'mono' : undefined}>{value}</strong>
    </div>
  )
}

function SettingsToggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange?: (checked: boolean) => void }) {
  return (
    <label className="vibelink-settings-toggle">
      <span>{label}</span>
      <input type="checkbox" checked={checked} disabled={disabled || !onChange} onChange={(event) => onChange?.(event.target.checked)} />
    </label>
  )
}

function SettingsSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <label>
      {label}
      <span className="vibelink-settings-select-shell">
        <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <ChevronDown size={14} />
      </span>
    </label>
  )
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
