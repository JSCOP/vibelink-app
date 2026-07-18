import { Channel, invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitBranch as GitBranchIcon } from 'lucide-react'
import type { BranchInfo, CloneProgress, FileContents, StatusEntry, WorkingStatus } from '../../ipc/types'
import { emptyGitSessionState, useGitStore, type GitTab } from '../../state/git'
import { useWorkspaceStore } from '../../state/store'
import { QuickPick } from '../QuickPick'
import type { PickerEntry } from '../pickerModel'
import { BranchesTab } from './BranchesTab'
import { HistoryTab } from './HistoryTab'
import { PullRequestsTab } from './PullRequestsTab'
import { GitWindowView, type GitChangeGroup, type GitCloneViewState, type GitRowAction } from './GitWindowView'

const EMPTY_STATUS: WorkingStatus = { staged: [], unstaged: [], untracked: [], conflicted: [], truncated: false }

type DiffArea = 'staged' | 'unstaged'

export function GitWindow() {
  const sessionId = useWorkspaceStore((state) => state.activeSessionId)
  const sessions = useWorkspaceStore((state) => state.sessions)
  const workspaceFolder = useMemo(() => sessions.find((session) => session.id === sessionId)?.workspaceFolder ?? null, [sessionId, sessions])
  const gitState = useGitStore((state) => sessionId ? state.sessions[sessionId] : undefined) ?? emptyGitSessionState
  const refreshGit = useGitStore((state) => state.refreshGit)
  const refreshHosting = useGitStore((state) => state.refreshHosting)
  const runGitMutation = useGitStore((state) => state.runGitMutation)
  const setSelectedPath = useGitStore((state) => state.setSelectedPath)
  const setActiveTab = useGitStore((state) => state.setActiveTab)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const [selectedArea, setSelectedArea] = useState<DiffArea>('unstaged')
  const [contents, setContents] = useState<FileContents | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [branchPickerOpen, setBranchPickerOpen] = useState(false)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [cloneOpen, setCloneOpen] = useState(false)
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloneTargetDir, setCloneTargetDir] = useState('')
  const [cloneProgress, setCloneProgress] = useState<string[]>([])
  const [cloneRunning, setCloneRunning] = useState(false)

  useEffect(() => {
    if (!sessionId) return
    void refreshGit(sessionId, workspaceFolder)
    void refreshHosting(sessionId, workspaceFolder)
    const timer = window.setInterval(() => {
      if (rootRef.current?.offsetParent !== null) {
        void refreshGit(sessionId, workspaceFolder)
        void refreshHosting(sessionId, workspaceFolder)
      }
    }, 3_000)
    return () => window.clearInterval(timer)
  }, [refreshGit, refreshHosting, sessionId, workspaceFolder])

  const status = gitState.status ?? EMPTY_STATUS
  const orderedEntries = useMemo(
    () => [...status.conflicted, ...status.staged, ...status.unstaged, ...status.untracked],
    [status.conflicted, status.staged, status.unstaged, status.untracked],
  )

  useEffect(() => {
    if (!sessionId) return
    const selectedExists = orderedEntries.some((entry) => entry.path === gitState.selectedPath)
    if (selectedExists) return
    const first = orderedEntries[0] ?? null
    setSelectedPath(sessionId, first?.path ?? null)
    setSelectedArea(first && status.staged.some((entry) => entry.path === first.path) ? 'staged' : 'unstaged')
  }, [gitState.selectedPath, orderedEntries, sessionId, setSelectedPath, status.staged])

  useEffect(() => {
    if (!workspaceFolder || !gitState.selectedPath) {
      setContents(null)
      setDiffError(null)
      return
    }
    let cancelled = false
    setDiffLoading(true)
    setDiffError(null)
    invoke<FileContents>('git_working_file_contents', { workspaceFolder, path: gitState.selectedPath, area: selectedArea })
      .then((next) => {
        if (!cancelled) setContents(next)
      })
      .catch((reason) => {
        if (!cancelled) {
          setContents(null)
          setDiffError(String(reason))
        }
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false)
      })
    return () => { cancelled = true }
  }, [gitState.selectedPath, selectedArea, workspaceFolder, gitState.lastRefreshAt])

  const mutate = useCallback((operation: () => Promise<unknown>, after?: () => void) => {
    if (!sessionId || !workspaceFolder) return
    void runGitMutation(sessionId, workspaceFolder, operation).then(after).catch(() => {})
  }, [runGitMutation, sessionId, workspaceFolder])

  const selectEntry = useCallback((entry: StatusEntry, area: DiffArea) => {
    if (!sessionId) return
    setSelectedArea(area)
    setSelectedPath(sessionId, entry.path)
  }, [sessionId, setSelectedPath])

  const discard = useCallback((paths: string[], untracked: boolean) => {
    if (!workspaceFolder || paths.length === 0) return
    const message = untracked
      ? `Discard ${paths.length === 1 ? paths[0] : `${paths.length} untracked files`}? (moves to Recycle Bin)`
      : `Discard changes in ${paths.length === 1 ? paths[0] : `${paths.length} files`}? This cannot be undone.`
    if (!window.confirm(message)) return
    mutate(() => invoke('git_discard', { workspaceFolder, paths }))
  }, [mutate, workspaceFolder])

  const rowAction = useCallback((id: string, label: string, action: () => void, danger = false): GitRowAction => ({ id, label, danger, onClick: action }), [])

  const groups = useMemo<GitChangeGroup[]>(() => [
    {
      id: 'conflicted',
      title: 'Merge Conflicts',
      actions: [],
      rows: status.conflicted.map((entry) => ({
        id: `conflicted:${entry.path}`,
        entry,
        selected: gitState.selectedPath === entry.path,
        onSelect: () => selectEntry(entry, 'unstaged'),
        actions: [
          rowAction('ours', 'Accept Ours', () => mutate(() => invoke('git_conflict_take', { workspaceFolder, paths: [entry.path], side: 'ours' }))),
          rowAction('theirs', 'Accept Theirs', () => mutate(() => invoke('git_conflict_take', { workspaceFolder, paths: [entry.path], side: 'theirs' }))),
        ],
      })),
    },
    {
      id: 'staged',
      title: 'Staged',
      actions: status.staged.length > 0 ? [rowAction('unstage-all', 'Unstage All', () => mutate(() => invoke('git_unstage_all', { workspaceFolder })))] : [],
      rows: status.staged.map((entry) => ({
        id: `staged:${entry.path}`,
        entry,
        selected: gitState.selectedPath === entry.path && selectedArea === 'staged',
        onSelect: () => selectEntry(entry, 'staged'),
        actions: [rowAction('unstage', 'Unstage', () => mutate(() => invoke('git_unstage', { workspaceFolder, paths: [entry.path] })))],
      })),
    },
    {
      id: 'unstaged',
      title: 'Changes',
      actions: status.unstaged.length > 0 ? [
        rowAction('stage-all', 'Stage All', () => mutate(() => invoke('git_stage_all', { workspaceFolder }))),
        rowAction('discard-all', 'Discard All', () => discard(status.unstaged.map((entry) => entry.path), false), true),
      ] : [],
      rows: status.unstaged.map((entry) => ({
        id: `unstaged:${entry.path}`,
        entry,
        selected: gitState.selectedPath === entry.path && selectedArea === 'unstaged',
        onSelect: () => selectEntry(entry, 'unstaged'),
        actions: [
          rowAction('stage', 'Stage', () => mutate(() => invoke('git_stage', { workspaceFolder, paths: [entry.path] }))),
          rowAction('discard', 'Discard', () => discard([entry.path], false), true),
        ],
      })),
    },
    {
      id: 'untracked',
      title: 'Untracked',
      actions: status.untracked.length > 0 ? [
        rowAction('stage-all', 'Stage All', () => mutate(() => invoke('git_stage_all', { workspaceFolder }))),
        rowAction('discard-all', 'Discard All', () => discard(status.untracked.map((entry) => entry.path), true), true),
      ] : [],
      rows: status.untracked.map((entry) => ({
        id: `untracked:${entry.path}`,
        entry,
        selected: gitState.selectedPath === entry.path && selectedArea === 'unstaged',
        onSelect: () => selectEntry(entry, 'unstaged'),
        actions: [
          rowAction('stage', 'Stage', () => mutate(() => invoke('git_stage', { workspaceFolder, paths: [entry.path] }))),
          rowAction('discard', 'Discard', () => discard([entry.path], true), true),
        ],
      })),
    },
  ], [discard, gitState.selectedPath, mutate, rowAction, selectEntry, selectedArea, status, workspaceFolder])

  const openBranchPicker = useCallback(() => {
    if (!workspaceFolder) return
    void invoke<BranchInfo[]>('git_branches', { workspaceFolder })
      .then((items) => {
        setBranches(items.filter((branch) => !branch.isRemote))
        setBranchPickerOpen(true)
      })
      .catch(() => {})
  }, [workspaceFolder])

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

  const repoInfo = gitState.repoInfo
  const continueState = repoInfo?.state === 'rebasing' && workspaceFolder
    ? () => mutate(() => invoke('git_rebase_continue', { workspaceFolder }))
    : null
  const abortState = repoInfo?.state === 'rebasing' && workspaceFolder
    ? () => mutate(() => invoke('git_rebase_abort', { workspaceFolder }))
    : repoInfo?.state === 'merging' && workspaceFolder
      ? () => mutate(() => invoke('git_merge_abort', { workspaceFolder }))
      : null

  return (
    <>
      <GitWindowView
        setRootElement={(element) => { rootRef.current = element }}
        workspaceFolder={workspaceFolder}
        repoInfo={repoInfo}
        status={gitState.status}
        refreshing={gitState.refreshing}
        error={gitState.error}
        activeTab={gitState.activeTab}
        pullRequestsVisible={Boolean(gitState.hostingInfo?.provider)}
        ciStatus={gitState.ciStatus}
        commitMessage={commitMessage}
        amend={amend}
        canCommit={Boolean(commitMessage.trim()) && (amend || status.staged.length > 0)}
        groups={groups}
        selectedPath={gitState.selectedPath}
        contents={contents}
        diffLoading={diffLoading}
        diffError={diffError}
        clone={clone}
        onRefresh={() => { if (sessionId) void refreshGit(sessionId, workspaceFolder) }}
        onInitialize={() => mutate(() => invoke('git_init', { workspaceFolder }))}
        onOpenClone={() => setCloneOpen(true)}
        onOpenBranchPicker={openBranchPicker}
        onFetch={() => mutate(() => invoke('git_fetch', { workspaceFolder, remote: null, prune: false, refspec: null }))}
        onPull={() => mutate(() => invoke('git_pull', { workspaceFolder, rebase: false }))}
        onPush={() => mutate(() => invoke('git_push', { workspaceFolder, remote: null, branch: repoInfo?.branch ?? null, setUpstream: !repoInfo?.upstream, forceWithLease: false }))}
        onContinueState={continueState}
        onAbortState={abortState}
        onTabChange={(tab: GitTab) => { if (sessionId) setActiveTab(sessionId, tab) }}
        onCommitMessageChange={setCommitMessage}
        onAmendChange={setAmend}
        onCommit={() => mutate(
          () => invoke<string>('git_commit', { workspaceFolder, message: commitMessage, amend, signoff: false }),
          () => setCommitMessage(''),
        )}
        historyContent={sessionId && workspaceFolder ? <HistoryTab sessionId={sessionId} workspaceFolder={workspaceFolder} pathFilter={gitState.pathFilter} /> : null}
        branchesContent={sessionId && workspaceFolder && repoInfo ? <BranchesTab sessionId={sessionId} workspaceFolder={workspaceFolder} repoInfo={repoInfo} status={status} /> : null}
        pullRequestsContent={sessionId && workspaceFolder && repoInfo && gitState.hostingInfo ? <PullRequestsTab sessionId={sessionId} workspaceFolder={workspaceFolder} repoInfo={repoInfo} hostingInfo={gitState.hostingInfo} hostingError={gitState.hostingError} onHostingChanged={() => refreshHosting(sessionId, workspaceFolder, 'HEAD', true)} /> : null}
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
            mutate(() => invoke('git_checkout', { workspaceFolder, refName: branch }))
          }}
          onCancel={() => setBranchPickerOpen(false)}
        />
      ) : null}
    </>
  )
}

