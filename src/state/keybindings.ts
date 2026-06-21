export const keybindingActionIds = [
  'splitRight',
  'splitDown',
  'closePane',
  'closeWorkspace',
  'toggleMaximize',
  'arrangePanes',
  'nextTab',
  'previousTab',
  'focusLeft',
  'focusRight',
  'focusUp',
  'focusDown',
  'copyTerminalContents',
  'copyTerminalSelection',
  'captureImage',
  'captureVideo',
] as const

export type KeybindingActionId = (typeof keybindingActionIds)[number]
export type KeybindingSettings = Record<KeybindingActionId, string>

export type KeybindingDefinition = {
  id: KeybindingActionId
  label: string
  description: string
}

export const keybindingDefinitions: KeybindingDefinition[] = [
  { id: 'splitRight', label: 'Split pane right', description: 'Create a pane to the right of the active pane.' },
  { id: 'splitDown', label: 'Split pane down', description: 'Create a pane below the active pane.' },
  { id: 'closePane', label: 'Close pane', description: 'Close the active pane.' },
  { id: 'closeWorkspace', label: 'Close workspace', description: 'Close the active workspace.' },
  { id: 'toggleMaximize', label: 'Toggle pane zoom', description: 'Maximize or restore the active pane.' },
  { id: 'arrangePanes', label: 'Arrange all panes', description: 'Reflow all panes into a balanced grid without creating or closing panes.' },
  { id: 'nextTab', label: 'Next tab', description: 'Move to the next tab or pane.' },
  { id: 'previousTab', label: 'Previous tab', description: 'Move to the previous tab or pane.' },
  { id: 'focusLeft', label: 'Focus pane left', description: 'Move focus to the pane on the left.' },
  { id: 'focusRight', label: 'Focus pane right', description: 'Move focus to the pane on the right.' },
  { id: 'focusUp', label: 'Focus pane up', description: 'Move focus to the pane above.' },
  { id: 'focusDown', label: 'Focus pane down', description: 'Move focus to the pane below.' },
  { id: 'copyTerminalContents', label: 'Copy terminal contents', description: 'Select all terminal buffer text and copy it to the clipboard.' },
  { id: 'copyTerminalSelection', label: 'Copy terminal selection', description: 'Copy the currently selected terminal text.' },
  { id: 'captureImage', label: 'Capture image', description: 'Open the region selector for a screenshot.' },
  { id: 'captureVideo', label: 'Capture video', description: 'Open the region selector for a screen recording.' },
]

export const defaultKeybindings: KeybindingSettings = {
  splitRight: 'alt+shift+v',
  splitDown: 'alt+shift+h',
  closePane: 'ctrl+w',
  closeWorkspace: 'ctrl+shift+w',
  toggleMaximize: 'alt+z',
  arrangePanes: 'ctrl+shift+g',
  nextTab: 'ctrl+tab',
  previousTab: 'ctrl+pgup',
  focusLeft: 'ctrl+left',
  focusRight: 'ctrl+right',
  focusUp: 'ctrl+up',
  focusDown: 'ctrl+down',
  copyTerminalContents: 'ctrl+a',
  copyTerminalSelection: 'ctrl+shift+c',
  captureImage: 'alt+shift+c',
  captureVideo: 'alt+shift+r',
}

export function normalizeKeybindings(value: unknown): KeybindingSettings {
  const record = isRecord(value) ? value : undefined
  const normalized = { ...defaultKeybindings }
  for (const id of keybindingActionIds) {
    const value = record?.[id]
    if (typeof value === 'string') {
      normalized[id] = normalizeKeyChord(value)
    }
  }
  return normalized
}

export function findKeybindingAction(settings: KeybindingSettings, event: KeyboardEvent): KeybindingActionId | null {
  const chord = eventToKeyChord(event)
  return keybindingActionIds.find((id) => settings[id] === chord) ?? null
}

export function handleCapturedKeybindingEvent(
  settings: KeybindingSettings,
  event: KeyboardEvent,
  onAction: (action: KeybindingActionId) => void,
  shouldHandleAction?: (action: KeybindingActionId) => boolean,
): boolean {
  if (event.defaultPrevented) return false
  const action = findKeybindingAction(settings, event)
  if (!action || shouldHandleAction?.(action) === false) return false
  event.preventDefault()
  event.stopPropagation()
  onAction(action)
  return true
}

export function eventToKeyChord(event: KeyboardEvent): string {
  const parts: string[] = []
  if (event.ctrlKey) parts.push('ctrl')
  if (event.altKey) parts.push('alt')
  if (event.shiftKey) parts.push('shift')
  if (event.metaKey) parts.push('win')
  parts.push(normalizeKeyName(event.key))
  return parts.join('+')
}

export function normalizeKeyChord(chord: string): string {
  return chord
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map(normalizeKeyName)
    .join('+')
}

function normalizeKeyName(key: string): string {
  const lower = key.toLowerCase()
  if (lower.startsWith('arrow')) return lower.slice('arrow'.length)
  if (lower === 'escape') return 'esc'
  if (lower === ' ') return 'space'
  if (lower === 'pageup') return 'pgup'
  if (lower === 'pagedown') return 'pgdn'
  return lower
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
