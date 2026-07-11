import { describe, expect, test, vi } from 'vitest'
import { loadSidebarPinned, saveSidebarPinned, SIDEBAR_PIN_STORAGE_KEY } from './sidebarPinState'

describe('sidebar pin persistence', () => {
  test('loads only the persisted pinned value', () => {
    expect(loadSidebarPinned({ getItem: () => '1' })).toBe(true)
    expect(loadSidebarPinned({ getItem: () => '0' })).toBe(false)
    expect(loadSidebarPinned({ getItem: () => null })).toBe(false)
  })

  test('stores pin and unpin transitions under the VibeLink key', () => {
    const setItem = vi.fn()

    saveSidebarPinned(true, { setItem })
    saveSidebarPinned(false, { setItem })

    expect(setItem).toHaveBeenNthCalledWith(1, SIDEBAR_PIN_STORAGE_KEY, '1')
    expect(setItem).toHaveBeenNthCalledWith(2, SIDEBAR_PIN_STORAGE_KEY, '0')
  })

  test('falls back safely when storage is unavailable', () => {
    expect(loadSidebarPinned({ getItem: () => { throw new Error('blocked') } })).toBe(false)
    expect(() => saveSidebarPinned(true, { setItem: () => { throw new Error('blocked') } })).not.toThrow()
  })
})
