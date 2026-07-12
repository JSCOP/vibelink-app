import type { PaneConfig, PaneMeta } from '../ipc/types'
import { defaultKeybindings, normalizeKeybindings, type KeybindingSettings } from './keybindings'
import { defaultTerminalThemeId, isTerminalThemeId, type TerminalThemeId } from './terminalThemes'
import { preferredFontFamily } from './fonts'

export type ProfileKind = 'local' | 'ssh' | 'command'
export type ChatPersonality = 'direct' | 'balanced' | 'concise' | 'exploratory'
export type ChatImageAttachmentMode = 'auto' | 'always' | 'never'
export type TerminalCursorStyle = 'bar' | 'block' | 'underline'
export type SetupWizardSettings = {
  completedAt: string | null
  hermesAutoInstall: boolean
  skippedSteps: string[]
}


export type Profile = {
  id: string
  name: string
  type: ProfileKind
  shell: string | null
  args: string[]
  command: string
  sshHost: string
  sshUser: string
  sshPort: number | null
  sshIdentityFile: string | null
  sshRemoteCommand: string
  sshRemoteCwd: string | null
  sshOptions: string
  sshAllocateTty: boolean
  env: [string, string][]
  cwd: string | null
  color: string
  icon: string
}

const builtInAgentProfileIds = new Set(['claude', 'codex', 'omp'])
const agentCommandNames = ['claude', 'codex', 'omp', 'opencode']
const agentNamePhrasePattern = /\b(?:claude code|oh my pi|oh-my-pi|ohmypi)\b/
const sixDigitHexColorPattern = /^#[0-9a-f]{6}$/i

export type Settings = {
  fontFamily: string
  fontSize: number
  scrollback: number
  terminalFontWeight: number
  uiScale: number
  terminalThemeId: TerminalThemeId
  selectedPaneHighlightColor: string
  alarmHighlightColor: string
  reviewedPaneHighlightColor: string
  terminalScrollbarVisible: boolean
  terminalTabsVisible: boolean
  cursorStyle: TerminalCursorStyle
  cursorWidth: number
  keepTerminalsAliveOnClose: boolean
  resizeSnapTolerance: number
  paneHeaderHeight: number
  profiles: Profile[]
  defaultProfileId: string
  workspaceProfileIds: Record<string, string>
  paneRoles: Record<string, string>
  workspaceOrder: string[]
  rolePresets: string[]
  keybindings: KeybindingSettings
  hermesCommand: string
  chatPersonality: ChatPersonality
  chatReasoningBlocks: boolean
  chatToolCalls: boolean
  chatToolCallContent: boolean
  chatImageAttachments: ChatImageAttachmentMode
  captureDir: string
  captureFfmpegPath: string
  setupWizard: SetupWizardSettings
}

const legacyTerminalModeResetSequence = '`e[?1049l`e[?25h`e[?1000l`e[?1002l`e[?1003l`e[?1006l`e[?2004l`e[0m'
const terminalModeResetSequence = '`e[?1049l`e[2J`e[3J`e[H`e[?25h`e[?1000l`e[?1002l`e[?1003l`e[?1006l`e[?2004l`e[0m'

function agentProfileArgs(command: string): string[] {
  return ['-NoLogo', '-NoExit', '-Command', agentProfileCommand(command, terminalModeResetSequence)]
}

