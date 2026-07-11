import { describe, expect, it, vi } from 'vitest'
import { waitForDockviewOverlayLayout } from './splitOverlayLayout'

describe('waitForDockviewOverlayLayout', () => {
  it('waits for two distinct animation frames before continuing a split layout', async () => {
    const callbacks: FrameRequestCallback[] = []
    const scheduleFrame = vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback)
      return callbacks.length
    })

    let settled = false
    const pending = waitForDockviewOverlayLayout(scheduleFrame).then(() => {
      settled = true
    })

    expect(scheduleFrame).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)

    callbacks.shift()?.(1)
    await Promise.resolve()
    expect(scheduleFrame).toHaveBeenCalledTimes(2)
    expect(settled).toBe(false)

    callbacks.shift()?.(2)
    await pending
    expect(settled).toBe(true)
  })
})
