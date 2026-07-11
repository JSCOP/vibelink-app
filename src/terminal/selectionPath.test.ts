import { describe, expect, it } from 'vitest'
import { pathFromTerminalSelection } from './selectionPath'

describe('pathFromTerminalSelection', () => {
  it('preserves spaces in a selected Windows installer path', () => {
    expect(pathFromTerminalSelection(String.raw`E:\VibeCodingProject\vibelink\vibelink-voice\src-tauri\target\release\bundle\nsis\VibeLink Voice_0.1.0_x64-setup.exe`)).toBe(
      String.raw`E:\VibeCodingProject\vibelink\vibelink-voice\src-tauri\target\release\bundle\nsis\VibeLink Voice_0.1.0_x64-setup.exe`,
    )
  })

  it('joins soft-wrapped terminal selection rows and removes matching quotes', () => {
    expect(pathFromTerminalSelection('"E:\\Build Output\\VibeLink Voice_0.1.0_\r\nx64-setup.exe"')).toBe(
      String.raw`E:\Build Output\VibeLink Voice_0.1.0_x64-setup.exe`,
    )
  })

  it('accepts UNC, Unix, and home-relative local paths', () => {
    expect(pathFromTerminalSelection(String.raw`\\server\share\Build Output\setup.exe`)).toBe(String.raw`\\server\share\Build Output\setup.exe`)
    expect(pathFromTerminalSelection('/tmp/build output/setup')).toBe('/tmp/build output/setup')
    expect(pathFromTerminalSelection('~/build output/setup')).toBe('~/build output/setup')
  })

  it('rejects commands, URLs, and invalid local path characters', () => {
    expect(pathFromTerminalSelection('git status --short')).toBeNull()
    expect(pathFromTerminalSelection('https://example.com/setup.exe')).toBeNull()
    expect(pathFromTerminalSelection(String.raw`E:\build\bad?.exe`)).toBeNull()
  })
})
