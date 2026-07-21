import { describe, expect, it, vi } from 'vitest'
import { settleDockviewOverlayLayout, waitForDockviewOverlayLayout } from './splitOverlayLayout'

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
  it('retries an outer maximize layout until its overlay matches the group', async () => {
    const frames: FrameRequestCallback[] = []
    const scheduleFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const order: string[] = []
    let checks = 0
    const pending = settleDockviewOverlayLayout({
      layout: () => order.push('layout'),
      refresh: () => order.push('refresh'),
      isSettled: () => {
        order.push('check')
        checks += 1
        return checks === 2
      },
      complete: () => order.push('complete'),
    }, scheduleFrame)

    expect(order).toEqual(['layout'])
    frames.shift()?.(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['layout', 'refresh', 'check'])
    frames.shift()?.(2)
    await pending
    expect(order).toEqual(['layout', 'refresh', 'check', 'refresh', 'check', 'complete'])
  })
})
