import { describe, expect, it } from 'vitest'
import { terminalOutputAfterLastHardClear } from './clearSequences'

const enc = new TextEncoder()
const dec = new TextDecoder()

const decode = (bytes: Uint8Array) => dec.decode(bytes)

describe('terminal clear sequence filtering', () => {
  it('keeps ordinary terminal output unchanged', () => {
    const bytes = enc.encode('before\nafter')

    const result = terminalOutputAfterLastHardClear(bytes)

    expect(result.clear).toBe(false)
    expect(result.bytes).toBe(bytes)
    expect(decode(result.bytes)).toBe('before\nafter')
  })

  it.each([
    ['CSI 2J', '\x1b[2Jafter', 'before\x1b[2Jafter'],
    ['CSI 3J', '\x1b[3Jafter', 'before\x1b[3Jafter'],
    ['RIS reset', '\x1bcafter', 'before\x1bcafter'],
    ['cursor-home plus erase-to-end', '\x1b[H\x1b[Jafter', 'before\x1b[H\x1b[Jafter'],
  ])('treats %s as a hard clear', (_name, expected, input) => {
    const result = terminalOutputAfterLastHardClear(enc.encode(input))

    expect(result.clear).toBe(true)
    expect(decode(result.bytes)).toBe(expected)
  })

  it('preserves adjacent hard clear clusters after dropping earlier output', () => {
    const result = terminalOutputAfterLastHardClear(enc.encode('before\x1b[2J\x1b[3Jafter'))

    expect(result.clear).toBe(true)
    expect(decode(result.bytes)).toBe('\x1b[2J\x1b[3Jafter')
  })

  it.each([
    ['enter alt screen', '\x1b[?1049h'],
    ['leave alt screen', '\x1b[?1049l'],
  ])('passes through %s as ordinary PTY bytes', (_name, sequence) => {
    const input = `before${sequence}after`

    const bytes = enc.encode(input)
    const result = terminalOutputAfterLastHardClear(bytes)

    expect(result.clear).toBe(false)
    expect(result.bytes).toBe(bytes)
    expect(decode(result.bytes)).toBe(input)
  })
})
