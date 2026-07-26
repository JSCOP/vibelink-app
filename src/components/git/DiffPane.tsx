import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'
import type { ChangedFile, FileContents } from '../../ipc/types'
import { buildDiffHighlightMap, expandDiffTabs, type DiffHighlightMap } from './diffSyntaxHighlight'
import { gitChangeMeta } from '../../state/gitChangeMeta'
import { useWorkspaceStore } from '../../state/store'

export type DiffPaneProps = {
  files: ChangedFile[]
  selectedPath: string | null
  onSelect: (path: string) => void
  contents: FileContents | null
  loading: boolean
  splitView: boolean
  title?: string
  error?: string | null
  onOpenInEditor?: (() => void) | null
  hideFileList?: boolean
}

const MIN_SPLIT_DIFF_WIDTH = 900
const MAX_RENDERED_DIFF_CHARACTERS = 512 * 1024
const MAX_RENDERED_DIFF_LINES = 20_000

export function DiffPane({ files, selectedPath, onSelect, contents, loading, splitView, title, error = null, onOpenInEditor = null, hideFileList = false }: DiffPaneProps) {
  const [listWidth, setListWidth] = useState(260)
  const [contentWidth, setContentWidth] = useState<number | null>(null)
  const contentRef = useRef<HTMLElement | null>(null)
  const [highlightState, setHighlightState] = useState<{ contents: FileContents | null; path: string | null; themeId: string; map: DiffHighlightMap | null } | null>(null)
  const terminalThemeId = useWorkspaceStore((state) => state.settings.terminalThemeId)

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = listWidth
    const move = (moveEvent: PointerEvent) => setListWidth(Math.max(180, Math.min(520, startWidth + moveEvent.clientX - startX)))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const measure = () => {
      const width = Math.round(content.getBoundingClientRect().width)
      setContentWidth((current) => current === width ? current : width)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  // Line endings and tabs are normalized once, before diffing, highlighting, or
  // rendering. CRLF checkouts would otherwise mark every line changed, and a
  // raw tab is one character to the word-diff overlay but `tabSize` rendered
  // columns to Monaco, which knocked every later highlight on the line out of
  // alignment onto partial words.
  const normalizedContents = useMemo(() => {
    if (!contents || contents.binary) return contents
    const normalize = (value: string) => expandDiffTabs(value.includes('\r') ? value.replace(/\r\n?/g, '\n') : value)
    return { ...contents, old: normalize(contents.old), new: normalize(contents.new) }
  }, [contents])
  const renderLimitExceeded = useMemo(
    () => Boolean(normalizedContents && !normalizedContents.binary && diffExceedsRenderLimit(normalizedContents.old, normalizedContents.new)),
    [normalizedContents],
  )
  const highlightMap = highlightState
    && highlightState.contents === normalizedContents
    && highlightState.path === selectedPath
    && highlightState.themeId === terminalThemeId
    ? highlightState.map
    : null

  useEffect(() => {
    if (renderLimitExceeded) return
    let cancelled = false
    const old = normalizedContents && !normalizedContents.binary ? normalizedContents.old : ''
    const next = normalizedContents && !normalizedContents.binary ? normalizedContents.new : ''
    void buildDiffHighlightMap(selectedPath, old, next, terminalThemeId).then((map) => {
      if (!cancelled) setHighlightState({ contents: normalizedContents, path: selectedPath, themeId: terminalThemeId, map })
    })
    return () => { cancelled = true }
  }, [normalizedContents, renderLimitExceeded, selectedPath, terminalThemeId])

  const renderContent = useMemo(() => {
    if (!highlightMap) return undefined
    return (source: string): ReactElement => {
      const html = highlightMap.get(source)
      return html !== undefined
        ? <span className="git-diff-code" dangerouslySetInnerHTML={{ __html: html }} />
        : <span className="git-diff-code">{source}</span>
    }
  }, [highlightMap])

  const effectiveSplitView = splitView && (contentWidth === null || contentWidth >= MIN_SPLIT_DIFF_WIDTH)

  const showSelectHint = hideFileList && !selectedPath
  const noDifferences = Boolean(normalizedContents && !normalizedContents.binary && normalizedContents.old === normalizedContents.new)
  const noFiles = !hideFileList && files.length === 0 && !selectedPath
  const noContents = !loading && !error && !contents && !showSelectHint && !noFiles && !renderLimitExceeded

  return (
    <div className="task-diff-view git-diff-pane" data-file-list-hidden={hideFileList || undefined} style={{ '--file-list-width': `${listWidth}px` } as CSSProperties}>
      {!hideFileList ? (
        <>
          <aside className="task-diff-files git-diff-files">
            {title ? <h3>{title}</h3> : null}
            {error ? <div className="kanban-error">{error}</div> : null}
            {files.map((file) => {
              const meta = gitChangeMeta[file.changeType]
              const slash = file.path.lastIndexOf('/')
              const basename = slash >= 0 ? file.path.slice(slash + 1) : file.path
              const parent = slash >= 0 ? file.path.slice(0, slash) : ''
              return (
                <button
                  key={`${file.changeType}:${file.path}`}
                  type="button"
                  data-selected={selectedPath === file.path || undefined}
                  data-change-type={file.changeType}
                  title={`${meta.word} — ${meta.explanation}\n${file.oldPath ? `${file.path} (from ${file.oldPath})` : file.path}`}
                  aria-label={`${meta.word}: ${file.path}`}
                  onClick={() => onSelect(file.path)}
                >
                  <span className="task-diff-file-badge" aria-hidden="true">{meta.letter}</span>
                  <strong>{basename}</strong>
                  {parent ? <small>{parent}</small> : null}
                </button>
              )
            })}
          </aside>
          <div className="task-diff-resizer git-diff-resizer" role="separator" aria-orientation="vertical" onPointerDown={startResize} />
        </>
      ) : null}
      <main ref={contentRef} className="task-diff-content git-diff-content" data-diff-layout={effectiveSplitView ? 'split' : 'unified'}>
        {loading ? <div className="task-diff-empty git-diff-empty">Loading diff…</div> : null}
        {!loading && normalizedContents?.binary ? <div className="task-diff-empty git-diff-empty">binary — not shown</div> : null}
        {!loading && error && !contents ? (
          <div className="task-diff-empty git-diff-empty">
            {error}
            {onOpenInEditor ? <button type="button" onClick={onOpenInEditor}>Open in editor</button> : null}
          </div>
        ) : null}
        {!loading && !error && renderLimitExceeded ? (
          <div className="task-diff-empty git-diff-empty">
            Diff is too large to render safely. Narrow the comparison or open the file from Explorer.
            {onOpenInEditor ? <button type="button" onClick={onOpenInEditor}>Open in editor</button> : null}
          </div>
        ) : null}
        {!loading && !error && noDifferences ? <div className="task-diff-empty git-diff-empty">No differences to show.</div> : null}
        {!loading && !error && noFiles ? <div className="task-diff-empty git-diff-empty">No changed files.</div> : null}
        {!loading && !error && !contents && showSelectHint ? (
          <div className="task-diff-empty git-diff-empty">Select a file to view its diff.</div>
        ) : null}
        {noContents ? <div className="task-diff-empty git-diff-empty">No diff available for this file.</div> : null}
        {!loading && normalizedContents && !normalizedContents.binary && !noDifferences && !renderLimitExceeded ? (
          // Word-level, not the library default `DiffMethod.CHARS`: character
          // diffing highlighted the shared letters inside unrelated identifiers
          // (`browser`/`editor` painting `brows`, `e`, `tor`), which reads as
          // noise. WORDS_WITH_SPACE keeps whitespace in the chunks, so the
          // reconstructed line is byte-identical to the source and the
          // syntax-highlight overlay stays aligned.
          <ReactDiffViewer oldValue={normalizedContents.old} newValue={normalizedContents.new} splitView={effectiveSplitView} compareMethod={DiffMethod.WORDS_WITH_SPACE} useDarkTheme styles={diffStyles} renderContent={renderContent} />
        ) : null}
      </main>
    </div>
  )
}

function diffExceedsRenderLimit(oldValue: string, newValue: string): boolean {
  if (oldValue.length + newValue.length > MAX_RENDERED_DIFF_CHARACTERS) return true
  let lines = 2
  for (let index = 0; index < oldValue.length; index += 1) {
    if (oldValue.charCodeAt(index) === 10) lines += 1
  }
  for (let index = 0; index < newValue.length; index += 1) {
    if (newValue.charCodeAt(index) === 10) lines += 1
  }
  return lines > MAX_RENDERED_DIFF_LINES
}

const diffStyles = {
  variables: {
    dark: {
      diffViewerBackground: 'var(--vibelink-bg)',
      diffViewerColor: 'var(--vibelink-text)',
      addedBackground: 'rgba(46, 160, 67, 0.18)',
      removedBackground: 'rgba(248, 81, 73, 0.18)',
      wordAddedBackground: 'rgba(46, 160, 67, 0.35)',
      wordRemovedBackground: 'rgba(248, 81, 73, 0.35)',
      gutterBackground: 'var(--vibelink-panel)',
      gutterBackgroundDark: 'var(--vibelink-panel)',
      highlightBackground: 'var(--vibelink-input)',
      codeFoldGutterBackground: 'var(--vibelink-panel)',
      codeFoldBackground: 'var(--vibelink-panel)',
      emptyLineBackground: 'var(--vibelink-bg)',
      gutterColor: 'var(--vibelink-muted)',
      addedGutterBackground: 'rgba(46, 160, 67, 0.18)',
      removedGutterBackground: 'rgba(248, 81, 73, 0.18)',
      codeFoldContentColor: 'var(--vibelink-muted)',
    },
  },
  diffContainer: {
    minWidth: '100%',
  },
  contentText: {
    overflowWrap: 'anywhere' as const,
  },
}
