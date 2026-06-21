import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { ProfileIcon } from './ProfileIcon'
import { HermesGatewayForm } from './HermesGatewayForm'
import { profileIconNames } from '../state/profileIcons'
import { defaultKeybindings, eventToKeyChord, keybindingDefinitions, type KeybindingActionId } from '../state/keybindings'
import { normalizeFontChoices, terminalFontStack } from '../state/fonts'
import { joinCommandLine, splitCommandLine, type Profile, type ProfileKind, type Settings } from '../state/profiles'
import { terminalThemeDefinitionById, terminalThemeGroups, type RequiredTerminalTheme, type TerminalThemeId } from '../state/terminalThemes'
import type { HermesRuntimeStatus, HermesWorkspaceState } from '../ipc/types'
import { useWorkspaceStore } from '../state/store'

type SettingsDialogProps = {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onClose: () => void
}

type SettingsSection = 'appearance' | 'layout' | 'profiles' | 'theme' | 'keybindings' | 'capture' | 'hermes'

const sectionLabels: Record<SettingsSection, string> = {
  appearance: 'Appearance',
  layout: 'Layout',
  profiles: 'Profiles',
  theme: 'Theme',
  keybindings: 'Keybindings',
  capture: 'Capture',
  hermes: 'Hermes',
}

const sectionDescriptions: Record<SettingsSection, string> = {
  appearance: 'Font and scrollback',
  layout: 'Pane resize and headers',
  profiles: 'Shell, SSH, commands',
  theme: 'Color palettes',
  keybindings: 'Shortcuts',
  capture: 'Screenshot & recording',
  hermes: 'Agent runtime',
}

const fontWeightOptions = [100, 200, 300, 400, 500, 600, 700, 800, 900]
const themePreviewAnsiKeys = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const
const profileKindLabels: Record<ProfileKind, string> = {
  local: 'Local shell',
  ssh: 'SSH remote',
  command: 'Command',
}


