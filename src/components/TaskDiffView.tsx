import { invoke } from '@tauri-apps/api/core'
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import ReactDiffViewer from 'react-diff-viewer-continued'
import type { ChangedFile, FileContents } from '../ipc/types'
import { useWorkspaceStore } from '../state/store'

export function TaskDiffView() {
  const sessionId = useWorkspaceStore((state) => state.activeSessionId)
  const sessions = useWorkspaceStore((state) => state.sessions)
  const selectedTaskId = useWorkspaceStore((state) => sessionId ? state.selectedTaskId[sessionId] : null)
  const task = useWorkspaceStore((state) => selectedTaskId ? state.kanban.tasks[selectedTaskId] : undefined)
  const workspaceFolder = useMemo(() => sessions.find((session) => session.id === sessionId)?.workspaceFolder ?? null, [sessionId, sessions])
  const [files, setFiles] = useState<ChangedFile[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [contents, setContents] = useState<FileContents | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [listWidth, setListWidth] = useState(260)

  useEffect(() => {
    if (!task?.baselineRef || !workspaceFolder) return
    let cancelled = false
    invoke<ChangedFile[]>('git_changed_files', { workspaceFolder, baseRef: task.baselineRef })
      .then((nextFiles) => {
        if (cancelled) return
        setFiles(nextFiles)
        setSelectedPath(nextFiles[0]?.path ?? null)
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason))
      })
    return () => { cancelled = true }
  }, [task?.baselineRef, task?.updatedAt, workspaceFolder])

  useEffect(() => {
    if (!task?.baselineRef || !workspaceFolder || !selectedPath) return
    let cancelled = false
    invoke<FileContents>('git_file_contents', { workspaceFolder, baseRef: task.baselineRef, path: selectedPath })
      .then((nextContents) => {
        if (!cancelled) setContents(nextContents)
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason))
      })
    return () => { cancelled = true }
  }, [selectedPath, task?.baselineRef, workspaceFolder])

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

  if (!task) return <div className="task-diff-empty">Select a task to view its diff.</div>
  if (!workspaceFolder || !task.baselineRef) return <div className="task-diff-empty">No git baseline for this task.</div>

  return (
    <div className="task-diff-view" style={{ '--file-list-width': `${listWidth}px` } as CSSProperties}>
      <aside className="task-diff-files">
        <h3>{task.title}</h3>
        {error ? <div className="kanban-error">{error}</div> : null}
        {files.map((file) => (
          <button key={`${file.changeType}:${file.path}`} type="button" className={selectedPath === file.path ? 'active' : undefined} onClick={() => setSelectedPath(file.path)}>
            <span>{file.changeType}</span>
            {file.path}
          </button>
        ))}
      </aside>
      <div className="task-diff-resizer" role="separator" aria-orientation="vertical" onPointerDown={startResize} />
      <main className="task-diff-content">
        {contents?.binary ? <div className="task-diff-empty">binary — not shown</div> : null}
        {contents && !contents.binary ? (
          <ReactDiffViewer oldValue={contents.old} newValue={contents.new} splitView useDarkTheme styles={diffStyles} />
        ) : null}
      </main>
    </div>
  )
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
}
