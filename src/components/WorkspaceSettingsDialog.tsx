import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { agentStatusLabel } from '../ipc/agents'
import type { SessionMeta } from '../ipc/types'
import { useWorkspaceStore } from '../state/store'
import { selectedProfileForWorkspace, workspaceDetailsFor, type Settings } from '../state/profiles'

type WorkspaceSettingsDialogProps = {
  session: SessionMeta
  settings: Settings
  onChange: (settings: Partial<Settings>) => void
  onRename: (sessionId: string, name: string) => Promise<void>
  onClose: () => void
}

export function WorkspaceSettingsDialog({ session, settings, onChange, onRename, onClose }: WorkspaceSettingsDialogProps) {
  const agentClis = useWorkspaceStore((state) => state.agentClis)
  const savedDetails = workspaceDetailsFor(settings, session.id)
  const [name, setName] = useState(session.name)
  const [profileId, setProfileId] = useState(selectedProfileForWorkspace(settings, session.id).id)
  const [githubIssue, setGithubIssue] = useState(savedDetails.githubIssue)
  const [githubPullRequest, setGithubPullRequest] = useState(savedDetails.githubPullRequest)
  const [notes, setNotes] = useState(savedDetails.notes)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const agentStatusById = useMemo(
    () => Object.fromEntries(agentClis.map((status) => [status.id.toLowerCase(), status])),
    [agentClis],
  )
  const selectedAgentStatus = agentStatusById[profileId.toLowerCase()]
  const selectedProfileUnavailable = Boolean(selectedAgentStatus && !selectedAgentStatus.installed)
  const normalizedName = name.trim()

  const submit = async () => {
    if (saving || normalizedName.length === 0 || selectedProfileUnavailable) return
    setSaving(true)
    setError(null)
    try {
      if (normalizedName !== session.name) await onRename(session.id, normalizedName)
      const nextDetails = {
        githubIssue: githubIssue.trim(),
        githubPullRequest: githubPullRequest.trim(),
        notes,
      }
      const workspaceDetails = { ...settings.workspaceDetails }
      if (nextDetails.githubIssue || nextDetails.githubPullRequest || nextDetails.notes) workspaceDetails[session.id] = nextDetails
      else delete workspaceDetails[session.id]
      onChange({
        workspaceProfileIds: { ...settings.workspaceProfileIds, [session.id]: profileId },
        workspaceDetails,
      })
      onClose()
    } catch (caught) {
      setError(String(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={saving ? undefined : onClose}>
      <section
        className="settings-dialog workspace-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !saving) onClose()
          if (event.key === 'Enter' && event.ctrlKey) {
            event.preventDefault()
            void submit()
          }
        }}
      >
        <header className="settings-dialog-header workspace-settings-header">
          <div>
            <h2 id="workspace-settings-title">Edit workspace details</h2>
            <p>Set the workspace label, terminal profile, GitHub links, and notes.</p>
          </div>
          <button type="button" className="settings-close" title="Close" aria-label="Close workspace settings" disabled={saving} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="workspace-settings-form">
          <label className="workspace-settings-field">
            <span>Display name</span>
            <input autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
            <small>Only the sidebar label changes. The folder remains {session.workspaceFolder || 'unchanged'}.</small>
          </label>

          <label className="workspace-settings-field">
            <span>Default terminal profile</span>
            <select
              value={profileId}
              title={selectedProfileUnavailable ? `Install ${selectedAgentStatus?.displayName ?? profileId} or choose another profile` : undefined}
              onChange={(event) => setProfileId(event.target.value)}
            >
              {settings.profiles.map((profile) => {
                const status = agentStatusById[profile.id.toLowerCase()]
                return (
                  <option key={profile.id} value={profile.id} disabled={Boolean(status && !status.installed)}>
                    {profile.name}{status ? ` · ${agentStatusLabel(status)}` : ''}
                  </option>
                )
              })}
            </select>
            <small>New terminal windows and splits start with this profile. Add panes also selects it by default.</small>
          </label>

          <label className="workspace-settings-field">
            <span>GitHub issue</span>
            <input value={githubIssue} maxLength={512} placeholder="Issue # or GitHub URL" onChange={(event) => setGithubIssue(event.target.value)} />
            <small>Paste an issue URL or enter its number. Clear the field to remove it.</small>
          </label>

          <label className="workspace-settings-field">
            <span>GitHub pull request</span>
            <input value={githubPullRequest} maxLength={512} placeholder="PR # or GitHub URL" onChange={(event) => setGithubPullRequest(event.target.value)} />
            <small>Paste a pull request URL or enter its number. Clear the field to remove it.</small>
          </label>

          <label className="workspace-settings-field">
            <span>Notes</span>
            <textarea value={notes} maxLength={8000} rows={5} placeholder="Notes about this workspace…" onChange={(event) => setNotes(event.target.value)} />
            <small>Markdown text is preserved. Press Ctrl+Enter to save.</small>
          </label>

          {error ? <p className="workspace-settings-error" role="alert">{error}</p> : null}
        </div>

        <footer className="workspace-settings-footer">
          <button type="button" className="secondary-action" disabled={saving} onClick={onClose}>Cancel</button>
          <button type="button" className="primary-action" disabled={saving || normalizedName.length === 0 || selectedProfileUnavailable} onClick={() => void submit()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </section>
    </div>
  )
}
