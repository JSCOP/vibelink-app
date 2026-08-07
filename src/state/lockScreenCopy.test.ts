import { describe, expect, test } from 'vitest'
import { APP_LOCK_REASONS, lockScreenCopy } from './lockScreenCopy'

describe('lockScreenCopy', () => {
  test('provides complete copy for every app lock reason', () => {
    expect(APP_LOCK_REASONS).toEqual([
      'unlicensed',
      'trialExpired',
      'activationLimit',
      'reviewRequired',
      'invalid',
      'revoked',
      'configurationError',
    ])
    for (const reason of APP_LOCK_REASONS) {
      const copy = lockScreenCopy(reason, true)
      expect(copy.heading.trim()).not.toBe('')
      expect(copy.body.trim()).not.toBe('')
      expect(copy.primary.label.trim()).not.toBe('')
    }
  })

  test('marks purchase unavailable when no checkout URL is configured', () => {
    const copy = lockScreenCopy('trialExpired', false)
    expect(copy.primary.kind).toBe('purchase')
    expect(copy.primary.available).toBe(false)
    expect(copy.primary.unavailableReason).toBeTruthy()
  })
})
