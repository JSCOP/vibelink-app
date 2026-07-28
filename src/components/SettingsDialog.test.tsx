// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
  if (command === 'list_installed_fonts') return []
  if (command === 'default_capture_dir') return ''
  if (command === 'git_worktree_storage_options') return { drives: ['C:', 'E:'], appDataRoot: 'C:\\Users\\test\\AppData\\Roaming\\vibelink\\worktrees' }
  if (command === 'git_worktree_resolve_root') {
    const storage = args?.storage as { mode: string; drive: string; folderName: string; customRoot: string }
    const workspaceDrive = String(args?.workspaceFolder ?? '').match(/^([A-Za-z]:)/)?.[1] ?? 'C:'
    let root = 'C:\\Users\\test\\AppData\\Roaming\\vibelink\\worktrees'
    let fallbackReason: string | null = null
    if (storage.mode === 'drive') root = `${storage.drive || workspaceDrive}\\${storage.folderName}`
    else if (storage.mode === 'custom' && storage.customRoot) root = storage.customRoot
    else if (storage.mode === 'custom') fallbackReason = 'Custom folder is empty; using app data.'
    return { root, example: `${root}\\example-abcd1234`, writable: true, fallbackReason }
  }
  if (command === 'hermes_runtime_status') return { detected: false, command: null, cliCommand: null, version: null, home: null, source: null, configuredModel: null }
  if (command === 'agent_hook_status') {
    return [{
      id: 'omp',
      displayName: 'Oh My Pi',
      installed: false,
      configPresent: true,
      configPath: 'C:\\Users\\test\\.omp\\agent\\hooks\\pre\\vibelink-complete.ts',
      blockedReason: null,
    }]
  }
  return null
}) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { defaultSettings, normalizeSettings } from '../state/profiles'
import { SettingsDialog } from './SettingsDialog'
import { useWorkspaceStore } from '../state/store'

afterEach(() => {
  cleanup()
  invoke.mockClear()
  useWorkspaceStore.setState({ sessions: [], activeSessionId: undefined })
})

describe('SettingsDialog preferences', () => {
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
    const wordWrap = screen.getByRole('switch', { name: 'Word wrap' })
    const minimap = screen.getByRole('switch', { name: 'Minimap' })
    expect((wordWrap as HTMLInputElement).checked).toBe(true)
    expect((minimap as HTMLInputElement).checked).toBe(false)

    fireEvent.click(wordWrap)
    fireEvent.click(minimap)
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ editorWordWrap: false, editorMinimap: true }))
  })

  test('stages built-in completion sound and volume changes until Apply', () => {
    const onChange = vi.fn()
    render(
      <SettingsDialog
        settings={normalizeSettings(defaultSettings)}
        onChange={onChange}
        onClose={vi.fn()}
        onRunSetupWizard={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(screen.getByRole('switch', { name: 'Play completion sound' })).toBeChecked()
    const sound = screen.getByRole('combobox', { name: 'Completion sound' })
    expect(screen.getByRole('option', { name: 'Clear chime' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Soft bell' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Success rise' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Gentle pulse' })).toBeInTheDocument()

    fireEvent.change(sound, { target: { value: 'builtin:soft-bell' } })
    fireEvent.change(screen.getByRole('slider', { name: 'Completion sound volume' }), { target: { value: '0.25' } })
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      completionSoundEnabled: true,
      completionSoundId: 'builtin:soft-bell',
      completionSoundVolume: 0.25,
    }))
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

  test('stages worktree storage controls and resolves the current draft preview', async () => {
    const onChange = vi.fn()
    useWorkspaceStore.setState({
      sessions: [{ id: 'repo', name: 'Repository', paneCount: 0, createdAt: 1, workspaceFolder: 'E:/repo' }],
      activeSessionId: 'repo',
    })
    render(
      <SettingsDialog
        settings={normalizeSettings(defaultSettings)}
        onChange={onChange}
        onClose={vi.fn()}
        onRunSetupWizard={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Worktrees' }))
    const mode = screen.getByRole('combobox', { name: 'Storage mode' })
    expect(mode).toHaveValue('sameDrive')
    expect(screen.getByRole('option', { name: 'Same drive as repository' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Specific drive' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'App data folder' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Custom folder' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Root folder name' })).toHaveValue('VibeLinkWorktrees')
    expect(screen.getByRole('switch', { name: 'Group by repository' })).toBeChecked()

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_worktree_resolve_root', {
      workspaceFolder: 'E:/repo',
      storage: defaultSettings.worktreeStorage,
      name: 'example',
    }))
    expect(await screen.findByText('E:\\VibeLinkWorktrees')).toBeInTheDocument()
    expect(screen.getByText('E:\\VibeLinkWorktrees\\example-abcd1234')).toBeInTheDocument()

    fireEvent.change(mode, { target: { value: 'specificDrive' } })
    const drive = screen.getByRole('combobox', { name: 'Drive' })
    expect(screen.getByRole('option', { name: 'C:' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'E:' })).toBeInTheDocument()
    fireEvent.change(drive, { target: { value: 'E:' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Root folder name' }), { target: { value: 'TeamWorktrees' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Group by repository' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_worktree_resolve_root', {
      workspaceFolder: 'E:/repo',
      storage: {
        mode: 'drive',
        drive: 'E:',
        folderName: 'TeamWorktrees',
        customRoot: '',
        groupByRepository: false,
      },
      name: 'example',
    }))

    fireEvent.change(mode, { target: { value: 'custom' } })
    const customFolder = screen.getByRole('textbox', { name: 'Custom folder' })
    expect(screen.getByRole('button', { name: 'Browse' })).toBeInTheDocument()
    expect(await screen.findByText('Custom folder is empty; using app data.')).toBeInTheDocument()
    fireEvent.change(customFolder, { target: { value: 'E:/custom-worktrees' } })
    expect(await screen.findByText('E:/custom-worktrees')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      worktreeStorage: {
        mode: 'custom',
        drive: 'E:',
        folderName: 'TeamWorktrees',
        customRoot: 'E:/custom-worktrees',
        groupByRepository: false,
      },
    }))
  })

  test('renders each AI agent row with its vendor brand mark, not a generic glyph', async () => {
    render(
      <SettingsDialog
        settings={normalizeSettings(defaultSettings)}
        onChange={vi.fn()}
        onClose={vi.fn()}
        onRunSetupWizard={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Agents' }))
    const row = await screen.findByText('Oh My Pi')
    const icon = row.closest('.vl-set-agent')?.querySelector('img')
    expect(icon).toHaveAttribute('src', '/agent-icons/oh-my-pi.svg')
  })
})
