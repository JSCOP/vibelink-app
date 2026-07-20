import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangedFile, CommitDetail, CommitInfo, FileContents, LogPage } from '../../ipc/types'
import { useGitStore } from '../../state/git'
import { computeGraphLanes } from './graphLanes'
import { HistoryTabView } from './HistoryTabView'

export type HistoryTabProps = {
  sessionId: string
  workspaceFolder: string
  pathFilter: string | null
  onRunMutation: (operation: () => Promise<unknown>) => Promise<void>
}

export function HistoryTab({ sessionId, workspaceFolder, pathFilter, onRunMutation }: HistoryTabProps) {
  const [commits, setCommits] = useState<CommitInfo[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [author, setAuthor] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [debouncedAuthor, setDebouncedAuthor] = useState('')
  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [detail, setDetail] = useState<CommitDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [compareMode, setCompareMode] = useState(false)
  const [compareFiles, setCompareFiles] = useState<ChangedFile[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [contents, setContents] = useState<FileContents | null>(null)
  const [contentsLoading, setContentsLoading] = useState(false)
  const [contentsError, setContentsError] = useState<string | null>(null)
  const requestGeneration = useRef(0)
  const loadPageRef = useRef<(reset: boolean) => Promise<void>>(async () => {})
  const setActiveTab = useGitStore((state) => state.setActiveTab)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 400)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedAuthor(author.trim()), 400)
    return () => window.clearTimeout(timer)
  }, [author])

  const loadPage = useCallback(async (reset: boolean) => {
    const generation = reset ? requestGeneration.current + 1 : requestGeneration.current
    if (reset) requestGeneration.current = generation
    setLoading(true)
    setError(null)
    try {
      const page = await invoke<LogPage>('git_log', {
        workspaceFolder,
        options: {
          refName: null,
          path: pathFilter,
          skip: reset ? 0 : commits.length,
          limit: 200,
          search: debouncedSearch || null,
          author: debouncedAuthor || null,
        },
      })
      if (requestGeneration.current !== generation) return
      setCommits((current) => reset ? page.commits : [...current, ...page.commits])
      setHasMore(page.hasMore)
      if (reset) {
        setSelectedSha(null)
        setDetail(null)
        setSelectedPath(null)
        setContents(null)
      }
    } catch (reason) {
      if (requestGeneration.current === generation) setError(String(reason))
    } finally {
      if (requestGeneration.current === generation) setLoading(false)
    }
  }, [commits.length, debouncedAuthor, debouncedSearch, pathFilter, workspaceFolder])

  useEffect(() => { loadPageRef.current = loadPage }, [loadPage])
  useEffect(() => {
    const timer = window.setTimeout(() => { void loadPageRef.current(true) }, 0)
    return () => window.clearTimeout(timer)
  }, [debouncedAuthor, debouncedSearch, pathFilter, workspaceFolder])

  const selectCommit = useCallback((sha: string) => {
    setSelectedSha(sha)
    setDetailLoading(true)
    setCompareMode(false)
    setCompareFiles([])
    setSelectedPath(null)
    setContents(null)
    void invoke<CommitDetail>('git_commit_detail', { workspaceFolder, sha })
      .then((next) => {
        setDetail(next)
        setSelectedPath(next.files[0]?.path ?? null)
      })
      .catch((reason) => setError(String(reason)))
      .finally(() => setDetailLoading(false))
  }, [workspaceFolder])

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (!selectedSha || !selectedPath) { setContents(null); return }
      setContentsLoading(true)
      setContentsError(null)
      const command = compareMode ? 'git_diff_refs_file' : 'git_commit_file_contents'
      const args = compareMode
        ? { workspaceFolder, baseRef: selectedSha, headRef: 'HEAD', path: selectedPath }
        : { workspaceFolder, sha: selectedSha, path: selectedPath }
      void invoke<FileContents>(command, args)
        .then((next) => { if (!cancelled) setContents(next) })
        .catch((reason) => {
          if (!cancelled) { setContents(null); setContentsError(String(reason)) }
        })
        .finally(() => { if (!cancelled) setContentsLoading(false) })
    }, 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [compareMode, selectedPath, selectedSha, workspaceFolder])

  const compareHead = useCallback(() => {
    if (!selectedSha) return
    setContentsLoading(true)
    void invoke<ChangedFile[]>('git_diff_refs', { workspaceFolder, baseRef: selectedSha, headRef: 'HEAD' })
      .then((files) => {
        setCompareMode(true)
        setCompareFiles(files)
        setSelectedPath(files[0]?.path ?? null)
        setContents(null)
      })
      .catch((reason) => setContentsError(String(reason)))
      .finally(() => setContentsLoading(false))
  }, [selectedSha, workspaceFolder])

  const createBranch = useCallback(() => {
    if (!selectedSha) return
    const name = window.prompt('Branch name')?.trim()
    if (!name) return
    void onRunMutation(() => invoke('git_branch_create', { workspaceFolder, name, fromRef: selectedSha, checkout: false })).catch(() => {})
  }, [onRunMutation, selectedSha, workspaceFolder])

  const createTag = useCallback(() => {
    if (!selectedSha) return
    const name = window.prompt('Tag name')?.trim()
    if (!name) return
    const message = window.prompt('Annotation message (leave empty for lightweight tag)')?.trim() ?? ''
    void onRunMutation(() => invoke('git_tag_create', { workspaceFolder, name, refName: selectedSha, message: message || null })).catch(() => {})
  }, [onRunMutation, selectedSha, workspaceFolder])

  const graph = useMemo(() => computeGraphLanes(commits), [commits])

  return (
    <HistoryTabView
      commits={commits}
      graph={graph}
      hasMore={hasMore}
      loading={loading}
      error={error}
      search={search}
      author={author}
      pathFilter={pathFilter}
      selectedSha={selectedSha}
      detail={detail}
      detailLoading={detailLoading}
      compareMode={compareMode}
      compareFiles={compareFiles}
      selectedPath={selectedPath}
      contents={contents}
      contentsLoading={contentsLoading}
      contentsError={contentsError}
      onSearchChange={setSearch}
      onAuthorChange={setAuthor}
      onClearPathFilter={() => setActiveTab(sessionId, 'history', null)}
      onSelectCommit={selectCommit}
      onLoadMore={() => { if (!loading && hasMore) void loadPage(false) }}
      onSelectFile={setSelectedPath}
      onCopySha={() => { if (selectedSha) void navigator.clipboard.writeText(selectedSha) }}
      onCompareHead={compareHead}
      onCreateBranch={createBranch}
      onCreateTag={createTag}
    />
  )
}
