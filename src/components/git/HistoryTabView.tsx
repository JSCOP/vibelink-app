import { useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { GitBranch, GitCommitHorizontal, GitCompare, History, Loader2, Search, Tag, User, X } from 'lucide-react'
import type { ChangedFile, CommitDetail, CommitInfo, FileContents } from '../../ipc/types'
import type { GraphLanes } from './graphLanes'
import { DiffPane } from './DiffPane'

export type HistoryTabViewProps = {
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
  onSearchChange: (value: string) => void
  onAuthorChange: (value: string) => void
  onClearPathFilter: () => void
  onSelectCommit: (sha: string) => void
  onLoadMore: () => void
  onSelectFile: (path: string) => void
  onCopySha: () => void
  onCompareHead: () => void
  onCreateBranch: () => void
  onCreateTag: () => void
}

const ROW_HEIGHT = 42
const LANE_STEP = 14
const LANE_PAD = 9

type EdgeSpan = {
  fromLane: number
  toLane: number
  fromIndex: number
  toIndex: number
}

function laneX(lane: number): number {
  return lane * LANE_STEP + LANE_PAD
}

function laneColor(lane: number): string {
  return `var(--vibelink-graph-${(lane % 8) + 1})`
}

function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`
  const mid = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`
}

function parseRef(ref: string): { label: string; kind: 'head' | 'tag' | 'ref' } {
  if (ref.startsWith('tag: ')) return { label: ref.slice(5), kind: 'tag' }
  if (ref.startsWith('HEAD -> ')) return { label: ref.slice(8), kind: 'head' }
  if (ref.includes('HEAD')) return { label: ref, kind: 'head' }
  return { label: ref, kind: 'ref' }
}

