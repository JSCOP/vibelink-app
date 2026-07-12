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
    expect(defaultKeybindings.moveLeft).toBe('ctrl+shift+left')
    expect(defaultKeybindings.moveRight).toBe('ctrl+shift+right')
    expect(defaultKeybindings.moveUp).toBe('ctrl+shift+up')
    expect(defaultKeybindings.moveDown).toBe('ctrl+shift+down')
    expect(defaultKeybindings.copyTerminalContents).toBe('ctrl+a')
    expect(defaultKeybindings.copyTerminalSelection).toBe('ctrl+shift+c')
    expect(defaultKeybindings.captureImage).toBe('alt+shift+s')
    expect(defaultKeybindings.captureQuickImage).toBe('alt+s')
    expect(defaultKeybindings.captureVideo).toBe('alt+shift+r')
    expect(defaultKeybindings.toggleTerminalTabs).toBe('alt+shift+t')
    expect(defaultKeybindings.togglePaneReviewed).toBe('alt+shift+c')
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
    expect(normalized.captureQuickImage).toBe(defaultKeybindings.captureQuickImage)
    expect(normalized.toggleTerminalTabs).toBe(defaultKeybindings.toggleTerminalTabs)
    expect(normalized.togglePaneReviewed).toBe(defaultKeybindings.togglePaneReviewed)
  })

  it('migrates short-lived Alt+arrow focus bindings back to Ctrl+arrow defaults', () => {
    const normalized = normalizeKeybindings({
      focusLeft: 'alt+left',
      focusRight: 'Alt+ArrowRight',
      focusUp: 'alt+up',
      focusDown: 'alt+down',
    })

    expect(normalized.focusLeft).toBe('ctrl+left')
    expect(normalized.focusRight).toBe('ctrl+right')
    expect(normalized.focusUp).toBe('ctrl+up')
    expect(normalized.focusDown).toBe('ctrl+down')
  })

  it('migrates the previous capture image default to the new screenshot shortcut', () => {
    expect(normalizeKeybindings({ captureImage: 'alt+shift+c' }).captureImage).toBe('alt+shift+s')
  })

  it('preserves custom capture image bindings during normalization', () => {
    expect(normalizeKeybindings({ captureImage: 'ctrl+alt+p' }).captureImage).toBe('ctrl+alt+p')
  })

  it('preserves custom focus bindings during normalization', () => {
    const normalized = normalizeKeybindings({ focusLeft: 'ctrl+shift+1', focusRight: 'alt+shift+right' })

    expect(normalized.focusLeft).toBe('ctrl+shift+1')
    expect(normalized.focusRight).toBe('alt+shift+right')
  })

  it('converts keyboard events into stable lower-case chords', () => {
    const event = keyEvent({ key: 'ArrowLeft', ctrlKey: true })

    expect(eventToKeyChord(event)).toBe('ctrl+left')
  })

  it('finds matching actions from user settings', () => {
    expect(findKeybindingAction(defaultKeybindings, keyEvent({ key: 'w', ctrlKey: true }))).toBe('closePane')
    expect(findKeybindingAction(defaultKeybindings, keyEvent({ key: 'a', ctrlKey: true }))).toBe('copyTerminalContents')
    expect(findKeybindingAction(defaultKeybindings, keyEvent({ key: 'c', ctrlKey: true, shiftKey: true }))).toBe('copyTerminalSelection')
    expect(findKeybindingAction(defaultKeybindings, keyEvent({ key: 's', altKey: true, shiftKey: true }))).toBe('captureImage')
    expect(findKeybindingAction(defaultKeybindings, keyEvent({ key: 's', altKey: true }))).toBe('captureQuickImage')
    expect(findKeybindingAction(defaultKeybindings, keyEvent({ key: 'r', altKey: true, shiftKey: true }))).toBe('captureVideo')
    expect(findKeybindingAction(defaultKeybindings, keyEvent({ key: 't', altKey: true, shiftKey: true }))).toBe('toggleTerminalTabs')
    expect(findKeybindingAction(defaultKeybindings, keyEvent({ key: 'c', altKey: true, shiftKey: true }))).toBe('togglePaneReviewed')
  })

  it('maps Ctrl+Shift+arrow to directional pane movement', () => {
    expect(findKeybindingAction(defaultKeybindings, keyEvent({ key: 'ArrowLeft', ctrlKey: true, shiftKey: true }))).toBe('moveLeft')
    expect(findKeybindingAction(defaultKeybindings, keyEvent({ key: 'ArrowRight', ctrlKey: true, shiftKey: true }))).toBe('moveRight')
    expect(findKeybindingAction(defaultKeybindings, keyEvent({ key: 'ArrowUp', ctrlKey: true, shiftKey: true }))).toBe('moveUp')
    expect(findKeybindingAction(defaultKeybindings, keyEvent({ key: 'ArrowDown', ctrlKey: true, shiftKey: true }))).toBe('moveDown')
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

  it('handles Ctrl+arrow focus shortcuts from captured keydown events', () => {
    const seen: string[] = []
    const event = keyEvent({ key: 'ArrowLeft', ctrlKey: true })

    const handled = handleCapturedKeybindingEvent(defaultKeybindings, event, (action) => seen.push(action))

    expect(handled).toBe(true)
    expect(seen).toEqual(['focusLeft'])
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
  })

  it('does not intercept Alt+arrow so terminal word navigation reaches the PTY', () => {
    const seen: string[] = []
    const event = keyEvent({ key: 'ArrowLeft', altKey: true })

    const handled = handleCapturedKeybindingEvent(defaultKeybindings, event, (action) => seen.push(action))

    expect(handled).toBe(false)
    expect(seen).toEqual([])
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
  })

  it('does not intercept global-only capture shortcuts from terminal keydown events', () => {
    const seen: string[] = []
    const event = keyEvent({ key: 's', altKey: true })

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

  it('reserves Ctrl+1 through Ctrl+9 for workspace selection over custom pane bindings', () => {
    const seen: string[] = []
    const settings = { ...defaultKeybindings, focusLeft: 'ctrl+1' }
    const event = keyEvent({ key: '1', ctrlKey: true })

    const handled = handleCapturedKeybindingEvent(settings, event, (action) => seen.push(action))

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