const defaultProfiles: Profile[] = [
  {
    id: 'default',
    name: 'Shell',
    type: 'local',
    shell: 'pwsh.exe',
    args: ['-NoLogo'],
    command: '',
    sshHost: '',
    sshUser: '',
    sshPort: null,
    sshIdentityFile: null,
    sshRemoteCommand: '',
    sshRemoteCwd: null,
    sshOptions: '',
    sshAllocateTty: true,
    env: [],
    cwd: null,
    color: '#7ee787',
    icon: 'terminal',
  },
  {
    id: 'powershell',
    name: 'PowerShell',
    type: 'local',
    shell: 'pwsh.exe',
    args: ['-NoLogo'],
    command: '',
    sshHost: '',
    sshUser: '',
    sshPort: null,
    sshIdentityFile: null,
    sshRemoteCommand: '',
    sshRemoteCwd: null,
    sshOptions: '',
    sshAllocateTty: true,
    env: [],
    cwd: null,
    color: '#58a6ff',
    icon: 'terminal-square',
  },
  {
    id: 'cmd',
    name: 'CMD',
    type: 'local',
    shell: 'cmd.exe',
    args: ['/D'],
    command: '',
    sshHost: '',
    sshUser: '',
    sshPort: null,
    sshIdentityFile: null,
    sshRemoteCommand: '',
    sshRemoteCwd: null,
    sshOptions: '',
    sshAllocateTty: true,
    env: [],
    cwd: null,
    color: '#d2a8ff',
    icon: 'square-terminal',
  },
  {
    id: 'claude',
    name: 'Claude',
    type: 'local',
    shell: 'pwsh.exe',
    args: agentProfileArgs('claude'),
    command: '',
    sshHost: '',
    sshUser: '',
    sshPort: null,
    sshIdentityFile: null,
    sshRemoteCommand: '',
    sshRemoteCwd: null,
    sshOptions: '',
    sshAllocateTty: true,
    env: [],
    cwd: null,
    color: '#f2cc60',
    icon: 'sparkles',
  },
  {
    id: 'codex',
    name: 'Codex',
    type: 'local',
    shell: 'pwsh.exe',
    args: agentProfileArgs('codex'),
    command: '',
    sshHost: '',
    sshUser: '',
    sshPort: null,
    sshIdentityFile: null,
    sshRemoteCommand: '',
    sshRemoteCwd: null,
    sshOptions: '',
    sshAllocateTty: true,
    env: [],
    cwd: null,
    color: '#7ee787',
    icon: 'bot',
  },
  {
    id: 'omp',
    name: 'OMP',
    type: 'local',
    shell: 'pwsh.exe',
    args: agentProfileArgs('omp'),
    command: '',
    sshHost: '',
    sshUser: '',
    sshPort: null,
    sshIdentityFile: null,
    sshRemoteCommand: '',
    sshRemoteCwd: null,
    sshOptions: '',
    sshAllocateTty: true,
    env: [],
    cwd: null,
    color: '#76e3ea',
    icon: 'zap',
  },
]

const defaultProfile = defaultProfiles[0]

export const defaultSettings: Settings = {
  fontFamily: preferredFontFamily,
  fontSize: 11,
  scrollback: 5000,
  terminalFontWeight: 400,
  uiScale: 1,
  terminalThemeId: defaultTerminalThemeId,
  selectedPaneHighlightColor: '#ff9f1a',
  alarmHighlightColor: '#7ee787',
  reviewedPaneHighlightColor: '#58a6ff',
  terminalScrollbarVisible: false,
  terminalTabsVisible: true,
  cursorStyle: 'bar',
  cursorWidth: 1,
  keepTerminalsAliveOnClose: false,
  resizeSnapTolerance: 32,
  paneHeaderHeight: 28,
  profiles: cloneProfiles(defaultProfiles),
  defaultProfileId: defaultProfile.id,
  workspaceProfileIds: {},
  paneRoles: {},
  workspaceOrder: [],
  hermesCommand: '',
  rolePresets: ['Planner', 'Frontend', 'Backend', 'Reviewer', 'Tester', 'Docs'],
  chatPersonality: 'direct',
  chatReasoningBlocks: true,
  chatToolCalls: true,
  chatToolCallContent: true,
  chatImageAttachments: 'auto',
  captureDir: '',
  captureFfmpegPath: '',
  keybindings: { ...defaultKeybindings },
  setupWizard: { completedAt: null, hermesAutoInstall: false, skippedSteps: [] },
}

