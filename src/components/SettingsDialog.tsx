import { invoke } from '@tauri-apps/api/core'
import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { defaultKeybindings, eventToKeyChord, keybindingDefinitions, type KeybindingActionId } from '../state/keybindings'
import { normalizeFontChoices } from '../state/fonts'
import type { Settings } from '../state/profiles'
import { terminalThemes } from '../state/terminalThemes'

type SettingsDialogProps = {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onClose: () => void
}

type SettingsSection = 'appearance' | 'theme' | 'keybindings'

const sectionLabels: Record<SettingsSection, string> = {
  appearance: 'Appearance',
  theme: 'Theme',
  keybindings: 'Keybindings',
}

export function SettingsDialog({ settings, onChange, onClose }: SettingsDialogProps) {
  const [draft, setDraft] = useState(settings)
  const [activeSection, setActiveSection] = useState<SettingsSection>('appearance')
  const [installedFonts, setInstalledFonts] = useState<string[]>([])
  const fontChoices = useMemo(() => normalizeFontChoices(installedFonts, draft.fontFamily), [installedFonts, draft.fontFamily])

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
            <p className="settings-eyebrow">Control deck</p>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button type="button" className="settings-close" title="Close settings" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="settings-dialog-body">
          <nav className="settings-section-nav" aria-label="Settings sections">
            {(Object.keys(sectionLabels) as SettingsSection[]).map((section) => (
              <button key={section} type="button" className={activeSection === section ? 'selected' : ''} onClick={() => setActiveSection(section)}>
                {sectionLabels[section]}
                <span>{section === 'appearance' ? 'Font and scrollback' : section === 'theme' ? 'Color palettes' : 'Shortcuts'}</span>
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
                  <div className="settings-preview" style={{ fontFamily: draft.fontFamily }}>
                    <span>PS E:\\repo&gt;</span>
                    <strong> 한글 │ Nerd Font ✓</strong>
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
                  <div className="settings-grid-3">
                    <label>
                      Font size
                      <input type="number" min="8" max="32" value={draft.fontSize} onChange={(event) => patchDraft({ fontSize: Number(event.target.value) })} />
                    </label>
                    <label>
                      Scrollback
                      <input type="number" min="100" max="200000" step="100" value={draft.scrollback} onChange={(event) => patchDraft({ scrollback: Number(event.target.value) })} />
                    </label>
                    <label>
                      Accent
                      <input type="color" value={draft.accent} onChange={(event) => patchDraft({ accent: event.target.value })} />
                    </label>
                  </div>
                  <label className="settings-checkbox">
                    <input type="checkbox" checked={draft.terminalScrollbarVisible} onChange={(event) => patchDraft({ terminalScrollbarVisible: event.target.checked })} />
                    <span><strong>Show terminal scrollbars</strong><small>Hide only the visual scrollbar; scrollback remains available.</small></span>
                  </label>
                </section>
              </>
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
