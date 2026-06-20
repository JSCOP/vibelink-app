import { invoke } from '@tauri-apps/api/core'
import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { ProfileIcon } from './ProfileIcon'
import { profileIconNames } from '../state/profileIcons'
import { defaultKeybindings, eventToKeyChord, keybindingDefinitions, type KeybindingActionId } from '../state/keybindings'
import { normalizeFontChoices, terminalFontStack } from '../state/fonts'
import { joinCommandLine, splitCommandLine, type Profile, type ProfileKind, type Settings } from '../state/profiles'
import { terminalThemes } from '../state/terminalThemes'

type SettingsDialogProps = {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onClose: () => void
}

type SettingsSection = 'appearance' | 'layout' | 'profiles' | 'theme' | 'keybindings'

const sectionLabels: Record<SettingsSection, string> = {
  appearance: 'Appearance',
  layout: 'Layout',
  profiles: 'Profiles',
  theme: 'Theme',
  keybindings: 'Keybindings',
}

const sectionDescriptions: Record<SettingsSection, string> = {
  appearance: 'Font and scrollback',
  layout: 'Pane resize',
  profiles: 'Shell, SSH, commands',
  theme: 'Color palettes',
  keybindings: 'Shortcuts',
}

const fontWeightOptions = [100, 200, 300, 400, 500, 600, 700, 800, 900]
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
  const fontChoices = useMemo(() => normalizeFontChoices(installedFonts, draft.fontFamily), [installedFonts, draft.fontFamily])
  const editingProfile = draft.profiles.find((profile) => profile.id === editingProfileId) ?? draft.profiles[0]

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
                    <p>Font, scrollback, scrollbar, and accent apply when you press Apply or OK.</p>
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
                      Accent
                      <input type="color" value={draft.accent} onChange={(event) => patchDraft({ accent: event.target.value })} />
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
                <h3>Pane resize</h3>
                <div className="settings-grid-4">
                  <label>
                    Snap distance
                    <input type="number" min="0" max="128" step="1" value={draft.resizeSnapTolerance} onChange={(event) => patchDraft({ resizeSnapTolerance: Number(event.target.value) })} />
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
                <p>Windows Terminal-inspired palettes plus AWT custom themes.</p>
                <div className="theme-choice-grid expanded">
                  {terminalThemes.map((theme) => (
                    <button
                      key={theme.id}
                      type="button"
                      className={draft.terminalThemeId === theme.id ? 'selected' : ''}
                      onClick={() => patchDraft({ terminalThemeId: theme.id })}
                    >
                      <span className="theme-swatch" style={{ background: theme.theme.background, color: theme.theme.foreground, borderColor: theme.theme.cursor }}>
                        Aa
                      </span>
                      <span>
                        <strong>{theme.name}</strong>
                        <small>{theme.description}</small>
                      </span>
                    </button>
                  ))}
                </div>
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