export function normalizeSettings(value: unknown): Settings {
  const record = isRecord(value) ? value : undefined
  const legacyShell = readNullableString(record?.shell, defaultProfile.shell)
  const profiles = normalizeProfiles(record?.profiles, legacyShell)
  const requestedProfileId = readString(record?.defaultProfileId, profiles[0].id)
  const defaultProfileId = profiles.some((profile) => profile.id === requestedProfileId) ? requestedProfileId : profiles[0].id
  const workspaceProfileIds = normalizeWorkspaceProfileIds(record?.workspaceProfileIds, profiles)
  const paneRoles = normalizePaneRoles(record?.paneRoles)
  const workspaceOrder = normalizeWorkspaceOrder(record?.workspaceOrder)
  const rolePresets = normalizeRolePresets(record?.rolePresets)
  const setupWizard = normalizeSetupWizard(record?.setupWizard)

  return {
    fontFamily: readNonEmptyString(record?.fontFamily, defaultSettings.fontFamily),
    fontSize: readNumber(record?.fontSize, defaultSettings.fontSize),
    scrollback: readNumber(record?.scrollback, defaultSettings.scrollback),
    terminalFontWeight: readNumberInRange(record?.terminalFontWeight, defaultSettings.terminalFontWeight, 100, 900),
    uiScale: readNumberInRange(record?.uiScale, defaultSettings.uiScale, 0.85, 1.2),
    terminalThemeId: readTerminalThemeId(record?.terminalThemeId),
    selectedPaneHighlightColor: readHexColor(record?.selectedPaneHighlightColor, defaultSettings.selectedPaneHighlightColor),
    alarmHighlightColor: readHexColor(record?.alarmHighlightColor, defaultSettings.alarmHighlightColor),
    reviewedPaneHighlightColor: readHexColor(record?.reviewedPaneHighlightColor, defaultSettings.reviewedPaneHighlightColor),
    terminalScrollbarVisible: readBoolean(record?.terminalScrollbarVisible, defaultSettings.terminalScrollbarVisible),
    terminalTabsVisible: readBoolean(record?.terminalTabsVisible, defaultSettings.terminalTabsVisible),
    cursorStyle: readTerminalCursorStyle(record?.cursorStyle),
    cursorWidth: readNumberInRange(record?.cursorWidth, defaultSettings.cursorWidth, 1, 10),
    keepTerminalsAliveOnClose: readBoolean(record?.keepTerminalsAliveOnClose, defaultSettings.keepTerminalsAliveOnClose),
    resizeSnapTolerance: readNumberInRange(record?.resizeSnapTolerance, defaultSettings.resizeSnapTolerance, 0, 128),
    paneHeaderHeight: readNumberInRange(record?.paneHeaderHeight, defaultSettings.paneHeaderHeight, 24, 56),
    profiles,
    keybindings: normalizeKeybindings(record?.keybindings),
    defaultProfileId,
    workspaceProfileIds,
    paneRoles,
    workspaceOrder,
    hermesCommand: readString(record?.hermesCommand, defaultSettings.hermesCommand),
    chatPersonality: readChatPersonality(record?.chatPersonality),
    rolePresets,
    chatReasoningBlocks: readBoolean(record?.chatReasoningBlocks, defaultSettings.chatReasoningBlocks),
    chatToolCalls: readBoolean(record?.chatToolCalls, defaultSettings.chatToolCalls),
    chatToolCallContent: readBoolean(record?.chatToolCallContent, defaultSettings.chatToolCallContent),
    chatImageAttachments: readChatImageAttachmentMode(record?.chatImageAttachments),
    captureDir: readString(record?.captureDir, defaultSettings.captureDir),
    captureFfmpegPath: readString(record?.captureFfmpegPath, defaultSettings.captureFfmpegPath),
    setupWizard,
  }
}

export function selectedProfile(settings: Settings): Profile {
  return settings.profiles.find((profile) => profile.id === settings.defaultProfileId) ?? settings.profiles[0]
}

export function selectedProfileForWorkspace(settings: Settings, sessionId?: string | null): Profile {
  const profileId = sessionId ? settings.workspaceProfileIds[sessionId] : undefined
  return profileById(settings, profileId)
}

export function profileById(settings: Settings, profileId?: string | null): Profile {
  return settings.profiles.find((profile) => profile.id === profileId) ?? selectedProfile(settings)
}

export function createProfile(settings: Settings, seed: Partial<Profile> = {}): Profile {
  const type = readProfileKind(seed.type)
  const defaults = profileDefaultsForType(type)
  const name = readString(seed.name, defaults.name).trim() || defaults.name
  const requestedId = readString(seed.id, '').trim()
  const baseId = slugifyProfileId(requestedId || name) || `profile-${randomProfileSuffix()}`
  const id = uniqueProfileId(baseId, new Set(settings.profiles.map((profile) => profile.id)))

  return normalizeProfile({ ...defaults, ...seed, id, name, type }, settings.profiles.length)
}

export function canDeleteProfile(settings: Settings, profileId: string): boolean {
  return settings.profiles.length > 1 && settings.profiles.some((profile) => profile.id === profileId)
}

export function paneOverridesFromProfile(
  profile: Profile,
  title?: string,
  options: { remoteCwd?: string | null } = {},
): Pick<PaneConfig, 'shell' | 'args' | 'cwd' | 'env' | 'title'> {
  const command = commandFromProfile(profile, options.remoteCwd)
  return {
    shell: command.shell,
    args: command.args,
    cwd: profile.cwd,
    env: profile.env.map(([key, value]) => [key, value]),
    title: title ?? profile.name,
  }
}

