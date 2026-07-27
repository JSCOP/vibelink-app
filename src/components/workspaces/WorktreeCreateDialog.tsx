import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { FolderGit2, GitBranch, TriangleAlert, X } from 'lucide-react'
import type { SessionMeta } from '../../ipc/types'
import type { Profile } from '../../state/profiles'
import type { CreateWorkspaceWorktreeInput } from '../../state/store'
import { ProfileIcon } from '../ProfileIcon'
import { worktreeBranchName, worktreeNameSlug } from './worktreeNaming'

export type WorktreeCreateDialogProps = {
  sourceSession: SessionMeta
  profiles: Profile[]
  initialProfileId: string
  onCreate: (input: CreateWorkspaceWorktreeInput) => Promise<void>
  onClose: () => void
}


export function WorktreeCreateDialog({ sourceSession, profiles, initialProfileId, onCreate, onClose }: WorktreeCreateDialogProps) {
  const [name, setName] = useState('')
  const [startRef, setStartRef] = useState('HEAD')
  const [branch, setBranch] = useState(worktreeBranchName(''))
  const [branchEdited, setBranchEdited] = useState(false)
  const [profileId, setProfileId] = useState(() => profiles.some((profile) => profile.id === initialProfileId) ? initialProfileId : profiles[0]?.id ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selectedProfile = useMemo(() => profiles.find((profile) => profile.id === profileId) ?? profiles[0], [profileId, profiles])
  const folderSlug = worktreeNameSlug(name)
  const managedFolder = `App data/worktrees/manual/${folderSlug || '<name>'}-<id>`

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || submitting) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, submitting])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const normalizedName = name.trim()
    const normalizedStartRef = startRef.trim()
    const normalizedBranch = branch.trim()
    if (!normalizedName || !normalizedStartRef || !normalizedBranch || !profileId) {
      setError('Name, start ref, branch, and agent profile are required.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await onCreate({
        parentSessionId: sourceSession.id,
        name: normalizedName,
        startRef: normalizedStartRef,
        branch: normalizedBranch,
        profileId,
      })
    } catch (caught) {
      setError(String(caught))
      setSubmitting(false)
    }
  }

  return (
    <div className="workspace-create-backdrop worktree-create-backdrop" role="presentation" onMouseDown={() => { if (!submitting) onClose() }}>
      <form className="workspace-create-dialog worktree-create-dialog" role="dialog" aria-modal="true" aria-labelledby="worktree-create-title" onSubmit={(event) => void submit(event)} onMouseDown={(event) => event.stopPropagation()}>
        <header className="workspace-create-header">
          <div className="worktree-create-heading">
            <span className="worktree-create-mark" aria-hidden="true"><FolderGit2 size={17} /></span>
            <h2 id="worktree-create-title">Create worktree</h2>
          </div>
          <button type="button" className="settings-close" title="Close" aria-label="Close worktree dialog" disabled={submitting} onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <div className="worktree-create-source">
          <GitBranch size={14} aria-hidden="true" />
          <span><strong>{sourceSession.name}</strong><small title={sourceSession.workspaceFolder ?? undefined}>{sourceSession.workspaceFolder}</small></span>
        </div>

        <div className="worktree-create-fields">
          <label>
            Worktree name
            <input
              autoFocus
              value={name}
              placeholder="fix-login-flow"
              disabled={submitting}
              onChange={(event) => {
                const next = event.target.value
                setName(next)
                if (!branchEdited) setBranch(worktreeBranchName(next))
              }}
            />
          </label>
          <div className="worktree-create-field-grid">
            <label>
              Start ref
              <input value={startRef} placeholder="HEAD, main, or origin/main" disabled={submitting} onChange={(event) => setStartRef(event.target.value)} />
            </label>
            <label>
              New branch
              <input aria-label="New branch" value={branch} placeholder="vibelink/fix-login-flow" disabled={submitting} onChange={(event) => { setBranchEdited(true); setBranch(event.target.value) }} />
              <small className="worktree-create-field-hint">Creates a new branch; the name must not already exist.</small>
            </label>
          </div>
          <label>
            Start with
            <span className="worktree-profile-select">
              {selectedProfile ? <ProfileIcon name={selectedProfile.icon} size={18} /> : null}
              <select value={profileId} disabled={submitting} onChange={(event) => setProfileId(event.target.value)}>
                {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
              </select>
            </span>
          </label>
          <div className="worktree-create-summary" aria-label="Worktree behavior">
            <div><span>Managed folder</span><code>{managedFolder}</code></div>
            <div><span>Agent cwd</span><strong>This worktree folder</strong></div>
          </div>
          <p className="worktree-create-warning"><TriangleAlert size={13} aria-hidden="true" /><span>Uncommitted source changes are not copied. Branches and Git history are shared.</span></p>
          {error ? <p className="worktree-create-error" role="alert">{error}</p> : null}
        </div>

        <footer className="workspace-create-footer worktree-create-footer">
          {submitting ? <span className="worktree-create-progress">Creating checkout and terminal…</span> : null}
          <div className="workspace-create-footer-actions">
            <button type="button" disabled={submitting} onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-action" disabled={submitting || !name.trim() || !profileId}>{submitting ? 'Creating…' : 'Create worktree'}</button>
          </div>
        </footer>
      </form>
    </div>
  )
}
