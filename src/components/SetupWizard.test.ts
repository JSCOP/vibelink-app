import { describe, expect, test } from 'vitest'
import { readAppStylesheet } from '../appStylesheet.test-support'
import { isSetupStepId, setupStepAutoPass, setupStepIds, setupStepTitle } from './setupWizardSteps'

describe('setup wizard steps', () => {
  test('uses the simplified first-run flow', () => {
    expect(setupStepIds).toEqual(['welcome', 'account', 'appearance', 'finish'])
    expect(setupStepIds.map(setupStepTitle)).toEqual(['Welcome', 'Account', 'Appearance', 'Finish'])
    expect(setupStepIds.join(',')).not.toMatch(/agents|runtime|model|mcp/)
  })

  test('ignores persisted step ids from the retired flow', () => {
    expect(['agents', 'appearance', 'mcp', 'finish'].filter(isSetupStepId)).toEqual(['appearance', 'finish'])
  })

  test('auto-passes only an already-entitled account step', () => {
    expect(setupStepAutoPass({ entitled: true })).toEqual({ account: true })
    expect(setupStepAutoPass({ entitled: false })).toEqual({ account: false })
  })

  test('keeps the setup backdrop below the draggable topbar', () => {
    const css = readAppStylesheet()

    expect(css).toMatch(/\.main-surface\s*\{[^}]*--vibelink-topbar-height:\s*36px/s)
    expect(css).toMatch(/\.topbar\s*\{[^}]*flex:\s*0 0 var\(--vibelink-topbar-height\)/s)
    expect(css).toMatch(/\.setup-wizard-backdrop\s*\{[^}]*top:\s*var\(--vibelink-topbar-height\)/s)
  })
})
