// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (command: string) => {
  if (command === 'list_installed_fonts') return []
  if (command === 'default_capture_dir') return ''
  if (command === 'hermes_runtime_status') return { detected: false, command: null, cliCommand: null, version: null, home: null, source: null, configuredModel: null }
  return null
}) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { defaultSettings, normalizeSettings } from '../state/profiles'
import { SettingsDialog } from './SettingsDialog'

afterEach(cleanup)

describe('SettingsDialog editor preferences', () => {
  test('stages word wrap and minimap changes until Apply', () => {
    const onChange = vi.fn()
    render(
      <SettingsDialog
        settings={normalizeSettings(defaultSettings)}
        onChange={onChange}
        onClose={vi.fn()}
        onRunSetupWizard={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    const wordWrap = screen.getByRole('checkbox', { name: 'Word wrap' })
    const minimap = screen.getByRole('checkbox', { name: 'Minimap' })
    expect((wordWrap as HTMLInputElement).checked).toBe(true)
    expect((minimap as HTMLInputElement).checked).toBe(false)

    fireEvent.click(wordWrap)
    fireEvent.click(minimap)
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ editorWordWrap: false, editorMinimap: true }))
  })

  test('lists workspace navigation shortcuts in Advanced settings', () => {
    const view = render(
      <SettingsDialog
        settings={normalizeSettings(defaultSettings)}
        onChange={vi.fn()}
        onClose={vi.fn()}
        onRunSetupWizard={vi.fn()}
      />,
    )

    fireEvent.click(view.getByRole('button', { name: 'Advanced' }))
    expect((view.getByRole('textbox', { name: 'Toggle Workspaces panel' }) as HTMLInputElement).value).toBe('ctrl+shift+e')
    expect((view.getByRole('textbox', { name: 'Toggle left sidebar' }) as HTMLInputElement).value).toBe('ctrl+b')
  })
})
