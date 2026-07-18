import { invoke } from '@tauri-apps/api/core'
import { useEffect, useMemo, useState } from 'react'
import type { ChangedFile, FileContents } from '../ipc/types'
import { useWorkspaceStore } from '../state/store'
import { DiffPane } from './git/DiffPane'

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
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!task?.baselineRef || !workspaceFolder) return
    let cancelled = false
    setLoading(true)
    setError(null)
    invoke<ChangedFile[]>('git_changed_files', { workspaceFolder, baseRef: task.baselineRef })
      .then((nextFiles) => {
        if (cancelled) return
        setFiles(nextFiles)
        setSelectedPath(nextFiles[0]?.path ?? null)
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [task?.baselineRef, task?.updatedAt, workspaceFolder])

  useEffect(() => {
    if (!task?.baselineRef || !workspaceFolder || !selectedPath) {
      setContents(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    invoke<FileContents>('git_file_contents', { workspaceFolder, baseRef: task.baselineRef, path: selectedPath })
      .then((nextContents) => {
        if (!cancelled) setContents(nextContents)
      })
      .catch((reason) => {
        if (!cancelled) {
          setContents(null)
          setError(String(reason))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [selectedPath, task?.baselineRef, workspaceFolder])

  if (!task) return <div className="task-diff-empty">Select a task to view its diff.</div>
  if (!workspaceFolder || !task.baselineRef) return <div className="task-diff-empty">No git baseline for this task.</div>

  return (
    <DiffPane
      files={files}
      selectedPath={selectedPath}
      onSelect={setSelectedPath}
      contents={contents}
      loading={loading}
      splitView
      title={task.title}
      error={error}
    />
  )
}
