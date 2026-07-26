import { describe, expect, test } from 'vitest'
import {
  builtInCompletionSounds,
  customCompletionSoundValidationError,
  defaultCompletionSoundId,
  hasNewCompletionHighlight,
  isCompletionSoundId,
  maxCustomCompletionSoundBytes,
} from './completionSounds'

describe('completion sounds', () => {
  test('ships a distinct built-in completion set with a valid default', () => {
    expect(builtInCompletionSounds.map((sound) => sound.id)).toEqual([
      'builtin:clear-chime',
      'builtin:soft-bell',
      'builtin:success-rise',
      'builtin:gentle-pulse',
    ])
    expect(isCompletionSoundId(defaultCompletionSoundId)).toBe(true)
  })

  test('accepts persisted built-in and custom ids while rejecting arbitrary values', () => {
    expect(isCompletionSoundId('builtin:soft-bell')).toBe(true)
    expect(isCompletionSoundId('custom:12345678-abcd')).toBe(true)
    expect(isCompletionSoundId('builtin:missing')).toBe(false)
    expect(isCompletionSoundId('custom:short')).toBe(false)
  })

  test('validates the supported custom audio formats and storage limit', () => {
    for (const name of ['done.mp3', 'done.wav', 'done.ogg', 'done.m4a', 'done.aac', 'done.flac']) {
      expect(customCompletionSoundValidationError({ name, size: 128 })).toBeNull()
    }
    expect(customCompletionSoundValidationError({ name: 'done.exe', size: 128 })).toMatch(/MP3/)
    expect(customCompletionSoundValidationError({ name: 'done.wav', size: 0 })).toMatch(/empty/)
    expect(customCompletionSoundValidationError({ name: 'done.wav', size: maxCustomCompletionSoundBytes + 1 })).toMatch(/10 MB/)
  })

  test('recognizes only newly created or refreshed completion highlights', () => {
    const previous = { paneA: { completedAt: 10 } }
    expect(hasNewCompletionHighlight(previous, previous)).toBe(false)
    expect(hasNewCompletionHighlight({ ...previous, paneB: { completedAt: 11 } }, previous)).toBe(true)
    expect(hasNewCompletionHighlight({ paneA: { completedAt: 12 } }, previous)).toBe(true)
    expect(hasNewCompletionHighlight({}, previous)).toBe(false)
  })
})
