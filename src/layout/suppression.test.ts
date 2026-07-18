import { describe, expect, test } from 'vitest'
import { withAllowedPanelRemoval, withSuppressedPanelRemoval } from './suppression'

describe('withSuppressedPanelRemoval', () => {
  test('resets suppression when async work rejects', async () => {
    const ref = { current: false }

    await expect(withSuppressedPanelRemoval(ref, async () => {
      expect(ref.current).toBe(true)
      throw new Error('spawn failed')
    })).rejects.toThrow('spawn failed')

    expect(ref.current).toBe(false)
  })

  test('temporarily allows removal and restores prior suppression', async () => {
    const ref = { current: true }

    await withAllowedPanelRemoval(ref, async () => {
      expect(ref.current).toBe(false)
    })

    expect(ref.current).toBe(true)
  })
})
