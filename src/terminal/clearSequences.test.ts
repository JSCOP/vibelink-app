import { describe, expect, it } from 'vitest'
import { terminalOutputAfterLastHardClear, terminalQuerySequences, terminalStateSequences } from './clearSequences'

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

  it('replays a leave-alt-screen dropped before a hard clear', () => {
    // omp's /resume picker teardown: leave alt screen, then clear + repaint.
    // Dropping the prefix must not drop `?1049l`, or xterm stays stuck in the
    // alternate buffer (no scrollback, wheel swallowed) forever.
    const result = terminalOutputAfterLastHardClear(enc.encode('picker frame\x1b[?1049l\x1b[2Jtranscript'))

    expect(result.clear).toBe(true)
    expect(decode(result.bytes)).toBe('\x1b[?1049l\x1b[2Jtranscript')
  })

  it('replays mode toggles from the dropped prefix in their original order', () => {
    const input = 'x\x1b[?1049h\x1b[?1000hoverlay\x1b[?1000l\x1b[?1049ly\x1b[2Jafter'

    const result = terminalOutputAfterLastHardClear(enc.encode(input))

    expect(decode(result.bytes)).toBe('\x1b[?1049h\x1b[?1000h\x1b[?1000l\x1b[?1049l\x1b[2Jafter')
  })

  it('replays kitty keyboard state and cursor style but not queries', () => {
    const input = 'a\x1b[>1u\x1b[?u\x1b[5 qb\x1b[2Jafter'

    const result = terminalOutputAfterLastHardClear(enc.encode(input))

    expect(decode(result.bytes)).toBe('\x1b[>1u\x1b[5 q\x1b[2Jafter')
  })

  it('replays only the last dropped window title', () => {
    const input = '\x1b]0;first\x07text\x1b]0;second\x07more\x1b[2Jafter'

    const result = terminalOutputAfterLastHardClear(enc.encode(input))

    expect(decode(result.bytes)).toBe('\x1b]0;second\x07\x1b[2Jafter')
  })

  it('does not treat cursor moves or SGR as state to replay', () => {
    const input = '\x1b[10;10H\x1b[31mred\x1b[0m\x1b[2Jafter'

    const result = terminalOutputAfterLastHardClear(enc.encode(input))

    expect(decode(result.bytes)).toBe('\x1b[2Jafter')
  })

  it('keeps the agent-exit reset usable after prefix dropping', () => {
    // The managed agent profiles emit `?1049l` immediately before their clear
    // cluster; the leave-alt-screen must survive.
    const input = 'session tail\x1b[?1049l\x1b[2J\x1b[3J\x1b[H\x1b[?25h'

    const result = terminalOutputAfterLastHardClear(enc.encode(input))

    expect(decode(result.bytes)).toBe('\x1b[?1049l\x1b[2J\x1b[3J\x1b[H\x1b[?25h')
  })

  it('keeps the last-finishing clear of an overlapping clear cluster', () => {
    // `\x1b[1;1H` opens two clear candidates that never complete and the
    // `\x1b[H\x1b[J` behind it overlaps them. The retained tail must start at
    // the clear that finishes LAST, with its adjacent cluster pulled back in.
    const result = terminalOutputAfterLastHardClear(enc.encode('out\x1b[1;1H\x1b[H\x1b[J\x1b[3Jtail'))

    expect(result.clear).toBe(true)
    expect(decode(result.bytes)).toBe('\x1b[H\x1b[J\x1b[3Jtail')
  })

  it('ignores a clear candidate whose prefix never completes', () => {
    const result = terminalOutputAfterLastHardClear(enc.encode('\x1b[H\x1b[2Jtail'))

    expect(result.clear).toBe(true)
    expect(decode(result.bytes)).toBe('\x1b[2Jtail')
  })

  it.each([
    ['at the buffer start', '\x1b[2Jtail', '\x1b[2Jtail'],
    ['at the buffer end', 'head\x1b[2J', '\x1b[2J'],
    ['as the whole buffer', '\x1bc', '\x1bc'],
  ])('detects a hard clear %s', (_name, input, expected) => {
    const result = terminalOutputAfterLastHardClear(enc.encode(input))

    expect(result.clear).toBe(true)
    expect(decode(result.bytes)).toBe(expected)
  })

  it.each([
    ['erase', 'head\x1b[2'],
    ['cursor-home cluster', 'head\x1b[H\x1b['],
  ])('leaves a %s truncated by the buffer end alone', (_name, input) => {
    const bytes = enc.encode(input)

    const result = terminalOutputAfterLastHardClear(bytes)

    expect(result.clear).toBe(false)
    expect(result.bytes).toBe(bytes)
  })

  it('finds no hard clear in a large ESC-dense ANSI buffer', () => {
    // The cold-replay path runs this over a whole snapshot before it starts
    // yielding, so an ESC on every few bytes must not cost a rescan per clear
    // pattern — and must not produce a false positive either.
    const frame = '\x1b[38;5;196m\x1b[1m\x1b[10;20H\x1b[Kcell\x1b[0m\x1b]0;title\x07\x1b[?25l\x1b[?25h'
    const bytes = enc.encode(frame.repeat(4000))

    const result = terminalOutputAfterLastHardClear(bytes)

    expect(result.clear).toBe(false)
    expect(result.bytes).toBe(bytes)
  })

  it('finds a hard clear behind a large ESC-dense ANSI prefix', () => {
    const frame = '\x1b[38;5;196m\x1b[1m\x1b[10;20H\x1b[Kcell\x1b[0m'

    const result = terminalOutputAfterLastHardClear(enc.encode(`${frame.repeat(4000)}\x1b[2Jprompt`))

    expect(result.clear).toBe(true)
    expect(decode(result.bytes)).toBe('\x1b[2Jprompt')
  })
})

describe('terminalStateSequences', () => {
  it('collects state sequences from a discarded backlog chunk', () => {
    const input = enc.encode('junk\x1b[?1049htext\x1b[?25l\x1b(0more\x1b=end')

    const sequences = terminalStateSequences(input).map((bytes) => dec.decode(bytes))

    expect(sequences).toEqual(['\x1b[?1049h', '\x1b[?25l', '\x1b(0', '\x1b='])
  })

  it('returns nothing for plain output', () => {
    expect(terminalStateSequences(enc.encode('hello \x1b[31mred\x1b[0m'))).toEqual([])
  })
})

describe('terminalQuerySequences', () => {
  it('extracts answerable CSI, OSC, and DCS probes without visual or mode bytes', () => {
    const input = enc.encode([
      'visible',
      '\x1b[?1049h',
      '\x1b[c',
      '\x1b[6n',
      '\x1b[?2026$p',
      '\x1b[>0q',
      '\x1b[?u',
      '\x1b[18t',
      '\x1b]11;?\x07',
      '\x1bP+q544e\x1b\\',
      '\x1b[31m',
    ].join(''))

    const queries = terminalQuerySequences(input).map((bytes) => decode(bytes))

    expect(queries).toEqual([
      '\x1b[c',
      '\x1b[6n',
      '\x1b[?2026$p',
      '\x1b[>0q',
      '\x1b[?u',
      '\x1b[18t',
      '\x1b]11;?\x07',
      '\x1bP+q544e\x1b\\',
    ])
  })
})
