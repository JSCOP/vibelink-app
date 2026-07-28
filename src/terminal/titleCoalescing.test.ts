import { describe, expect, it } from 'vitest'
import { PaneTitleCoalescer, TITLE_COALESCE_MS, paneTitleSignature } from './titleCoalescing'

/** Deterministic clock/timer pair: the coalescer's whole contract is "how many
 *  emits per unit time", which a real timer cannot assert without flaking. */
function harness() {
  let now = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  let nextHandle = 1
  const coalescer = new PaneTitleCoalescer({
    now: () => now,
    setTimer: (callback, delayMs) => {
      const handle = nextHandle++
      timers.set(handle, { at: now + delayMs, callback })
      return handle
    },
    clearTimer: (handle) => { timers.delete(handle) },
  })
  const advance = (ms: number) => {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = due[1].at
      due[1].callback()
    }
    now = target
  }
  return { coalescer, advance }
}

describe('paneTitleSignature', () => {
  it('treats every braille spinner frame as the same title', () => {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    const signatures = new Set(frames.map((glyph) => paneTitleSignature(`π ${glyph} Orca Logic Analysis`)))
    expect(signatures.size).toBe(1)
  })

  it('keeps genuinely different titles distinct', () => {
    expect(paneTitleSignature('π ⠋ Build')).not.toBe(paneTitleSignature('π ⠋ Deploy'))
  })

  it('collapses trailing dot animations', () => {
    expect(paneTitleSignature('Working.')).toBe(paneTitleSignature('Working...'))
  })
})

describe('PaneTitleCoalescer', () => {
  it('emits a spinner storm exactly once instead of once per frame', () => {
    const { coalescer, advance } = harness()
    const emitted: string[] = []
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

    // 100 spinner ticks at 80ms — an agent animating for 8 seconds.
    for (let i = 0; i < 100; i += 1) {
      coalescer.submit('pane-1', `π ${frames[i % frames.length]} Analysis`, (title) => emitted.push(title))
      advance(80)
    }

    expect(emitted).toEqual(['π ⠋ Analysis'])
  })

  it('delivers the first real title immediately', () => {
    const { coalescer } = harness()
    const emitted: string[] = []
    coalescer.submit('pane-1', 'π ⠋ Analysis', (title) => emitted.push(title))
    expect(emitted).toEqual(['π ⠋ Analysis'])
  })

  it('rate-limits a rapidly changing real title to one emit per window', () => {
    const { coalescer, advance } = harness()
    const emitted: string[] = []

    coalescer.submit('pane-1', 'step 1', (title) => emitted.push(title))
    expect(emitted).toEqual(['step 1'])

    // Ten distinct titles inside one window collapse to the newest.
    for (let i = 2; i <= 11; i += 1) {
      coalescer.submit('pane-1', `step ${i}`, (title) => emitted.push(title))
      advance(10)
    }
    advance(TITLE_COALESCE_MS)

    expect(emitted).toEqual(['step 1', 'step 11'])
  })

  it('never loses the final title of a burst', () => {
    const { coalescer, advance } = harness()
    const emitted: string[] = []
    coalescer.submit('pane-1', 'first', (title) => emitted.push(title))
    coalescer.submit('pane-1', 'middle', (title) => emitted.push(title))
    coalescer.submit('pane-1', 'settled', (title) => emitted.push(title))
    advance(TITLE_COALESCE_MS * 2)
    expect(emitted[emitted.length - 1]).toBe('settled')
  })

  it('keeps panes independent', () => {
    const { coalescer } = harness()
    const emitted: string[] = []
    coalescer.submit('pane-1', 'π ⠋ A', (title) => emitted.push(`1:${title}`))
    coalescer.submit('pane-2', 'π ⠋ B', (title) => emitted.push(`2:${title}`))
    expect(emitted).toEqual(['1:π ⠋ A', '2:π ⠋ B'])
  })

  it('drops a disposed pane\'s pending emit', () => {
    const { coalescer, advance } = harness()
    const emitted: string[] = []
    coalescer.submit('pane-1', 'first', (title) => emitted.push(title))
    coalescer.submit('pane-1', 'queued', (title) => emitted.push(title))
    coalescer.clear('pane-1')
    advance(TITLE_COALESCE_MS * 2)
    expect(emitted).toEqual(['first'])
  })
})