export function isAgentProfile(profile: Profile): boolean {
  if (builtInAgentProfileIds.has(profile.id.toLowerCase())) return true
  const haystack = [profile.id, profile.name, profile.command, profile.shell ?? '', ...profile.args].join(' ').toLowerCase()
  return agentNamePhrasePattern.test(haystack) || agentCommandNames.some((command) => new RegExp(`(^|[\\s\\\\/"'])${command}([\\s\\\\/"']|$|\\.)`).test(haystack))
}

export function isAgentPane(pane: PaneMeta, settings: Settings): boolean {
  const profileId = pane.config.profileId?.trim()
  if (profileId) {
    const profile = settings.profiles.find((candidate) => candidate.id === profileId)
    if (profile) return isAgentProfile(profile)
  }
  const haystack = [
    pane.config.title ?? '',
    pane.config.shell ?? '',
    ...(pane.config.args ?? []),
  ].join(' ').toLowerCase()
  return agentNamePhrasePattern.test(haystack) || agentCommandNames.some((command) => new RegExp(`(^|[\\s\\\\/"'])${command}([\\s\\\\/"']|$|\\.)`).test(haystack))
}

function normalizeProfiles(value: unknown, legacyShell: string | null): Profile[] {
  if (!Array.isArray(value)) {
    return defaultProfiles.map((profile, index) => ({ ...profile, shell: index === 0 ? legacyShell : profile.shell }))
  }

  const profiles = value.map((profile, index) => normalizeProfile(profile, index)).filter((profile) => profile.id.length > 0)
  return profiles.length > 0 ? profiles : defaultProfiles.map((profile, index) => ({ ...profile, shell: index === 0 ? legacyShell : profile.shell }))
}

function normalizeProfile(value: unknown, index: number): Profile {
  const record = isRecord(value) ? value : undefined
  const fallbackId = index === 0 ? defaultProfile.id : `${defaultProfile.id}-${index + 1}`
  const id = readString(record?.id, fallbackId).trim() || fallbackId
  const name = readString(record?.name, id === defaultProfile.id ? defaultProfile.name : id).trim() || defaultProfile.name
  const type = readProfileKind(record?.type)

  const args = readStringArray(record?.args)

  return {
    id,
    name,
    type,
    shell: readNullableString(record?.shell, defaultProfile.shell),
    args: type === 'local' ? normalizeAgentProfileArgs(id, args) : args,
    command: readString(record?.command, defaultProfile.command),
    sshHost: readString(record?.sshHost, defaultProfile.sshHost),
    sshUser: readString(record?.sshUser, defaultProfile.sshUser),
    sshPort: readNullablePort(record?.sshPort, defaultProfile.sshPort),
    sshIdentityFile: readNullableString(record?.sshIdentityFile, defaultProfile.sshIdentityFile),
    sshRemoteCommand: readString(record?.sshRemoteCommand, defaultProfile.sshRemoteCommand),
    sshRemoteCwd: readNullableString(record?.sshRemoteCwd, defaultProfile.sshRemoteCwd),
    sshOptions: readString(record?.sshOptions, defaultProfile.sshOptions),
    sshAllocateTty: readBoolean(record?.sshAllocateTty, defaultProfile.sshAllocateTty),
    env: readEnv(record?.env),
    cwd: readNullableString(record?.cwd, defaultProfile.cwd),
    color: readString(record?.color, defaultProfile.color),
    icon: readString(record?.icon, defaultProfile.icon),
  }
}

function cloneProfiles(profiles: Profile[]): Profile[] {
  return profiles.map((profile) => ({
    ...profile,
    args: [...profile.args],
    env: profile.env.map(([key, value]) => [key, value]),
  }))
}

