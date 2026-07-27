import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  builtInCompletionSounds,
  customCompletionSoundValidationError,
  defaultCompletionSoundId,
  hasNewCompletionHighlight,
  isCompletionSoundId,
  maxCustomCompletionSoundBytes,
  playCompletionSound,
  prepareCompletionSoundPlayback,
} from './completionSounds'

const originalAudioContext = globalThis.AudioContext

afterEach(() => {
  vi.restoreAllMocks()
  if (originalAudioContext) vi.stubGlobal('AudioContext', originalAudioContext)
  else vi.unstubAllGlobals()
})
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

  test('primes and reuses one audio context for later completion playback', async () => {
    let created = 0
    let resumed = 0
    class FakeAudioContext {
      currentTime = 0
      destination = {}
      state: AudioContextState = 'suspended'
      constructor() { created += 1 }
      createGain() {
        return {
          connect: vi.fn(),
          gain: {
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
        }
      }
      createOscillator() {
        return {
          connect: vi.fn(),
          frequency: { setValueAtTime: vi.fn() },
          start: vi.fn(),
          stop: vi.fn(),
          type: 'sine' as OscillatorType,
        }
      }
      async resume() { resumed += 1; this.state = 'running' as AudioContextState }
      async close() { this.state = 'closed' as AudioContextState }
    }
    vi.stubGlobal('AudioContext', FakeAudioContext)

    expect(await prepareCompletionSoundPlayback()).toBe(true)
    expect(await playCompletionSound({ completionSoundEnabled: true, completionSoundId: defaultCompletionSoundId, completionSoundVolume: 0.55 })).toBe(true)
    expect(created).toBe(1)
    expect(resumed).toBe(1)
  })
})
