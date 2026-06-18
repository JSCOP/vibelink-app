import { describe, expect, it } from 'vitest'
import { isTerminalHostMeasurable } from './geometry'

describe('terminal host geometry', () => {
  it('does not treat zero-sized dockview hosts as ready for fitting', () => {
    expect(isTerminalHostMeasurable({ width: 0, height: 320 })).toBe(false)
    expect(isTerminalHostMeasurable({ width: 640, height: 0 })).toBe(false)
  })

  it('treats visible dockview hosts as ready for fitting', () => {
    expect(isTerminalHostMeasurable({ width: 640, height: 320 })).toBe(true)
  })
})