function profileDefaultsForType(type: ProfileKind): Profile {
  switch (type) {
    case 'ssh':
      return {
        ...defaultProfile,
        id: '',
        name: 'SSH profile',
        type,
        shell: null,
        args: [],
        command: '',
        sshHost: '',
        sshUser: '',
        sshPort: null,
        sshIdentityFile: null,
        sshRemoteCommand: '',
        sshRemoteCwd: null,
        sshOptions: '',
        sshAllocateTty: true,
        env: [],
        cwd: null,
        color: '#76e3ea',
        icon: 'radio-tower',
      }
    case 'command':
      return {
        ...defaultProfile,
        id: '',
        name: 'Command profile',
        type,
        shell: null,
        args: [],
        command: joinCommandLine([defaultProfile.shell ?? 'pwsh.exe', ...defaultProfile.args]),
        sshHost: '',
        sshUser: '',
        sshPort: null,
        sshIdentityFile: null,
        sshRemoteCommand: '',
        sshRemoteCwd: null,
        sshOptions: '',
        sshAllocateTty: true,
        env: [],
        cwd: null,
        color: '#f2cc60',
        icon: 'command',
      }
    default:
      return {
        ...defaultProfile,
        id: '',
        name: 'Local profile',
        type: 'local',
        args: [...defaultProfile.args],
        env: [],
      }
  }
}

function uniqueProfileId(baseId: string, existingIds: Set<string>): string {
  let candidate = baseId
  let attempts = 0
  while (existingIds.has(candidate)) {
    attempts += 1
    const suffix = randomProfileSuffix()
    candidate = attempts > 8 ? `${baseId}-${suffix}-${attempts}` : `${baseId}-${suffix}`
  }
  return candidate
}

function slugifyProfileId(value: string): string {
  const slug = value.trim().toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug
}

function randomProfileSuffix(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid.slice(0, 8)
  return Math.random().toString(36).slice(2, 10) || Date.now().toString(36)
}

function normalizeWorkspaceProfileIds(value: unknown, profiles: Profile[]): Record<string, string> {
  if (!isRecord(value)) return {}
  const profileIds = new Set(profiles.map((profile) => profile.id))
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => entry[0].trim().length > 0 && typeof entry[1] === 'string' && profileIds.has(entry[1]),
    ),
  )
}

function normalizePaneRoles(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        entry[0].trim().length > 0 && typeof entry[1] === 'string' && entry[1].trim().length > 0,
    ),
  )
}

function normalizeWorkspaceOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const order: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    order.push(id)
  }
  return order
}

/** Order sessions by the persisted `workspaceOrder`: ids present in the saved
 *  order come first (in that order), then any sessions not yet in the order
 *  (newly created or never dragged) in their incoming order. Deleted ids in the
 *  saved order are skipped. */
export function orderSessions<T extends { id: string }>(sessions: T[], order: string[]): T[] {
  if (order.length === 0) return sessions
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const ordered: T[] = []
  const used = new Set<string>()
  for (const id of order) {
    const session = byId.get(id)
    if (session && !used.has(id)) {
      ordered.push(session)
      used.add(id)
    }
  }
  for (const session of sessions) {
    if (!used.has(session.id)) ordered.push(session)
  }
  return ordered
}

function commandFromProfile(profile: Profile, remoteCwd?: string | null): Pick<PaneConfig, 'shell' | 'args'> {
  if (profile.type === 'ssh') {
    return { shell: 'ssh', args: sshArgsFromProfile(profile, remoteCwd) }
  }

  if (profile.type === 'command') {
    const [shell, ...args] = splitCommandLine(profile.command)
    return { shell: shell ?? null, args }
  }

  return { shell: profile.shell, args: [...profile.args] }
}

function normalizeAgentProfileArgs(id: string, args: string[]): string[] {
  const command = defaultAgentCommand(id)
  if (!command || !isManagedAgentProfileArgs(args, command)) return args
  return agentProfileArgs(command)
}

function defaultAgentCommand(id: string): string | null {
  switch (id) {
    case 'claude':
      return 'claude'
    case 'codex':
      return 'codex'
    case 'omp':
      return 'omp'
    default:
      return null
  }
}

function isManagedAgentProfileArgs(args: string[], command: string): boolean {
  if (args.length !== 4 || args[0] !== '-NoLogo' || args[1] !== '-NoExit' || args[2] !== '-Command') return false
  return args[3] === command || args[3] === agentProfileCommand(command, legacyTerminalModeResetSequence) || args[3] === agentProfileCommand(command, terminalModeResetSequence)
}

function agentProfileCommand(command: string, resetSequence: string): string {
  return `try { & ${command} } finally { [Console]::Out.Write("${resetSequence}") }`
}

