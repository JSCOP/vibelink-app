import { describe, expect, it, vi } from 'vitest'
import { defaultKeybindings, eventToKeyChord, findKeybindingAction, handleCapturedKeybindingEvent, normalizeKeybindings } from './keybindings'

describe('keybindings', () => {
  it('uses Windows Terminal compatible defaults for pane close and focus movement', () => {
    expect(defaultKeybindings.closePane).toBe('ctrl+w')
    expect(defaultKeybindings.closeWorkspace).toBe('ctrl+shift+w')
    expect(defaultKeybindings.arrangePanes).toBe('ctrl+shift+g')
    expect(defaultKeybindings.focusLeft).toBe('ctrl+left')
    expect(defaultKeybindings.focusRight).toBe('ctrl+right')
    expect(defaultKeybindings.focusUp).toBe('ctrl+up')
    expect(defaultKeybindings.focusDown).toBe('ctrl+down')
    expect(defaultKeybindings.copyTerminalContents).toBe('ctrl+a')
    expect(defaultKeybindings.copyTerminalSelection).toBe('ctrl+shift+c')
    expect(defaultKeybindings.captureImage).toBe('alt+shift+c')
    expect(defaultKeybindings.captureVideo).toBe('alt+shift+r')
  })

  it('normalizes partial stored keybindings without dropping new defaults', () => {
    const normalized = normalizeKeybindings({ closePane: 'ctrl+q' })

    expect(normalized.closePane).toBe('ctrl+q')
    expect(normalized.closeWorkspace).toBe(defaultKeybindings.closeWorkspace)
    expect(normalized.arrangePanes).toBe(defaultKeybindings.arrangePanes)
    expect(normalized.focusLeft).toBe(defaultKeybindings.focusLeft)
    expect(normalized.copyTerminalContents).toBe(defaultKeybindings.copyTerminalContents)
    expect(normalized.copyTerminalSelection).toBe(defaultKeybindings.copyTerminalSelection)
    expect(normalized.captureImage).toBe(defaultKeybindings.captureImage)
    expect(normalized.captureVideo).toBe(defaultKeybindings.captureVideo)
  })

  it('converts keyboard events into stable lower-case chords', () => {
    const event = keyEvent({ key: 'ArrowLeft', ctrlKey: true })

    expect(eventToKeyChord(event)).toBe('ctrl+left')
  })

  it('finds matching actions from user settings', () => {
    expect(findKeybindingAction(defaultKeybindings, keyEvent({ key: 'w', ctrlKey: true }))).toBe('closePane')
    expect(findKeybindingAction(defaultKeybindings, keyEvent({ key: 'a', ctrlKey: true }))).toBe('copyTerminalContents')
    expect(findKeybindingAction(defaultKeybindings, keyEvent({ key: 'c', ctrlKey: true, shiftKey: true }))).toBe('copyTerminalSelection')
    expect(findKeybindingAction(defaultKeybindings, keyEvent({ key: 'c', altKey: true, shiftKey: true }))).toBe('captureImage')
    expect(findKeybindingAction(defaultKeybindings, keyEvent({ key: 'r', altKey: true, shiftKey: true }))).toBe('captureVideo')
  })

  it('does not intercept Ctrl+C so terminal interrupt reaches the PTY', () => {
    const seen: string[] = []
    const event = keyEvent({ key: 'c', ctrlKey: true })

    const handled = handleCapturedKeybindingEvent(defaultKeybindings, event, (action) => seen.push(action))

    expect(handled).toBe(false)
    expect(seen).toEqual([])
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
  })

  it('handles terminal copy shortcuts from captured keydown events', () => {
    const seen: string[] = []
    const event = keyEvent({ key: 'a', ctrlKey: true })

    const handled = handleCapturedKeybindingEvent(defaultKeybindings, event, (action) => seen.push(action))

    expect(handled).toBe(true)
    expect(seen).toEqual(['copyTerminalContents'])
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
  })

  it('handles selected terminal copy from captured keydown events before devtools shortcuts', () => {
    const seen: string[] = []
    const event = keyEvent({ key: 'c', ctrlKey: true, shiftKey: true })

    const handled = handleCapturedKeybindingEvent(defaultKeybindings, event, (action) => seen.push(action))

    expect(handled).toBe(true)
    expect(seen).toEqual(['copyTerminalSelection'])
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
  })

  it('does not consume terminal copy shortcuts when the action predicate rejects them', () => {
    const seen: string[] = []
    const event = keyEvent({ key: 'a', ctrlKey: true })

    const handled = handleCapturedKeybindingEvent(
      defaultKeybindings,
      event,
      (action) => seen.push(action),
      (action) => action !== 'copyTerminalContents',
    )

    expect(handled).toBe(false)
    expect(seen).toEqual([])
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
  })

  it('handles configured app shortcuts from captured terminal keydown events', () => {
    const seen: string[] = []
    const event = keyEvent({ key: 'w', ctrlKey: true })

    const handled = handleCapturedKeybindingEvent(defaultKeybindings, event, (action) => seen.push(action))

    expect(handled).toBe(true)
    expect(seen).toEqual(['closePane'])
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
  })

  it('lets ordinary terminal typing pass through captured keydown events', () => {
    const seen: string[] = []
    const event = keyEvent({ key: 'a' })

    const handled = handleCapturedKeybindingEvent(defaultKeybindings, event, (action) => seen.push(action))

    expect(handled).toBe(false)
    expect(seen).toEqual([])
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
  })

  it('ignores already-consumed keydown events', () => {
    const seen: string[] = []
    const event = keyEvent({ key: 'w', ctrlKey: true, defaultPrevented: true })

    const handled = handleCapturedKeybindingEvent(defaultKeybindings, event, (action) => seen.push(action))

    expect(handled).toBe(false)
    expect(seen).toEqual([])
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
  })

  function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
    return {
      key: '',
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      defaultPrevented: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...overrides,
    } as KeyboardEvent
  }
})
