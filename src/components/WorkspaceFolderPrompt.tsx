import { open } from '@tauri-apps/plugin-dialog'
import { FolderOpen } from 'lucide-react'
import { useState } from 'react'
import { useWorkspaceStore } from '../state/store'
import {
  loadWorkspaceFolderHistory,
  rememberWorkspaceFolder,
  saveWorkspaceFolderHistory,
} from '../state/workspaceFolders'

type WorkspaceFolderPromptProps = {
  sessionId: string
}

export function WorkspaceFolderPrompt({ sessionId }: WorkspaceFolderPromptProps) {
  const setSessionWorkspaceFolder = useWorkspaceStore((state) => state.setSessionWorkspaceFolder)
  const setError = useWorkspaceStore((state) => state.setError)
  const [selecting, setSelecting] = useState(false)

  const chooseFolder = async () => {
    if (selecting) return
    setSelecting(true)
    try {
      const selected = await open({ directory: true, multiple: false, title: 'Select workspace folder' })
      if (typeof selected !== 'string') return
      await setSessionWorkspaceFolder(sessionId, selected)
      const history = rememberWorkspaceFolder(loadWorkspaceFolderHistory(), selected)
      saveWorkspaceFolderHistory(history)
    } catch (error) {
      setError(`Could not set the workspace folder: ${String(error)}`)
    } finally {
      setSelecting(false)
    }
  }

  return (
    <div className="placeholder-panel workspace-folder-prompt">
      <FolderOpen size={26} aria-hidden="true" />
      <strong>This workspace has no local folder.</strong>
      <span>Choose a project folder to enable Explorer, Git, and Agent session history. New terminals will start there.</span>
      <button type="button" className="primary-action" disabled={selecting} onClick={() => void chooseFolder()}>
        {selecting ? 'Opening…' : 'Choose workspace folder…'}
      </button>
    </div>
  )
}
