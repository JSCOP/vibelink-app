import { describe, expect, it } from 'vitest'
import { syncSafeWriteLength } from './syncOutputFrames'

const enc = new TextEncoder()
const BSU = '\x1b[?2026h'
const ESU = '\x1b[?2026l'
const MAX_FRAME = 1024 * 1024

const queue = (...parts: string[]) => parts.map((part) => enc.encode(part))

describe('syncSafeWriteLength', () => {
  it('writes the plain byte budget when nothing wraps a synchronized frame', () => {
    expect(syncSafeWriteLength(queue('x'.repeat(100)), 16, MAX_FRAME)).toBe(16)
    expect(syncSafeWriteLength(queue('x'.repeat(10)), 16, MAX_FRAME)).toBe(10)
  })

  it('extends the write to the frame end instead of cutting mid-frame', () => {
    const frame = `${BSU}${'F'.repeat(200)}${ESU}`
    const bytes = enc.encode(frame).byteLength

    // Budget 16 lands deep inside the frame; the whole frame is already queued.
    expect(syncSafeWriteLength(queue(frame), 16, MAX_FRAME)).toBe(bytes)
    // Trailing bytes after the frame stay for the next write.
    expect(syncSafeWriteLength(queue(`${frame}tail`), 16, MAX_FRAME)).toBe(bytes)
  })

  it('holds a frame whose end has not arrived yet', () => {
    // Everything queued is one unterminated frame: nothing is safe to write.
    expect(syncSafeWriteLength(queue(`${BSU}${'F'.repeat(200)}`), 16, MAX_FRAME)).toBe(0)
    // Bytes that precede the frame are still safe; the frame itself waits.
    expect(syncSafeWriteLength(queue(`done\r\n${BSU}${'F'.repeat(200)}`), 16, MAX_FRAME)).toBe(6)
  })

  it('matches a frame marker split across queued pieces', () => {
    // `ESC[?2026h` straddles the first two pieces; the frame must still be seen
    // and held at its start (offset 6) rather than cut at the 16-byte budget.
    expect(syncSafeWriteLength(queue('done\r\n\x1b[?20', '26h', 'F'.repeat(200)), 16, MAX_FRAME)).toBe(6)
  })

  it('never treats the support query as a frame marker', () => {
    expect(syncSafeWriteLength(queue(`\x1b[?2026$p${'x'.repeat(100)}`), 16, MAX_FRAME)).toBe(16)
  })

  it('gives up on a frame larger than the cap rather than stalling the pane', () => {
    expect(syncSafeWriteLength(queue(`${BSU}${'F'.repeat(4096)}`), 16, 1024)).toBe(16)
  })

  it('keeps cutting on boundaries across a run of frames', () => {
    const frame = `${BSU}${'F'.repeat(50)}${ESU}`
    const one = enc.encode(frame).byteLength

    // Two complete frames queued, budget inside the first: stop after the first.
    expect(syncSafeWriteLength(queue(frame, frame), 16, MAX_FRAME)).toBe(one)
    // Budget past both frames and outside either: the budget wins.
    expect(syncSafeWriteLength(queue(frame, frame), one + 5, MAX_FRAME)).toBe(one + 5)
  })
})
