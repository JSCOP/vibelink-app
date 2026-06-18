import type { PaneConfig } from '../ipc/types'

export type Profile = {
  id: string
  name: string
  shell: string | null
  args: string[]
  env: [string, string][]
  cwd: string | null
  color: string
  icon: string
}

export type Settings = {
  fontFamily: string
  fontSize: number
  scrollback: number
  accent: string
  profiles: Profile[]
  defaultProfileId: string
}

const defaultProfiles: Profile[] = [
  {
    id: 'default',
    name: 'Shell',
    shell: null,
    args: [],
    env: [],
    cwd: null,
    color: '#7ee787',
    icon: 'terminal',
  },
  {
    id: 'powershell',
    name: 'PowerShell',
    shell: 'pwsh.exe',
    args: ['-NoLogo'],
    env: [],
    cwd: null,
    color: '#58a6ff',
    icon: 'terminal-square',
  },
  {
    id: 'cmd',
    name: 'CMD',
    shell: 'cmd.exe',
    args: ['/D'],
    env: [],
    cwd: null,
    color: '#d2a8ff',
    icon: 'square-terminal',
  },
  {
    id: 'claude',
    name: 'Claude',
    shell: 'claude',
    args: [],
    env: [],
    cwd: null,
    color: '#f2cc60',
    icon: 'sparkles',
  },
  {
    id: 'codex',
    name: 'Codex',
    shell: 'codex',
    args: [],
    env: [],
    cwd: null,
    color: '#7ee787',
    icon: 'bot',
  },
  {
    id: 'omp',
    name: 'OMP',
    shell: 'omp',
    args: [],
    env: [],
    cwd: null,
    color: '#76e3ea',
    icon: 'zap',
  },
]

const defaultProfile = defaultProfiles[0]

export const defaultSettings: Settings = {
  fontFamily: '"Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace',
  fontSize: 13,
  scrollback: 5000,
  accent: '#7ee787',
  profiles: cloneProfiles(defaultProfiles),
  defaultProfileId: defaultProfile.id,
}

export function normalizeSettings(value: unknown): Settings {
  const record = isRecord(value) ? value : undefined
  const legacyShell = readNullableString(record?.shell, defaultProfile.shell)
  const profiles = normalizeProfiles(record?.profiles, legacyShell)
  const requestedProfileId = readString(record?.defaultProfileId, profiles[0].id)
  const defaultProfileId = profiles.some((profile) => profile.id === requestedProfileId) ? requestedProfileId : profiles[0].id

  return {
    fontFamily: readString(record?.fontFamily, defaultSettings.fontFamily),
    fontSize: readNumber(record?.fontSize, defaultSettings.fontSize),
    scrollback: readNumber(record?.scrollback, defaultSettings.scrollback),
    accent: readString(record?.accent, defaultSettings.accent),
    profiles,
    defaultProfileId,
  }
}

export function selectedProfile(settings: Settings): Profile {
  return settings.profiles.find((profile) => profile.id === settings.defaultProfileId) ?? settings.profiles[0]
}

export function paneOverridesFromProfile(profile: Profile, title?: string): Pick<PaneConfig, 'shell' | 'args' | 'cwd' | 'env' | 'title'> {
  return {
    shell: profile.shell,
    args: [...profile.args],
    cwd: profile.cwd,
    env: profile.env.map(([key, value]) => [key, value]),
    title: title ?? profile.name,
  }
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

  return {
    id,
    name,
    shell: readNullableString(record?.shell, defaultProfile.shell),
    args: readStringArray(record?.args),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function readNullableString(value: unknown, fallback: string | null): string | null {
  if (value === null) return null
  return typeof value === 'string' ? value : fallback
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
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