export function HistoryTabView({ commits, graph, hasMore, loading, error, search, author, pathFilter, selectedSha, detail, detailLoading, compareMode, compareFiles, selectedPath, contents, contentsLoading, contentsError, onSearchChange, onAuthorChange, onClearPathFilter, onSelectCommit, onLoadMore, onSelectFile, onCopySha, onCompareHead, onCreateBranch, onCreateTag }: HistoryTabViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // TanStack Virtual intentionally exposes non-memoizable functions; this component is not compiler-memoized.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({ count: commits.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_HEIGHT, overscan: 12 })
  const virtualItems = virtualizer.getVirtualItems()
  const rows = virtualItems.length > 0
    ? virtualItems
    : commits.map((_, index) => ({ index, key: index, start: index * ROW_HEIGHT, size: ROW_HEIGHT, end: (index + 1) * ROW_HEIGHT, lane: 0 }))

  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1]
    if (hasMore && !loading && last && last.index >= commits.length - 8) onLoadMore()
  }, [commits.length, hasMore, loading, onLoadMore, virtualItems])

  const shaIndex = useMemo(() => {
    const map = new Map<string, number>()
    commits.forEach((commit, index) => map.set(commit.sha, index))
    return map
  }, [commits])

  const edgeSpans = useMemo<EdgeSpan[]>(() => graph.edges.map((edge) => ({
    fromLane: edge.fromLane,
    toLane: edge.toLane,
    fromIndex: shaIndex.get(edge.fromSha) ?? -1,
    toIndex: shaIndex.get(edge.toSha) ?? Number.MAX_SAFE_INTEGER,
  })), [graph, shaIndex])

  const graphWidth = Math.max(26, (graph.laneCount - 1) * LANE_STEP + LANE_PAD * 2)
  const filtersActive = search !== '' || author !== '' || pathFilter !== null
  const files = compareMode ? compareFiles : detail?.files ?? []
  const committerDiffers = detail !== null && (detail.committerName !== detail.authorName || detail.committerDate !== detail.authorDate)

  const renderGraphCell = (index: number, commit: CommitInfo, height: number) => {
    const lane = graph.laneOf.get(commit.sha) ?? 0
    const cx = laneX(lane)
    const mid = height / 2
    const passLanes = new Set<number>()
    const incoming: EdgeSpan[] = []
    const outgoing: EdgeSpan[] = []
    for (const span of edgeSpans) {
      if (span.fromIndex === index) outgoing.push(span)
      else if (span.toIndex === index) incoming.push(span)
      else if (span.fromIndex < index && index < span.toIndex) passLanes.add(span.toLane)
    }
    const isMerge = commit.parents.length > 1
    const isHead = commit.refs.some((ref) => ref.includes('HEAD'))
    return (
      <svg className="git-history-graph" width={graphWidth} height={height} aria-hidden="true">
        {[...passLanes].map((passLane) => (
          <line key={`pass-${passLane}`} x1={laneX(passLane)} y1={0} x2={laneX(passLane)} y2={height} stroke={laneColor(passLane)} />
        ))}
        {incoming.map((span, edgeIndex) => (
          <path key={`in-${edgeIndex}`} d={edgePath(laneX(span.toLane), 0, cx, mid)} stroke={laneColor(span.toLane)} fill="none" />
        ))}
        {outgoing.map((span, edgeIndex) => (
          <path key={`out-${edgeIndex}`} d={edgePath(cx, mid, laneX(span.toLane), height)} stroke={laneColor(span.toLane)} fill="none" />
        ))}
        {isHead ? <circle cx={cx} cy={mid} r={6} fill="none" stroke={laneColor(lane)} opacity={0.45} /> : null}
        {isMerge
          ? <circle cx={cx} cy={mid} r={3.5} fill="var(--vibelink-bg)" stroke={laneColor(lane)} strokeWidth={1.5} />
          : <circle cx={cx} cy={mid} r={3.5} fill={laneColor(lane)} />}
      </svg>
    )
  }

  return (
    <section className="git-history-tab" data-git-history="true">
      <div className="git-history-list-pane">
        <header className="git-history-filters">
          <label className="git-history-filter-input git-history-search">
            <Search size={13} aria-hidden="true" />
            <input aria-label="Search commits" value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search commits" spellCheck={false} />
            {search !== '' ? (
              <button type="button" className="git-history-filter-clear" aria-label="Clear search" onClick={() => onSearchChange('')}><X size={11} /></button>
            ) : null}
          </label>
          <label className="git-history-filter-input git-history-author">
            <User size={13} aria-hidden="true" />
            <input aria-label="Filter by author" value={author} onChange={(event) => onAuthorChange(event.target.value)} placeholder="Author" spellCheck={false} />
            {author !== '' ? (
              <button type="button" className="git-history-filter-clear" aria-label="Clear author filter" onClick={() => onAuthorChange('')}><X size={11} /></button>
            ) : null}
          </label>
          {pathFilter ? (
            <button type="button" className="git-history-filter-chip" onClick={onClearPathFilter} title={`Showing history for ${pathFilter} — click to clear`}>
              <span>{pathFilter}</span>
              <X size={12} aria-hidden="true" />
            </button>
          ) : null}
        </header>
        {error ? <div className="git-window-error">{error}</div> : null}
        <div ref={scrollRef} className="git-history-scroll">
          <div className="git-history-virtual" style={{ height: `${virtualizer.getTotalSize() || commits.length * ROW_HEIGHT}px` }}>
            {rows.map((virtualRow) => {
              const commit = commits[virtualRow.index]
              if (!commit) return null
              return (
                <button
                  key={commit.sha}
                  type="button"
                  className="git-history-row"
                  data-selected={selectedSha === commit.sha || undefined}
                  style={{ height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)` }}
                  onClick={() => onSelectCommit(commit.sha)}
                >
                  {renderGraphCell(virtualRow.index, commit, virtualRow.size)}
                  <span className="git-history-row-main">
                    <span className="git-history-row-subject">
                      {commit.refs.length > 0 ? (
                        <span className="git-history-refs">
                          {commit.refs.map((ref) => {
                            const parsed = parseRef(ref)
                            return (
                              <span key={ref} data-head={parsed.kind === 'head' || undefined} data-tag={parsed.kind === 'tag' || undefined} title={ref}>
                                {parsed.kind === 'tag' ? <Tag size={9} aria-hidden="true" /> : <GitBranch size={9} aria-hidden="true" />}
                                {parsed.label}
                              </span>
                            )
                          })}
                        </span>
                      ) : null}
                      <strong>{commit.subject}</strong>
                    </span>
                    <small>
                      <code>{commit.sha.slice(0, 7)}</code>
                      <span className="git-history-row-author" title={commit.authorEmail}>{commit.authorName}</span>
                      <span className="git-history-row-date">{relativeDate(commit.authorDate)}</span>
                    </small>
                  </span>
                </button>
              )
            })}
          </div>
          {loading && commits.length === 0 ? (
            <div className="git-history-skeletons" aria-hidden="true">
              {Array.from({ length: 7 }, (_, index) => (
                <div key={index} className="git-history-skeleton-row">
                  <span className="git-history-skeleton-dot" />
                  <span className="git-history-skeleton-lines">
                    <span style={{ width: `${62 - (index % 4) * 9}%` }} />
                    <span style={{ width: `${34 - (index % 3) * 5}%` }} />
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {commits.length === 0 && !loading ? (
            <div className="git-history-empty">
              <History size={20} aria-hidden="true" />
              <p>No commits found.</p>
              {filtersActive ? <small>Try clearing the search, author, or path filters.</small> : <small>Commits will appear here once the repository has history.</small>}
            </div>
          ) : null}
          {hasMore ? (
            <button type="button" className="git-history-load-more" onClick={onLoadMore} disabled={loading}>
              {loading ? <><Loader2 size={12} className="git-history-spin" aria-hidden="true" /> Loading…</> : 'Load more'}
            </button>
          ) : null}
        </div>
      </div>
      <div className="git-window-main-divider" role="separator" aria-orientation="vertical" />
      <aside className="git-history-detail">
        {detailLoading ? (
          <div className="git-history-detail-placeholder">
            <Loader2 size={18} className="git-history-spin" aria-hidden="true" />
            <p>Loading commit…</p>
          </div>
        ) : null}
        {!detailLoading && detail ? (
          <>
            <header className="git-history-detail-header">
              <div className="git-history-detail-title">
                <GitCommitHorizontal size={14} aria-hidden="true" />
                <code title={detail.sha}>{detail.sha.slice(0, 12)}</code>
                {compareMode ? <span className="git-history-compare-chip"><GitCompare size={11} aria-hidden="true" /> vs HEAD</span> : null}
                <span className="git-history-detail-files">{files.length} {files.length === 1 ? 'file' : 'files'}</span>
              </div>
              <dl className="git-history-detail-meta">
                <div>
                  <dt>Author</dt>
                  <dd title={detail.authorEmail}>{detail.authorName} · {relativeDate(detail.authorDate)}</dd>
                </div>
                {committerDiffers ? (
                  <div>
                    <dt>Committed</dt>
                    <dd>{detail.committerName} · {relativeDate(detail.committerDate)}</dd>
                  </div>
                ) : null}
              </dl>
              <div className="git-history-detail-actions">
                <button type="button" onClick={onCopySha}>Copy SHA</button>
                <button type="button" onClick={onCompareHead}><GitCompare size={13} aria-hidden="true" /> Compare with HEAD</button>
                <button type="button" onClick={onCreateBranch}><GitBranch size={13} aria-hidden="true" /> Create branch here</button>
                <button type="button" onClick={onCreateTag}><Tag size={13} aria-hidden="true" /> Create tag here</button>
              </div>
            </header>
            {detail.body ? <pre className="git-history-body">{detail.body}</pre> : null}
            <DiffPane files={files} selectedPath={selectedPath} onSelect={onSelectFile} contents={contents} loading={contentsLoading} splitView error={contentsError} />
          </>
        ) : null}
        {!detailLoading && !detail ? (
          <div className="git-history-detail-placeholder">
            <GitCommitHorizontal size={20} aria-hidden="true" />
            <p>Select a commit to inspect it.</p>
            <small>Browse the graph, search subjects, or filter by author.</small>
          </div>
        ) : null}
      </aside>
    </section>
  )
}

function relativeDate(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(elapsed)) return value
  const minutes = Math.max(0, Math.floor(elapsed / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days < 30 ? `${days}d ago` : new Date(value).toLocaleDateString()
}
