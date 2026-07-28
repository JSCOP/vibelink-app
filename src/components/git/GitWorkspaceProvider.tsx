/* eslint-disable react-hooks/preserve-manual-memoization, react-hooks/set-state-in-effect */
import { Channel, invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { GitBranch as GitBranchIcon } from 'lucide-react'
import type {
  BranchInfo,
  ChangedFile,
  CloneProgress,
  CommitDetail,
  CommitInfo,
  FileContents,
  LogPage,
  RepoInfo,
  StashInfo,
  TagInfo,
  WorkingStatus,
  UnifiedFileDiff,
  GitHunkAction,
} from '../../ipc/types'
import { discoverRepos, type DiscoveredRepo } from '../../ipc/gitDiscovery'
import { useWorkspaceContentActions } from '../../layout/contentActions'
import { useExplorerStore } from '../../state/explorer'
import {
  emptyGitSessionState,
  repositoryFolder,
  repositoryStateFor,
  useGitStore,
  type GitDiffArea,
  type GitRepositoryState,
  type GitTab,
} from '../../state/git'
import { useWorkspaceStore } from '../../state/store'
import { worktreeBySession, type WorktreeCheckpoint, type WorktreeReviewComment } from '../../state/worktrees'
import { QuickPick } from '../QuickPick'
import { confirmDialog, promptDialog } from '../appDialogStore'
import type { PickerEntry } from '../pickerModel'
import { computeGraphLanes, type GraphLanes } from './graphLanes'
import type {
  BranchRowAction,
  BranchRowView,
  GitChangeGroup,
  GitChangeItem,
  GitRowAction,
  SourceControlPrimaryAction,
  StashRowView,
} from './gitWorkspaceModel'
import { sourceControlPrimaryAction } from './gitWorkspaceModel'
import { isCurrentReviewComment, reviewCommentAnchorKey, type WorktreeReviewIdentity } from '../workspaces/worktreeReview'
import './GitWorkspace.css'

const EMPTY_STATUS: WorkingStatus = { staged: [], unstaged: [], untracked: [], conflicted: [], truncated: false }

const REPOSITORY_DISCOVERY_DEPTH = 4
const REPOSITORY_STATUS_PREFETCH_LIMIT = 64

type GitRepositoryTargetDefinition = {
  root: string
  name: string
  isSubmodule: boolean
}

export type GitRepositoryTarget = GitRepositoryTargetDefinition & {
  repository: GitRepositoryState
}

function normalizeRepositoryPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/')
  if (normalized === '/') return normalized
  if (/^[A-Za-z]:\/+$/u.test(normalized)) return `${normalized.slice(0, 2)}/`
  return normalized.replace(/\/+$/u, '')
}

function repositoryPathKey(value: string): string {
  const normalized = normalizeRepositoryPath(value)
  return /^(?:[A-Za-z]:\/|\/\/)/u.test(normalized) ? normalized.toLowerCase() : normalized
}

function repositoryPathsEqual(left: string, right: string): boolean {
  return repositoryPathKey(left) === repositoryPathKey(right)
}

function repositoryPathWithin(path: string, parent: string): boolean {
  const normalizedParent = normalizeRepositoryPath(parent)
  if (!normalizedParent) return false
  const prefix = normalizedParent.endsWith('/') ? normalizedParent : `${normalizedParent}/`
  const pathKey = repositoryPathKey(path)
  return pathKey === repositoryPathKey(normalizedParent) || pathKey.startsWith(repositoryPathKey(prefix))
}

function relativeRepositoryRoot(workspaceFolder: string, repositoryPath: string): string | null {
  const workspace = normalizeRepositoryPath(workspaceFolder)
  const repository = normalizeRepositoryPath(repositoryPath)
  if (repositoryPathsEqual(workspace, repository)) return ''
  const prefix = workspace.endsWith('/') ? workspace : `${workspace}/`
  if (!repositoryPathKey(repository).startsWith(repositoryPathKey(prefix))) return null
  return repository.slice(prefix.length)
}

function repositoryTargetDefinitions(
  workspaceFolder: string,
  repositories: DiscoveredRepo[],
  allowedRepositoryFolders: string[] | null,
): GitRepositoryTargetDefinition[] {
  const targets = new Map<string, GitRepositoryTargetDefinition>()
  for (const repository of repositories) {
    const root = relativeRepositoryRoot(workspaceFolder, repository.path)
    if (root === null) continue
    if (root && allowedRepositoryFolders && !allowedRepositoryFolders.some((folder) => repositoryPathWithin(repository.path, folder))) continue
    const name = repository.name.trim() || root.split('/').pop() || 'Workspace repository'
    targets.set(root, { root, name, isSubmodule: repository.isSubmodule })
  }
  return [...targets.values()].sort((left, right) => {
    if (!left.root) return right.root ? -1 : 0
    if (!right.root) return 1
    return left.root.localeCompare(right.root, undefined, { sensitivity: 'base' })
  })
}


type RemoteComparison = {
  repoRoot: string
  upstream: string
  files: ChangedFile[]
  selectedPath: string | null
}

type HistoryModel = {
  commits: CommitInfo[]
  graph: GraphLanes
  hasMore: boolean
  loading: boolean
  error: string | null
  search: string
  author: string
  pathFilter: string | null
  selectedSha: string | null
  detail: CommitDetail | null
  detailLoading: boolean
  compareMode: boolean
  compareFiles: ChangedFile[]
  selectedPath: string | null
  contents: FileContents | null
  contentsLoading: boolean
  contentsError: string | null
  setSearch: (value: string) => void
  setAuthor: (value: string) => void
  clearPathFilter: () => void
  activate: () => void
  refresh: () => Promise<void>
  loadMore: () => Promise<void>
  selectCommit: (sha: string) => void
  selectFile: (path: string) => void
  copySha: () => void
  compareHead: () => void
  createBranch: () => void
  createTag: () => void
}

type BranchesModel = {
  localRows: BranchRowView[]
  remoteRows: BranchRowView[]
  stashRows: StashRowView[]
  tags: TagInfo[]
  loading: boolean
  error: string | null
  baseRef: string
  headRef: string
  compareFiles: ChangedFile[]
  selectedPath: string | null
  contents: FileContents | null
  contentsLoading: boolean
  contentsError: string | null
  workingTreeDirty: boolean
  stashOpen: boolean
  stashMessage: string
  includeUntracked: boolean
  setStashMessage: (value: string) => void
  setIncludeUntracked: (value: boolean) => void
  activate: () => void
  refresh: () => Promise<void>
  createBranch: () => void
  openBasePicker: () => void
  openHeadPicker: () => void
  compare: () => void
  selectFile: (path: string) => void
  openStash: () => void
  saveStash: () => void
  closeStash: () => void
}

export type GitWorkspaceController = {
  entitled: boolean
  sessionId: string | null
  workspaceFolder: string | null
  activeRepoRoot: string
  activeWorkspaceFolder: string | null
  repository: GitRepositoryState
  repoInfo: RepoInfo | null
  status: WorkingStatus
  repositoryTargets: GitRepositoryTarget[]
  repositoryDiscoveryLoading: boolean
  repositoryDiscoveryError: string | null
  repositoryScopeName: string | null
  activeTab: GitTab
  commitMessage: string
  amend: boolean
  setCommitMessage: (value: string) => void
  setAmend: (value: boolean) => void
  groups: GitChangeGroup[]
  selectedPath: string | null
  selectedArea: GitDiffArea | 'remote'
  contents: FileContents | null
  diffLoading: boolean
  diffError: string | null
  diffHunks: UnifiedFileDiff | null
  selectedHunkId: string | null
  reviewWarning: string | null
  reviewIdentity: WorktreeReviewIdentity | null
  reviewComments: WorktreeReviewComment[]
  reviewCheckpoints: WorktreeCheckpoint[]
  reviewAnchorKeys: ReadonlySet<string>
  selectedHunkComments: WorktreeReviewComment[]
  reviewLoading: boolean
  reviewError: string | null
  refreshReview: () => Promise<void>
  selectHunk: (hunkId: string) => void
  applyHunk: (action: GitHunkAction) => void
  commentHunk: () => void
  commentLine: (line: number, side: 'old' | 'new') => void
  remoteComparisonActive: boolean
  remoteCompareLoading: boolean
  primaryAction: SourceControlPrimaryAction | null
  history: HistoryModel
  branches: BranchesModel
  refresh: () => Promise<void>
  refreshRepository: () => Promise<void>
  refreshHosting: (force?: boolean) => Promise<void>
  activateRepository: (repoRoot: string) => void
  openBranchPicker: () => void
  openClone: () => void
  fetch: () => void
  pull: () => void
  push: () => void
  compareRemote: () => void
  showWorkingChanges: () => void
  selectChange: (item: GitChangeItem) => void
  stagePaths: (paths: string[]) => void
  unstagePaths: (paths: string[]) => void
  discardPaths: (paths: string[], untracked: boolean) => void
  stageAll: () => void
  commit: () => void
  continueState: (() => void) | null
  abortState: (() => void) | null
  runPrimaryAction: () => void
  openWorkbench: (tab?: GitTab) => Promise<void>
  openAssigned: () => Promise<void>
  // Background-only: highlights the path in the Explorer store without
  // activating the Explorer panel. Diff/file-list clicks use this.
  selectInExplorer: (path: string) => void
  // Explicit reveal: also brings the Explorer panel forward.
  revealFile: (path: string) => void
  runMutation: (operation: () => Promise<unknown>) => Promise<void>
}

