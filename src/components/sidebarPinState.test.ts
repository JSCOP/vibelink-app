import { describe, expect, test, vi } from 'vitest'
import { loadSidebarPinned, saveSidebarPinned, SIDEBAR_PIN_STORAGE_KEY } from './sidebarPinState'

describe('sidebar pin persistence', () => {
  test('defaults to pinned while preserving an explicit current-version choice', () => {
    expect(loadSidebarPinned({ getItem: () => '1' })).toBe(true)
    expect(loadSidebarPinned({ getItem: () => '0' })).toBe(false)
    expect(loadSidebarPinned({ getItem: () => null })).toBe(true)
  })

  test('stores pin and unpin transitions under the current-version VibeLink key', () => {
    const setItem = vi.fn()
    expect(SIDEBAR_PIN_STORAGE_KEY).toBe('vibelink:sidebarPinned:v2')

    saveSidebarPinned(true, { setItem })
    saveSidebarPinned(false, { setItem })

    expect(setItem).toHaveBeenNthCalledWith(1, SIDEBAR_PIN_STORAGE_KEY, '1')
    expect(setItem).toHaveBeenNthCalledWith(2, SIDEBAR_PIN_STORAGE_KEY, '0')
  })

  test('falls back to the visible pinned sidebar when storage is unavailable', () => {
    expect(loadSidebarPinned({ getItem: () => { throw new Error('blocked') } })).toBe(true)
    expect(() => saveSidebarPinned(true, { setItem: () => { throw new Error('blocked') } })).not.toThrow()
  })
})
