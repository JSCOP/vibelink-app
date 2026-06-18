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

export function SettingsDialog({ settings, onChange, onClose }: SettingsDialogProps) {
  const [installedFonts, setInstalledFonts] = useState<string[]>([])
  const fontChoices = useMemo(() => normalizeFontChoices(installedFonts, settings.fontFamily), [installedFonts, settings.fontFamily])

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

  const updateKeybinding = (id: KeybindingActionId, chord: string) => {
    onChange({ keybindings: { ...settings.keybindings, [id]: chord } })
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
          <section className="settings-card settings-card-hero">
            <div>
              <h3>Terminal appearance</h3>
              <p>Font, scrollback, accent, and theme apply to live panes immediately.</p>
            </div>
            <div className="settings-preview" style={{ fontFamily: settings.fontFamily }}>
              <span>PS E:\\repo&gt;</span>
              <strong> codex --continue</strong>
            </div>
          </section>

          <section className="settings-card">
            <div className="settings-card-heading">
              <div>
                <h3>Font</h3>
                <p>Installed Windows fonts are loaded from the system registry, with terminal fallbacks kept available.</p>
              </div>
            </div>
            <label>
              Font family
              <select value={settings.fontFamily} onChange={(event) => onChange({ fontFamily: event.target.value })}>
                {fontChoices.map((font) => (
                  <option key={font} value={font}>{font}</option>
                ))}
              </select>
            </label>
            <div className="settings-grid-3">
              <label>
                Font size
                <input type="number" min="8" max="32" value={settings.fontSize} onChange={(event) => onChange({ fontSize: Number(event.target.value) })} />
              </label>
              <label>
                Scrollback
                <input type="number" min="100" max="200000" step="100" value={settings.scrollback} onChange={(event) => onChange({ scrollback: Number(event.target.value) })} />
              </label>
              <label>
                Accent
                <input type="color" value={settings.accent} onChange={(event) => onChange({ accent: event.target.value })} />
              </label>
            </div>
          </section>

          <section className="settings-card">
            <h3>Theme</h3>
            <p>Pick the terminal color palette independently from the app chrome.</p>
            <div className="theme-choice-grid">
              {terminalThemes.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  className={settings.terminalThemeId === theme.id ? 'selected' : ''}
                  onClick={() => onChange({ terminalThemeId: theme.id })}
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

          <section className="settings-card">
            <div className="settings-card-heading">
              <div>
                <h3>Keybindings</h3>
                <p>Click a shortcut field, press the new key combination, and it is saved immediately.</p>
              </div>
              <button type="button" onClick={() => onChange({ keybindings: { ...defaultKeybindings } })}>Reset</button>
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
                    value={settings.keybindings[definition.id]}
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
        </div>
      </section>
    </div>
  )
}