function sshArgsFromProfile(profile: Profile, remoteCwdOverride?: string | null): string[] {
  const args = splitCommandLine(profile.sshOptions)
  if (profile.sshAllocateTty) args.push('-t')
  if (profile.sshPort !== null) args.push('-p', String(profile.sshPort))
  if (profile.sshIdentityFile) args.push('-i', profile.sshIdentityFile)

  const host = profile.sshHost.trim()
  if (host.length === 0) return args

  const user = profile.sshUser.trim()
  args.push(user.length > 0 ? `${user}@${host}` : host)

  const remoteCommand = remoteCommandFromProfile(profile, remoteCwdOverride)
  if (remoteCommand.length > 0) args.push(remoteCommand)
  return args
}

function remoteCommandFromProfile(profile: Profile, remoteCwdOverride?: string | null): string {
  const remoteCommand = profile.sshRemoteCommand.trim()
  const remoteCwd = typeof remoteCwdOverride === 'string' && remoteCwdOverride.trim().length > 0
    ? remoteCwdOverride.trim()
    : profile.sshRemoteCwd?.trim() ?? ''
  if (remoteCwd.length === 0) return remoteCommand
  const changeDirectory = `cd -- ${quoteRemoteShellArg(remoteCwd)}`
  return remoteCommand.length > 0
    ? `${changeDirectory} && ${remoteCommand}`
    : `${changeDirectory} && exec "\${SHELL:-sh}" -l`
}

function quoteRemoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function splitCommandLine(input: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (quote === '"' && char === '\\' && index + 1 < input.length && (input[index + 1] === '"' || input[index + 1] === '\\')) {
      current += input[index + 1]
      index += 1
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        parts.push(current)
        current = ''
      }
      continue
    }
    current += char
  }

  if (current.length > 0) parts.push(current)
  return parts
}

export function joinCommandLine(parts: string[]): string {
  return parts.map(quoteCommandPart).join(' ')
}

function quoteCommandPart(part: string): string {
  if (/^[^\s"']+$/.test(part)) return part
  return `"${part.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function readNonEmptyString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : fallback
}

function readHexColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim()
  return sixDigitHexColorPattern.test(normalized) ? normalized : fallback
}

function readProfileKind(value: unknown): ProfileKind {
  return value === 'ssh' || value === 'command' || value === 'local' ? value : 'local'
}

function normalizeRolePresets(value: unknown): string[] {
  const source = Array.isArray(value) ? readStringArray(value) : defaultSettings.rolePresets
  const normalized = source
    .map((role) => role.trim())
    .filter((role, index, roles) => role.length > 0 && roles.findIndex((candidate) => candidate.toLowerCase() === role.toLowerCase()) === index)
  return normalized.length > 0 ? normalized : [...defaultSettings.rolePresets]
}

function normalizeSetupWizard(value: unknown): SetupWizardSettings {
  const record = isRecord(value) ? value : undefined
  const completedAt = typeof record?.completedAt === 'string' && record.completedAt.trim()
    ? record.completedAt
    : null
  return {
    completedAt,
    hermesAutoInstall: record?.hermesAutoInstall === true,
    skippedSteps: readStringArray(record?.skippedSteps)
      .map((step) => step.trim())
      .filter((step, index, steps) => step.length > 0 && steps.indexOf(step) === index),
  }
}

function readTerminalThemeId(value: unknown): TerminalThemeId {
  return typeof value === 'string' && isTerminalThemeId(value) ? value : defaultSettings.terminalThemeId
}

function readTerminalCursorStyle(value: unknown): TerminalCursorStyle {
  return value === 'bar' || value === 'block' || value === 'underline' ? value : defaultSettings.cursorStyle
}

function readChatPersonality(value: unknown): ChatPersonality {
  return value === 'direct' || value === 'balanced' || value === 'concise' || value === 'exploratory'
    ? value
    : defaultSettings.chatPersonality
}

function readChatImageAttachmentMode(value: unknown): ChatImageAttachmentMode {
  return value === 'auto' || value === 'always' || value === 'never'
    ? value
    : defaultSettings.chatImageAttachments
}

function readNullableString(value: unknown, fallback: string | null): string | null {
  if (value === null) return null
  return typeof value === 'string' ? value : fallback
}

function readNullablePort(value: unknown, fallback: number | null): number | null {
  if (value === null) return null
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535 ? value : fallback
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readNumberInRange(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback
}


function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

function readEnv(value: unknown): [string, string][] {
  if (!Array.isArray(value)) return []
  return value.filter(isStringPair).map(([key, envValue]) => [key, envValue])
}

function isStringPair(value: unknown): value is [string, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string'
}
