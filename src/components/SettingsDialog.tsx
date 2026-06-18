import { X } from 'lucide-react'
import { defaultKeybindings, eventToKeyChord, keybindingDefinitions, type KeybindingActionId } from '../state/keybindings'
import type { Settings } from '../state/profiles'

type SettingsDialogProps = {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onClose: () => void
}

export function SettingsDialog({ settings, onChange, onClose }: SettingsDialogProps) {
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
          <section className="settings-card">
            <h3>Terminal appearance</h3>
            <p>Defaults mirror this machine's Windows Terminal PowerShell profile.</p>
            <label>
              Font family
              <input value={settings.fontFamily} onChange={(event) => onChange({ fontFamily: event.target.value })} />
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
