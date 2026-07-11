import { describe, expect, test } from 'vitest'
import { MAX_NUMBERED_WORKSPACE_SHORTCUTS, workspaceForShortcut, workspaceShortcutIndex } from './workspaceShortcuts'

describe('workspaceShortcutIndex', () => {
  test('maps Ctrl+1 through Ctrl+9 to zero-based workspace positions', () => {
    expect(workspaceShortcutIndex(keyEvent('1'))).toBe(0)
    expect(workspaceShortcutIndex(keyEvent('4'))).toBe(3)
    expect(workspaceShortcutIndex(keyEvent('9'))).toBe(8)
    expect(MAX_NUMBERED_WORKSPACE_SHORTCUTS).toBe(9)
  })

  test('selects from the current persisted workspace order', () => {
    const ordered = ['workspace-c', 'workspace-a', 'workspace-b']

    expect(workspaceForShortcut(keyEvent('1'), ordered)).toBe('workspace-c')
    expect(workspaceForShortcut(keyEvent('3'), ordered)).toBe('workspace-b')
    expect(workspaceForShortcut(keyEvent('4'), ordered)).toBeNull()
  })

  test('rejects zero, non-digits, and extra modifiers', () => {
    expect(workspaceShortcutIndex(keyEvent('0'))).toBeNull()
    expect(workspaceShortcutIndex(keyEvent('a'))).toBeNull()
    expect(workspaceShortcutIndex(keyEvent('1', { ctrlKey: false }))).toBeNull()
    expect(workspaceShortcutIndex(keyEvent('1', { altKey: true }))).toBeNull()
    expect(workspaceShortcutIndex(keyEvent('1', { shiftKey: true }))).toBeNull()
    expect(workspaceShortcutIndex(keyEvent('1', { metaKey: true }))).toBeNull()
  })
})

function keyEvent(key: string, overrides: Partial<KeyboardEvent> = {}) {
  return {
    key,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...overrides,
  } as KeyboardEvent
}
