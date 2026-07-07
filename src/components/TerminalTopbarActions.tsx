import { useState } from 'react'
import { Eraser, LayoutGrid, PanelTopClose, PanelTopOpen } from 'lucide-react'
import { NewTerminalLauncher } from './NewTerminalLauncher'
import { occupancyFromDockLayout, terminalAlignGridForNewPaneBasis, type GridSize, type TerminalOccupancyGrid } from './newTerminalGrid'
import { ProfileIcon } from './ProfileIcon'
import type { WorkspaceWindowActions } from '../layout/windowActions'
import { selectedProfileForWorkspace } from '../state/profiles'
import { useWorkspaceStore } from '../state/store'

type TerminalTopbarActionsProps = {
  actions: WorkspaceWindowActions | null
}

export function TerminalTopbarActions({ actions }: TerminalTopbarActionsProps) {
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const panes = useWorkspaceStore((state) => state.panes)
  const settings = useWorkspaceStore((state) => state.settings)
  const setDefaultProfile = useWorkspaceStore((state) => state.setDefaultProfile)
  const toggleTerminalTabsVisible = useWorkspaceStore((state) => state.toggleTerminalTabsVisible)
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [preferredGrid, setPreferredGrid] = useState<GridSize | null>(null)
  const [occupancyMatrix, setOccupancyMatrix] = useState<TerminalOccupancyGrid | null>(null)
  const activeProfile = selectedProfileForWorkspace(settings, activeSessionId)
  const paneCount = Object.values(panes).filter((pane) => pane.alive).length
  const alignGrid = terminalAlignGridForNewPaneBasis(paneCount, preferredGrid)
  const TerminalTabsIcon = settings.terminalTabsVisible ? PanelTopClose : PanelTopOpen

  if (!actions) return null

  const toggleLauncher = () => {
    setLauncherOpen((open) => {
      if (!open) setOccupancyMatrix(occupancyFromDockLayout(actions.getTerminalLayoutSnapshot()))
      return !open
    })
  }

  return (
    <div className="terminal-titlebar-toolbar">
      <label className="terminal-titlebar-profile">
        <span>Profile</span>
        <ProfileIcon name={activeProfile.icon} size={13} color={activeProfile.color} />
        <select
          aria-label="Active terminal profile"
          value={activeProfile.id}
          disabled={!activeSessionId}
          onChange={(event) => setDefaultProfile(event.target.value)}
        >
          {settings.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>{profile.name}</option>
          ))}
        </select>
      </label>
      <button type="button" className="terminal-titlebar-button" disabled={!activeSessionId || paneCount === 0} title="Clear terminal panes" onClick={actions.clearTerminals}>
        <Eraser size={13} /> <span>Clear</span>
      </button>
      <button type="button" className="terminal-titlebar-button" disabled={!activeSessionId || paneCount === 0} title="Arrange terminal panes" onClick={() => actions.arrangeTerminals(alignGrid)}>
        <LayoutGrid size={13} /> <span>Align</span>
      </button>
      <button type="button" className="terminal-titlebar-button" disabled={!activeSessionId} title={settings.terminalTabsVisible ? 'Hide pane tabs' : 'Show pane tabs'} onClick={toggleTerminalTabsVisible}>
        <TerminalTabsIcon size={13} /> <span>Tabs</span>
      </button>
      <NewTerminalLauncher
        isOpen={launcherOpen}
        disabled={!activeSessionId}
        existingPaneCount={paneCount}
        preferredGrid={preferredGrid}
        occupancyMatrix={occupancyMatrix}
        profiles={settings.profiles}
        activeProfileId={activeProfile.id}
        onToggle={toggleLauncher}
        onClose={() => setLauncherOpen(false)}
        onSelectionCommit={setPreferredGrid}
        onLaunch={(request) => {
          setPreferredGrid({ cols: request.cols, rows: request.rows })
          setLauncherOpen(false)
          actions.launchTerminalGrid(request)
        }}
      />
    </div>
  )
}
