import { describe, expect, it } from 'vitest'
import { isDevelopmentRuntime, runtimeIdentityFor } from './runtimeIdentity'

describe('isDevelopmentRuntime', () => {
  it('honors explicit build flavor before the Vite mode fallback', () => {
    expect(isDevelopmentRuntime('dev', false)).toBe(true)
    expect(isDevelopmentRuntime('prod', true)).toBe(false)
    expect(isDevelopmentRuntime(undefined, true)).toBe(true)
  })
})

describe('runtimeIdentityFor', () => {
  it('makes the development build the only VibeLink test target', () => {
    expect(runtimeIdentityFor(true)).toMatchObject({
      kind: 'development',
      protected: false,
      browserTitle: 'VibeLink Dev',
      badgeDetail: 'TEST TARGET',
    })
  })

  it('marks the installed release as a protected host', () => {
    expect(runtimeIdentityFor(false)).toMatchObject({
      kind: 'release',
      protected: true,
      browserTitle: 'VibeLink',
      badgeDetail: 'PROTECTED',
    })
  })
})
