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
  restoreOnStart?: boolean
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
export type WorkspaceBrief = {
  purpose: string
  notes: string
  updatedAt: string
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

export type WorktreeStorageMode = 'drive' | 'appData' | 'custom'

export type WorktreeStorage = {
  mode: WorktreeStorageMode
  drive: string
  folderName: string
  customRoot: string
  groupByRepository: boolean
}

export type WorktreeStorageOptions = { drives: string[]; appDataRoot: string }

export type WorktreeStorageResolution = { root: string; example: string; writable: boolean; fallbackReason: string | null }

export type WorktreeEntry = {
  worktreePath: string
  branch: string
  head: string
  isMain: boolean
  locked: boolean
  prunable: boolean
  dirty: boolean
  exists: boolean
}

export type WorktreeInfo = { worktreePath: string; branch: string }

export type RepoState = 'clean' | 'merging' | 'rebasing' | 'cherryPicking' | 'reverting'

export type RemoteInfo = { name: string; url: string }

export type RepoInfo = {
  isRepo: boolean
  root: string | null
  branch: string | null
  detachedSha: string | null
  headSha: string | null
  upstream: string | null
  ahead: number
  behind: number
  state: RepoState
  remotes: RemoteInfo[]
}

export type RepoKind = 'submodule' | 'nestedRepo'

export type SubmoduleState = { commitChanged: boolean; modified: boolean; untracked: boolean }

export type StatusEntry = { path: string; oldPath: string | null; changeType: ChangeType; repoKind?: RepoKind | null; submoduleState?: SubmoduleState | null }

export type GitDirEntry = { name: string; isDir: boolean; repoKind: RepoKind | null; repositoryInitialized: boolean | null; ignored: boolean; changeType?: ChangeType | null; oldPath?: string | null; diffArea?: 'staged' | 'unstaged' | null }

export type WorkingStatus = {
  staged: StatusEntry[]
  unstaged: StatusEntry[]
  untracked: StatusEntry[]
  conflicted: StatusEntry[]
  truncated: boolean
}

export type LogOptions = {
  refName?: string | null
  path?: string | null
  skip: number
  limit: number
  search?: string | null
  author?: string | null
}

export type CommitInfo = {
  sha: string
  parents: string[]
  refs: string[]
  authorName: string
  authorEmail: string
  authorDate: string
  subject: string
}

export type LogPage = { commits: CommitInfo[]; hasMore: boolean }

export type CommitDetail = {
  sha: string
  parents: string[]
  authorName: string
  authorEmail: string
  authorDate: string
  committerName: string
  committerDate: string
  body: string
  files: ChangedFile[]
}

export type BranchInfo = {
  name: string
  isHead: boolean
  isRemote: boolean
  upstream: string | null
  ahead: number
  behind: number
  lastCommitSubject: string
  lastCommitDate: string
}

export type StashInfo = { index: number; message: string }
export type TagInfo = { name: string; sha: string; message: string | null }
export type CloneProgress = { line: string; done: boolean }

export type DirEntryInfo = {
  name: string
  isDir: boolean
  isSymlink: boolean
  size: number
  modifiedAt: string | null
}

export type TextFile = { content: string; truncated: boolean; binary: boolean }

export type HostingInfo = {
  provider: 'github' | 'gitlab' | null
  host: string | null
  owner: string | null
  repo: string | null
  webUrl: string | null
  tokenPresent: boolean
}

export type CreatePrRequest = { title: string; body: string; sourceBranch: string; targetBranch: string; draft: boolean }
export type PrInfo = { number: number; title: string; author: string; sourceBranch: string; targetBranch: string; draft: boolean; url: string; state: string }
export type PrCreated = { number: number; url: string }
export type CiCheck = { name: string; state: string; url: string | null }
export type CiStatus = { state: 'success' | 'failure' | 'pending' | 'none'; checks: CiCheck[] }
export type PrDetail = PrInfo & { body: string; headSha: string | null; checks: CiCheck[] }
export type DeviceCodeInfo = { userCode: string; verificationUri: string; interval: number; deviceCodeHandle: string }

export type HermesConfiguredModel = { provider: string; model: string; baseUrl?: string | null }

export type HermesWorkspaceState = { home: string; workspaceFolder: string; model: HermesConfiguredModel | null }

export type HermesRuntimeStatus = {
  detected: boolean
  command: string | null
  cliCommand: string | null
  version: string | null
  home: string | null
  source: 'override' | 'path' | 'installer' | null
  configuredModel: HermesConfiguredModel | null
}

export type HermesModelInfo = { id: string; name: string }

export type HermesPermissionOption = { optionId: string; name: string; kind: string }


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

export type LicenseState = 'development' | 'unlicensed' | 'core' | 'trial' | 'trialExpired' | 'validOnline' | 'validOffline' | 'activationLimit' | 'reviewRequired' | 'invalid' | 'revoked' | 'configurationError'

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
  provider: 'vibelink' | 'lemonsqueezy' | 'moobang' | null
  plan?: 'core' | 'pro' | 'trial' | 'none' | null
  email?: string | null
  maskedKey: string | null
  activationId: string | null
  deviceId: string
  deviceName: string
  maxDevices: number
  devices: LicenseDevice[]
  validatedAt: string | null
  offlineGraceUntil: string | null
  trialEndsAt?: string | null
  purchaseUrl: string
  message: string
}

export type GitDiffArea = 'unstaged' | 'staged' | 'review'
export type GitHunkAction = 'stage' | 'unstage' | 'discard'
export type UnifiedDiffLine = { kind: 'context' | 'addition' | 'deletion' | 'noNewline'; text: string; oldLine: number | null; newLine: number | null }
export type UnifiedDiffHunk = { id: string; header: string; oldStart: number; oldCount: number; newStart: number; newCount: number; lines: UnifiedDiffLine[] }
export type UnifiedFileDiff = { path: string; area: GitDiffArea; binary: boolean; hunks: UnifiedDiffHunk[] }

export type MergePrResult = { number: number; sourceBranch: string; targetBranch: string; headSha: string; mergeSha: string | null; message: string }