const GitWorkspaceContext = createContext<GitWorkspaceController | null>(null)

// eslint-disable-next-line react-refresh/only-export-components
export function useGitWorkspace(): GitWorkspaceController {
  const controller = useContext(GitWorkspaceContext)
  if (!controller) throw new Error('GitWorkspaceProvider is not mounted')
  return controller
}

export type GitWorkspaceProviderProps = {
  children: ReactNode
  pollIntervalMs?: number
}


export function GitWorkspaceProvider({ children, pollIntervalMs = 3_000 }: GitWorkspaceProviderProps) {
  "use no memo"
  const contentActions = useWorkspaceContentActions()
  const sessionId = useWorkspaceStore((state) => state.activeSessionId ?? null)
  const sessions = useWorkspaceStore((state) => state.sessions)
  const worktrees = useWorkspaceStore((state) => state.worktreeProjections)
  const entitled = useWorkspaceStore((state) => Boolean(state.license.ready && state.license.status?.entitled))
  const workspaceGroups = useWorkspaceStore((state) => state.settings.workspaceGroups)
  const workspaceGroupIds = useWorkspaceStore((state) => state.settings.workspaceGroupIds)
  const workspaceFolder = useMemo(() => sessions.find((session) => session.id === sessionId)?.workspaceFolder ?? null, [sessionId, sessions])
  const workspaceGroup = useMemo(() => {
    const directGroupId = sessionId ? workspaceGroupIds[sessionId] : null
    const directGroup = directGroupId ? workspaceGroups.find((group) => group.id === directGroupId) : null
    if (directGroup) return directGroup
    return workspaceGroups.find((group) => group.rootFolder && workspaceFolder && repositoryPathsEqual(group.rootFolder, workspaceFolder)) ?? null
  }, [sessionId, workspaceFolder, workspaceGroupIds, workspaceGroups])
  const workspaceGroupRootActive = Boolean(workspaceGroup?.rootFolder && workspaceFolder && repositoryPathsEqual(workspaceGroup.rootFolder, workspaceFolder))
  const repositoryScopeName = workspaceGroupRootActive ? workspaceGroup?.name ?? null : null
  const repositoryDiscoveryFolders = useMemo(() => {
    if (!workspaceGroupRootActive || !workspaceGroup) return null
    const memberFolders = sessions.flatMap((session) => {
      if (session.id === sessionId || workspaceGroupIds[session.id] !== workspaceGroup.id || !session.workspaceFolder) return []
      return [session.workspaceFolder]
    })
    return memberFolders.length > 0 ? memberFolders : null
  }, [sessionId, sessions, workspaceGroup, workspaceGroupIds, workspaceGroupRootActive])
  const gitState = useGitStore((state) => sessionId ? state.sessions[sessionId] : undefined) ?? emptyGitSessionState
  const activeRepoRoot = gitState.activeRepoRoot
  const repository = repositoryStateFor(gitState, activeRepoRoot)
  const repoInfo = repository.repoInfo
  const status = repository.status ?? EMPTY_STATUS
  const activeWorkspaceFolder = workspaceFolder ? repositoryFolder(workspaceFolder, activeRepoRoot) : null
  const refreshRepository = useGitStore((state) => state.refreshRepository)
  const refreshHosting = useGitStore((state) => state.refreshHosting)
  const runGitMutation = useGitStore((state) => state.runGitMutation)
  const setActiveRepository = useGitStore((state) => state.setActiveRepository)
  const setSelectedPath = useGitStore((state) => state.setSelectedPath)
  const setActiveTab = useGitStore((state) => state.setActiveTab)

  const [commitDrafts, setCommitDrafts] = useState<Record<string, { message: string; amend: boolean }>>({})
  const draft = sessionId ? commitDrafts[sessionId] ?? { message: '', amend: false } : { message: '', amend: false }
  const setCommitMessage = useCallback((message: string) => {
    if (!sessionId) return
    setCommitDrafts((current) => ({ ...current, [sessionId]: { ...(current[sessionId] ?? { message: '', amend: false }), message } }))
  }, [sessionId])
  const setAmend = useCallback((amend: boolean) => {
    if (!sessionId) return
    setCommitDrafts((current) => ({ ...current, [sessionId]: { ...(current[sessionId] ?? { message: '', amend: false }), amend } }))
  }, [sessionId])

  const [diffContents, setDiffContents] = useState<FileContents | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffHunks, setDiffHunks] = useState<UnifiedFileDiff | null>(null)
  const [selectedHunkId, setSelectedHunkId] = useState<string | null>(null)
  const [reviewWarning, setReviewWarning] = useState<string | null>(null)
  const [reviewBaseHead, setReviewBaseHead] = useState<string | null>(null)
  const [reviewComments, setReviewComments] = useState<WorktreeReviewComment[]>([])
  const [reviewCheckpoints, setReviewCheckpoints] = useState<WorktreeCheckpoint[]>([])
  const [reviewAnchorKeys, setReviewAnchorKeys] = useState<ReadonlySet<string>>(new Set<string>())
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [diffRefreshRevision, setDiffRefreshRevision] = useState(0)
  const diffRequestGeneration = useRef(0)
  const [remoteComparison, setRemoteComparison] = useState<RemoteComparison | null>(null)
  const activeRemoteComparison = remoteComparison?.repoRoot === activeRepoRoot ? remoteComparison : null
  const [remoteCompareLoading, setRemoteCompareLoading] = useState(false)

  const [discoveredRepositoryTargets, setDiscoveredRepositoryTargets] = useState<GitRepositoryTargetDefinition[]>([])
  const [repositoryDiscoveryLoading, setRepositoryDiscoveryLoading] = useState(false)
  const [repositoryDiscoveryError, setRepositoryDiscoveryError] = useState<string | null>(null)
  const repositoryDiscoveryGeneration = useRef(0)
  const repositoryTargets = useMemo<GitRepositoryTarget[]>(() => {
    const workspace = workspaceFolder ? normalizeRepositoryPath(workspaceFolder) : ''
    const workspaceRepositoryName = workspace.split('/').pop() || 'Workspace repository'
    const targets = new Map(discoveredRepositoryTargets.map((target) => [target.root, target]))
    for (const [root, cachedRepository] of Object.entries(gitState.repositories)) {
      if (!cachedRepository.repoInfo?.isRepo || targets.has(root)) continue
      targets.set(root, {
        root,
        name: root ? root.split('/').pop() || root : workspaceRepositoryName,
        isSubmodule: false,
      })
    }
    return [...targets.values()]
      .sort((left, right) => {
        if (!left.root) return right.root ? -1 : 0
        if (!right.root) return 1
        return left.root.localeCompare(right.root, undefined, { sensitivity: 'base' })
      })
      .map((target) => ({ ...target, repository: repositoryStateFor(gitState, target.root) }))
  }, [discoveredRepositoryTargets, gitState, workspaceFolder])

  const refreshRepositoryDiscovery = useCallback(async () => {
    if (!entitled || !sessionId || !workspaceFolder) return
    const generation = repositoryDiscoveryGeneration.current + 1
    repositoryDiscoveryGeneration.current = generation
    setRepositoryDiscoveryLoading(true)
    setRepositoryDiscoveryError(null)
    try {
      const discovered = await discoverRepos(workspaceFolder, REPOSITORY_DISCOVERY_DEPTH)
      if (repositoryDiscoveryGeneration.current !== generation) return
      const targets = repositoryTargetDefinitions(workspaceFolder, Array.isArray(discovered) ? discovered : [], repositoryDiscoveryFolders)
      setDiscoveredRepositoryTargets(targets)
      void Promise.all(targets.slice(0, REPOSITORY_STATUS_PREFETCH_LIMIT).map((target) => (
        refreshRepository(sessionId, workspaceFolder, target.root)
      )))
    } catch (reason) {
      if (repositoryDiscoveryGeneration.current === generation) setRepositoryDiscoveryError(String(reason))
    } finally {
      if (repositoryDiscoveryGeneration.current === generation) setRepositoryDiscoveryLoading(false)
    }
  }, [entitled, refreshRepository, repositoryDiscoveryFolders, sessionId, workspaceFolder])

  const selectedRelativePath = useMemo(() => {
    if (!gitState.selectedPath || gitState.selectedRepoRoot !== activeRepoRoot) return null
    return activeRepoRoot ? gitState.selectedPath.slice(activeRepoRoot.length).replace(/^\/+/, '') : gitState.selectedPath
  }, [activeRepoRoot, gitState.selectedPath, gitState.selectedRepoRoot])
  const selectedPath = activeRemoteComparison?.selectedPath ?? selectedRelativePath
  const selectedArea = activeRemoteComparison ? 'remote' : gitState.selectedArea ?? 'unstaged'
  const activeWorktree = useMemo(() => sessionId ? worktreeBySession(worktrees, sessionId)?.record ?? null : null, [sessionId, worktrees])
  const reviewIdentity = useMemo<WorktreeReviewIdentity | null>(() => activeWorktree && reviewBaseHead && repoInfo?.headSha ? {
    worktreeId: activeWorktree.id,
    instanceId: activeWorktree.instanceId,
    baseHead: reviewBaseHead,
    head: repoInfo.headSha,
  } : null, [activeWorktree, repoInfo?.headSha, reviewBaseHead])

  const refreshReview = useCallback(async () => {
    if (!entitled || !activeWorktree || !activeWorkspaceFolder) {
      setReviewBaseHead(null)
      setReviewComments([])
      setReviewCheckpoints([])
      setReviewAnchorKeys(new Set<string>())
      setReviewError(null)
      return
    }
    setReviewLoading(true)
    setReviewError(null)
    let loadedCheckpoints: WorktreeCheckpoint[] = []
    let loadedComments: WorktreeReviewComment[] = []
    try {
      const [checkpoints, comments] = await Promise.all([
        invoke<WorktreeCheckpoint[]>('worktree_checkpoints_list', { worktreeId: activeWorktree.id }),
        invoke<WorktreeReviewComment[]>('worktree_review_comments_list', { worktreeId: activeWorktree.id }),
      ])
      loadedCheckpoints = checkpoints
      loadedComments = comments
      const baseRef = activeWorktree.baseRef.trim() || activeWorktree.head
      const basePage = await invoke<LogPage>('git_log', { workspaceFolder: activeWorkspaceFolder, options: { refName: baseRef, path: null, skip: 0, limit: 1, search: null, author: null } })
      const baseHead = basePage.commits[0]?.sha ?? activeWorktree.head
      const head = repoInfo?.headSha ?? activeWorktree.head
      const paths = [...new Set(comments.filter((comment) => comment.worktreeId === activeWorktree.id && comment.instanceId === activeWorktree.instanceId && comment.baseHead === baseHead && comment.head === head).map((comment) => comment.path))]
      const diffs = await Promise.all(paths.flatMap((path) => [
        invoke<UnifiedFileDiff>('git_diff_hunks', { workspaceFolder: activeWorkspaceFolder, path, area: 'unstaged', baseRef: null, headRef: null }).catch(() => null),
        invoke<UnifiedFileDiff>('git_diff_hunks', { workspaceFolder: activeWorkspaceFolder, path, area: 'staged', baseRef: null, headRef: null }).catch(() => null),
        invoke<UnifiedFileDiff>('git_diff_hunks', { workspaceFolder: activeWorkspaceFolder, path, area: 'review', baseRef: baseHead, headRef: head }).catch(() => null),
      ]))
      const anchors = new Set<string>()
      for (const diff of diffs) {
        if (!diff) continue
        for (const hunk of diff.hunks) {
          anchors.add(`${diff.path}\0hunk\0${hunk.id}`)
          for (const line of hunk.lines) {
            if (line.oldLine !== null) anchors.add(reviewCommentAnchorKey({ path: diff.path, side: 'old', line: line.oldLine, hunkId: hunk.id }))
            if (line.newLine !== null) anchors.add(reviewCommentAnchorKey({ path: diff.path, side: 'new', line: line.newLine, hunkId: hunk.id }))
          }
        }
      }
      setReviewBaseHead(baseHead)
      setReviewCheckpoints(checkpoints)
      setReviewComments(comments)
      setReviewAnchorKeys(anchors)
    } catch (reason) {
      setReviewError(String(reason))
      setReviewBaseHead(null)
      setReviewComments(loadedComments)
      setReviewCheckpoints(loadedCheckpoints)
      setReviewAnchorKeys(new Set<string>())
    } finally {
      setReviewLoading(false)
    }
  }, [activeWorkspaceFolder, activeWorktree, entitled, repoInfo?.headSha])

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshReview() }, 0)
    return () => window.clearTimeout(timer)
  }, [diffRefreshRevision, refreshReview])

  const refresh = useCallback(async () => {
    if (!entitled || !sessionId) return
    await Promise.all([
      refreshRepository(sessionId, workspaceFolder, activeRepoRoot),
      refreshHosting(sessionId, workspaceFolder, 'HEAD', false, activeRepoRoot),
    ])
  }, [activeRepoRoot, entitled, refreshHosting, refreshRepository, sessionId, workspaceFolder])

  useEffect(() => {
    if (!entitled || !sessionId) return
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    refreshVisible()
    const timer = window.setInterval(refreshVisible, pollIntervalMs)
    window.addEventListener('focus', refreshVisible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshVisible)
    }
  }, [entitled, pollIntervalMs, refresh, sessionId])

  useEffect(() => {
    setDiscoveredRepositoryTargets([])
    setRepositoryDiscoveryError(null)
    setRepositoryDiscoveryLoading(false)
    if (entitled && sessionId && workspaceFolder) void refreshRepositoryDiscovery()
    return () => {
      repositoryDiscoveryGeneration.current += 1
    }
  }, [entitled, refreshRepositoryDiscovery, sessionId, workspaceFolder])

  const orderedEntries = useMemo(
    () => [...status.conflicted, ...status.staged, ...status.unstaged, ...status.untracked],
    [status.conflicted, status.staged, status.unstaged, status.untracked],
  )

  useEffect(() => {
    if (!repository.status || !sessionId) return
    const selectedEntry = selectedRelativePath ? orderedEntries.find((entry) => entry.path === selectedRelativePath) : null
    const selectedExists = Boolean(selectedEntry && !selectedEntry.repoKind && !selectedEntry.path.endsWith('/'))
    if (selectedExists && selectedRelativePath) {
      const area: GitDiffArea = status.conflicted.some((entry) => entry.path === selectedRelativePath)
        || status.unstaged.some((entry) => entry.path === selectedRelativePath)
        || status.untracked.some((entry) => entry.path === selectedRelativePath)
        ? 'unstaged'
        : 'staged'
      if (gitState.selectedArea !== area) setSelectedPath(sessionId, gitState.selectedPath, activeRepoRoot, area)
      return
    }
    const first = orderedEntries.find((entry) => !entry.repoKind && !entry.path.endsWith('/')) ?? null
    const area: GitDiffArea = first && status.staged.some((entry) => entry.path === first.path) ? 'staged' : 'unstaged'
    const fullPath = first ? (activeRepoRoot ? `${activeRepoRoot}/${first.path}` : first.path) : null
    setSelectedPath(sessionId, fullPath, activeRepoRoot, first ? area : null)
  }, [activeRepoRoot, gitState.selectedArea, gitState.selectedPath, orderedEntries, repository.status, selectedRelativePath, sessionId, setSelectedPath, status.conflicted, status.staged, status.unstaged, status.untracked])

  useEffect(() => {
    const generation = diffRequestGeneration.current + 1
    diffRequestGeneration.current = generation
    if (!activeWorkspaceFolder || !selectedPath) {
      setDiffContents(null)
      setDiffError(null)
      setDiffLoading(false)
      return
    }
    setDiffContents(null)
    setDiffLoading(true)
    setDiffError(null)
    const command = activeRemoteComparison ? 'git_compare_refs_file' : 'git_working_file_contents'
    const args = activeRemoteComparison
      ? { workspaceFolder: activeWorkspaceFolder, baseRef: 'HEAD', headRef: activeRemoteComparison.upstream, path: selectedPath }
      : { workspaceFolder: activeWorkspaceFolder, path: selectedPath, area: selectedArea }
    void invoke<FileContents>(command, args)
      .then((next) => { if (diffRequestGeneration.current === generation) setDiffContents(next) })
      .catch((reason) => {
        if (diffRequestGeneration.current === generation) {
          setDiffContents(null)
          setDiffError(String(reason))
        }
      })
      .finally(() => { if (diffRequestGeneration.current === generation) setDiffLoading(false) })
  }, [activeRemoteComparison, activeWorkspaceFolder, diffRefreshRevision, selectedArea, selectedPath])

  useEffect(() => {
    if (!activeWorkspaceFolder || !selectedPath || activeRemoteComparison || selectedArea === 'remote') {
      setDiffHunks(null)
      setSelectedHunkId(null)
      return
    }
    const generation = diffRequestGeneration.current
    void invoke<UnifiedFileDiff>('git_diff_hunks', { workspaceFolder: activeWorkspaceFolder, path: selectedPath, area: selectedArea, baseRef: null, headRef: null })
      .then((next) => {
        if (diffRequestGeneration.current !== generation || !next) return
        setDiffHunks(next)
        setSelectedHunkId((current) => next.hunks.some((hunk) => hunk.id === current) ? current : next.hunks[0]?.id ?? null)
      })
      .catch((reason) => { if (diffRequestGeneration.current === generation) setReviewWarning(String(reason)) })
  }, [activeRemoteComparison, activeWorkspaceFolder, diffRefreshRevision, selectedArea, selectedPath])

  const runMutation = useCallback(async (operation: () => Promise<unknown>) => {
    if (!entitled || !sessionId || !workspaceFolder) return
    await runGitMutation(sessionId, workspaceFolder, operation, activeRepoRoot)
    setDiffRefreshRevision((current) => current + 1)
  }, [activeRepoRoot, entitled, runGitMutation, sessionId, workspaceFolder])

  const mutate = useCallback((operation: () => Promise<unknown>, after?: () => void) => {
    void runMutation(operation).then(after).catch(() => {})
  }, [runMutation])

  const applyHunk = useCallback((action: GitHunkAction) => {
    if (!activeWorkspaceFolder || !selectedPath || !selectedHunkId || selectedArea === 'remote') return
    setReviewWarning(null)
    mutate(() => invoke('git_apply_hunk', { workspaceFolder: activeWorkspaceFolder, path: selectedPath, area: selectedArea, hunkId: selectedHunkId, action }))
  }, [activeWorkspaceFolder, mutate, selectedArea, selectedHunkId, selectedPath])

  const saveReviewComment = useCallback(async (body: string, side: 'hunk' | 'old' | 'new', line: number | null) => {
    if (!activeWorktree || !reviewIdentity || !selectedPath || !selectedHunkId) {
      setReviewWarning('Import this checkout and load its current review snapshot before adding comments.')
      return
    }
    try {
      const saved = await invoke<WorktreeReviewComment>('worktree_review_comment_create', {
        request: {
          worktreeId: activeWorktree.id,
          expectedInstanceId: activeWorktree.instanceId,
          baseHead: reviewIdentity.baseHead,
          head: reviewIdentity.head,
          path: selectedPath,
          side,
          line,
          range: null,
          hunkId: selectedHunkId,
          body,
        },
      })
      setReviewComments((current) => current.some((comment) => comment.id === saved.id) ? current.map((comment) => comment.id === saved.id ? saved : comment) : [...current, saved])
      setReviewAnchorKeys((current) => new Set(current).add(reviewCommentAnchorKey(saved)))
    } catch (reason) {
      setReviewWarning(`Comment was not saved: ${String(reason)}`)
    }
  }, [activeWorktree, reviewIdentity, selectedHunkId, selectedPath])

  const commentHunk = useCallback(() => {
    if (!selectedPath || !selectedHunkId) return
    void promptDialog({ title: 'Comment on hunk', message: selectedPath, label: 'Review comment', confirmLabel: 'Add comment' }).then((body) => {
      if (body) return saveReviewComment(body, 'hunk', null)
    })
  }, [saveReviewComment, selectedHunkId, selectedPath])

  const commentLine = useCallback((line: number, side: 'old' | 'new') => {
    if (!selectedPath || !selectedHunkId) return
    void promptDialog({ title: `Comment on ${side} line ${line}`, message: selectedPath, label: 'Review comment', confirmLabel: 'Add comment' }).then((body) => {
      if (body) return saveReviewComment(body, side, line)
    })
  }, [saveReviewComment, selectedHunkId, selectedPath])

  const selectedHunkComments = useMemo(() => reviewComments.filter((comment) => comment.path === selectedPath && comment.hunkId === selectedHunkId && isCurrentReviewComment(comment, reviewIdentity, reviewAnchorKeys)), [reviewAnchorKeys, reviewComments, reviewIdentity, selectedHunkId, selectedPath])

  // Clicking a change/commit/PR file is a DIFF gesture, not a navigation
  // gesture: it must not yank the left rail from Source Control over to
  // Explorer (the user loses their change list mid-review). Select the path in
  // the Explorer store so the file is already highlighted when Explorer is
  // opened, but never activate/expand that panel here. Explicit "reveal"
  // remains available from the editor toolbar and the Explorer context menu.
  const selectInExplorer = useCallback((path: string) => {
    if (!sessionId || !workspaceFolder) return
    const fullPath = activeRepoRoot ? `${activeRepoRoot}/${path}` : path
    void useExplorerStore.getState().revealPath(sessionId, workspaceFolder, fullPath)
  }, [activeRepoRoot, sessionId, workspaceFolder])

  const openWorkbench = useCallback(async (tab: GitTab = gitState.activeTab) => {
    if (sessionId) setActiveTab(sessionId, tab, tab === 'history' ? gitState.pathFilter : null)
    await contentActions.openContent({ kind: 'workbench' })
  }, [contentActions, gitState.activeTab, gitState.pathFilter, sessionId, setActiveTab])

  const openAssigned = useCallback(() => openWorkbench('assigned'), [openWorkbench])

  // Explicit user request to see the file in the tree — this one IS allowed to
  // bring the Explorer panel forward.
  const revealFile = useCallback((path: string) => {
    if (!sessionId || !workspaceFolder) return
    selectInExplorer(path)
    void contentActions.openContent({ kind: 'explorer' })
  }, [contentActions, selectInExplorer, sessionId, workspaceFolder])

  const selectChange = useCallback((item: GitChangeItem) => {
    if (!sessionId) return
    if (item.area === 'remote') {
      setRemoteComparison((current) => current ? { ...current, selectedPath: item.path } : current)
    } else {
      const fullPath = activeRepoRoot ? `${activeRepoRoot}/${item.path}` : item.path
      setRemoteComparison(null)
      setSelectedPath(sessionId, fullPath, activeRepoRoot, item.area)
    }
    setActiveTab(sessionId, 'changes')
    selectInExplorer(item.path)
    void openWorkbench('changes')
  }, [activeRepoRoot, openWorkbench, selectInExplorer, sessionId, setActiveTab, setSelectedPath])

  const discardPaths = useCallback((paths: string[], untracked: boolean) => {
    if (!activeWorkspaceFolder || paths.length === 0) return
    const message = untracked
      ? `Discard ${paths.length === 1 ? paths[0] : `${paths.length} untracked files`}? They are moved to the Recycle Bin.`
      : `Discard changes in ${paths.length === 1 ? paths[0] : `${paths.length} files`}? This cannot be undone.`
    void confirmDialog({ title: 'Discard changes', message, confirmLabel: 'Discard', danger: true }).then((confirmed) => {
      if (confirmed) mutate(() => invoke('git_discard', { workspaceFolder: activeWorkspaceFolder, paths }))
    })
  }, [activeWorkspaceFolder, mutate])

  const stagePaths = useCallback((paths: string[]) => {
    if (activeWorkspaceFolder && paths.length > 0) mutate(() => invoke('git_stage', { workspaceFolder: activeWorkspaceFolder, paths }))
  }, [activeWorkspaceFolder, mutate])
  const unstagePaths = useCallback((paths: string[]) => {
    if (activeWorkspaceFolder && paths.length > 0) mutate(() => invoke('git_unstage', { workspaceFolder: activeWorkspaceFolder, paths }))
  }, [activeWorkspaceFolder, mutate])

  const rowAction = useCallback((id: string, label: string, action: () => void, danger = false): GitRowAction => ({ id, label, danger, onClick: action }), [])
  const groups = useMemo<GitChangeGroup[]>(() => {
    if (activeRemoteComparison) return [{
      id: 'remote',
      title: 'Remote Changes',
      count: activeRemoteComparison.files.length,
      actions: [],
      items: activeRemoteComparison.files.map((file) => ({ path: file.path, oldPath: file.oldPath ?? null, changeType: file.changeType, area: 'remote' })),
    }]
    const items = (entries: typeof status.staged, area: GitDiffArea): GitChangeItem[] => entries
      .filter((entry) => !entry.repoKind && !entry.path.endsWith('/'))
      .map((entry) => ({ path: entry.path, oldPath: entry.oldPath, changeType: entry.changeType, area }))
    const stageableUnstaged = status.unstaged
      .filter((entry) => !entry.repoKind || (entry.repoKind === 'submodule' && entry.submoduleState?.commitChanged))
      .map((entry) => entry.path)
    const stageableUntracked = status.untracked.filter((entry) => !entry.repoKind).map((entry) => entry.path)
    const discardableUnstaged = status.unstaged.filter((entry) => !entry.repoKind).map((entry) => entry.path)
    return [
      { id: 'conflicted', title: 'Merge Conflicts', count: status.conflicted.length, actions: [], items: items(status.conflicted, 'unstaged') },
      {
        id: 'staged', title: 'Staged', count: status.staged.length, items: items(status.staged, 'staged'),
        actions: status.staged.length > 0 ? [rowAction('unstage-all', 'Unstage All', () => {
          if (activeWorkspaceFolder) mutate(() => invoke('git_unstage_all', { workspaceFolder: activeWorkspaceFolder }))
        })] : [],
      },
      {
        id: 'unstaged', title: 'Changes', count: status.unstaged.length, items: items(status.unstaged, 'unstaged'),
        actions: [
          ...(stageableUnstaged.length > 0 ? [rowAction('stage-all', 'Stage All', () => stagePaths(stageableUnstaged))] : []),
          ...(discardableUnstaged.length > 0 ? [rowAction('discard-all', 'Discard All', () => discardPaths(discardableUnstaged, false), true)] : []),
        ],
      },
      {
        id: 'untracked', title: 'Untracked', count: status.untracked.length, items: items(status.untracked, 'unstaged'),
        actions: stageableUntracked.length > 0 ? [
          rowAction('stage-all', 'Stage All', () => stagePaths(stageableUntracked)),
          rowAction('discard-all', 'Discard All', () => discardPaths(stageableUntracked, true), true),
        ] : [],
      },
    ]
  }, [activeRemoteComparison, activeWorkspaceFolder, discardPaths, mutate, rowAction, stagePaths, status])

  const stageAll = useCallback(() => {
    const paths = [...status.unstaged, ...status.untracked]
      .filter((entry) => !entry.repoKind || (entry.repoKind === 'submodule' && entry.submoduleState?.commitChanged))
      .map((entry) => entry.path)
    stagePaths(paths)
  }, [stagePaths, status.unstaged, status.untracked])

  const writeCheckpoint = useCallback(async (kind: 'committed' | 'pushed' | 'pr_opened' | 'merged', label: string, comment: string | null = null) => {
    if (!activeWorktree) return
    try {
      const saved = await invoke<WorktreeCheckpoint>('worktree_checkpoint_create', { request: { worktreeId: activeWorktree.id, kind, label, comment } })
      setReviewCheckpoints((current) => [...current, saved])
    } catch (reason) {
      setReviewWarning(`Git action succeeded, but its ${kind} checkpoint was not saved: ${String(reason)}`)
    }
  }, [activeWorktree])

  const commit = useCallback(() => {
    if (!activeWorkspaceFolder || !draft.message.trim()) return
    mutate(
      async () => {
        const sha = await invoke<string>('git_commit', { workspaceFolder: activeWorkspaceFolder, message: draft.message, amend: draft.amend, signoff: false })
        await writeCheckpoint('committed', draft.message.trim(), sha)
        return sha
      },
      () => setCommitMessage(''),
    )
  }, [activeWorkspaceFolder, draft.amend, draft.message, mutate, setCommitMessage, writeCheckpoint])

  const continueState = useMemo(() => repoInfo?.state === 'rebasing' && activeWorkspaceFolder
    ? () => mutate(() => invoke('git_rebase_continue', { workspaceFolder: activeWorkspaceFolder }))
    : null, [activeWorkspaceFolder, mutate, repoInfo?.state])
  const abortState = useMemo(() => repoInfo?.state === 'rebasing' && activeWorkspaceFolder
    ? () => mutate(() => invoke('git_rebase_abort', { workspaceFolder: activeWorkspaceFolder }))
    : repoInfo?.state === 'merging' && activeWorkspaceFolder
      ? () => mutate(() => invoke('git_merge_abort', { workspaceFolder: activeWorkspaceFolder }))
      : null, [activeWorkspaceFolder, mutate, repoInfo?.state])

  const primaryAction = repoInfo?.isRepo ? sourceControlPrimaryAction(repoInfo, status, draft.message, Boolean(continueState)) : null
  const runPrimaryAction = useCallback(() => {
    switch (primaryAction?.id) {
      case 'review-conflicts': void openWorkbench('changes'); break
      case 'continue': continueState?.(); break
      case 'stage-all': stageAll(); break
      case 'commit': commit(); break
      case 'pull': if (activeWorkspaceFolder) mutate(() => invoke('git_pull', { workspaceFolder: activeWorkspaceFolder, rebase: false })); break
      case 'push': if (activeWorkspaceFolder) mutate(async () => { await invoke('git_push', { workspaceFolder: activeWorkspaceFolder, remote: null, branch: repoInfo?.branch ?? null, setUpstream: !repoInfo?.upstream, forceWithLease: false }); await writeCheckpoint('pushed', repoInfo?.branch ?? 'HEAD') }); break
    }
  }, [activeWorkspaceFolder, commit, continueState, mutate, openWorkbench, primaryAction?.id, repoInfo?.branch, repoInfo?.upstream, stageAll, writeCheckpoint])

  const activateRepository = useCallback((repoRoot: string) => {
    if (!sessionId || !workspaceFolder) return
    setActiveRepository(sessionId, repoRoot)
    setSelectedPath(sessionId, null, repoRoot, null)
    void refreshRepository(sessionId, workspaceFolder, repoRoot)
    void refreshHosting(sessionId, workspaceFolder, 'HEAD', false, repoRoot)
  }, [refreshHosting, refreshRepository, sessionId, setActiveRepository, setSelectedPath, workspaceFolder])

  const fetchRepo = useCallback(() => {
    if (activeWorkspaceFolder) mutate(() => invoke('git_fetch', { workspaceFolder: activeWorkspaceFolder, remote: null, prune: false, refspec: null }))
  }, [activeWorkspaceFolder, mutate])
  const pull = useCallback(() => {
    if (activeWorkspaceFolder) mutate(() => invoke('git_pull', { workspaceFolder: activeWorkspaceFolder, rebase: false }))
  }, [activeWorkspaceFolder, mutate])
  const push = useCallback(() => {
    if (activeWorkspaceFolder) mutate(async () => {
      await invoke('git_push', { workspaceFolder: activeWorkspaceFolder, remote: null, branch: repoInfo?.branch ?? null, setUpstream: !repoInfo?.upstream, forceWithLease: false })
      await writeCheckpoint('pushed', repoInfo?.branch ?? 'HEAD')
    })
  }, [activeWorkspaceFolder, mutate, repoInfo?.branch, repoInfo?.upstream, writeCheckpoint])

  const compareRemote = useCallback(() => {
    if (!activeWorkspaceFolder || !repoInfo?.upstream) return
    setRemoteCompareLoading(true)
    setDiffError(null)
    void runMutation(() => invoke('git_fetch', { workspaceFolder: activeWorkspaceFolder, remote: null, prune: false, refspec: null }))
      .then(() => invoke<ChangedFile[]>('git_compare_refs', { workspaceFolder: activeWorkspaceFolder, baseRef: 'HEAD', headRef: repoInfo.upstream }))
      .then((files) => {
        setRemoteComparison({ repoRoot: activeRepoRoot, upstream: repoInfo.upstream!, files, selectedPath: files[0]?.path ?? null })
        setActiveTab(sessionId!, 'changes')
        return openWorkbench('changes')
      })
      .catch((reason) => setDiffError(String(reason)))
      .finally(() => setRemoteCompareLoading(false))
  }, [activeRepoRoot, activeWorkspaceFolder, openWorkbench, repoInfo?.upstream, runMutation, sessionId, setActiveTab])

  const showWorkingChanges = useCallback(() => {
    setRemoteComparison(null)
    setDiffError(null)
  }, [])

  const [historyActivated, setHistoryActivated] = useState(false)
  const [historyCommits, setHistoryCommits] = useState<CommitInfo[]>([])
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historySearch, setHistorySearch] = useState('')
  const [historyAuthor, setHistoryAuthor] = useState('')
  const [debouncedHistorySearch, setDebouncedHistorySearch] = useState('')
  const [debouncedHistoryAuthor, setDebouncedHistoryAuthor] = useState('')
  const [historySelectedSha, setHistorySelectedSha] = useState<string | null>(null)
  const [historyDetail, setHistoryDetail] = useState<CommitDetail | null>(null)
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false)
  const [historyCompareMode, setHistoryCompareMode] = useState(false)
  const [historyCompareFiles, setHistoryCompareFiles] = useState<ChangedFile[]>([])
  const [historySelectedPath, setHistorySelectedPath] = useState<string | null>(null)
  const [historyContents, setHistoryContents] = useState<FileContents | null>(null)
  const [historyContentsLoading, setHistoryContentsLoading] = useState(false)
  const [historyContentsError, setHistoryContentsError] = useState<string | null>(null)
  const historyRequestGeneration = useRef(0)
  const historyDetailGeneration = useRef(0)
  const historyCommitsRef = useRef<CommitInfo[]>([])

  useEffect(() => { historyCommitsRef.current = historyCommits }, [historyCommits])
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedHistorySearch(historySearch.trim()), 400)
    return () => window.clearTimeout(timer)
  }, [historySearch])
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedHistoryAuthor(historyAuthor.trim()), 400)
    return () => window.clearTimeout(timer)
  }, [historyAuthor])

  const loadHistory = useCallback(async (reset: boolean) => {
    if (!entitled || !activeWorkspaceFolder || !historyActivated) return
    const generation = reset ? historyRequestGeneration.current + 1 : historyRequestGeneration.current
    if (reset) historyRequestGeneration.current = generation
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const page = await invoke<LogPage>('git_log', {
        workspaceFolder: activeWorkspaceFolder,
        options: {
          refName: null,
          path: gitState.pathFilter,
          skip: reset ? 0 : historyCommitsRef.current.length,
          limit: 200,
          search: debouncedHistorySearch || null,
          author: debouncedHistoryAuthor || null,
        },
      })
      if (historyRequestGeneration.current !== generation) return
      setHistoryCommits((current) => reset ? page.commits : [...current, ...page.commits])
      setHistoryHasMore(page.hasMore)
      if (reset) {
        setHistorySelectedSha(null)
        setHistoryDetail(null)
        setHistoryCompareMode(false)
        setHistoryCompareFiles([])
        setHistorySelectedPath(null)
        setHistoryContents(null)
      }
    } catch (reason) {
      if (historyRequestGeneration.current === generation) setHistoryError(String(reason))
    } finally {
      if (historyRequestGeneration.current === generation) setHistoryLoading(false)
    }
  }, [activeWorkspaceFolder, debouncedHistoryAuthor, debouncedHistorySearch, entitled, gitState.pathFilter, historyActivated])

  useEffect(() => {
    if (historyActivated) void loadHistory(true)
  }, [activeRepoRoot, debouncedHistoryAuthor, debouncedHistorySearch, gitState.pathFilter, historyActivated, loadHistory, repoInfo?.headSha])

  const activateHistory = useCallback(() => setHistoryActivated(true), [])
  const selectHistoryCommit = useCallback((sha: string) => {
    if (!activeWorkspaceFolder || !sessionId) return
    setHistoryActivated(true)
    setActiveTab(sessionId, 'history', gitState.pathFilter)
    void openWorkbench('history')
    if (historySelectedSha === sha && historyDetail?.sha === sha) return
    setHistorySelectedSha(sha)
    setHistoryCompareMode(false)
    setHistoryCompareFiles([])
    setHistorySelectedPath(null)
    setHistoryContents(null)
    const generation = historyDetailGeneration.current + 1
    historyDetailGeneration.current = generation
    setHistoryDetailLoading(true)
    void invoke<CommitDetail>('git_commit_detail', { workspaceFolder: activeWorkspaceFolder, sha })
      .then((next) => {
        if (historyDetailGeneration.current !== generation) return
        setHistoryDetail(next)
        setHistorySelectedPath(next.files[0]?.path ?? null)
      })
      .catch((reason) => { if (historyDetailGeneration.current === generation) setHistoryError(String(reason)) })
      .finally(() => { if (historyDetailGeneration.current === generation) setHistoryDetailLoading(false) })
  }, [activeWorkspaceFolder, gitState.pathFilter, historyDetail?.sha, historySelectedSha, openWorkbench, sessionId, setActiveTab])

  useEffect(() => {
    const generation = historyDetailGeneration.current
    if (!activeWorkspaceFolder || !historySelectedSha || !historySelectedPath) {
      setHistoryContents(null)
      setHistoryContentsLoading(false)
      return
    }
    setHistoryContentsLoading(true)
    setHistoryContentsError(null)
    const command = historyCompareMode ? 'git_diff_refs_file' : 'git_commit_file_contents'
    const args = historyCompareMode
      ? { workspaceFolder: activeWorkspaceFolder, baseRef: historySelectedSha, headRef: 'HEAD', path: historySelectedPath }
      : { workspaceFolder: activeWorkspaceFolder, sha: historySelectedSha, path: historySelectedPath }
    void invoke<FileContents>(command, args)
      .then((next) => { if (historyDetailGeneration.current === generation) setHistoryContents(next) })
      .catch((reason) => {
        if (historyDetailGeneration.current === generation) {
          setHistoryContents(null)
          setHistoryContentsError(String(reason))
        }
      })
      .finally(() => { if (historyDetailGeneration.current === generation) setHistoryContentsLoading(false) })
  }, [activeWorkspaceFolder, historyCompareMode, historySelectedPath, historySelectedSha])

  const selectHistoryFile = useCallback((path: string) => {
    setHistorySelectedPath(path)
    selectInExplorer(path)
    void openWorkbench('history')
  }, [openWorkbench, selectInExplorer])
  const compareHistoryHead = useCallback(() => {
    if (!activeWorkspaceFolder || !historySelectedSha) return
    setHistoryContentsLoading(true)
    void invoke<ChangedFile[]>('git_diff_refs', { workspaceFolder: activeWorkspaceFolder, baseRef: historySelectedSha, headRef: 'HEAD' })
      .then((files) => {
        setHistoryCompareMode(true)
        setHistoryCompareFiles(files)
        setHistorySelectedPath(files[0]?.path ?? null)
        setHistoryContents(null)
      })
      .catch((reason) => setHistoryContentsError(String(reason)))
      .finally(() => setHistoryContentsLoading(false))
  }, [activeWorkspaceFolder, historySelectedSha])

  const historyModel = useMemo<HistoryModel>(() => ({
    commits: historyCommits,
    graph: computeGraphLanes(historyCommits),
    hasMore: historyHasMore,
    loading: historyLoading,
    error: historyError,
    search: historySearch,
    author: historyAuthor,
    pathFilter: gitState.pathFilter,
    selectedSha: historySelectedSha,
    detail: historyDetail,
    detailLoading: historyDetailLoading,
    compareMode: historyCompareMode,
    compareFiles: historyCompareFiles,
    selectedPath: historySelectedPath,
    contents: historyContents,
    contentsLoading: historyContentsLoading,
    contentsError: historyContentsError,
    setSearch: setHistorySearch,
    setAuthor: setHistoryAuthor,
    clearPathFilter: () => { if (sessionId) setActiveTab(sessionId, 'history', null) },
    activate: activateHistory,
    refresh: () => loadHistory(true),
    loadMore: () => loadHistory(false),
    selectCommit: selectHistoryCommit,
    selectFile: selectHistoryFile,
    copySha: () => { if (historySelectedSha) void navigator.clipboard.writeText(historySelectedSha) },
    compareHead: compareHistoryHead,
    createBranch: () => {
      if (!activeWorkspaceFolder || !historySelectedSha) return
      void promptDialog({ title: 'New branch', label: 'Branch name', placeholder: 'feature/my-change', confirmLabel: 'Create' }).then((name) => {
        if (name) mutate(() => invoke('git_branch_create', { workspaceFolder: activeWorkspaceFolder, name, fromRef: historySelectedSha, checkout: false }))
      })
    },
    createTag: async () => {
      if (!activeWorkspaceFolder || !historySelectedSha) return
      const name = await promptDialog({ title: 'New tag', label: 'Tag name', placeholder: 'v1.0.0', confirmLabel: 'Next' })
      if (!name) return
      const message = await promptDialog({ title: 'Tag annotation', message: 'Leave empty for a lightweight tag.', label: 'Annotation message', confirmLabel: 'Create' })
      mutate(() => invoke('git_tag_create', { workspaceFolder: activeWorkspaceFolder, name, refName: historySelectedSha, message }))
    },
  }), [activeWorkspaceFolder, activateHistory, compareHistoryHead, gitState.pathFilter, historyAuthor, historyCommits, historyCompareFiles, historyCompareMode, historyContents, historyContentsError, historyContentsLoading, historyDetail, historyDetailLoading, historyError, historyHasMore, historyLoading, historySearch, historySelectedPath, historySelectedSha, loadHistory, mutate, selectHistoryCommit, selectHistoryFile, sessionId, setActiveTab])

  const [branchesActivated, setBranchesActivated] = useState(false)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [stashes, setStashes] = useState<StashInfo[]>([])
  const [tags, setTags] = useState<TagInfo[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [branchesError, setBranchesError] = useState<string | null>(null)
  const [baseRef, setBaseRef] = useState('HEAD')
  const [headRef, setHeadRef] = useState('HEAD')
  const [refPicker, setRefPicker] = useState<'base' | 'head' | null>(null)
  const [compareFiles, setCompareFiles] = useState<ChangedFile[]>([])
  const [compareSelectedPath, setCompareSelectedPath] = useState<string | null>(null)
  const [compareContents, setCompareContents] = useState<FileContents | null>(null)
  const [compareContentsLoading, setCompareContentsLoading] = useState(false)
  const [compareContentsError, setCompareContentsError] = useState<string | null>(null)
  const [stashOpen, setStashOpen] = useState(false)
  const [stashMessage, setStashMessage] = useState('')
  const [includeUntracked, setIncludeUntracked] = useState(false)

  const loadBranches = useCallback(async () => {
    if (!entitled || !activeWorkspaceFolder || !branchesActivated) return
    setBranchesLoading(true)
    setBranchesError(null)
    try {
      const [nextBranches, nextStashes, nextTags] = await Promise.all([
        invoke<BranchInfo[]>('git_branches', { workspaceFolder: activeWorkspaceFolder }),
        invoke<StashInfo[]>('git_stash_list', { workspaceFolder: activeWorkspaceFolder }),
        invoke<TagInfo[]>('git_tag_list', { workspaceFolder: activeWorkspaceFolder }),
      ])
      setBranches(nextBranches)
      setStashes(nextStashes)
      setTags(nextTags)
      setBaseRef((current) => current === 'HEAD' ? repoInfo?.upstream ?? 'HEAD' : current)
      setHeadRef((current) => current === 'HEAD' ? repoInfo?.branch ?? 'HEAD' : current)
    } catch (reason) {
      setBranchesError(String(reason))
    } finally {
      setBranchesLoading(false)
    }
  }, [activeWorkspaceFolder, branchesActivated, entitled, repoInfo?.branch, repoInfo?.upstream])

  useEffect(() => {
    setCompareFiles([])
    setCompareSelectedPath(null)
    setCompareContents(null)
    setBaseRef(repoInfo?.upstream ?? 'HEAD')
    setHeadRef(repoInfo?.branch ?? 'HEAD')
    if (branchesActivated) void loadBranches()
  }, [activeRepoRoot, branchesActivated, loadBranches, repoInfo?.branch, repoInfo?.headSha, repoInfo?.upstream])

  const mutateBranch = useCallback((operation: () => Promise<unknown>, after?: () => void) => {
    void runMutation(operation)
      .then(() => loadBranches())
      .then(after)
      .catch((reason) => setBranchesError(String(reason)))
  }, [loadBranches, runMutation])

  const branchActions = useCallback((branch: BranchInfo) => {
    const actions: BranchRowAction[] = [
      { id: 'checkout', label: 'Checkout', onClick: () => mutateBranch(() => invoke('git_checkout', { workspaceFolder: activeWorkspaceFolder, refName: branch.name })) },
      { id: 'merge', label: 'Merge', onClick: () => mutateBranch(() => invoke('git_merge', { workspaceFolder: activeWorkspaceFolder, refName: branch.name })) },
      { id: 'rebase', label: 'Rebase', onClick: () => mutateBranch(() => invoke('git_rebase', { workspaceFolder: activeWorkspaceFolder, refName: branch.name })) },
      { id: 'copy', label: 'Copy name', onClick: () => { void navigator.clipboard.writeText(branch.name) } },
      { id: 'new-from', label: 'New branch from', onClick: () => {
        void promptDialog({ title: `New branch from ${branch.name}`, label: 'Branch name', placeholder: 'feature/my-change', confirmLabel: 'Create' }).then((name) => {
          if (name) mutateBranch(() => invoke('git_branch_create', { workspaceFolder: activeWorkspaceFolder, name, fromRef: branch.name, checkout: false }))
        })
      } },
    ]
    if (!branch.isRemote) {
      actions.splice(3, 0,
        { id: 'rename', label: 'Rename', onClick: () => {
          void promptDialog({ title: 'Rename branch', label: 'Branch name', defaultValue: branch.name, confirmLabel: 'Rename' }).then((newName) => {
            if (newName && newName !== branch.name) mutateBranch(() => invoke('git_branch_rename', { workspaceFolder: activeWorkspaceFolder, oldName: branch.name, newName }))
          })
        } },
        { id: 'delete', label: 'Delete', danger: true, onClick: () => {
          void confirmDialog({ title: 'Delete branch', message: `Delete branch ${branch.name}?`, confirmLabel: 'Delete', danger: true }).then((confirmed) => {
            if (!confirmed) return
            return runMutation(() => invoke('git_branch_delete', { workspaceFolder: activeWorkspaceFolder, name: branch.name, force: false }))
              .then(() => loadBranches())
              .catch(async (reason) => {
                const message = String(reason)
                // Git refuses an unmerged branch; offer the force path instead
                // of surfacing a dead-end error the user cannot act on.
                if (!message.includes('not fully merged')) return setBranchesError(message)
                if (await confirmDialog({ title: 'Branch is not fully merged', message: `${message}\n\nForce delete ${branch.name}?`, confirmLabel: 'Force delete', danger: true })) {
                  mutateBranch(() => invoke('git_branch_delete', { workspaceFolder: activeWorkspaceFolder, name: branch.name, force: true }))
                }
              })
          })
        } },
      )
    }
    return actions
  }, [activeWorkspaceFolder, loadBranches, mutateBranch, runMutation])

  const compareBranches = useCallback(() => {
    if (!activeWorkspaceFolder) return
    setCompareContentsLoading(true)
    setCompareContentsError(null)
    void invoke<ChangedFile[]>('git_diff_refs', { workspaceFolder: activeWorkspaceFolder, baseRef, headRef })
      .then((files) => {
        setCompareFiles(files)
        setCompareSelectedPath(files[0]?.path ?? null)
        setCompareContents(null)
        if (sessionId) setActiveTab(sessionId, 'branches')
        return openWorkbench('branches')
      })
      .catch((reason) => setCompareContentsError(String(reason)))
      .finally(() => setCompareContentsLoading(false))
  }, [activeWorkspaceFolder, baseRef, headRef, openWorkbench, sessionId, setActiveTab])

  useEffect(() => {
    if (!activeWorkspaceFolder || !compareSelectedPath) {
      setCompareContents(null)
      setCompareContentsLoading(false)
      return
    }
    let cancelled = false
    setCompareContentsLoading(true)
    setCompareContentsError(null)
    void invoke<FileContents>('git_diff_refs_file', { workspaceFolder: activeWorkspaceFolder, baseRef, headRef, path: compareSelectedPath })
      .then((next) => { if (!cancelled) setCompareContents(next) })
      .catch((reason) => { if (!cancelled) setCompareContentsError(String(reason)) })
      .finally(() => { if (!cancelled) setCompareContentsLoading(false) })
    return () => { cancelled = true }
  }, [activeWorkspaceFolder, baseRef, compareSelectedPath, headRef])

  const branchesModel = useMemo<BranchesModel>(() => ({
    localRows: branches.filter((branch) => !branch.isRemote).map((branch) => ({ branch, actions: branchActions(branch) })),
    remoteRows: branches.filter((branch) => branch.isRemote).map((branch) => ({ branch, actions: branchActions(branch) })),
    stashRows: stashes.map((stash) => ({
      stash,
      onApply: () => mutateBranch(() => invoke('git_stash_apply', { workspaceFolder: activeWorkspaceFolder, index: stash.index })),
      onPop: () => mutateBranch(() => invoke('git_stash_pop', { workspaceFolder: activeWorkspaceFolder, index: stash.index })),
      onDrop: () => {
        void confirmDialog({ title: 'Drop stash', message: `Drop stash@{${stash.index}}? This cannot be undone.`, confirmLabel: 'Drop', danger: true }).then((confirmed) => {
          if (confirmed) mutateBranch(() => invoke('git_stash_drop', { workspaceFolder: activeWorkspaceFolder, index: stash.index }))
        })
      },
    })),
    tags,
    loading: branchesLoading,
    error: branchesError,
    baseRef,
    headRef,
    compareFiles,
    selectedPath: compareSelectedPath,
    contents: compareContents,
    contentsLoading: compareContentsLoading,
    contentsError: compareContentsError,
    workingTreeDirty: status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length > 0,
    stashOpen,
    stashMessage,
    includeUntracked,
    setStashMessage,
    setIncludeUntracked,
    activate: () => setBranchesActivated(true),
    refresh: loadBranches,
    createBranch: () => {
      void promptDialog({ title: 'New branch', label: 'Branch name', placeholder: 'feature/my-change', confirmLabel: 'Create' }).then((name) => {
        if (name) mutateBranch(() => invoke('git_branch_create', { workspaceFolder: activeWorkspaceFolder, name, fromRef: null, checkout: false }))
      })
    },
    openBasePicker: () => setRefPicker('base'),
    openHeadPicker: () => setRefPicker('head'),
    compare: compareBranches,
    selectFile: (path: string) => {
      setCompareSelectedPath(path)
      selectInExplorer(path)
      void openWorkbench('branches')
    },
    openStash: () => setStashOpen(true),
    saveStash: () => mutateBranch(
      () => invoke('git_stash_save', { workspaceFolder: activeWorkspaceFolder, message: stashMessage, includeUntracked }),
      () => { setStashOpen(false); setStashMessage(''); setIncludeUntracked(false) },
    ),
    closeStash: () => setStashOpen(false),
  }), [activeWorkspaceFolder, baseRef, branchActions, branches, branchesError, branchesLoading, compareBranches, compareContents, compareContentsError, compareContentsLoading, compareFiles, compareSelectedPath, headRef, includeUntracked, loadBranches, mutateBranch, openWorkbench, selectInExplorer, stashMessage, stashOpen, stashes, status.conflicted.length, status.staged.length, status.unstaged.length, status.untracked.length, tags])

  const [branchPickerOpen, setBranchPickerOpen] = useState(false)
  const [switchBranches, setSwitchBranches] = useState<BranchInfo[]>([])
  const openBranchPicker = useCallback(() => {
    if (!activeWorkspaceFolder) return
    void invoke<BranchInfo[]>('git_branches', { workspaceFolder: activeWorkspaceFolder })
      .then((items) => {
        setSwitchBranches(items.filter((branch) => !branch.isRemote))
        setBranchPickerOpen(true)
      })
      .catch(() => {})
  }, [activeWorkspaceFolder])

  const [cloneOpen, setCloneOpen] = useState(false)
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloneTargetDir, setCloneTargetDir] = useState('')
  const [cloneProgress, setCloneProgress] = useState<string[]>([])
  const [cloneRunning, setCloneRunning] = useState(false)

  const refreshRepositoryNow = useCallback(async () => {
    if (!entitled || !sessionId) return
    await refreshRepository(sessionId, workspaceFolder, activeRepoRoot)
  }, [activeRepoRoot, entitled, refreshRepository, sessionId, workspaceFolder])
  const refreshHostingNow = useCallback(async (force = true) => {
    if (!entitled || !sessionId) return
    await refreshHosting(sessionId, workspaceFolder, 'HEAD', force, activeRepoRoot)
  }, [activeRepoRoot, entitled, refreshHosting, sessionId, workspaceFolder])
  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), refreshRepositoryDiscovery()])
    setDiffRefreshRevision((current) => current + 1)
  }, [refresh, refreshRepositoryDiscovery])

  const value = useMemo<GitWorkspaceController>(() => ({
    entitled,
    sessionId,
    workspaceFolder,
    activeRepoRoot,
    activeWorkspaceFolder,
    repository,
    repoInfo,
    status,
    repositoryTargets,
    repositoryDiscoveryLoading,
    repositoryDiscoveryError,
    repositoryScopeName,
    activeTab: gitState.activeTab,
    commitMessage: draft.message,
    amend: draft.amend,
    setCommitMessage,
    setAmend,
    groups,
    selectedPath,
    selectedArea,
    contents: diffContents,
    diffLoading,
    diffError,
    diffHunks,
    selectedHunkId,
    reviewWarning,
    reviewIdentity,
    reviewComments,
    reviewCheckpoints,
    reviewAnchorKeys,
    selectedHunkComments,
    reviewLoading,
    reviewError,
    refreshReview,
    selectHunk: setSelectedHunkId,
    applyHunk,
    commentHunk,
    commentLine,
    remoteComparisonActive: activeRemoteComparison !== null,
    remoteCompareLoading,
    primaryAction,
    history: historyModel,
    branches: branchesModel,
    refresh: refreshAll,
    refreshRepository: refreshRepositoryNow,
    refreshHosting: refreshHostingNow,
    activateRepository,
    openBranchPicker,
    openClone: () => setCloneOpen(true),
    fetch: fetchRepo,
    pull,
    push,
    compareRemote,
    showWorkingChanges,
    selectChange,
    stagePaths,
    unstagePaths,
    discardPaths,
    stageAll,
    commit,
    continueState,
    abortState,
    runPrimaryAction,
    openWorkbench,
    openAssigned,
    selectInExplorer,
    revealFile,
    runMutation,
  }), [
    abortState,
    activateRepository,
    applyHunk,
    activeRemoteComparison,
    activeRepoRoot,
    activeWorkspaceFolder,
    branchesModel,
    commentHunk,
    commentLine,
    commit,
    compareRemote,
    continueState,
    diffContents,
    diffError,
    diffHunks,
    diffLoading,
    discardPaths,
    draft.amend,
    draft.message,
    entitled,
    fetchRepo,
    gitState.activeTab,
    groups,
    historyModel,
    openAssigned,
    openBranchPicker,
    openWorkbench,
    primaryAction,
    pull,
    push,
    refreshAll,
    refreshHostingNow,
    refreshRepositoryNow,
    refreshReview,
    remoteCompareLoading,
    repoInfo,
    reviewAnchorKeys,
    reviewCheckpoints,
    reviewComments,
    reviewError,
    reviewIdentity,
    reviewLoading,
    reviewWarning,
    repository,
    repositoryDiscoveryError,
    repositoryDiscoveryLoading,
    repositoryScopeName,
    repositoryTargets,
    revealFile,
    runMutation,
    runPrimaryAction,
    selectChange,
    selectInExplorer,
    selectedArea,
    selectedHunkComments,
    selectedHunkId,
    selectedPath,
    sessionId,
    setAmend,
    setCommitMessage,
    showWorkingChanges,
    stageAll,
    stagePaths,
    status,
    unstagePaths,
    workspaceFolder,
  ])

  const refNames = Array.from(new Set(['HEAD', ...branches.map((branch) => branch.name), ...tags.map((tag) => tag.name)]))
  const refEntries = (filter: string): PickerEntry<string>[] => refNames
    .filter((ref) => ref.toLowerCase().includes(filter.toLowerCase()))
    .map((ref) => ({ kind: 'item', id: ref, name: ref }))
  const branchEntries = (filter: string): PickerEntry<string>[] => switchBranches
    .filter((branch) => branch.name.toLowerCase().includes(filter.toLowerCase()))
    .map((branch) => ({ kind: 'item', id: branch.name, name: branch.name, description: branch.lastCommitSubject }))

  return (
    <GitWorkspaceContext.Provider value={value}>
      {children}
      {branchPickerOpen && switchBranches.length > 0 ? (
        <QuickPick
          value={repoInfo?.branch && switchBranches.some((branch) => branch.name === repoInfo.branch) ? repoInfo.branch : switchBranches[0].name}
          ariaLabel="Switch Git branch"
          placeholder="Search branches"
          icon={<GitBranchIcon size={15} />}
          noMatchLabel="branches"
          entriesForFilter={branchEntries}
          renderItem={(item) => <><span>{item.name}</span>{item.description ? <small>{item.description}</small> : null}</>}
          onPreview={() => {}}
          onSelect={(branch) => {
            setBranchPickerOpen(false)
            if (activeWorkspaceFolder) mutate(() => invoke('git_checkout', { workspaceFolder: activeWorkspaceFolder, refName: branch }))
          }}
          onCancel={() => setBranchPickerOpen(false)}
        />
      ) : null}
      {refPicker && refNames.length > 0 ? (
        <QuickPick
          value={refPicker === 'base' ? baseRef : headRef}
          ariaLabel={refPicker === 'base' ? 'Choose base ref' : 'Choose head ref'}
          placeholder="Search refs"
          icon={<GitBranchIcon size={15} />}
          noMatchLabel="refs"
          entriesForFilter={refEntries}
          renderItem={(item) => <span>{item.name}</span>}
          onPreview={() => {}}
          onSelect={(ref) => {
            if (refPicker === 'base') setBaseRef(ref)
            else setHeadRef(ref)
            setRefPicker(null)
          }}
          onCancel={() => setRefPicker(null)}
        />
      ) : null}
      {cloneOpen ? (
        <div className="git-clone-backdrop" role="presentation" onMouseDown={() => { if (!cloneRunning) setCloneOpen(false) }}>
          <section className="git-clone-dialog" role="dialog" aria-label="Clone repository" onMouseDown={(event) => event.stopPropagation()}>
            <header><h2>Clone Repository</h2><button type="button" onClick={() => { if (!cloneRunning) setCloneOpen(false) }}>Close</button></header>
            <label>Repository URL<input autoFocus value={cloneUrl} onChange={(event) => setCloneUrl(event.target.value)} placeholder="https://github.com/owner/repository.git" /></label>
            <label>Target directory<div><input value={cloneTargetDir} readOnly placeholder="Choose a directory" /><button type="button" onClick={() => {
              void open({ directory: true, multiple: false, title: 'Choose clone target directory' }).then((path) => {
                if (typeof path === 'string') setCloneTargetDir(path)
              })
            }}>Browse…</button></div></label>
            {cloneProgress.length > 0 ? <pre className="git-clone-progress">{cloneProgress.join('\n')}</pre> : null}
            <footer><button type="button" onClick={() => setCloneOpen(false)} disabled={cloneRunning}>Cancel</button><button type="button" className="git-window-primary-action" disabled={cloneRunning || !cloneUrl.trim() || !cloneTargetDir} onClick={() => {
              if (!cloneUrl.trim() || !cloneTargetDir) return
              setCloneRunning(true)
              setCloneProgress([])
              const channel = new Channel<CloneProgress>((event) => {
                if (event.line) setCloneProgress((lines) => [...lines, event.line])
                if (event.done) setCloneProgress((lines) => [...lines, 'Clone complete.'])
              })
              void invoke('git_clone', { url: cloneUrl.trim(), targetDir: cloneTargetDir, channel })
                .catch((reason) => setCloneProgress((lines) => [...lines, String(reason)]))
                .finally(() => setCloneRunning(false))
            }}>{cloneRunning ? 'Cloning…' : 'Clone'}</button></footer>
          </section>
        </div>
      ) : null}
    </GitWorkspaceContext.Provider>
  )
}
