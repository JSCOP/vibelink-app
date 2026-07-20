import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BranchInfo, ChangedFile, CiStatus, DeviceCodeInfo, FileContents, HostingInfo, LogPage, PrCreated, PrDetail, PrInfo, RepoInfo } from '../../ipc/types'
import { PullRequestsTabView } from './PullRequestsTabView'

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

export function PullRequestsTab({ workspaceFolder, repoInfo, hostingInfo, hostingError, onHostingChanged, onRepositoryChanged, onRevealFile }: PullRequestsTabProps) {
  const [prs, setPrs] = useState<PrInfo[]>([])
  const [ciByNumber, setCiByNumber] = useState<Record<number, CiStatus>>({})
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null)
  const [detail, setDetail] = useState<PrDetail | null>(null)
  const [files, setFiles] = useState<ChangedFile[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [contents, setContents] = useState<FileContents | null>(null)
  const [diffRefs, setDiffRefs] = useState<{ base: string; head: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [diffLoading, setDiffLoading] = useState(false)
  const [error, setError] = useState<string | null>(hostingError)
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
      const changed = await invoke<ChangedFile[]>('git_diff_refs', { workspaceFolder, baseRef: refs.base, headRef: refs.head })
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

  const pushBranch = useCallback(async () => {
    if (!sourceBranch) return
    setLoading(true)
    try {
      await invoke('git_push', { workspaceFolder, remote: 'origin', branch: sourceBranch, setUpstream: true, forceWithLease: false })
      await onHostingChanged()
      await onRepositoryChanged()
    } catch (reason) { setError(String(reason)) } finally { setLoading(false) }
  }, [onHostingChanged, onRepositoryChanged, sourceBranch, workspaceFolder])

  const createPr = useCallback(async () => {
    if (!sourceBranch) return
    setLoading(true)
    setError(null)
    try {
      const result = await invoke<PrCreated>('hosting_pr_create', { workspaceFolder, request: { title: createTitle.trim(), body: createBody, sourceBranch, targetBranch: createTarget, draft: createDraft } })
      setCreated(result)
      setMode('list')
      await loadPrs()
    } catch (reason) {
      setError(String(reason))
      if (String(reason).includes('AUTH:')) await onHostingChanged()
    } finally { setLoading(false) }
  }, [createBody, createDraft, createTarget, createTitle, loadPrs, onHostingChanged, sourceBranch, workspaceFolder])

  const openUrl = useCallback((url: string) => { void invoke('open_path', { path: url }) }, [])
  const copyUrl = useCallback((url: string) => { void navigator.clipboard.writeText(url) }, [])
  const deviceView = useMemo(() => deviceCode ? { userCode: deviceCode.userCode, verificationUri: deviceCode.verificationUri } : null, [deviceCode])
  const visibleError = error ?? hostingError

  return <PullRequestsTabView provider={hostingInfo.provider} host={hostingInfo.host} tokenPresent={hostingInfo.tokenPresent} loading={loading} error={visibleError} prs={prs} ciByNumber={ciByNumber} selectedNumber={selectedNumber} detail={detail} files={files} selectedPath={selectedPath} contents={contents} diffLoading={diffLoading} mode={mode} token={token} deviceCode={deviceView} created={created} createTitle={createTitle} createBody={createBody} createTarget={createTarget} createTargets={createTargets} createDraft={createDraft} sourceBranch={sourceBranch} needsPush={!repoInfo.upstream} onRefresh={() => { void loadPrs() }} onTokenChange={setToken} onSaveToken={() => { void saveToken() }} onDeviceSignIn={() => { void startDeviceSignIn() }} onOpenUrl={openUrl} onCopyUrl={copyUrl} onSelectPr={(number) => { void selectPr(number) }} onSelectFile={(path) => { setSelectedPath(path); onRevealFile?.(path) }} onModeChange={setMode} onCreateTitleChange={setCreateTitle} onCreateBodyChange={setCreateBody} onCreateTargetChange={setCreateTarget} onCreateDraftChange={setCreateDraft} onPushBranch={() => { void pushBranch() }} onCreate={() => { void createPr() }} />
}

function branchTargets(branches: BranchInfo[]): string[] {
  const names = branches.filter((branch) => branch.isRemote && branch.name.startsWith('origin/') && branch.name !== 'origin/HEAD').map((branch) => branch.name.slice('origin/'.length))
  const unique = [...new Set(names)]
  unique.sort((left, right) => Number(right === 'main') - Number(left === 'main') || Number(right === 'master') - Number(left === 'master') || left.localeCompare(right))
  return unique.length > 0 ? unique : ['main']
}
