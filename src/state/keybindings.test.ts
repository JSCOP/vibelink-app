import { describe, expect, it } from 'vitest'
import { defaultKeybindings, eventToKeyChord, findKeybindingAction, normalizeKeybindings } from './keybindings'

describe('keybindings', () => {
  it('uses Windows Terminal compatible defaults for pane close and focus movement', () => {
    expect(defaultKeybindings.closePane).toBe('ctrl+w')
    expect(defaultKeybindings.closeWorkspace).toBe('ctrl+shift+w')
    expect(defaultKeybindings.focusLeft).toBe('ctrl+left')
    expect(defaultKeybindings.focusRight).toBe('ctrl+right')
    expect(defaultKeybindings.focusUp).toBe('ctrl+up')
    expect(defaultKeybindings.focusDown).toBe('ctrl+down')
  })

  it('normalizes partial stored keybindings without dropping new defaults', () => {
    const normalized = normalizeKeybindings({ closePane: 'ctrl+q' })

    expect(normalized.closePane).toBe('ctrl+q')
    expect(normalized.closeWorkspace).toBe(defaultKeybindings.closeWorkspace)
    expect(normalized.focusLeft).toBe(defaultKeybindings.focusLeft)
  })

  it('converts keyboard events into stable lower-case chords', () => {
    const event = keyEvent({ key: 'ArrowLeft', ctrlKey: true })

    expect(eventToKeyChord(event)).toBe('ctrl+left')
  })

  it('finds matching actions from user settings', () => {
    const event = keyEvent({ key: 'w', ctrlKey: true })

    expect(findKeybindingAction(defaultKeybindings, event)).toBe('closePane')
  })

  function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
    return {
      key: '',
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      ...overrides,
    } as KeyboardEvent
  }
})