export function SettingsDialog({ settings, onChange, onClose }: SettingsDialogProps) {
  const [draft, setDraft] = useState(settings)
  const [activeSection, setActiveSection] = useState<SettingsSection>('appearance')
  const [editingProfileId, setEditingProfileId] = useState(settings.defaultProfileId)
  const [installedFonts, setInstalledFonts] = useState<string[]>([])
  const [hermesRuntime, setHermesRuntime] = useState<HermesRuntimeStatus | null>(null)
  const [hermesRuntimeBusy, setHermesRuntimeBusy] = useState(false)
  const [hermesRuntimeMessage, setHermesRuntimeMessage] = useState('')
  const [agentHome, setAgentHome] = useState('')
  const [workspaceState, setWorkspaceState] = useState<HermesWorkspaceState | null>(null)
  const [defaultDir, setDefaultDir] = useState('')
  const [captureFolderBusy, setCaptureFolderBusy] = useState(false)
  const [ffmpegTestStatus, setFfmpegTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle')
  const [ffmpegTestMessage, setFfmpegTestMessage] = useState('')
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const sessions = useWorkspaceStore((state) => state.sessions)
  const fontChoices = useMemo(() => normalizeFontChoices(installedFonts, draft.fontFamily), [installedFonts, draft.fontFamily])
  const editingProfile = draft.profiles.find((profile) => profile.id === editingProfileId) ?? draft.profiles[0]
  const selectedTheme = terminalThemeDefinitionById(draft.terminalThemeId)
  const activeSession = activeSessionId ? sessions.find((session) => session.id === activeSessionId) : undefined
  const workspaceModel = workspaceState?.model ?? null

  useEffect(() => {
    let cancelled = false
    void invoke<string[]>('list_installed_fonts')
      .then((fonts) => {
        if (!cancelled) setInstalledFonts(fonts)
      })
      .catch(() => {
        if (!cancelled) setInstalledFonts([])
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    void invoke<string>('default_capture_dir')
      .then((dir) => {
        if (!cancelled) setDefaultDir(dir)
      })
      .catch(() => {
        if (!cancelled) setDefaultDir('')
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (activeSection !== 'hermes') return
    let cancelled = false
    void invoke<HermesRuntimeStatus>('hermes_runtime_status', { commandOverride: draft.hermesCommand || null })
      .then((status) => {
        if (!cancelled) setHermesRuntime(status)
      })
      .catch((error) => {
        if (!cancelled) setHermesRuntime({ installed: false, command: draft.hermesCommand || 'hermes-acp', version: String(error) })
      })
    return () => { cancelled = true }
  }, [activeSection, draft.hermesCommand])

  useEffect(() => {
    if (activeSection !== 'hermes' || !activeSessionId) return
    let cancelled = false
    void invoke<HermesWorkspaceState>('hermes_workspace_state', { sessionId: activeSessionId })
      .then((state) => {
        if (!cancelled) {
          setWorkspaceState(state)
          setAgentHome(state.home)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setWorkspaceState(null)
          setAgentHome(String(error))
        }
      })
    return () => { cancelled = true }
  }, [activeSection, activeSessionId])


  const patchDraft = (patch: Partial<Settings>) => setDraft((current) => ({ ...current, ...patch }))
  const updateKeybinding = (id: KeybindingActionId, chord: string) => {
    patchDraft({ keybindings: { ...draft.keybindings, [id]: chord } })
  }
  const updateProfile = (profileId: string, patch: Partial<Profile>) => {
    setDraft((current) => ({
      ...current,
      profiles: current.profiles.map((profile) => profile.id === profileId ? { ...profile, ...patch } : profile),
    }))
  }
  const addProfile = (type: ProfileKind) => {
    const profile = createProfile(type, draft.profiles)
    patchDraft({ profiles: [...draft.profiles, profile] })
    setEditingProfileId(profile.id)
  }
  const deleteProfile = (profileId: string) => {
    if (draft.profiles.length <= 1) return
    const profiles = draft.profiles.filter((profile) => profile.id !== profileId)
    const defaultProfileId = draft.defaultProfileId === profileId ? profiles[0].id : draft.defaultProfileId
    patchDraft({ profiles, defaultProfileId })
    setEditingProfileId(defaultProfileId)
  }
  const installHermesRuntime = async () => {
    setHermesRuntimeBusy(true)
    setHermesRuntimeMessage('Installing Hermes runtime…')
    try {
      const command = await invoke<string>('hermes_install_runtime')
      const status = await invoke<HermesRuntimeStatus>('hermes_runtime_status', { commandOverride: draft.hermesCommand || null })
      setHermesRuntime(status)
      setHermesRuntimeMessage(`Installed: ${command}`)
    } catch (error) {
      setHermesRuntimeMessage(String(error))
    } finally {
      setHermesRuntimeBusy(false)
    }
  }
  const browseCaptureDir = async () => {
    setCaptureFolderBusy(true)
    try {
      const selected = await open({ directory: true, multiple: false, title: 'Select capture folder' })
      if (typeof selected === 'string') patchDraft({ captureDir: selected })
    } finally {
      setCaptureFolderBusy(false)
    }
  }
  const testFfmpeg = async () => {
    setFfmpegTestStatus('testing')
    setFfmpegTestMessage('Checking…')
    try {
      await invoke('check_ffmpeg', { ffmpegPath: draft.captureFfmpegPath })
      setFfmpegTestStatus('ok')
      setFfmpegTestMessage('OK')
    } catch (error) {
      setFfmpegTestStatus('error')
      setFfmpegTestMessage(String(error))
    }
  }
  const apply = () => onChange(draft)
  const ok = () => {
    onChange(draft)
    onClose()
  }

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-dialog-header">
          <div>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button type="button" className="settings-close" title="Close settings" onClick={onClose}>
            <X size={14} />
          </button>
        </header>

        <div className="settings-dialog-body">
          <nav className="settings-section-nav" aria-label="Settings sections">
            {(Object.keys(sectionLabels) as SettingsSection[]).map((section) => (
              <button key={section} type="button" className={activeSection === section ? 'selected' : ''} onClick={() => setActiveSection(section)}>
                {sectionLabels[section]}
                <span>{sectionDescriptions[section]}</span>
              </button>
            ))}
          </nav>

          <div className="settings-section-content">
            {activeSection === 'appearance' ? (
              <>
                <section className="settings-card settings-card-hero">
                  <div>
                    <h3>Terminal appearance</h3>
                    <p>Font, scrollback, scrollbar, and theme apply when you press Apply or OK.</p>
                  </div>
                  <div className="settings-preview" style={{ fontFamily: terminalFontStack(draft.fontFamily), fontWeight: draft.terminalFontWeight }}>
                    <span>PS E:\\repo&gt;</span>
                    <strong style={{ fontWeight: Math.min(900, Math.max(draft.terminalFontWeight, 700)) }}> 한글 │ Nerd Font ✓</strong>
                  </div>
                </section>

                <section className="settings-card">
                  <div className="settings-card-heading">
                    <div>
                      <h3>Font</h3>
                      <p>Installed Windows fonts are loaded from the system registry. D2CodingLigature Nerd Font Mono is preferred for Korean and Nerd Font glyphs.</p>
                    </div>
                  </div>
                  <label>
                    Font family
                    <select value={draft.fontFamily} onChange={(event) => patchDraft({ fontFamily: event.target.value })}>
                      {fontChoices.map((font) => (
                        <option key={font} value={font}>{font}</option>
                      ))}
                    </select>
                  </label>
                  <div className="settings-grid-4">
                    <label>
                      Font size
                      <input type="number" min="8" max="32" value={draft.fontSize} onChange={(event) => patchDraft({ fontSize: Number(event.target.value) })} />
                    </label>
                    <label>
                      Font weight
                      <select value={draft.terminalFontWeight} onChange={(event) => patchDraft({ terminalFontWeight: Number(event.target.value) })}>
                        {fontWeightOptions.map((weight) => (
                          <option key={weight} value={weight}>{weight}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Scrollback
                      <input type="number" min="100" max="200000" step="100" value={draft.scrollback} onChange={(event) => patchDraft({ scrollback: Number(event.target.value) })} />
                    </label>
                    <label>
                      UI scale
                      <input type="number" min="0.85" max="1.2" step="0.05" value={draft.uiScale} onChange={(event) => patchDraft({ uiScale: Number(event.target.value) })} />
                    </label>
                  </div>
                  <label className="settings-checkbox">
                    <input type="checkbox" checked={draft.terminalScrollbarVisible} onChange={(event) => patchDraft({ terminalScrollbarVisible: event.target.checked })} />
                    <span><strong>Show terminal scrollbars</strong><small>Hide only the visual scrollbar; scrollback remains available.</small></span>
                  </label>
                </section>
              </>
            ) : null}

            {activeSection === 'layout' ? (
              <section className="settings-card">
                <h3>Pane layout</h3>
                <div className="settings-grid-4">
                  <label>
                    Snap distance
                    <input type="number" min="0" max="128" step="1" value={draft.resizeSnapTolerance} onChange={(event) => patchDraft({ resizeSnapTolerance: Number(event.target.value) })} />
                  </label>
                  <label>
                    Header height
                    <input type="number" min="24" max="56" step="1" value={draft.paneHeaderHeight} onChange={(event) => patchDraft({ paneHeaderHeight: Number(event.target.value) })} />
                  </label>
                </div>
              </section>
            ) : null}

            {activeSection === 'profiles' && editingProfile ? (
              <section className="settings-card profile-editor-card">
                <div className="settings-card-heading">
                  <div>
                    <h3>Profiles</h3>
                    <p>Create local shell, SSH remote terminal, or arbitrary command profiles. New panes use the active topbar profile.</p>
                  </div>
                  <div className="profile-actions">
                    <button type="button" onClick={() => addProfile('local')}>Add local</button>
                    <button type="button" onClick={() => addProfile('ssh')}>Add SSH</button>
                    <button type="button" onClick={() => addProfile('command')}>Add command</button>
                  </div>
                </div>

                <div className="profile-editor">
                  <div className="profile-list" aria-label="Terminal profiles">
                    {draft.profiles.map((profile) => (
                      <button key={profile.id} type="button" className={profile.id === editingProfile.id ? 'selected' : ''} onClick={() => setEditingProfileId(profile.id)}>
                        <span className="profile-list-icon" style={{ color: profile.color }}><ProfileIcon name={profile.icon} size={18} /></span>
                        <span>
                          <strong>{profile.name}</strong>
                          <small>{profileKindLabels[profile.type]}{profile.id === draft.defaultProfileId ? ' · default' : ''}</small>
                        </span>
                      </button>
                    ))}
                  </div>

                  <div className="profile-form">
                    <div className="settings-grid-4">
                      <label>
                        Name
                        <input value={editingProfile.name} onChange={(event) => updateProfile(editingProfile.id, { name: event.target.value })} />
                      </label>
                      <label>
                        Type
                        <select value={editingProfile.type} onChange={(event) => updateProfile(editingProfile.id, { type: event.target.value as ProfileKind })}>
                          <option value="local">Local shell</option>
                          <option value="ssh">SSH remote</option>
                          <option value="command">Command</option>
                        </select>
                      </label>
                      <label>
                        Color
                        <input type="color" value={editingProfile.color} onChange={(event) => updateProfile(editingProfile.id, { color: event.target.value })} />
                      </label>
                    </div>
                    <div className="icon-picker">
                      <span className="icon-picker-label">Icon</span>
                      <div className="icon-picker-grid">
                        {profileIconNames.map((name) => (
                          <button
                            key={name}
                            type="button"
                            className={editingProfile.icon === name ? 'selected' : ''}
                            style={editingProfile.icon === name ? { color: editingProfile.color } : undefined}
                            title={name}
                            aria-label={name}
                            onClick={() => updateProfile(editingProfile.id, { icon: name })}
                          >
                            <ProfileIcon name={name} size={16} />
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="settings-grid-3">
                      <label>
                        Working directory
                        <input value={editingProfile.cwd ?? ''} placeholder="Session folder or default" onChange={(event) => updateProfile(editingProfile.id, { cwd: event.target.value.trim() || null })} />
                      </label>
                      <button type="button" className="secondary-action" onClick={() => patchDraft({ defaultProfileId: editingProfile.id })}>Set as default</button>
                      <button type="button" className="secondary-action danger" disabled={draft.profiles.length <= 1} onClick={() => deleteProfile(editingProfile.id)}>Delete profile</button>
                    </div>

                    {editingProfile.type === 'local' ? (
                      <div className="profile-fieldset">
                        <h4>Local shell</h4>
                        <div className="settings-grid-3">
                          <label>
                            Executable
                            <input value={editingProfile.shell ?? ''} placeholder="Default shell" onChange={(event) => updateProfile(editingProfile.id, { shell: event.target.value.trim() || null })} />
                          </label>
                          <label>
                            Arguments
                            <input key={editingProfile.id} defaultValue={joinCommandLine(editingProfile.args)} placeholder="--flag value" onChange={(event) => updateProfile(editingProfile.id, { args: splitCommandLine(event.target.value) })} />
                          </label>
                        </div>
                      </div>
                    ) : null}

                    {editingProfile.type === 'ssh' ? (
                      <div className="profile-fieldset">
                        <h4>SSH remote terminal</h4>
                        <div className="settings-grid-4">
                          <label>
                            Host
                            <input value={editingProfile.sshHost} placeholder="server.example.com" onChange={(event) => updateProfile(editingProfile.id, { sshHost: event.target.value })} />
                          </label>
                          <label>
                            User
                            <input value={editingProfile.sshUser} placeholder="optional" onChange={(event) => updateProfile(editingProfile.id, { sshUser: event.target.value })} />
                          </label>
                          <label>
                            Port
                            <input type="number" min="1" max="65535" value={editingProfile.sshPort ?? ''} placeholder="22" onChange={(event) => updateProfile(editingProfile.id, { sshPort: readPortInput(event.target.value) })} />
                          </label>
                          <label>
                            Identity file
                            <input value={editingProfile.sshIdentityFile ?? ''} placeholder="C:\\Users\\me\\.ssh\\id_ed25519" onChange={(event) => updateProfile(editingProfile.id, { sshIdentityFile: event.target.value.trim() || null })} />
                          </label>
                        </div>
                        <label>
                          Extra SSH options
                          <input value={editingProfile.sshOptions} placeholder="-o ServerAliveInterval=30" onChange={(event) => updateProfile(editingProfile.id, { sshOptions: event.target.value })} />
                        </label>
                        <label>
                          Remote folder
                          <input value={editingProfile.sshRemoteCwd ?? ''} placeholder="/home/me/project" onChange={(event) => updateProfile(editingProfile.id, { sshRemoteCwd: event.target.value.trim() || null })} />
                        </label>
                        <label>
                          Remote command
                          <textarea rows={2} value={editingProfile.sshRemoteCommand} placeholder="tmux attach || tmux" onChange={(event) => updateProfile(editingProfile.id, { sshRemoteCommand: event.target.value })} />
                        </label>
                        <label className="settings-checkbox">
                          <input type="checkbox" checked={editingProfile.sshAllocateTty} onChange={(event) => updateProfile(editingProfile.id, { sshAllocateTty: event.target.checked })} />
                          <span><strong>Allocate a remote TTY</strong><small>Adds -t so remote shells and tmux behave like terminals.</small></span>
                        </label>
                      </div>
                    ) : null}

                    {editingProfile.type === 'command' ? (
                      <div className="profile-fieldset">
                        <h4>Startup command</h4>
                        <label>
                          Command line
                          <textarea rows={2} value={editingProfile.command} placeholder="pnpm dev" onChange={(event) => updateProfile(editingProfile.id, { command: event.target.value })} />
                        </label>
                      </div>
                    ) : null}

                    <label>
                      Environment
                      <textarea rows={4} value={formatEnv(editingProfile.env)} placeholder="NAME=value" onChange={(event) => updateProfile(editingProfile.id, { env: parseEnv(event.target.value) })} />
                    </label>
                  </div>
                </div>
              </section>
            ) : null}

            {activeSection === 'theme' ? (
              <section className="settings-card">
                <h3>Theme</h3>
                <p>Choose one palette for app chrome, settings, and pane tabs. Terminal panes keep the Codex/Claude-friendly dark palette.</p>
                <label>
                  Theme
                  <select value={draft.terminalThemeId} onChange={(event) => patchDraft({ terminalThemeId: event.target.value as TerminalThemeId })}>
                    {terminalThemeGroups.map((group) => (
                      <optgroup key={group.category} label={group.category}>
                        {group.themes.map((theme) => (
                          <option key={theme.id} value={theme.id}>{theme.name}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <ThemePreview theme={selectedTheme.terminal} name={selectedTheme.name} description={selectedTheme.description} />
              </section>
            ) : null}

            {activeSection === 'keybindings' ? (
              <section className="settings-card">
                <div className="settings-card-heading">
                  <div>
                    <h3>Keybindings</h3>
                    <p>Click a shortcut field, press the new key combination, then Apply or OK.</p>
                  </div>
                  <button type="button" onClick={() => patchDraft({ keybindings: { ...defaultKeybindings } })}>Reset</button>
                </div>
                <div className="keybinding-list">
                  {keybindingDefinitions.map((definition) => (
                    <div key={definition.id} className="keybinding-row">
                      <div>
                        <strong>{definition.label}</strong>
                        <span>{definition.description}</span>
                      </div>
                      <input
                        aria-label={`${definition.label} shortcut`}
                        value={draft.keybindings[definition.id]}
                        onChange={(event) => updateKeybinding(definition.id, event.target.value)}
                        onKeyDown={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          updateKeybinding(definition.id, eventToKeyChord(event.nativeEvent))
                        }}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
            {activeSection === 'capture' ? (
              <section className="settings-card">
                <div className="settings-card-heading">
                  <div>
                    <h3>Capture</h3>
                    <p>Choose where screenshots and recordings are saved, and optionally pin the ffmpeg executable used for video capture.</p>
                  </div>
                </div>
                <div className="settings-grid-3">
                  <label>
                    Capture folder
                    <input
                      value={draft.captureDir}
                      placeholder={defaultDir || 'Default capture folder'}
                      onChange={(event) => patchDraft({ captureDir: event.target.value })}
                    />
                  </label>
                  <button type="button" className="secondary-action" disabled={captureFolderBusy} onClick={() => void browseCaptureDir()}>
                    {captureFolderBusy ? 'Browsing…' : 'Browse'}
                  </button>
                </div>
                {!draft.captureDir && defaultDir ? <p>{`Default: ${defaultDir}\\Images and \\Video`}</p> : null}
                <div className="settings-grid-3">
                  <label>
                    ffmpeg path
                    <input
                      value={draft.captureFfmpegPath}
                      placeholder="ffmpeg on PATH"
                      onChange={(event) => {
                        patchDraft({ captureFfmpegPath: event.target.value })
                        setFfmpegTestStatus('idle')
                        setFfmpegTestMessage('')
                      }}
                    />
                  </label>
                  <button type="button" className="secondary-action" disabled={ffmpegTestStatus === 'testing'} onClick={() => void testFfmpeg()}>
                    {ffmpegTestStatus === 'testing' ? 'Testing…' : 'Test'}
                  </button>
                  {ffmpegTestMessage ? <p role="status" aria-live="polite">{ffmpegTestStatus === 'ok' ? 'OK' : ffmpegTestMessage}</p> : null}
                </div>
              </section>
            ) : null}

            {activeSection === 'hermes' ? (
              <>
                <section className="settings-card">
                  <div className="settings-card-heading">
                    <div>
                      <h3>Workspace agent{activeSession ? ` — ${activeSession.name}` : ''}</h3>
                      <p>This workspace uses native Hermes model and auth configuration. Use Orchestrator → Configure model &amp; login to change provider, login, or model.</p>
                    </div>
                  </div>
                  {activeSessionId ? (
                    <div className="settings-grid-3">
                      <div className="settings-status">
                        <strong>{workspaceModel ? `${workspaceModel.provider} / ${workspaceModel.model}` : 'Not configured — use Orchestrator → Configure model & login'}</strong>
                        <span>{workspaceModel?.baseUrl || 'Native Hermes config.yaml'}</span>
                        <small>HERMES_HOME: {agentHome || 'resolving…'}</small>
                      </div>
                    </div>
                  ) : <p>Open a workspace to inspect its agent.</p>}
                </section>

                <section className="settings-card">
                  <div className="settings-card-heading">
                    <div>
                      <h3>Hermes runtime</h3>
                      <p>AWT uses Hermes ACP for the chat UI. The managed runtime is installed under app data; Orchestrator shows the exact Hermes CLI and workspace HERMES_HOME paths.</p>
                    </div>
                    <button type="button" onClick={installHermesRuntime} disabled={hermesRuntimeBusy}>
                      {hermesRuntimeBusy ? 'Installing…' : 'Install / update Hermes runtime'}
                    </button>
                  </div>
                  <div className="settings-grid-4">
                    <label>
                      hermes-acp command override
                      <input
                        value={draft.hermesCommand}
                        placeholder="hermes-acp"
                        onChange={(event) => patchDraft({ hermesCommand: event.target.value })}
                      />
                    </label>
                    <div className="settings-status">
                      <strong>{hermesRuntime?.installed ? 'Installed' : 'Not installed'}</strong>
                      <span>{hermesRuntime?.command ?? 'hermes-acp'}</span>
                      {hermesRuntime?.version ? <small>{hermesRuntime.version}</small> : null}
                      {hermesRuntimeMessage ? <small>{hermesRuntimeMessage}</small> : null}
                    </div>
                  </div>
                </section>

                <section className="settings-card">
                  <div className="settings-card-heading">
                    <div>
                      <h3>Messaging gateway</h3>
                      {activeSessionId ? <p>Configure messaging for {activeSession?.name ?? 'the active workspace'}.</p> : <p>Open a workspace to configure its messaging gateway.</p>}
                    </div>
                  </div>
                  {activeSessionId ? <HermesGatewayForm sessionId={activeSessionId} /> : null}
                </section>

              </>
            ) : null}
          </div>
        </div>

        <footer className="settings-dialog-footer">
          <span>Changes are staged until Apply or OK.</span>
          <div className="settings-dialog-footer-actions">
            <button type="button" className="secondary-action" onClick={onClose}>Cancel</button>
            <button type="button" className="secondary-action" onClick={apply}>Apply</button>
            <button type="button" className="primary-action" onClick={ok}>OK</button>
          </div>
        </footer>
      </section>
    </div>
  )
}


function ThemePreview({ theme, name, description }: { theme: RequiredTerminalTheme; name: string; description: string }) {
  return (
    <div className="theme-preview-panel" style={{ background: theme.background, color: theme.foreground, borderColor: theme.selectionBackground }}>
      <div className="theme-preview-header">
        <span className="theme-preview-swatch" style={{ background: theme.background, color: theme.foreground, borderColor: theme.cursor }}>Aa</span>
        <span>
          <strong>{name}</strong>
          <small>{description}</small>
        </span>
      </div>
      <div className="theme-preview-terminal" style={{ background: theme.background, color: theme.foreground }}>
        <span style={{ color: theme.cursor }}>PS E:\repo&gt;</span>
        <strong> pnpm test</strong>
        <small style={{ color: theme.brightBlack }}> 24 palettes loaded</small>
      </div>
      <div className="theme-preview-colors" aria-hidden="true">
        {themePreviewAnsiKeys.map((key) => (
          <span key={key} style={{ background: theme[key] }} />
        ))}
      </div>
    </div>
  )
}

function createProfile(type: ProfileKind, existing: Profile[]): Profile {
  const id = nextProfileId(type, existing)
  return {
    id,
    name: type === 'ssh' ? 'SSH' : type === 'command' ? 'Command' : 'Shell',
    type,
    shell: null,
    args: [],
    command: '',
    sshHost: '',
    sshUser: '',
    sshPort: null,
    sshIdentityFile: null,
    sshRemoteCommand: '',
    sshRemoteCwd: null,
    sshOptions: '',
    sshAllocateTty: true,
    env: [],
    cwd: null,
    color: type === 'ssh' ? '#76e3ea' : type === 'command' ? '#f2cc60' : '#7ee787',
    icon: type === 'ssh' ? 'radio-tower' : type === 'command' ? 'play' : 'terminal',
  }
}

function nextProfileId(type: ProfileKind, existing: Profile[]): string {
  const base = type === 'local' ? 'profile' : type
  let id = base
  let suffix = 2
  while (existing.some((profile) => profile.id === id)) {
    id = `${base}-${suffix}`
    suffix += 1
  }
  return id
}

function readPortInput(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  const port = Number(trimmed)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

function formatEnv(env: [string, string][]): string {
  return env.map(([key, value]) => `${key}=${value}`).join('\n')
}

function parseEnv(value: string): [string, string][] {
  return value.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf('=')
    if (separator <= 0) return []
    const key = line.slice(0, separator).trim()
    if (key.length === 0) return []
    return [[key, line.slice(separator + 1)] as [string, string]]
  })
}
