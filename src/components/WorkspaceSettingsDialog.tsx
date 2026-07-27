import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleDot, Folder, GitPullRequest, Layers, PanelsTopLeft, SquareTerminal, StickyNote, TriangleAlert, Type, X } from 'lucide-react'
import { agentStatusLabel } from '../ipc/agents'
import type { SessionMeta } from '../ipc/types'
import { useWorkspaceStore } from '../state/store'
import { selectedProfileForWorkspace, workspaceDetailsFor, type Settings } from '../state/profiles'
import { ProfileIcon } from './ProfileIcon'
import {
  SettingsButton,
  SettingsCard,
  SettingsIconButton,
  SettingsMessage,
  SettingsRow,
  SettingsText,
  SettingsValue,
} from './settings/controls'
import './settings/workspaceDialog.css'

type WorkspaceSettingsDialogProps = {
  session: SessionMeta
  settings: Settings
  onChange: (settings: Partial<Settings>) => void
  onRename: (sessionId: string, name: string) => Promise<void>
  onClose: () => void
}

export function WorkspaceSettingsDialog({ session, settings, onChange, onRename, onClose }: WorkspaceSettingsDialogProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const agentClis = useWorkspaceStore((state) => state.agentClis)
  const workspaceGroups = useWorkspaceStore((state) => state.settings.workspaceGroups)
  const savedDetails = workspaceDetailsFor(settings, session.id)
  const [name, setName] = useState(session.name)
  const [profileId, setProfileId] = useState(selectedProfileForWorkspace(settings, session.id).id)
  const [githubIssue, setGithubIssue] = useState(savedDetails.githubIssue)
  const [githubPullRequest, setGithubPullRequest] = useState(savedDetails.githubPullRequest)
  const [notes, setNotes] = useState(savedDetails.notes)
  const [groupId, setGroupId] = useState(settings.workspaceGroupIds[session.id] ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const agentStatusById = useMemo(
    () => Object.fromEntries(agentClis.map((status) => [status.id.toLowerCase(), status])),
    [agentClis],
  )
  const selectedAgentStatus = agentStatusById[profileId.toLowerCase()]
  const selectedProfileUnavailable = Boolean(selectedAgentStatus && !selectedAgentStatus.installed)
  const selectedProfile = settings.profiles.find((profile) => profile.id === profileId)
    ?? selectedProfileForWorkspace(settings, session.id)
  const normalizedName = name.trim()
  const headerName = normalizedName || session.name

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.focus()
  }, [])

  const SelectedProfileIcon = () => (
    <ProfileIcon name={selectedProfile.icon} color={selectedProfile.color} size={16} />
  )

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
      const workspaceGroupIds = { ...settings.workspaceGroupIds }
      if (groupId) workspaceGroupIds[session.id] = groupId
      else delete workspaceGroupIds[session.id]
      onChange({
        workspaceProfileIds: { ...settings.workspaceProfileIds, [session.id]: profileId },
        workspaceDetails,
        workspaceGroupIds,
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
        ref={dialogRef}
        className="vl-ws-dialog"
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
        <header className="vl-ws-dialog-header">
          <PanelsTopLeft size={17} strokeWidth={1.9} aria-hidden="true" />
          <h2 id="workspace-settings-title">{headerName}</h2>
          <SettingsIconButton icon={X} label="Close workspace settings" disabled={saving} onClick={onClose} />
        </header>

        <div className="vl-ws-dialog-body">
          <SettingsCard icon={PanelsTopLeft} title="Workspace">
            <SettingsRow
              icon={Type}
              label="Name"
              hint="Changes only the workspace label."
              stacked
              control={<SettingsText label="Name" value={name} onChange={(value) => setName(value.slice(0, 120))} />}
            />
            <SettingsRow
              icon={Folder}
              label="Folder"
              control={<SettingsValue value={session.workspaceFolder || 'No folder'} mono />}
            />
          </SettingsCard>

          <SettingsCard icon={SquareTerminal} title="Default profile">
            <SettingsRow
              icon={SelectedProfileIcon}
              label="Profile"
              hint="New terminal windows, splits, and added panes start with this profile."
              control={(
                <select
                  className="vl-set-select"
                  aria-label="Default profile"
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
              )}
            />
          </SettingsCard>

          <SettingsCard icon={GitPullRequest} title="Linked work">
            <SettingsRow
              icon={CircleDot}
              label="Issue"
              hint="Paste a GitHub issue URL or number. Clear it to remove the link."
              stacked
              control={(
                <SettingsText
                  label="Issue"
                  value={githubIssue}
                  placeholder="# or URL"
                  onChange={(value) => setGithubIssue(value.slice(0, 512))}
                />
              )}
            />
            <SettingsRow
              icon={GitPullRequest}
              label="Pull request"
              hint="Paste a GitHub pull request URL or number. Clear it to remove the link."
              stacked
              control={(
                <SettingsText
                  label="Pull request"
                  value={githubPullRequest}
                  placeholder="# or URL"
                  onChange={(value) => setGithubPullRequest(value.slice(0, 512))}
                />
              )}
            />
          </SettingsCard>

          <SettingsCard icon={StickyNote} title="Notes" hint="Markdown is preserved. Press Ctrl+Enter to save.">
            <textarea
              className="vl-set-textarea"
              aria-label="Notes"
              value={notes}
              maxLength={8000}
              rows={5}
              placeholder="Workspace notes…"
              onChange={(event) => setNotes(event.target.value)}
            />
          </SettingsCard>

          <SettingsCard icon={Layers} title="Group">
            <SettingsRow
              icon={Layers}
              label="Workspace group"
              control={(
                <select className="vl-set-select" aria-label="Workspace group" value={groupId} onChange={(event) => setGroupId(event.target.value)}>
                  <option value="">No group</option>
                  {workspaceGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                </select>
              )}
            />
          </SettingsCard>

          {error ? (
            <div role="alert">
              <SettingsMessage tone="danger" icon={TriangleAlert}>{error}</SettingsMessage>
            </div>
          ) : null}
        </div>

        <footer className="vl-ws-dialog-footer">
          <SettingsButton label="Cancel" disabled={saving} onClick={onClose} />
          <SettingsButton
            label={saving ? 'Saving…' : 'Save'}
            tone="accent"
            disabled={saving || normalizedName.length === 0 || selectedProfileUnavailable}
            onClick={() => void submit()}
          />
        </footer>
      </section>
    </div>
  )
}
