// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { readAppStylesheet } from '../appStylesheet.test-support'
import { defaultSettings, normalizeSettings } from '../state/profiles'
import { useWorkspaceStore } from '../state/store'
import { SetupWizard } from './SetupWizard'
import { isSetupStepId, setupStepAutoPass, setupStepIds, setupStepTitle } from './setupWizardSteps'
// TerminalManager's module-level singleton invokes at import time, before any
// `beforeEach` runs, so the hoisted mock has to resolve from creation.
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue([]) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: class MockChannel<T> { onmessage: ((event: T) => void) | null = null } }))

beforeEach(() => {
  cleanup()
  invoke.mockReset().mockResolvedValue([])
  useWorkspaceStore.setState({ settings: normalizeSettings(defaultSettings) })
})

describe('setup wizard steps', () => {
  test('uses the simplified first-run flow', () => {
    expect(setupStepIds).toEqual(['welcome', 'account', 'appearance', 'finish'])
    expect(setupStepIds.map(setupStepTitle)).toEqual(['Welcome', 'Account', 'Appearance', 'Finish'])
    expect(setupStepIds.join(',')).not.toMatch(/agents|runtime|model|mcp/)
  })

  test('ignores persisted step ids from the retired flow', () => {
    expect(['agents', 'appearance', 'mcp', 'finish'].filter(isSetupStepId)).toEqual(['appearance', 'finish'])
  })

  test('does not auto-pass the optional account step', () => {
    expect(setupStepAutoPass()).toEqual({})
  })

  test('completes without signing in to an account', async () => {
    const onComplete = vi.fn()
    render(createElement(SetupWizard, { onComplete }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('list_installed_fonts'))

    fireEvent.click(screen.getByRole('button', { name: 'Start setup' }))
    expect(screen.getByRole('heading', { name: 'Account' })).toBeTruthy()
    const accountContinue = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement
    expect(accountContinue.disabled).toBe(false)
    fireEvent.click(accountContinue)
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByText('Account sign-in is optional for bug reports.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))

    expect(onComplete).toHaveBeenCalledOnce()
    expect(useWorkspaceStore.getState().settings.setupWizard.completedAt).not.toBeNull()
  })

  test('keeps the setup backdrop below the draggable topbar', () => {
    const css = readAppStylesheet()

    expect(css).toMatch(/\.main-surface\s*\{[^}]*--vibelink-topbar-height:\s*36px/s)
    expect(css).toMatch(/\.topbar\s*\{[^}]*flex:\s*0 0 var\(--vibelink-topbar-height\)/s)
    expect(css).toMatch(/\.setup-wizard-backdrop\s*\{[^}]*top:\s*var\(--vibelink-topbar-height\)/s)
  })
})
