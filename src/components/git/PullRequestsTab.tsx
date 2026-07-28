import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BranchInfo, ChangedFile, CiStatus, DeviceCodeInfo, FileContents, HostingInfo, LogPage, MergePrResult, PrCreated, PrDetail, PrInfo, RepoInfo, UnifiedFileDiff } from '../../ipc/types'
import { PullRequestsTabView } from './PullRequestsTabView'
import { useWorkspaceStore } from '../../state/store'
import { worktreeBySession, type WorktreeReviewComment } from '../../state/worktrees'
import { useGitStore } from '../../state/git'
import { choiceDialog, promptDialog } from '../appDialogStore'

export type PullRequestsTabProps = {
  sessionId: string
  workspaceFolder: string
  repoInfo: RepoInfo
  hostingInfo: HostingInfo
  hostingError: string | null
  onHostingChanged: () => Promise<void>
  onRepositoryChanged: () => Promise<void>
  onRevealFile?: (path: string) => void
}

export function PullRequestsTab({ sessionId, workspaceFolder, repoInfo, hostingInfo, hostingError, onHostingChanged, onRepositoryChanged, onRevealFile }: PullRequestsTabProps) {
  const [prs, setPrs] = useState<PrInfo[]>([])
  const [ciByNumber, setCiByNumber] = useState<Record<number, CiStatus>>({})
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null)
  const [detail, setDetail] = useState<PrDetail | null>(null)
  const [files, setFiles] = useState<ChangedFile[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [contents, setContents] = useState<FileContents | null>(null)
  const [diffRefs, setDiffRefs] = useState<{ base: string; head: string } | null>(null)
  const [reviewBaseHead, setReviewBaseHead] = useState<string | null>(null)
  const [reviewHunks, setReviewHunks] = useState<UnifiedFileDiff | null>(null)
  const [selectedReviewHunkId, setSelectedReviewHunkId] = useState<string | null>(null)
  const [providerReviewComments, setProviderReviewComments] = useState<WorktreeReviewComment[]>([])
  const [loading, setLoading] = useState(false)
  const [diffLoading, setDiffLoading] = useState(false)
  const [error, setError] = useState<string | null>(hostingError)
  const [checkpointWarning, setCheckpointWarning] = useState<string | null>(null)
  const [mode, setMode] = useState<'list' | 'create'>('list')
  const [token, setToken] = useState('')
  const [deviceCode, setDeviceCode] = useState<DeviceCodeInfo | null>(null)
  const [created, setCreated] = useState<PrCreated | null>(null)
  const [createTitle, setCreateTitle] = useState('')
  const [createBody, setCreateBody] = useState('')
  const [createTarget, setCreateTarget] = useState('main')
  const [createTargets, setCreateTargets] = useState<string[]>(['main'])
  const [createDraft, setCreateDraft] = useState(false)
  const pollTimerRef = useRef<number | null>(null)
  const sourceBranch = repoInfo.branch ?? ''

  const clearPoll = useCallback(() => {
    if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current)
    pollTimerRef.current = null
  }, [])
  useEffect(() => clearPoll, [clearPoll])

  const loadPrs = useCallback(async () => {
    if (!hostingInfo.provider || !hostingInfo.tokenPresent) return
    setLoading(true)
    setError(null)
    try {
      const next = await invoke<PrInfo[]>('hosting_prs_list', { workspaceFolder })
      setPrs(next)
      const states = await Promise.all(next.map(async (pr) => [pr.number, await invoke<CiStatus>('hosting_ci_status', { workspaceFolder, refName: pr.sourceBranch }).catch(() => ({ state: 'none', checks: [] } as CiStatus))] as const))
      setCiByNumber(Object.fromEntries(states))
    } catch (reason) {
      setError(String(reason))
      if (String(reason).includes('AUTH:')) await onHostingChanged()
    } finally { setLoading(false) }
  }, [hostingInfo.provider, hostingInfo.tokenPresent, onHostingChanged, workspaceFolder])

  useEffect(() => { const timer = window.setTimeout(() => { void loadPrs() }, 0); return () => window.clearTimeout(timer) }, [loadPrs])
  useEffect(() => {
    if (!hostingInfo.tokenPresent || !sourceBranch) return
    void Promise.all([
      invoke<BranchInfo[]>('git_branches', { workspaceFolder }),
      invoke<LogPage>('git_log', { workspaceFolder, options: { refName: null, path: null, skip: 0, limit: 1, search: null, author: null } }),
    ]).then(([branches, page]) => {
      const targets = branchTargets(branches)
      setCreateTargets(targets)
      setCreateTarget((current) => targets.includes(current) ? current : targets[0] ?? 'main')
      setCreateTitle((current) => current || page.commits[0]?.subject || '')
    }).catch(() => {})
  }, [hostingInfo.tokenPresent, sourceBranch, workspaceFolder])

  const saveToken = useCallback(async () => {
    if (!hostingInfo.host || !token.trim()) return
    setLoading(true)
    try {
      await invoke('hosting_token_set', { host: hostingInfo.host, token: token.trim() })
      setToken('')
      await onHostingChanged()
    } catch (reason) { setError(String(reason)) } finally { setLoading(false) }
  }, [hostingInfo.host, onHostingChanged, token])

  const startDeviceSignIn = useCallback(async () => {
    clearPoll()
    setError(null)
    try {
      const code = await invoke<DeviceCodeInfo>('hosting_github_device_start')
      setDeviceCode(code)
      await invoke('open_path', { path: code.verificationUri })
      const poll = async () => {
        try {
          const complete = await invoke<boolean>('hosting_github_device_poll', { handle: code.deviceCodeHandle })
          if (complete) {
            setDeviceCode(null)
            await onHostingChanged()
            return
          }
        } catch (reason) { setError(String(reason)); return }
        pollTimerRef.current = window.setTimeout(() => { void poll() }, Math.max(2, code.interval) * 1000)
      }
      pollTimerRef.current = window.setTimeout(() => { void poll() }, Math.max(2, code.interval) * 1000)
    } catch (reason) { setError(String(reason)) }
  }, [clearPoll, onHostingChanged])

  const selectPr = useCallback(async (number: number) => {
    setSelectedNumber(number)
    setDetail(null)
    setFiles([])
    setContents(null)
    setSelectedPath(null)
    setReviewBaseHead(null)
    setReviewHunks(null)
    setSelectedReviewHunkId(null)
    setProviderReviewComments([])
    setDiffLoading(true)
    setError(null)
    try {
      const next = await invoke<PrDetail>('hosting_pr_detail', { workspaceFolder, number })
      setDetail(next)
      const remotePath = hostingInfo.provider === 'gitlab' ? `mr/${number}` : `pr/${number}`
      const refspec = hostingInfo.provider === 'gitlab'
        ? `+refs/merge-requests/${number}/head:refs/remotes/origin/${remotePath}`
        : `+refs/pull/${number}/head:refs/remotes/origin/${remotePath}`
      await invoke('git_fetch', { workspaceFolder, remote: 'origin', prune: false, refspec })
      const refs = { base: `origin/${next.targetBranch}`, head: `origin/${remotePath}` }
      setDiffRefs(refs)
      const [changed, basePage] = await Promise.all([
        invoke<ChangedFile[]>('git_diff_refs', { workspaceFolder, baseRef: refs.base, headRef: refs.head }),
        invoke<LogPage>('git_log', { workspaceFolder, options: { refName: refs.base, path: null, skip: 0, limit: 1, search: null, author: null } }),
      ])
      setReviewBaseHead(basePage.commits[0]?.sha ?? null)
      setFiles(changed)
      if (changed[0]) setSelectedPath(changed[0].path)
    } catch (reason) { setError(String(reason)) } finally { setDiffLoading(false) }
  }, [hostingInfo.provider, workspaceFolder])

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (!selectedPath || !diffRefs) { setContents(null); return }
      setDiffLoading(true)
      void invoke<FileContents>('git_diff_refs_file', { workspaceFolder, baseRef: diffRefs.base, headRef: diffRefs.head, path: selectedPath })
        .then((next) => { if (!cancelled) setContents(next) })
        .catch((reason) => { if (!cancelled) setError(String(reason)) })
        .finally(() => { if (!cancelled) setDiffLoading(false) })
    }, 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [diffRefs, selectedPath, workspaceFolder])

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (!selectedPath || !reviewBaseHead || !detail?.headSha) { setReviewHunks(null); setSelectedReviewHunkId(null); return }
      void invoke<UnifiedFileDiff>('git_diff_hunks', { workspaceFolder, path: selectedPath, area: 'review', baseRef: reviewBaseHead, headRef: detail.headSha })
        .then((next) => {
          if (cancelled) return
          setReviewHunks(next)
          setSelectedReviewHunkId((current) => next.hunks.some((hunk) => hunk.id === current) ? current : next.hunks[0]?.id ?? null)
        })
        .catch((reason) => { if (!cancelled) setError(String(reason)) })
    }, 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [detail?.headSha, reviewBaseHead, selectedPath, workspaceFolder])

  useEffect(() => {
    const record = worktreeBySession(useWorkspaceStore.getState().worktreeProjections, sessionId)?.record
    if (!record || !reviewBaseHead || !detail?.headSha) return
    let cancelled = false
    void invoke<WorktreeReviewComment[]>('worktree_review_comments_list', { worktreeId: record.id })
      .then((comments) => { if (!cancelled) setProviderReviewComments(comments) })
      .catch((reason) => { if (!cancelled) setError(String(reason)) })
    return () => { cancelled = true }
  }, [detail?.headSha, reviewBaseHead, sessionId])

  const providerHeadSha = detail?.headSha ?? null
  const saveReviewComment = useCallback(async (body: string, side: 'hunk' | 'old' | 'new', line: number | null) => {
    const record = worktreeBySession(useWorkspaceStore.getState().worktreeProjections, sessionId)?.record
    if (!record || !reviewBaseHead || !providerHeadSha || !selectedPath || !selectedReviewHunkId) {
      setError('Import this checkout and load the exact provider diff before adding a review comment.')
      return
    }
    try {
      const saved = await invoke<WorktreeReviewComment>('worktree_review_comment_create', { request: { worktreeId: record.id, expectedInstanceId: record.instanceId, baseHead: reviewBaseHead, head: providerHeadSha, path: selectedPath, side, line, range: null, hunkId: selectedReviewHunkId, body } })
      setProviderReviewComments((current) => current.some((comment) => comment.id === saved.id) ? current.map((comment) => comment.id === saved.id ? saved : comment) : [...current, saved])
    } catch (reason) {
      setError(`Comment was not saved: ${String(reason)}`)
    }
  }, [providerHeadSha, reviewBaseHead, selectedPath, selectedReviewHunkId, sessionId])

  const commentReviewHunk = useCallback(() => {
    if (!selectedPath || !selectedReviewHunkId) return
    void promptDialog({ title: 'Comment on review hunk', message: selectedPath, label: 'Review comment', confirmLabel: 'Add comment' }).then((body) => { if (body) return saveReviewComment(body, 'hunk', null) })
  }, [saveReviewComment, selectedPath, selectedReviewHunkId])

  const commentReviewLine = useCallback((line: number, side: 'old' | 'new') => {
    if (!selectedPath || !selectedReviewHunkId) return
    void promptDialog({ title: `Comment on ${side} line ${line}`, message: selectedPath, label: 'Review comment', confirmLabel: 'Add comment' }).then((body) => { if (body) return saveReviewComment(body, side, line) })
  }, [saveReviewComment, selectedPath, selectedReviewHunkId])

  const checkpoint = useCallback(async (kind: 'pushed' | 'pr_opened' | 'merged', label: string, comment: string | null = null) => {
    const record = worktreeBySession(useWorkspaceStore.getState().worktreeProjections, sessionId)?.record
    if (!record) return
    try {
      await invoke('worktree_checkpoint_create', { request: { worktreeId: record.id, kind, label, comment } })
    } catch (reason) {
      setCheckpointWarning(`Provider action succeeded, but its ${kind} checkpoint was not saved: ${String(reason)}`)
    }
  }, [sessionId])

  const pushBranch = useCallback(async () => {
    if (!sourceBranch) return
    setLoading(true)
    try {
      await invoke('git_push', { workspaceFolder, remote: 'origin', branch: sourceBranch, setUpstream: true, forceWithLease: false })
      await checkpoint('pushed', sourceBranch)
      await onHostingChanged()
      await onRepositoryChanged()
    } catch (reason) { setError(String(reason)) } finally { setLoading(false) }
  }, [checkpoint, onHostingChanged, onRepositoryChanged, sourceBranch, workspaceFolder])

  const createPr = useCallback(async () => {
    if (!sourceBranch) return
    setLoading(true)
    setError(null)
    try {
      const result = await invoke<PrCreated>('hosting_pr_create', { workspaceFolder, request: { title: createTitle.trim(), body: createBody, sourceBranch, targetBranch: createTarget, draft: createDraft } })
      setCreated(result)
      await checkpoint('pr_opened', `#${result.number}`, result.url)
      setMode('list')
      await loadPrs()
    } catch (reason) {
      setError(String(reason))
      if (String(reason).includes('AUTH:')) await onHostingChanged()
    } finally { setLoading(false) }
  }, [checkpoint, createBody, createDraft, createTarget, createTitle, loadPrs, onHostingChanged, sourceBranch, workspaceFolder])

  const mergeAndCleanup = useCallback(async () => {
    if (!detail?.headSha) { setError('Merge blocked: provider head SHA is unavailable.'); return }
    const choice = await choiceDialog({
      title: `Merge #${detail.number} and clean up`,
      message: `Merge #${detail.number}: ${detail.sourceBranch} → ${detail.targetBranch} at ${detail.headSha}, then remove this worktree checkout and local branch? VibeLink will fail closed if the local HEAD, upstream, conflicts, or required CI do not match provider state.`,
      choices: [{ id: 'merge-cleanup', label: 'Merge and clean up', tone: 'danger' }],
      cancelLabel: 'Cancel',
    })
    if (!choice) return
    setLoading(true)
    setError(null)
    try {
      const result = await invoke<MergePrResult>('hosting_pr_merge', { workspaceFolder, request: { number: detail.number, expectedHeadSha: detail.headSha } })
      await checkpoint('merged', `#${result.number}`, result.mergeSha ?? result.message)
      const workspaceState = useWorkspaceStore.getState()
      const worktree = worktreeBySession(workspaceState.worktreeProjections, sessionId)?.record
      if (!worktree) throw new Error('Merge succeeded, but this checkout is not registered for safe cleanup.')
      const preflight = await workspaceState.preflightWorktreeRemoval(worktree.id, true)
      const hardBlockers = preflight.blockers.filter((blocker) => blocker.hard)
      if (hardBlockers.length > 0) throw new Error(`Merge succeeded, but cleanup is blocked: ${hardBlockers.map((blocker) => blocker.message).join('; ')}`)
      const acknowledgedBlockers = preflight.blockers.filter((blocker) => !blocker.hard).map((blocker) => blocker.kind)
      if (acknowledgedBlockers.length > 0) {
        const cleanupChoice = await choiceDialog({
          title: 'Merge complete — confirm worktree cleanup',
          message: `The merge succeeded. Cleanup currently reports: ${preflight.blockers.map((blocker) => blocker.message).join('; ')}${preflight.warnings.length > 0 ? ` Warnings: ${preflight.warnings.join('; ')}` : ''}`,
          choices: [{ id: 'cleanup', label: 'Acknowledge and clean up', tone: 'danger' }],
          cancelLabel: 'Keep worktree',
        })
        if (!cleanupChoice) {
          setCheckpointWarning(`Merge succeeded; cleanup was deferred: ${preflight.blockers.map((blocker) => blocker.message).join('; ')}`)
          return
        }
      }
      const cleanup = await workspaceState.removeWorktreeSession(sessionId, { deleteBranch: true, acknowledgedBlockers, providerMergedHead: result.headSha })
      if (!cleanup.branchDeleted) {
        await choiceDialog({ title: 'Merge complete — branch preserved', message: cleanup.branchPreservedReason ?? 'The local branch was preserved for safety.', choices: [{ id: 'acknowledge', label: 'OK' }] })
      }
    } catch (reason) {
      const message = String(reason)
      if (message.includes('conflicts remain')) {
        useGitStore.getState().setActiveTab(sessionId, 'changes')
        await onRepositoryChanged().catch(() => undefined)
      }
      await loadPrs().catch(() => undefined)
      setError(message)
    } finally { setLoading(false) }
  }, [checkpoint, detail, loadPrs, onRepositoryChanged, sessionId, workspaceFolder])

  const openUrl = useCallback((url: string) => { void invoke('open_path', { path: url }) }, [])
  const copyUrl = useCallback((url: string) => { void navigator.clipboard.writeText(url) }, [])
  const deviceView = useMemo(() => deviceCode ? { userCode: deviceCode.userCode, verificationUri: deviceCode.verificationUri } : null, [deviceCode])
  const visibleError = error ?? checkpointWarning ?? hostingError
  const selectedReviewComments = useMemo(() => {
    const record = worktreeBySession(useWorkspaceStore.getState().worktreeProjections, sessionId)?.record
    if (!record || !reviewBaseHead || !providerHeadSha || !selectedPath || !selectedReviewHunkId) return []
    return providerReviewComments.filter((comment) => comment.worktreeId === record.id && comment.instanceId === record.instanceId && comment.baseHead === reviewBaseHead && comment.head === providerHeadSha && comment.path === selectedPath && comment.hunkId === selectedReviewHunkId && reviewHunks?.hunks.some((hunk) => hunk.id === comment.hunkId))
  }, [providerHeadSha, providerReviewComments, reviewBaseHead, reviewHunks?.hunks, selectedPath, selectedReviewHunkId, sessionId])

  return <PullRequestsTabView provider={hostingInfo.provider} host={hostingInfo.host} tokenPresent={hostingInfo.tokenPresent} loading={loading} error={visibleError} prs={prs} ciByNumber={ciByNumber} selectedNumber={selectedNumber} detail={detail} files={files} selectedPath={selectedPath} contents={contents} diffLoading={diffLoading} reviewHunks={reviewHunks} selectedReviewHunkId={selectedReviewHunkId} reviewHunkComments={selectedReviewComments} mode={mode} token={token} deviceCode={deviceView} created={created} createTitle={createTitle} createBody={createBody} createTarget={createTarget} createTargets={createTargets} createDraft={createDraft} sourceBranch={sourceBranch} needsPush={!repoInfo.upstream} onRefresh={() => { void loadPrs() }} onTokenChange={setToken} onSaveToken={() => { void saveToken() }} onDeviceSignIn={() => { void startDeviceSignIn() }} onOpenUrl={openUrl} onCopyUrl={copyUrl} onSelectPr={(number) => { void selectPr(number) }} onSelectFile={(path) => { setSelectedPath(path); onRevealFile?.(path) }} onSelectReviewHunk={setSelectedReviewHunkId} onCommentReviewHunk={commentReviewHunk} onCommentReviewLine={commentReviewLine} onModeChange={setMode} onCreateTitleChange={setCreateTitle} onCreateBodyChange={setCreateBody} onCreateTargetChange={setCreateTarget} onCreateDraftChange={setCreateDraft} onPushBranch={() => { void pushBranch() }} onCreate={() => { void createPr() }} onMergeAndCleanup={() => { void mergeAndCleanup() }} />
}

function branchTargets(branches: BranchInfo[]): string[] {
  const names = branches.filter((branch) => branch.isRemote && branch.name.startsWith('origin/') && branch.name !== 'origin/HEAD').map((branch) => branch.name.slice('origin/'.length))
  const unique = [...new Set(names)]
  unique.sort((left, right) => Number(right === 'main') - Number(left === 'main') || Number(right === 'master') - Number(left === 'master') || left.localeCompare(right))
  return unique.length > 0 ? unique : ['main']
}
