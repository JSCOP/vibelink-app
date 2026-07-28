import { describe, expect, test } from 'vitest'
import { defaultSettings, isAgentPane, isAgentProfile, joinCommandLine, normalizeSettings, orderSessions, paneOverridesFromProfile, profileById, profileIconForPane, selectedProfile, selectedProfileForWorkspace, splitCommandLine, workspaceDetailsFor } from './profiles'

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

    expect(profileNames).toEqual(expect.arrayContaining(['Shell', 'PowerShell', 'CMD', 'Claude Code', 'Codex', 'OMP']))
  })

  test('migrates legacy built-in glyphs to downloaded brand icons while preserving custom choices', () => {
    const settings = normalizeSettings({
      ...defaultSettings,
      profiles: defaultSettings.profiles.map((profile) => {
        if (profile.id === 'powershell') return { ...profile, icon: 'terminal-square' }
        if (profile.id === 'claude') return { ...profile, name: 'Claude', icon: 'sparkles' }
        if (profile.id === 'codex') return { ...profile, icon: 'bot' }
        if (profile.id === 'omp') return { ...profile, icon: 'zap' }
        return profile
      }),
    })

    expect(profileById(settings, 'powershell').icon).toBe('powershell')
    expect(profileById(settings, 'claude')).toMatchObject({ name: 'Claude Code', icon: 'claude-code' })
    expect(profileById(settings, 'codex').icon).toBe('codex')
    expect(profileById(settings, 'omp').icon).toBe('oh-my-pi')
    expect(profileIconForPane(profileById(settings, 'codex'), 'bot')).toBe('codex')

    const custom = normalizeSettings({
      ...defaultSettings,
      profiles: defaultSettings.profiles.map((profile) => profile.id === 'codex' ? { ...profile, icon: 'rocket' } : profile),
    })
    expect(profileById(custom, 'codex').icon).toBe('rocket')
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
    expect(isAgentPane({
      id: 'pane-icon-only',
      alive: true,
      config: {
        paneId: 'pane-icon-only',
        shell: 'pwsh.exe',
        args: ['-NoLogo'],
        cwd: null,
        env: [],
        title: 'PowerShell',
        icon: 'bot',
        cols: 120,
        rows: 32,
      },
    }, settings)).toBe(false)
  })

  test('detects an agent started by typing inside a plain shell pane', () => {
    const settings = normalizeSettings(null)
    // The overwhelmingly common real-world shape: the pane was opened with the
    // built-in `default` Shell profile and the user then typed `omp`. The
    // profile is NOT an agent profile, so a profile-only gate classified this
    // pane as a plain shell forever and suppressed every completion alert.
    const shellPaneRunningAgent = (title: string) => ({
      id: 'pane-typed',
      alive: true,
      config: {
        paneId: 'pane-typed',
        shell: 'pwsh.exe',
        args: ['-NoLogo'],
        cwd: null,
        env: [],
        title,
        icon: 'terminal',
        profileId: 'default',
        cols: 120,
        rows: 32,
      },
    })

    expect(isAgentPane(shellPaneRunningAgent('omp'), settings)).toBe(true)
    expect(isAgentPane(shellPaneRunningAgent('claude code'), settings)).toBe(true)
    expect(isAgentPane(shellPaneRunningAgent('codex'), settings)).toBe(true)
    // A genuine plain shell must still be rejected, or every long-running
    // command in any terminal would raise a completion alert.
    expect(isAgentPane(shellPaneRunningAgent('PowerShell'), settings)).toBe(false)
    expect(isAgentPane(shellPaneRunningAgent('build'), settings)).toBe(false)
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

  test('normalizes the external editor command', () => {
    expect(defaultSettings.externalEditorCommand).toBe('code')
    expect(normalizeSettings({}).externalEditorCommand).toBe('code')
    expect(normalizeSettings({ externalEditorCommand: 'cursor --reuse-window' }).externalEditorCommand).toBe('cursor --reuse-window')
  })

  test('normalizes Git status presentation', () => {
    expect(defaultSettings.gitStatusPresentation).toBe('words')
    expect(normalizeSettings({ gitStatusPresentation: 'icons' }).gitStatusPresentation).toBe('icons')
    expect(normalizeSettings({ gitStatusPresentation: 'letters' }).gitStatusPresentation).toBe('letters')
    expect(normalizeSettings({ gitStatusPresentation: 'missing' }).gitStatusPresentation).toBe('words')
  })

  test('normalizes Monaco word wrap and minimap defaults', () => {
    expect(defaultSettings.editorWordWrap).toBe(true)
    expect(defaultSettings.editorMinimap).toBe(false)
    expect(normalizeSettings({})).toMatchObject({ editorWordWrap: true, editorMinimap: false })
    expect(normalizeSettings({ editorWordWrap: false, editorMinimap: true })).toMatchObject({ editorWordWrap: false, editorMinimap: true })
    expect(normalizeSettings({ editorWordWrap: 'off', editorMinimap: 'on' })).toMatchObject({ editorWordWrap: true, editorMinimap: false })
  })

  test('resumes the previous session by default and quits rather than hiding', () => {
    expect(defaultSettings.sessionRestore).toBe('resume')
    expect(defaultSettings.minimizeToTrayOnClose).toBe(false)
    expect(defaultSettings.confirmExitWithRunningAgents).toBe(true)
    expect(normalizeSettings({ sessionRestore: 'clean' })).toMatchObject({ sessionRestore: 'clean' })
    expect(normalizeSettings({ sessionRestore: 'nonsense' })).toMatchObject({ sessionRestore: 'resume' })
  })

  test('migrates the superseded stop-terminals flag to the clean restore mode', () => {
    // The old boolean stopped the processes but still restored the panes, so an
    // opted-in user wanted an initialized screen: that is now `clean`.
    expect(normalizeSettings({ stopTerminalsOnAppExit: true })).toMatchObject({ sessionRestore: 'clean' })
    expect(normalizeSettings({ stopTerminalsOnAppExit: false })).toMatchObject({ sessionRestore: 'resume' })
    // An explicit new value always wins over the legacy flag.
    expect(normalizeSettings({ stopTerminalsOnAppExit: true, sessionRestore: 'resume' })).toMatchObject({ sessionRestore: 'resume' })
  })

  test('normalizes configurable pane highlight colors', () => {
    expect(defaultSettings.selectedPaneHighlightColor).toBe('#ff9f1a')
    expect(defaultSettings.alarmHighlightColor).toBe('#7ee787')
    expect(defaultSettings.reviewedPaneHighlightColor).toBe('#58a6ff')
    expect(normalizeSettings({})).toMatchObject({
      selectedPaneHighlightColor: '#ff9f1a',
      alarmHighlightColor: '#7ee787',
      reviewedPaneHighlightColor: '#58a6ff',
    })
    expect(normalizeSettings({
      selectedPaneHighlightColor: '  #123ABC  ',
      alarmHighlightColor: '#abcdef',
      reviewedPaneHighlightColor: '#FEDCBA',
    })).toMatchObject({
      selectedPaneHighlightColor: '#123ABC',
      alarmHighlightColor: '#abcdef',
      reviewedPaneHighlightColor: '#FEDCBA',
    })
    expect(normalizeSettings({
      selectedPaneHighlightColor: '#abc',
      alarmHighlightColor: '#12345678',
      reviewedPaneHighlightColor: 'blue',
    })).toMatchObject({
      selectedPaneHighlightColor: defaultSettings.selectedPaneHighlightColor,
      alarmHighlightColor: defaultSettings.alarmHighlightColor,
      reviewedPaneHighlightColor: defaultSettings.reviewedPaneHighlightColor,
    })
  })

  test('normalizes completion sound preferences', () => {
    expect(defaultSettings).toMatchObject({
      completionSoundEnabled: true,
      completionSoundId: 'builtin:clear-chime',
      completionSoundVolume: 0.55,
    })
    expect(normalizeSettings({
      completionSoundEnabled: false,
      completionSoundId: 'custom:12345678-abcd',
      completionSoundVolume: 0.25,
    })).toMatchObject({
      completionSoundEnabled: false,
      completionSoundId: 'custom:12345678-abcd',
      completionSoundVolume: 0.25,
    })
    expect(normalizeSettings({ completionSoundId: 'missing', completionSoundVolume: 4 })).toMatchObject({
      completionSoundId: defaultSettings.completionSoundId,
      completionSoundVolume: defaultSettings.completionSoundVolume,
    })
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

  test('normalizes workspace details and returns empty defaults', () => {
    const settings = normalizeSettings({
      workspaceDetails: {
        ' session-a ': { githubIssue: ' 42 ', githubPullRequest: ' https://github.com/example/repo/pull/7 ', notes: '**Review**' },
        empty: { githubIssue: '', githubPullRequest: '', notes: '' },
        invalid: 'nope',
      },
    })

    expect(settings.workspaceDetails).toEqual({
      'session-a': { githubIssue: '42', githubPullRequest: 'https://github.com/example/repo/pull/7', notes: '**Review**' },
    })
    expect(workspaceDetailsFor(settings, 'missing')).toEqual({ githubIssue: '', githubPullRequest: '', notes: '' })
  })

  test('normalizes worktree storage and round-trips the normalized shape', () => {
    expect(defaultSettings.worktreeStorage).toEqual({
      mode: 'drive',
      drive: '',
      folderName: 'VibeLinkWorktrees',
      customRoot: '',
      groupByRepository: true,
    })

    const normalized = normalizeSettings({
      worktreeStorage: {
        mode: 'custom',
        drive: ' e: ',
        folderName: ' TeamWorktrees ',
        customRoot: ' E:/managed/worktrees ',
        groupByRepository: false,
      },
    }).worktreeStorage
    expect(normalized).toEqual({
      mode: 'custom',
      drive: 'E:',
      folderName: 'TeamWorktrees',
      customRoot: 'E:/managed/worktrees',
      groupByRepository: false,
    })
    expect(normalizeSettings({ worktreeStorage: normalized }).worktreeStorage).toEqual(normalized)

    expect(normalizeSettings({
      worktreeStorage: {
        mode: 'missing',
        drive: 'EE:',
        folderName: 'nested/worktrees',
        customRoot: 42,
        groupByRepository: 'yes',
      },
    }).worktreeStorage).toEqual(defaultSettings.worktreeStorage)
    expect(normalizeSettings({ worktreeStorage: { folderName: 'cache..backup' } }).worktreeStorage.folderName).toBe('VibeLinkWorktrees')
    expect(normalizeSettings({ worktreeStorage: { folderName: 'nested\\worktrees' } }).worktreeStorage.folderName).toBe('VibeLinkWorktrees')
  })

  test('normalizes terminal scrollbar visibility and workspace order settings', () => {
    expect(normalizeSettings({ terminalScrollbarVisible: false }).terminalScrollbarVisible).toBe(false)
    expect(defaultSettings.terminalScrollbarVisible).toBe(false)
    expect(normalizeSettings({ terminalScrollbarVisible: 'nope' }).terminalScrollbarVisible).toBe(defaultSettings.terminalScrollbarVisible)
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
          env: [['TERM_PROGRAM', 'VibeLink']],
          cwd: 'E:/work',
          color: '#7ee787',
          icon: 'sparkles',
        },
      ],
    })

    expect(paneOverridesFromProfile(selectedProfile(settings), 'Codex 1')).toEqual({
      shell: 'codex.cmd',
      args: ['--dangerously-bypass-approvals-and-sandbox'],
      env: [['TERM_PROGRAM', 'VibeLink']],
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
  test('normalizes setup wizard state', () => {
    expect(normalizeSettings({}).setupWizard).toEqual({
      completedAt: null,
      skippedSteps: [],
    })
    expect(normalizeSettings({
      setupWizard: {
        completedAt: '2026-07-13T00:00:00.000Z',
        skippedSteps: ['agents', 'agents', ' ', 'mcp'],
      },
    }).setupWizard).toEqual({
      completedAt: '2026-07-13T00:00:00.000Z',
      skippedSteps: ['agents', 'mcp'],
    })
  })

  test('normalizes role presets with trim and case-insensitive dedupe', () => {
    expect(defaultSettings.rolePresets).toEqual(['Planner', 'Frontend', 'Backend', 'Reviewer', 'Tester', 'Docs'])
    expect(normalizeSettings({ rolePresets: [' Reviewer ', 'reviewer', '', 'Backend'] }).rolePresets).toEqual(['Reviewer', 'Backend'])
    expect(normalizeSettings({ rolePresets: [] }).rolePresets).toEqual(defaultSettings.rolePresets)
  })

})
