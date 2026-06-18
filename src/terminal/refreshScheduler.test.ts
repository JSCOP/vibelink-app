import { describe, expect, it, vi } from 'vitest'
import { createTerminalRefreshScheduler } from './refreshScheduler'

describe('terminal refresh scheduler', () => {
  it('coalesces repeated layout refresh requests into one animation-frame refresh', () => {
    const refreshAll = vi.fn()
    let frame: FrameRequestCallback | undefined
    const schedule = createTerminalRefreshScheduler(refreshAll, (callback) => {
      frame = callback
      return 1
    })

    schedule()
    schedule()
    schedule()

    expect(refreshAll).not.toHaveBeenCalled()
    frame?.(0)
    expect(refreshAll).toHaveBeenCalledTimes(1)
  })
})
