import { Channel, invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitBranch as GitBranchIcon } from 'lucide-react'
import type { BranchInfo, ChangedFile, CloneProgress, FileContents, WorkingStatus } from '../../ipc/types'
import { useExplorerStore } from '../../state/explorer'
import { emptyGitSessionState, repositoryFolder, repositoryStateFor, useGitStore, type GitDiffArea, type GitTab } from '../../state/git'
import { useWorkspaceStore } from '../../state/store'
import { useWorkspaceContentActions } from '../../layout/contentActions'
import { QuickPick } from '../QuickPick'
import type { PickerEntry } from '../pickerModel'
import { BranchesTab } from './BranchesTab'
import { AssignedTab } from './AssignedTab'
import { HistoryTab } from './HistoryTab'
import { PullRequestsTab } from './PullRequestsTab'
import { GitWindowView, type GitChangeGroup, type GitChangeItem, type GitCloneViewState, type GitRowAction } from './GitWindowView'
import type { WorkspaceCreationInput } from '../../ipc/providerIntegrations'

const EMPTY_STATUS: WorkingStatus = { staged: [], unstaged: [], untracked: [], conflicted: [], truncated: false }

type RemoteComparison = {
  repoRoot: string
  upstream: string
  files: ChangedFile[]
  selectedPath: string | null
}


export type WorkbenchContentPanelProps = {
  onWorkspaceInput?: (input: WorkspaceCreationInput) => void | Promise<void>
}

