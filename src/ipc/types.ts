export type SessionMeta = {
  id: string
  name: string
  paneCount: number
  createdAt: number
  workspaceFolder?: string | null
}

export type PaneConfig = {
  paneId: string
  shell?: string | null
  args: string[]
  cwd?: string | null
  env: [string, string][]
  title?: string | null
  icon?: string | null
  profileId?: string | null
  role?: string | null
  cols: number
  rows: number
}

export type PaneMeta = {
  id: string
  config: PaneConfig
  alive: boolean
}

export type ResourceProc = { pid: number; memBytes: number; processCount: number }

export type ResourcePane = { sessionId: string; paneId: string; rootPid: number | null; memBytes: number; processCount: number }

export type ResourceSnapshot = { daemon: ResourceProc; app: ResourceProc; panes: ResourcePane[]; totalMemBytes: number }

export type AttachedSession = {
  layoutJson?: string | null
  panes: PaneMeta[]
}

export type TaskStatus = 'pending' | 'assigned' | 'in-progress' | 'done'

export type Task = {
  id: string
  sessionId: string
  title: string
  description: string
  status: TaskStatus
  statusTimestamps: Partial<Record<TaskStatus, number>>
  assignedPaneId?: string
  assignedRole?: string
  baselineRef?: string
  worktreePath?: string
  commitMessage?: string
  resultSummary?: string
  createdAt: number
  updatedAt: number
}

export type ChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typeChanged' | 'untracked'

export type ChangedFile = {
  path: string
  oldPath?: string
  changeType: ChangeType
  additions: number
  deletions: number
  binary: boolean
}

export type FileContents = { old: string; new: string; binary: boolean }

export type WorktreeInfo = { worktreePath: string; branch: string }

export type HermesConfiguredModel = { provider: string; model: string; baseUrl?: string | null }

export type HermesWorkspaceState = { home: string; workspaceFolder: string; model: HermesConfiguredModel | null }

export type HermesRuntimeStatus = { installed: boolean; command: string; version?: string }

export type HermesModelInfo = { id: string; name: string }

export type HermesPermissionOption = { optionId: string; name: string; kind: string }

export type HermesGatewayConfig = {
  platform: 'telegram' | 'discord' | 'slack'
  tokenEnv: string
  tokenSet: boolean
  allowedUsers: string
}

export type HermesGatewayStatus = { running: boolean; pid?: number }

export type SkillScope = 'global' | 'workspace'

export type SkillEntry = {
  id: string
  name: string
  category: string
  description: string
  scope: SkillScope
  enabled: boolean
  updatedAt?: number | string | null
  path?: string | null
  readOnly?: boolean
  content?: string | null
}

export type SkillApplyInput = {
  content: string
  id: string
  name?: string | null
  category?: string | null
  description?: string | null
  scope: SkillScope
  sessionId?: string | null
  enabled?: boolean
}

export type LicenseState = 'unlicensed' | 'validOnline' | 'validOffline' | 'activationLimit' | 'reviewRequired' | 'invalid' | 'revoked' | 'configurationError'

export type LicenseDevice = {
  activationId: string
  deviceId: string
  deviceName: string
  appVersion: string
  status: 'pending' | 'active' | 'review_required' | 'deactivated'
  activatedAt: string | null
  lastValidatedAt: string | null
  current: boolean
}

export type LicenseStatus = {
  state: LicenseState
  entitled: boolean
  provider: 'vibelink' | 'lemonsqueezy' | null
  maskedKey: string | null
  activationId: string | null
  deviceId: string
  deviceName: string
  maxDevices: number
  devices: LicenseDevice[]
  validatedAt: string | null
  offlineGraceUntil: string | null
  purchaseUrl: string
  message: string
}
