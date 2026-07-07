import { describe, expect, it } from 'vitest'
import { isTerminalHostMeasurable, terminalHostBecameMeasurable, terminalHostMeasureState } from './geometry'

describe('terminal host geometry', () => {
  it('does not treat zero-sized dockview hosts as ready for fitting', () => {
    expect(isTerminalHostMeasurable({ width: 0, height: 320 })).toBe(false)
    expect(isTerminalHostMeasurable({ width: 640, height: 0 })).toBe(false)
  })

  it('treats visible dockview hosts as ready for fitting', () => {
    expect(isTerminalHostMeasurable({ width: 640, height: 320 })).toBe(true)
  })

  it('tracks zero-to-positive host transitions for renderer recovery', () => {
    const hidden = terminalHostMeasureState({ width: 0, height: 320 })
    const visible = terminalHostMeasureState({ width: 640, height: 320 })

    expect(hidden).toBe('unmeasurable')
    expect(visible).toBe('measurable')
    expect(terminalHostBecameMeasurable(hidden, visible)).toBe(true)
    expect(terminalHostBecameMeasurable(undefined, visible)).toBe(false)
    expect(terminalHostBecameMeasurable(visible, visible)).toBe(false)
  })
})
