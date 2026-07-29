import { describe, expect, it, vi } from 'vitest'
import { settleDockviewOverlayLayout, settleDockviewOverlayReposition, waitForDockviewOverlayLayout } from './splitOverlayLayout'

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

    expect(order).toEqual(['layout', 'refresh'])
    frames.shift()?.(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['layout', 'refresh', 'check', 'layout', 'refresh'])
    frames.shift()?.(2)
    await pending
    expect(order).toEqual(['layout', 'refresh', 'check', 'layout', 'refresh', 'check', 'complete'])
  })

  it('bounds unsettled overlay polling to twelve animation frames', async () => {
    const scheduleFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(scheduleFrame.mock.calls.length)
      return scheduleFrame.mock.calls.length
    })
    const layout = vi.fn()
    const refresh = vi.fn()
    const isSettled = vi.fn(() => false)
    const complete = vi.fn()

    await settleDockviewOverlayLayout({ layout, refresh, isSettled, complete }, scheduleFrame)

    expect(scheduleFrame).toHaveBeenCalledTimes(12)
    expect(layout).toHaveBeenCalledTimes(12)
    expect(refresh).toHaveBeenCalledTimes(12)
    expect(isSettled).toHaveBeenCalledTimes(12)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('repairs edge overlays without repeating the whole Dockview layout', async () => {
    const scheduleFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(scheduleFrame.mock.calls.length)
      return scheduleFrame.mock.calls.length
    })
    const refresh = vi.fn()
    const isSettled = vi.fn(() => isSettled.mock.calls.length === 2)
    const complete = vi.fn()

    await settleDockviewOverlayReposition({ refresh, isSettled, complete }, scheduleFrame)

    expect(scheduleFrame).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(isSettled).toHaveBeenCalledTimes(2)
    expect(complete).toHaveBeenCalledOnce()
  })
})
