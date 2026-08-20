import { open } from '@tauri-apps/plugin-dialog'
import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { agentStatusLabel } from '../ipc/agents'
import { useWorkspaceStore } from '../state/store'
import type { Profile, WorkspaceSshTarget } from '../state/profiles'
import { loadWorkspaceFolderHistory, rememberWorkspaceFolder, saveWorkspaceFolderHistory, toggleFavoriteWorkspaceFolder } from '../state/workspaceFolders'

type WorkspaceCreateDialogProps = {
  profiles: Profile[]
  defaultProfileId: string
  onCreate: (name: string, workspaceFolder: string | null, profileId: string, sshTarget: WorkspaceSshTarget | null) => void
  onClose: () => void
}

export function WorkspaceCreateDialog({ profiles, defaultProfileId, onCreate, onClose }: WorkspaceCreateDialogProps) {
  const agentClis = useWorkspaceStore((state) => state.agentClis)
  const [name, setName] = useState('')
  const [workspaceFolder, setWorkspaceFolder] = useState('')
  const [profileId, setProfileId] = useState(defaultProfileId)
  const [isPickingFolder, setIsPickingFolder] = useState(false)
  const [sshEnabled, setSshEnabled] = useState(false)
  const [sshUser, setSshUser] = useState('')
  const [sshHost, setSshHost] = useState('')
  const [sshPort, setSshPort] = useState('')
  const [sshIdentity, setSshIdentity] = useState('')
  const [sshOptions, setSshOptions] = useState('')
  const [sshRemoteShell, setSshRemoteShell] = useState<'posix' | 'powershell' | 'cmd'>('posix')
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
    const sshTarget: WorkspaceSshTarget | null = sshEnabled && sshHost.trim().length > 0
      ? {
          host: sshHost.trim(),
          user: sshUser.trim(),
          port: sshPort.trim().length > 0 && Number.isInteger(Number(sshPort)) ? Number(sshPort) : null,
          identityFile: sshIdentity.trim().length > 0 ? sshIdentity.trim() : null,
          options: sshOptions.trim(),
          remoteShell: sshRemoteShell,
        }
      : null
    onCreate(name.trim(), sshTarget ? (workspaceFolder.trim() || null) : (normalizedFolder.length > 0 ? normalizedFolder : null), profileId, sshTarget)
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
            <input value={workspaceFolder} placeholder={sshEnabled ? '/home/js/project (원격 경로)' : 'C:\\Users\\js or E:\\project'} onChange={(event) => setWorkspaceFolder(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit() }} />
            <button type="button" onClick={() => void browseFolder()} disabled={isPickingFolder || sshEnabled}>{isPickingFolder ? 'Opening…' : 'Browse'}</button>
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

        <div className="workspace-ssh-section">
          <label className="workspace-ssh-toggle">
            <input type="checkbox" checked={sshEnabled} onChange={(event) => setSshEnabled(event.target.checked)} />
            원격 SSH 워크스페이스 (에이전트를 이 호스트에서 실행)
          </label>
          {sshEnabled ? (
            <div className="workspace-ssh-fields">
              <div className="workspace-ssh-row">
                <input aria-label="SSH user" placeholder="user (예: js)" value={sshUser} onChange={(event) => setSshUser(event.target.value)} />
                <span className="workspace-ssh-at">@</span>
                <input aria-label="SSH host" placeholder="host (예: 100.67.54.25)" value={sshHost} onChange={(event) => setSshHost(event.target.value)} />
                <span className="workspace-ssh-at">-p</span>
                <input aria-label="SSH port" className="workspace-ssh-port" placeholder="22" value={sshPort} onChange={(event) => setSshPort(event.target.value.replace(/[^0-9]/g, ''))} />
              </div>
              <input aria-label="SSH identity file" placeholder="개인키 경로 (선택, 비우면 기본 키/에이전트)" value={sshIdentity} onChange={(event) => setSshIdentity(event.target.value)} />
              <input aria-label="SSH options" placeholder="추가 ssh 옵션 (선택, 예: -o StrictHostKeyChecking=accept-new)" value={sshOptions} onChange={(event) => setSshOptions(event.target.value)} />
              <label className="workspace-ssh-shell">
                원격 셸
                <select value={sshRemoteShell} onChange={(event) => setSshRemoteShell(event.target.value as 'posix' | 'powershell' | 'cmd')}>
                  <option value="posix">POSIX (Linux/macOS/WSL, bash/zsh)</option>
                  <option value="powershell">PowerShell (Windows 기본 OpenSSH)</option>
                  <option value="cmd">cmd.exe (Windows)</option>
                </select>
              </label>
              <p className="workspace-ssh-hint">터미널·Claude·Codex·OMP 등 이 워크스페이스의 에이전트가 <code>ssh {sshUser.trim() || 'user'}@{sshHost.trim() || 'host'}{sshPort.trim() ? ` -p ${sshPort.trim()}` : ''}</code> 안에서 실행됩니다. 폴더는 원격 경로로 처리됩니다.</p>
            </div>
          ) : null}
        </div>

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
