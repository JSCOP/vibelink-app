import { describe, expect, test } from 'vitest'
import { defaultSettings, isAgentPane, isAgentProfile, joinCommandLine, normalizeSettings, orderSessions, paneOverridesFromProfile, profileById, selectedProfile, selectedProfileForWorkspace, splitCommandLine } from './profiles'

describe('orderSessions', () => {
  const sessions = [
    { id: 'a', name: 'Alpha' },
    { id: 'b', name: 'Beta' },
    { id: 'c', name: 'Gamma' },
  ]

  test('returns the incoming sessions unchanged when there is no saved order', () => {
    const ordered = orderSessions(sessions, [])

    expect(ordered).toBe(sessions)
    expect(ordered.map((session) => session.id)).toEqual(['a', 'b', 'c'])
  })

  test('places sessions in the complete saved order', () => {
    const ordered = orderSessions(sessions, ['c', 'a', 'b'])

    expect(ordered.map((session) => session.id)).toEqual(['c', 'a', 'b'])
  })

  test('skips deleted session ids and appends unordered sessions', () => {
    const ordered = orderSessions(sessions, ['x', 'c', 'a'])

    expect(ordered.map((session) => session.id)).toEqual(['c', 'a', 'b'])
  })

  test('appends sessions missing from the saved order in incoming order', () => {
    const extendedSessions = [...sessions, { id: 'd', name: 'Delta' }]
    const ordered = orderSessions(extendedSessions, ['c', 'a'])

    expect(ordered.map((session) => session.id)).toEqual(['c', 'a', 'b', 'd'])
  })

  test('uses each saved session id at most once', () => {
    const ordered = orderSessions(sessions, ['c', 'c', 'a'])

    expect(ordered.map((session) => session.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('terminal profiles', () => {
  test('normalizes empty settings with a default profile', () => {
    const settings = normalizeSettings(null)

    expect(settings.profiles.length).toBeGreaterThan(0)
    expect(settings.defaultProfileId).toBe(settings.profiles[0].id)
    expect(selectedProfile(settings).id).toBe(settings.defaultProfileId)
  })

  test('ships common terminal and agent profiles by default', () => {
    const profileNames = normalizeSettings(null).profiles.map((profile) => profile.name)

    expect(profileNames).toEqual(expect.arrayContaining(['Shell', 'PowerShell', 'CMD', 'Claude', 'Codex', 'OMP']))
  })

  test('identifies task-assignable AI agent profiles and panes', () => {
    const settings = normalizeSettings(null)
    expect(isAgentProfile(profileById(settings, 'codex'))).toBe(true)
    expect(isAgentProfile(profileById(settings, 'powershell'))).toBe(false)
    expect(isAgentProfile({ ...profileById(settings, 'powershell'), id: 'custom-omp', name: 'Oh My Pi' })).toBe(true)
    expect(isAgentProfile({ ...profileById(settings, 'powershell'), id: 'custom-claude-code', name: 'Claude Code' })).toBe(true)
    expect(isAgentPane({
      id: 'pane-1',
      alive: true,
      config: {
        paneId: 'pane-1',
        shell: 'pwsh.exe',
        args: ['-NoLogo'],
        cwd: null,
        env: [],
        title: 'Codex 1',
        icon: 'bot',
        profileId: 'codex',
        cols: 120,
        rows: 32,
      },
    }, settings)).toBe(true)
    expect(isAgentPane({
      id: 'pane-2',
      alive: true,
      config: {
        paneId: 'pane-2',
        shell: 'pwsh.exe',
        args: ['-NoLogo'],
        cwd: null,
        env: [],
        title: 'PowerShell',
        icon: 'terminal-square',
        profileId: 'powershell',
        cols: 120,
        rows: 32,
      },
    }, settings)).toBe(false)
  })

  test('runs local agent tools inside PowerShell and resets terminal modes on exit', () => {
    const settings = normalizeSettings(null)

    expect(paneOverridesFromProfile(selectedProfile(settings))).toMatchObject({ shell: 'pwsh.exe', args: ['-NoLogo'] })
    const codex = paneOverridesFromProfile(profileById(settings, 'codex'))
    expect(codex.shell).toBe('pwsh.exe')
    expect(codex.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-Command'])
    expect(codex.args[3]).toContain('& codex')
    expect(codex.args[3]).toContain('finally')
    expect(codex.args[3]).toContain('`e[?1049l')
    expect(codex.args[3]).toContain('`e[2J')
    expect(codex.args[3]).toContain('`e[H')
    expect(codex.title).toBe('Codex')
  })

  test('upgrades stored default agent profiles to reset terminal modes', () => {
    const settings = normalizeSettings({
      defaultProfileId: 'codex',
      profiles: [{ id: 'codex', name: 'Codex', shell: 'pwsh.exe', args: ['-NoLogo', '-NoExit', '-Command', 'codex'] }],
    })

    const codex = paneOverridesFromProfile(selectedProfile(settings))
    expect(codex.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-Command'])
    expect(codex.args[3]).toContain('& codex')
    expect(codex.args[3]).toContain('`e[?1049l')
    expect(codex.args[3]).toContain('`e[2J')
  })

  test('upgrades stored managed agent profiles that only reset terminal modes', () => {
    const settings = normalizeSettings({
      defaultProfileId: 'codex',
      profiles: [{
        id: 'codex',
        name: 'Codex',
        shell: 'pwsh.exe',
        args: ['-NoLogo', '-NoExit', '-Command', 'try { & codex } finally { [Console]::Out.Write("`e[?1049l`e[?25h`e[?1000l`e[?1002l`e[?1003l`e[?1006l`e[?2004l`e[0m") }'],
      }],
    })

    const codex = paneOverridesFromProfile(selectedProfile(settings))
    expect(codex.args[3]).toContain('`e[?1049l')
    expect(codex.args[3]).toContain('`e[2J')
    expect(codex.args[3]).toContain('`e[H')
  })

  test('keeps customized agent profile commands unchanged', () => {
    const settings = normalizeSettings({
      defaultProfileId: 'codex',
      profiles: [{ id: 'codex', name: 'Codex', shell: 'pwsh.exe', args: ['-NoLogo', '-NoExit', '-Command', 'codex --resume'] }],
    })

    expect(paneOverridesFromProfile(selectedProfile(settings)).args).toEqual(['-NoLogo', '-NoExit', '-Command', 'codex --resume'])
  })

  test('migrates legacy flat shell into the default profile only', () => {
    const settings = normalizeSettings({ shell: 'cmd.exe', fontSize: 15 })

    expect(settings.fontSize).toBe(15)
    expect(settings.profiles[0]).toMatchObject({ shell: 'cmd.exe' })
    expect('shell' in settings).toBe(false)
  })

  test('normalizes keybinding settings with Windows Terminal compatible defaults', () => {
    const settings = normalizeSettings({ keybindings: { closePane: 'ctrl+q' } })

    expect(settings.keybindings.closePane).toBe('ctrl+q')
    expect(settings.keybindings.focusLeft).toBe('ctrl+left')
  })

  test('normalizes terminal font and theme choices', () => {
    const themed = normalizeSettings({ fontFamily: '  Cascadia Code  ', terminalThemeId: 'tokyoNight', accent: '#ff00ff' })

    expect(themed.fontFamily).toBe('Cascadia Code')
    expect(themed.terminalThemeId).toBe('tokyoNight')
    expect('accent' in themed).toBe(false)

    const fallback = normalizeSettings({ fontFamily: '   ', terminalThemeId: 'missing-theme' })

    expect(fallback.fontFamily).toBe(defaultSettings.fontFamily)
    expect(fallback.terminalThemeId).toBe(defaultSettings.terminalThemeId)
  })

  test('normalizes workspace specific profile defaults', () => {
    const settings = normalizeSettings({
      defaultProfileId: 'powershell',
      workspaceProfileIds: {
        'session-a': 'codex',
        'session-b': 'missing',
      },
    })

    expect(settings.workspaceProfileIds).toEqual({ 'session-a': 'codex' })
    expect(selectedProfileForWorkspace(settings, 'session-a').id).toBe('codex')
    expect(selectedProfileForWorkspace(settings, 'session-b').id).toBe('powershell')
  })

  test('normalizes terminal visibility and workspace order settings', () => {
    expect(normalizeSettings({ terminalScrollbarVisible: false }).terminalScrollbarVisible).toBe(false)
    expect(defaultSettings.terminalScrollbarVisible).toBe(false)
    expect(normalizeSettings({ terminalScrollbarVisible: 'nope' }).terminalScrollbarVisible).toBe(defaultSettings.terminalScrollbarVisible)
    expect(normalizeSettings({ terminalTabsVisible: false }).terminalTabsVisible).toBe(false)
    expect(defaultSettings.terminalTabsVisible).toBe(true)
    expect(normalizeSettings({ terminalTabsVisible: 'nope' }).terminalTabsVisible).toBe(defaultSettings.terminalTabsVisible)
    expect(normalizeSettings({ workspaceOrder: ['a', 'a', ' b ', '', 3, 'c'] }).workspaceOrder).toEqual(['a', 'b', 'c'])
    expect(normalizeSettings({ workspaceOrder: 'nope' }).workspaceOrder).toEqual([])
    expect(defaultSettings.workspaceOrder).toEqual([])
  })

  test('normalizes terminal cursor style settings', () => {
    expect(defaultSettings.cursorStyle).toBe('bar')
    expect(defaultSettings.cursorWidth).toBe(1)
    expect(normalizeSettings({ cursorStyle: 'underline', cursorWidth: 3 })).toMatchObject({ cursorStyle: 'underline', cursorWidth: 3 })
    expect(normalizeSettings({ cursorStyle: 'block' }).cursorStyle).toBe('block')
    expect(normalizeSettings({ cursorStyle: 'missing', cursorWidth: 0 })).toMatchObject({
      cursorStyle: defaultSettings.cursorStyle,
      cursorWidth: defaultSettings.cursorWidth,
    })
  })

  test('normalizes terminal font weight and UI scale settings', () => {
    expect(normalizeSettings({ terminalFontWeight: 500 }).terminalFontWeight).toBe(500)
    expect(normalizeSettings({ terminalFontWeight: 1200 }).terminalFontWeight).toBe(defaultSettings.terminalFontWeight)
    expect(normalizeSettings({ uiScale: 1.1 }).uiScale).toBe(1.1)
    expect(normalizeSettings({ uiScale: 3 }).uiScale).toBe(defaultSettings.uiScale)
  })

  test('normalizes chat UI preferences', () => {
    const settings = normalizeSettings({
      chatPersonality: 'concise',
      chatReasoningBlocks: false,
      chatToolCalls: false,
      chatToolCallContent: false,
      chatImageAttachments: 'never',
    })

    expect(settings.chatPersonality).toBe('concise')
    expect(settings.chatReasoningBlocks).toBe(false)
    expect(settings.chatToolCalls).toBe(false)
    expect(settings.chatToolCallContent).toBe(false)
    expect(settings.chatImageAttachments).toBe('never')
    expect(normalizeSettings({ chatPersonality: 'missing', chatImageAttachments: 'sometimes', chatToolCalls: 'nope', chatToolCallContent: 'nope' })).toMatchObject({
      chatPersonality: defaultSettings.chatPersonality,
      chatToolCalls: defaultSettings.chatToolCalls,
      chatToolCallContent: defaultSettings.chatToolCallContent,
      chatImageAttachments: defaultSettings.chatImageAttachments,
    })
  })

  test('normalizes pane resize snap tolerance', () => {
    expect(normalizeSettings({ resizeSnapTolerance: 48 }).resizeSnapTolerance).toBe(48)
    expect(normalizeSettings({ resizeSnapTolerance: -1 }).resizeSnapTolerance).toBe(defaultSettings.resizeSnapTolerance)
    expect(normalizeSettings({ resizeSnapTolerance: 200 }).resizeSnapTolerance).toBe(defaultSettings.resizeSnapTolerance)
  })

  test('normalizes pane header height setting', () => {
    expect(defaultSettings.paneHeaderHeight).toBe(28)
    expect(normalizeSettings({ paneHeaderHeight: 40 }).paneHeaderHeight).toBe(40)
    expect(normalizeSettings({ paneHeaderHeight: 12 }).paneHeaderHeight).toBe(defaultSettings.paneHeaderHeight)
    expect(normalizeSettings({ paneHeaderHeight: 80 }).paneHeaderHeight).toBe(defaultSettings.paneHeaderHeight)
  })

  test('builds pane config fields from selected profile', () => {
    const settings = normalizeSettings({
      ...defaultSettings,
      defaultProfileId: 'agent',
      profiles: [
        {
          id: 'agent',
          name: 'Codex',
          shell: 'codex.cmd',
          args: ['--dangerously-bypass-approvals-and-sandbox'],
          env: [['TERM_PROGRAM', 'AgenticWorkspaceTerminal']],
          cwd: 'E:/work',
          color: '#7ee787',
          icon: 'sparkles',
        },
      ],
    })

    expect(paneOverridesFromProfile(selectedProfile(settings), 'Codex 1')).toEqual({
      shell: 'codex.cmd',
      args: ['--dangerously-bypass-approvals-and-sandbox'],
      env: [['TERM_PROGRAM', 'AgenticWorkspaceTerminal']],
      cwd: 'E:/work',
      title: 'Codex 1',
    })
  })

  test('builds SSH pane config from remote profile fields', () => {
    const settings = normalizeSettings({
      defaultProfileId: 'remote',
      profiles: [
        {
          id: 'remote',
          name: 'Prod SSH',
          type: 'ssh',
          sshHost: 'box.example.com',
          sshUser: 'deploy',
          sshPort: 2222,
          sshIdentityFile: 'C:/Users/me/.ssh/id_ed25519',
          sshRemoteCommand: 'tmux attach || tmux',
          sshRemoteCwd: '/srv/app repo',
          sshOptions: '-o ServerAliveInterval=30',
          sshAllocateTty: true,
          env: [],
          cwd: null,
          color: '#76e3ea',
          icon: 'radio-tower',
        },
      ],
    })

    expect(paneOverridesFromProfile(selectedProfile(settings))).toEqual({
      shell: 'ssh',
      args: [
        '-o',
        'ServerAliveInterval=30',
        '-t',
        '-p',
        '2222',
        '-i',
        'C:/Users/me/.ssh/id_ed25519',
        'deploy@box.example.com',
        "cd -- '/srv/app repo' && tmux attach || tmux",
      ],
      env: [],
      cwd: null,
      title: 'Prod SSH',
    })
  })

  test('builds command profiles from a quoted command line', () => {
    const settings = normalizeSettings({
      defaultProfileId: 'dev',
      profiles: [
        {
          id: 'dev',
          name: 'Dev server',
          type: 'command',
          command: 'pnpm --filter "web app" dev',
          env: [],
          cwd: 'E:/repo',
          color: '#f2cc60',
          icon: 'play',
        },
      ],
    })

    expect(paneOverridesFromProfile(selectedProfile(settings))).toEqual({
      shell: 'pnpm',
      args: ['--filter', 'web app', 'dev'],
      env: [],
      cwd: 'E:/repo',
      title: 'Dev server',
    })
  })

  test('round-trips command arguments with spaces and Windows paths', () => {
    const parts = ['tool', 'two words', 'C:\\Users\\me\\.ssh\\id_ed25519']

    expect(splitCommandLine(joinCommandLine(parts))).toEqual(parts)
  })
})
