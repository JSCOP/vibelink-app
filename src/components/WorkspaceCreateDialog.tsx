import { open } from '@tauri-apps/plugin-dialog'
import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { agentStatusLabel } from '../ipc/agents'
import { useWorkspaceStore } from '../state/store'
import type { Profile } from '../state/profiles'
import { loadWorkspaceFolderHistory, rememberWorkspaceFolder, saveWorkspaceFolderHistory, toggleFavoriteWorkspaceFolder } from '../state/workspaceFolders'

type WorkspaceCreateDialogProps = {
  profiles: Profile[]
  defaultProfileId: string
  onCreate: (name: string, workspaceFolder: string | null, profileId: string) => void
  onClose: () => void
}

export function WorkspaceCreateDialog({ profiles, defaultProfileId, onCreate, onClose }: WorkspaceCreateDialogProps) {
  const agentClis = useWorkspaceStore((state) => state.agentClis)
  const [name, setName] = useState('')
  const [workspaceFolder, setWorkspaceFolder] = useState('')
  const [profileId, setProfileId] = useState(defaultProfileId)
  const [isPickingFolder, setIsPickingFolder] = useState(false)
  const [folderHistory, setFolderHistory] = useState(() => loadWorkspaceFolderHistory())
  const suggestedFolders = useMemo(() => {
    const folders = [...folderHistory.favorites, ...folderHistory.recent]
    return folders.filter((folder, index) => folders.findIndex((candidate) => candidate.toLowerCase() === folder.toLowerCase()) === index)
  }, [folderHistory])
  const agentStatusById = useMemo(
    () => Object.fromEntries(agentClis.map((status) => [status.id.toLowerCase(), status])),
    [agentClis],
  )
  const selectedAgentStatus = agentStatusById[profileId.toLowerCase()]
  const selectedProfileUnavailable = Boolean(selectedAgentStatus && !selectedAgentStatus.installed)

  const submit = () => {
    if (selectedProfileUnavailable) return
    const normalizedFolder = workspaceFolder.trim()
    if (normalizedFolder) {
      const nextHistory = rememberWorkspaceFolder(folderHistory, normalizedFolder)
      setFolderHistory(nextHistory)
      saveWorkspaceFolderHistory(nextHistory)
    }
    onCreate(name.trim(), normalizedFolder.length > 0 ? normalizedFolder : null, profileId)
  }

  const browseFolder = async () => {
    setIsPickingFolder(true)
    try {
      const selected = await open({ directory: true, multiple: false, title: 'Select workspace folder' })
      if (typeof selected === 'string') setWorkspaceFolder(selected)
    } finally {
      setIsPickingFolder(false)
    }
  }

  const toggleFavorite = (folder: string) => {
    const nextHistory = toggleFavoriteWorkspaceFolder(folderHistory, folder)
    setFolderHistory(nextHistory)
    saveWorkspaceFolderHistory(nextHistory)
  }

  return (
    <div className="workspace-create-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="workspace-create-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-create-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="workspace-create-header">
          <div>
            <p className="settings-eyebrow">New workspace</p>
            <h2 id="workspace-create-title">Create a workspace</h2>
          </div>
          <button type="button" className="settings-close" title="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <label className="workspace-create-name">
          Name
          <input autoFocus value={name} placeholder="Workspace" onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit() }} />
        </label>

        <label className="workspace-create-name">
          Folder
          <div className="workspace-folder-row">
            <input value={workspaceFolder} placeholder="C:\\Users\\js or E:\\project" onChange={(event) => setWorkspaceFolder(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit() }} />
            <button type="button" onClick={() => void browseFolder()} disabled={isPickingFolder}>{isPickingFolder ? 'Opening…' : 'Browse'}</button>
          </div>
        </label>

        <label className="workspace-create-name">
          Profile
          <select
            value={profileId}
            title={selectedProfileUnavailable ? `Install ${selectedAgentStatus?.displayName ?? profileId} or pick another profile` : undefined}
            onChange={(event) => setProfileId(event.target.value)}
          >
            {profiles.map((profile) => {
              const status = agentStatusById[profile.id.toLowerCase()]
              return (
                <option
                  key={profile.id}
                  value={profile.id}
                  disabled={Boolean(status && !status.installed)}
                  title={status && !status.installed ? `Install ${status.displayName} or pick another profile` : undefined}
                >
                  {profile.name}{status ? ` · ${agentStatusLabel(status)}` : ''}
                </option>
              )
            })}
          </select>
        </label>

        {suggestedFolders.length > 0 ? (
          <div className="workspace-folder-suggestions">
            <div className="workspace-folder-suggestions-heading">Recent / favorites</div>
            {suggestedFolders.map((folder) => {
              const favorite = folderHistory.favorites.some((item) => item.toLowerCase() === folder.toLowerCase())
              return (
                <div key={folder} className="workspace-folder-suggestion-row">
                  <button type="button" onClick={() => setWorkspaceFolder(folder)}>{folder}</button>
                  <button type="button" className={favorite ? 'selected' : ''} title={favorite ? 'Remove favorite' : 'Add favorite'} onClick={() => toggleFavorite(folder)}>★</button>
                </div>
              )
            })}
          </div>
        ) : null}


        <footer className="workspace-create-footer">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-action" disabled={selectedProfileUnavailable} onClick={submit}>Create workspace</button>
        </footer>
      </section>
    </div>
  )
}
