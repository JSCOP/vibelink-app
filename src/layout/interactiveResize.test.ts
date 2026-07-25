import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginInteractiveResize,
  endInteractiveResize,
  isDividerResizeActive,
  isInteractiveResizeActive,
  onInteractiveResizeEnd,
  resetInteractiveResizeForTests,
} from './interactiveResize'

afterEach(() => resetInteractiveResizeForTests())

describe('interactive resize signal', () => {
  it('reports a divider drag as both divider-active and interactive', () => {
    beginInteractiveResize('divider')

    expect(isDividerResizeActive()).toBe(true)
    expect(isInteractiveResizeActive()).toBe(true)
  })

  it('never reports a native window resize as a divider drag', () => {
    // A window resize really did change the container, so forced re-layout must
    // still run for it; only a divider drag owns the geometry itself.
    beginInteractiveResize('window')

    expect(isDividerResizeActive()).toBe(false)
    expect(isInteractiveResizeActive()).toBe(true)
  })

  it('stays active until every nested begin of that kind is ended', () => {
    beginInteractiveResize('divider')
    beginInteractiveResize('divider')
    endInteractiveResize('divider')

    expect(isDividerResizeActive()).toBe(true)

    endInteractiveResize('divider')

    expect(isDividerResizeActive()).toBe(false)
  })

  it('notifies end listeners once with the finished kind', () => {
    const listener = vi.fn()
    onInteractiveResizeEnd(listener)

    beginInteractiveResize('divider')
    endInteractiveResize('divider')

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith('divider')
  })

  it('does not fire the end listener while the other kind is still running', () => {
    // A window drag-resize can overlap a divider drag; each kind settles alone.
    const listener = vi.fn()
    onInteractiveResizeEnd(listener)

    beginInteractiveResize('divider')
    beginInteractiveResize('window')
    endInteractiveResize('divider')

    expect(listener).toHaveBeenCalledWith('divider')
    expect(isInteractiveResizeActive()).toBe(true)
    expect(isDividerResizeActive()).toBe(false)
  })

  it('ignores an unbalanced end so a stray pointerup cannot go negative', () => {
    const listener = vi.fn()
    onInteractiveResizeEnd(listener)

    endInteractiveResize('divider')

    expect(listener).not.toHaveBeenCalled()
    expect(isInteractiveResizeActive()).toBe(false)

    beginInteractiveResize('divider')
    expect(isDividerResizeActive()).toBe(true)
  })

  it('stops notifying after a listener unsubscribes', () => {
    const listener = vi.fn()
    const unsubscribe = onInteractiveResizeEnd(listener)
    unsubscribe()

    beginInteractiveResize('divider')
    endInteractiveResize('divider')

    expect(listener).not.toHaveBeenCalled()
  })
})