export function WorkbenchContentPanel({ onWorkspaceInput }: WorkbenchContentPanelProps = {}) {
  const sessionId = useWorkspaceStore((state) => state.activeSessionId)
  const sessions = useWorkspaceStore((state) => state.sessions)
  const workspaceFolder = useMemo(() => sessions.find((session) => session.id === sessionId)?.workspaceFolder ?? null, [sessionId, sessions])
  const gitState = useGitStore((state) => sessionId ? state.sessions[sessionId] : undefined) ?? emptyGitSessionState
  const activeRepoRoot = gitState.activeRepoRoot
  const activeRepository = repositoryStateFor(gitState, activeRepoRoot)
  const activeWorkspaceFolder = workspaceFolder ? repositoryFolder(workspaceFolder, activeRepoRoot) : null
  const selectedRelativePath = useMemo(() => {
    if (!gitState.selectedPath || gitState.selectedRepoRoot !== activeRepoRoot) return null
    return activeRepoRoot ? gitState.selectedPath.slice(activeRepoRoot.length).replace(/^\/+/, '') : gitState.selectedPath
  }, [activeRepoRoot, gitState.selectedPath, gitState.selectedRepoRoot])
  const refreshRepository = useGitStore((state) => state.refreshRepository)
  const refreshHosting = useGitStore((state) => state.refreshHosting)
  const runGitMutation = useGitStore((state) => state.runGitMutation)
  const setActiveRepository = useGitStore((state) => state.setActiveRepository)
  const setSelectedPath = useGitStore((state) => state.setSelectedPath)
  const setActiveTab = useGitStore((state) => state.setActiveTab)
  const contentActions = useWorkspaceContentActions()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const [selectedArea, setSelectedArea] = useState<GitDiffArea>('unstaged')
  const [contents, setContents] = useState<FileContents | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffRefreshRevision, setDiffRefreshRevision] = useState(0)
  const [remoteComparison, setRemoteComparison] = useState<RemoteComparison | null>(null)
  const activeRemoteComparison = remoteComparison?.repoRoot === activeRepoRoot ? remoteComparison : null
  const [remoteCompareLoading, setRemoteCompareLoading] = useState(false)
  const diffRequestGeneration = useRef(0)
  const [branchPickerOpen, setBranchPickerOpen] = useState(false)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [cloneOpen, setCloneOpen] = useState(false)
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloneTargetDir, setCloneTargetDir] = useState('')
  const [cloneProgress, setCloneProgress] = useState<string[]>([])
  const [cloneRunning, setCloneRunning] = useState(false)


  useEffect(() => {
    if (!sessionId) return
    void refreshRepository(sessionId, workspaceFolder, activeRepoRoot)
    void refreshHosting(sessionId, workspaceFolder, 'HEAD', false, activeRepoRoot)
    const timer = window.setInterval(() => {
      if (rootRef.current?.offsetParent !== null) {
        void refreshRepository(sessionId, workspaceFolder, activeRepoRoot)
        void refreshHosting(sessionId, workspaceFolder, 'HEAD', false, activeRepoRoot)
      }
    }, 3_000)
    return () => window.clearInterval(timer)
  }, [activeRepoRoot, refreshHosting, refreshRepository, sessionId, workspaceFolder])

  const status = activeRepository.status ?? EMPTY_STATUS
  const orderedEntries = useMemo(
    () => [...status.conflicted, ...status.staged, ...status.unstaged, ...status.untracked],
    [status.conflicted, status.staged, status.unstaged, status.untracked],
  )

  useEffect(() => {
    if (!activeRepository.status || !sessionId) return
    const timer = window.setTimeout(() => {
      const selectedEntry = selectedRelativePath ? orderedEntries.find((entry) => entry.path === selectedRelativePath) : null
      const selectedExists = Boolean(selectedEntry && !selectedEntry.repoKind && !selectedEntry.path.endsWith('/'))
      if (selectedExists && selectedRelativePath) {
        const hasWorkingTreeChange = status.conflicted.some((entry) => entry.path === selectedRelativePath)
          || status.unstaged.some((entry) => entry.path === selectedRelativePath)
          || status.untracked.some((entry) => entry.path === selectedRelativePath)
        setSelectedArea(hasWorkingTreeChange ? 'unstaged' : 'staged')
        return
      }
      const first = orderedEntries.find((entry) => !entry.repoKind && !entry.path.endsWith('/')) ?? null
      const area: GitDiffArea = first && status.staged.some((entry) => entry.path === first.path) ? 'staged' : 'unstaged'
      const fullPath = first ? (activeRepoRoot ? `${activeRepoRoot}/${first.path}` : first.path) : null
      setSelectedPath(sessionId, fullPath, activeRepoRoot, area)
      setSelectedArea(area)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [activeRepoRoot, activeRepository.status, orderedEntries, selectedRelativePath, sessionId, setSelectedPath, status.conflicted, status.staged, status.unstaged, status.untracked])

  const diffSelectedPath = activeRemoteComparison?.selectedPath ?? selectedRelativePath
  const diffSelectedArea = activeRemoteComparison ? 'remote' : selectedArea

  useEffect(() => {
    const generation = diffRequestGeneration.current + 1
    diffRequestGeneration.current = generation
    const timer = window.setTimeout(() => {
      if (!activeWorkspaceFolder || !diffSelectedPath) {
        setContents(null)
        setDiffError(null)
        setDiffLoading(false)
        return
      }
      setContents(null)
      setDiffLoading(true)
      setDiffError(null)
      const command = activeRemoteComparison ? 'git_compare_refs_file' : 'git_working_file_contents'
      const args = activeRemoteComparison
        ? { workspaceFolder: activeWorkspaceFolder, baseRef: 'HEAD', headRef: activeRemoteComparison.upstream, path: diffSelectedPath }
        : { workspaceFolder: activeWorkspaceFolder, path: diffSelectedPath, area: selectedArea }
      void invoke<FileContents>(command, args)
        .then((next) => { if (diffRequestGeneration.current === generation) setContents(next) })
        .catch((reason) => {
          if (diffRequestGeneration.current === generation) { setContents(null); setDiffError(String(reason)) }
        })
        .finally(() => { if (diffRequestGeneration.current === generation) setDiffLoading(false) })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [activeRemoteComparison, activeWorkspaceFolder, diffRefreshRevision, diffSelectedPath, selectedArea])

  const runActiveMutation = useCallback(async (operation: () => Promise<unknown>) => {
    if (!sessionId || !workspaceFolder) return
    await runGitMutation(sessionId, workspaceFolder, operation, activeRepoRoot)
    setDiffRefreshRevision((current) => current + 1)
  }, [activeRepoRoot, runGitMutation, sessionId, workspaceFolder])

  const mutate = useCallback((operation: () => Promise<unknown>, after?: () => void) => {
    void runActiveMutation(operation).then(after).catch(() => {})
  }, [runActiveMutation])

  const discard = useCallback((paths: string[], untracked: boolean) => {
    if (!activeWorkspaceFolder || paths.length === 0) return
    const message = untracked
      ? `Discard ${paths.length === 1 ? paths[0] : `${paths.length} untracked files`}? (moves to Recycle Bin)`
      : `Discard changes in ${paths.length === 1 ? paths[0] : `${paths.length} files`}? This cannot be undone.`
    if (!window.confirm(message)) return
    mutate(() => invoke('git_discard', { workspaceFolder: activeWorkspaceFolder, paths }))
  }, [activeWorkspaceFolder, mutate])

  const revealExplorerFile = useCallback((path: string) => {
    if (!sessionId || !workspaceFolder) return
    const fullPath = activeRepoRoot ? `${activeRepoRoot}/${path}` : path
    void contentActions.openContent({ kind: 'explorer' })
      .then(() => useExplorerStore.getState().revealPath(sessionId, workspaceFolder, fullPath))
  }, [activeRepoRoot, contentActions, sessionId, workspaceFolder])

  const selectChange = useCallback((item: GitChangeItem) => {
    if (!sessionId) return
    if (item.area === 'remote') {
      setRemoteComparison((current) => current ? { ...current, selectedPath: item.path } : current)
    } else {
      const fullPath = activeRepoRoot ? `${activeRepoRoot}/${item.path}` : item.path
      setRemoteComparison(null)
      setSelectedArea(item.area)
      setSelectedPath(sessionId, fullPath, activeRepoRoot, item.area)
    }
    revealExplorerFile(item.path)
  }, [activeRepoRoot, revealExplorerFile, sessionId, setSelectedPath])

  const rowAction = useCallback((id: string, label: string, action: () => void, danger = false): GitRowAction => ({ id, label, danger, onClick: action }), [])
  const groups = useMemo<GitChangeGroup[]>(() => {
    const items = (entries: typeof status.staged, area: GitDiffArea): GitChangeItem[] => entries
      .filter((entry) => !entry.repoKind && !entry.path.endsWith('/'))
      .map((entry) => ({ path: entry.path, oldPath: entry.oldPath, changeType: entry.changeType, area }))
    const conflictedItems = items(status.conflicted, 'unstaged')
    const stagedItems = items(status.staged, 'staged')
    const unstagedItems = items(status.unstaged, 'unstaged')
    const untrackedItems = items(status.untracked, 'unstaged')
    const stageableUnstaged = status.unstaged
      .filter((entry) => !entry.repoKind || (entry.repoKind === 'submodule' && entry.submoduleState?.commitChanged))
      .map((entry) => entry.path)
    const discardableUnstaged = status.unstaged.filter((entry) => !entry.repoKind).map((entry) => entry.path)
    const stageableUntracked = status.untracked.filter((entry) => !entry.repoKind).map((entry) => entry.path)
    return [
      { id: 'conflicted', title: 'Merge Conflicts', count: conflictedItems.length, actions: [], items: conflictedItems },
      {
        id: 'staged',
        title: 'Staged',
        count: stagedItems.length,
        actions: status.staged.length > 0 ? [rowAction('unstage-all', 'Unstage All', () => mutate(() => invoke('git_unstage_all', { workspaceFolder: activeWorkspaceFolder })))] : [],
        items: stagedItems,
      },
      {
        id: 'unstaged',
        title: 'Changes',
        count: unstagedItems.length,
        actions: [
          ...(stageableUnstaged.length > 0 ? [rowAction('stage-all', 'Stage All', () => mutate(() => invoke('git_stage', { workspaceFolder: activeWorkspaceFolder, paths: stageableUnstaged })))] : []),
          ...(discardableUnstaged.length > 0 ? [rowAction('discard-all', 'Discard All', () => discard(discardableUnstaged, false), true)] : []),
        ],
        items: unstagedItems,
      },
      {
        id: 'untracked',
        title: 'Untracked',
        count: untrackedItems.length,
        actions: stageableUntracked.length > 0 ? [
          rowAction('stage-all', 'Stage All', () => mutate(() => invoke('git_stage', { workspaceFolder: activeWorkspaceFolder, paths: stageableUntracked }))),
          rowAction('discard-all', 'Discard All', () => discard(stageableUntracked, true), true),
        ] : [],
        items: untrackedItems,
      },
    ]
  }, [activeWorkspaceFolder, discard, mutate, rowAction, status])

  const visibleGroups = useMemo<GitChangeGroup[]>(() => activeRemoteComparison ? [{
    id: 'remote',
    title: 'Remote changes',
    count: activeRemoteComparison.files.length,
    actions: [],
    items: activeRemoteComparison.files.map((file) => ({ path: file.path, oldPath: file.oldPath ?? null, changeType: file.changeType, area: 'remote' })),
  }] : groups, [activeRemoteComparison, groups])

  const openBranchPicker = useCallback(() => {
    if (!activeWorkspaceFolder) return
    void invoke<BranchInfo[]>('git_branches', { workspaceFolder: activeWorkspaceFolder })
      .then((items) => {
        setBranches(items.filter((branch) => !branch.isRemote))
        setBranchPickerOpen(true)
      })
      .catch(() => {})
  }, [activeWorkspaceFolder])

  const branchEntries = useCallback((filter: string): PickerEntry<string>[] => branches
    .filter((branch) => branch.name.toLowerCase().includes(filter.toLowerCase()))
    .map((branch) => ({ kind: 'item', id: branch.name, name: branch.name, description: branch.lastCommitSubject })), [branches])

  const chooseCloneTarget = useCallback(() => {
    void open({ directory: true, multiple: false, title: 'Choose clone target directory' }).then((path) => {
      if (typeof path === 'string') setCloneTargetDir(path)
    })
  }, [])

  const startClone = useCallback(() => {
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
  }, [cloneTargetDir, cloneUrl])

  const clone: GitCloneViewState = {
    open: cloneOpen,
    url: cloneUrl,
    targetDir: cloneTargetDir,
    progress: cloneProgress,
    running: cloneRunning,
    onUrlChange: setCloneUrl,
    onChooseTarget: chooseCloneTarget,
    onStart: startClone,
    onClose: () => { if (!cloneRunning) setCloneOpen(false) },
  }

  const repoInfo = activeRepository.repoInfo
  const upstream = repoInfo?.upstream ?? null
  const continueState = repoInfo?.state === 'rebasing' && activeWorkspaceFolder
    ? () => mutate(() => invoke('git_rebase_continue', { workspaceFolder: activeWorkspaceFolder }))
    : null
  const abortState = repoInfo?.state === 'rebasing' && activeWorkspaceFolder
    ? () => mutate(() => invoke('git_rebase_abort', { workspaceFolder: activeWorkspaceFolder }))
    : repoInfo?.state === 'merging' && activeWorkspaceFolder
      ? () => mutate(() => invoke('git_merge_abort', { workspaceFolder: activeWorkspaceFolder }))
      : null

  const compareRemote = useCallback(async () => {
    if (!sessionId || !workspaceFolder || !activeWorkspaceFolder || !upstream) return
    setRemoteCompareLoading(true)
    setDiffError(null)
    try {
      await runGitMutation(
        sessionId,
        workspaceFolder,
        () => invoke('git_fetch', { workspaceFolder: activeWorkspaceFolder, remote: null, prune: false, refspec: null }),
        activeRepoRoot,
      )
      const files = await invoke<ChangedFile[]>('git_compare_refs', {
        workspaceFolder: activeWorkspaceFolder,
        baseRef: 'HEAD',
        headRef: upstream,
      })
      setRemoteComparison({ repoRoot: activeRepoRoot, upstream, files, selectedPath: files[0]?.path ?? null })
      setContents(null)
    } catch (reason) {
      setDiffError(String(reason))
    } finally {
      setRemoteCompareLoading(false)
    }
  }, [activeRepoRoot, activeWorkspaceFolder, runGitMutation, sessionId, upstream, workspaceFolder])

  return (
    <>
      <GitWindowView
        setRootElement={(element) => { rootRef.current = element }}
        workspaceFolder={activeWorkspaceFolder}
        repositoryPath={activeRepoRoot}
        repoInfo={repoInfo}
        status={activeRepository.status}
        refreshing={activeRepository.refreshing}
        error={activeRepository.error}
        activeTab={gitState.activeTab}
        ciStatus={activeRepository.ciStatus}
        commitMessage={commitMessage}
        amend={amend}
        canCommit={Boolean(commitMessage.trim()) && (amend || status.staged.length > 0)}
        groups={visibleGroups}
        selectedPath={diffSelectedPath}
        selectedArea={diffSelectedArea}
        contents={contents}
        diffLoading={diffLoading}
        diffError={diffError}
        remoteUpstream={upstream}
        remoteComparisonActive={activeRemoteComparison !== null}
        remoteCompareLoading={remoteCompareLoading}
        clone={clone}
        onOpenWorkspaceRepository={activeRepoRoot && sessionId ? () => {
          setActiveRepository(sessionId, '')
          setSelectedPath(sessionId, null, '', null)
          void refreshRepository(sessionId, workspaceFolder, '')
          void refreshHosting(sessionId, workspaceFolder, 'HEAD', false, '')
        } : null}
        onRefresh={() => {
          if (!sessionId) return
          void refreshRepository(sessionId, workspaceFolder, activeRepoRoot).then(() => setDiffRefreshRevision((current) => current + 1))
        }}
        onInitialize={() => mutate(() => invoke('git_init', { workspaceFolder: activeWorkspaceFolder }))}
        onOpenClone={() => setCloneOpen(true)}
        onOpenBranchPicker={openBranchPicker}
        onFetch={() => mutate(() => invoke('git_fetch', { workspaceFolder: activeWorkspaceFolder, remote: null, prune: false, refspec: null }))}
        onPull={() => mutate(() => invoke('git_pull', { workspaceFolder: activeWorkspaceFolder, rebase: false }))}
        onPush={() => mutate(() => invoke('git_push', { workspaceFolder: activeWorkspaceFolder, remote: null, branch: repoInfo?.branch ?? null, setUpstream: !repoInfo?.upstream, forceWithLease: false }))}
        onCompareRemote={() => { void compareRemote() }}
        onShowWorkingChanges={() => { setRemoteComparison(null); setDiffError(null) }}
        onSelectChange={selectChange}
        onContinueState={continueState}
        onAbortState={abortState}
        onTabChange={(tab: GitTab) => { if (sessionId) setActiveTab(sessionId, tab) }}
        onCommitMessageChange={setCommitMessage}
        onAmendChange={setAmend}
        onCommit={() => mutate(
          () => invoke<string>('git_commit', { workspaceFolder: activeWorkspaceFolder, message: commitMessage, amend, signoff: false }),
          () => setCommitMessage(''),
        )}
        historyContent={sessionId && activeWorkspaceFolder ? <HistoryTab sessionId={sessionId} workspaceFolder={activeWorkspaceFolder} pathFilter={gitState.pathFilter} onRunMutation={runActiveMutation} onRevealFile={revealExplorerFile} /> : null}
        branchesContent={sessionId && activeWorkspaceFolder && repoInfo ? <BranchesTab sessionId={sessionId} workspaceFolder={activeWorkspaceFolder} repoInfo={repoInfo} status={status} onRunMutation={runActiveMutation} onRevealFile={revealExplorerFile} /> : null}
        assignedContent={sessionId ? (
          <AssignedTab
            sessionId={sessionId}
            onWorkspaceInput={onWorkspaceInput}
            reviewContent={activeWorkspaceFolder && repoInfo && activeRepository.hostingInfo ? (
              <PullRequestsTab sessionId={sessionId} workspaceFolder={activeWorkspaceFolder} repoInfo={repoInfo} hostingInfo={activeRepository.hostingInfo} hostingError={activeRepository.hostingError} onHostingChanged={() => refreshHosting(sessionId, workspaceFolder, 'HEAD', true, activeRepoRoot)} onRepositoryChanged={() => refreshRepository(sessionId, workspaceFolder, activeRepoRoot)} onRevealFile={revealExplorerFile} />
            ) : null}
          />
        ) : null}
      />
      {branchPickerOpen && branches.length > 0 ? (
        <QuickPick
          value={repoInfo?.branch && branches.some((branch) => branch.name === repoInfo.branch) ? repoInfo.branch : branches[0].name}
          ariaLabel="Switch Git branch"
          placeholder="Search branches"
          icon={<GitBranchIcon size={15} />}
          noMatchLabel="branches"
          entriesForFilter={branchEntries}
          renderItem={(item) => <><span>{item.name}</span>{item.description ? <small>{item.description}</small> : null}</>}
          onPreview={() => {}}
          onSelect={(branch) => {
            setBranchPickerOpen(false)
            mutate(() => invoke('git_checkout', { workspaceFolder: activeWorkspaceFolder, refName: branch }))
          }}
          onCancel={() => setBranchPickerOpen(false)}
        />
      ) : null}
    </>
  )
}
