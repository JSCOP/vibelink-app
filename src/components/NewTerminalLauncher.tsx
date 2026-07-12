import { Grid3X3, Plus } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Profile } from '../state/profiles'
import { agentStatusLabel } from '../ipc/agents'
import { useWorkspaceStore } from '../state/store'
import { clampGridCols, clampGridRows, defaultTerminalGridSelection, displayGridSize, occupiedGridForPaneCount, selectedNewPaneCount, terminalGridCellState, terminalGridSelectionFromCell, terminalGridSelectionFromDimensions, terminalOccupancyGridCellState, type GridSize, type TerminalOccupancyGrid } from './newTerminalGrid'

type LaunchRequest = {
  cols: number
  rows: number
  occupiedGrid?: GridSize
  profileId?: string | null
}

type NewTerminalLauncherProps = {
  isOpen: boolean
  disabled?: boolean
  existingPaneCount: number
  profiles: Profile[]
  activeProfileId: string
  preferredGrid?: GridSize | null
  occupancyMatrix?: TerminalOccupancyGrid | null
  onToggle: () => void
  onClose: () => void
  onLaunch: (request: LaunchRequest) => void
  onSelectionCommit?: (selection: GridSize) => void
}

type SelectionState = {
  key: string
  grid: GridSize
}

function selectionStateKey(paneCount: number, preferred?: GridSize | null, occupancyMatrix?: TerminalOccupancyGrid | null): string {
  const matrixKey = occupancyMatrix
    ? `${occupancyMatrix.cols}:${occupancyMatrix.rows}:${occupancyMatrix.cells.map((row) => row.map((cell) => (cell ? '1' : '0')).join('')).join('/')}`
    : 'none'
  return `${Math.max(0, Math.floor(Number.isFinite(paneCount) ? paneCount : 0))}:${preferred?.cols ?? 0}:${preferred?.rows ?? 0}:${matrixKey}`
}

export function NewTerminalLauncher({ isOpen, disabled, existingPaneCount, preferredGrid = null, occupancyMatrix = null, profiles, activeProfileId, onToggle, onClose, onLaunch, onSelectionCommit }: NewTerminalLauncherProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const agentClis = useWorkspaceStore((state) => state.agentClis)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [occupiedPreference, setOccupiedPreference] = useState<GridSize | null>(() => preferredGrid)
  const [selectionState, setSelectionState] = useState<SelectionState>(() => ({
    key: selectionStateKey(existingPaneCount, preferredGrid, occupancyMatrix),
    grid: occupancyMatrix ? { cols: occupancyMatrix.cols, rows: occupancyMatrix.rows } : defaultTerminalGridSelection(existingPaneCount, preferredGrid),
  }))
  const [previewSelection, setPreviewSelection] = useState<GridSize | null>(null)
  const [isPointerSelecting, setIsPointerSelecting] = useState(false)
  const [selectedProfileId, setSelectedProfileId] = useState(activeProfileId)
  const [popoverPosition, setPopoverPosition] = useState({ top: 42, right: 12 })
  const occupied = useMemo(
    () => occupancyMatrix ? { cols: occupancyMatrix.cols, rows: occupancyMatrix.rows } : occupiedGridForPaneCount(existingPaneCount, occupiedPreference),
    [existingPaneCount, occupancyMatrix, occupiedPreference],
  )
  const currentSelectionKey = selectionStateKey(existingPaneCount, occupiedPreference, occupancyMatrix)
  const selection = selectionState.key === currentSelectionKey
    ? selectionState.grid
    : occupancyMatrix ? { cols: occupancyMatrix.cols, rows: occupancyMatrix.rows } : defaultTerminalGridSelection(existingPaneCount, occupiedPreference)
  const display = useMemo(() => displayGridSize(), [])
  const visibleSelection = previewSelection ?? selection
  const newPaneCount = selectedNewPaneCount(existingPaneCount, selection)
  const effectiveProfileId = profiles.some((profile) => profile.id === selectedProfileId) ? selectedProfileId : activeProfileId
  const agentStatusById = useMemo(
    () => Object.fromEntries(agentClis.map((status) => [status.id.toLowerCase(), status])),
    [agentClis],
  )
  const selectedAgentStatus = agentStatusById[effectiveProfileId.toLowerCase()]
  const selectedProfileUnavailable = Boolean(selectedAgentStatus && !selectedAgentStatus.installed)
  const closeLauncher = useCallback(() => {
    setIsPointerSelecting(false)
    setPreviewSelection(null)
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!isOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node | null)) return
      closeLauncher()
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [closeLauncher, isOpen])
  useEffect(() => {
    if (!isOpen) return
    const endPointerSelection = () => {
      setIsPointerSelecting(false)
      setPreviewSelection(null)
    }
    window.addEventListener('pointerup', endPointerSelection)
    window.addEventListener('pointercancel', endPointerSelection)
    return () => {
      window.removeEventListener('pointerup', endPointerSelection)
      window.removeEventListener('pointercancel', endPointerSelection)
    }
  }, [isOpen])

  useLayoutEffect(() => {
    if (!isOpen) return

    const updatePosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (!rect) return
      setPopoverPosition({
        top: Math.round(rect.bottom + 5),
        right: Math.max(8, Math.round(window.innerWidth - rect.right)),
      })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    return () => window.removeEventListener('resize', updatePosition)
  }, [isOpen])


  const selectionFromCell = (col: number, row: number) => terminalGridSelectionFromCell(occupied, col, row)
  const previewCell = (col: number, row: number, commit = false) => {
    const next = selectionFromCell(col, row)
    setPreviewSelection(next)
    if (commit) commitSelection(next)
  }
  const commitSelection = (next: GridSize) => {
    setSelectionState({ key: currentSelectionKey, grid: next })
    onSelectionCommit?.(next)
  }

  const commitCell = (col: number, row: number) => {
    const next = selectionFromCell(col, row)
    setIsPointerSelecting(true)
    setPreviewSelection(next)
    commitSelection(next)
  }
  const clearCellPreview = () => {
    if (!isPointerSelecting) setPreviewSelection(null)
  }

  const commitDimensions = (cols: number, rows: number) => {
    const next = terminalGridSelectionFromDimensions(occupied, cols, rows)
    setPreviewSelection(null)
    commitSelection(next)
  }

  const launchSelection = () => {
    if (newPaneCount <= 0 || selectedProfileUnavailable) return
    onLaunch({ cols: selection.cols, rows: selection.rows, occupiedGrid: occupied, profileId: effectiveProfileId })
  }

  const toggleLauncher = () => {
    setIsPointerSelecting(false)
    setPreviewSelection(null)
    if (!isOpen) {
      setOccupiedPreference(preferredGrid)
      setSelectionState({
        key: selectionStateKey(existingPaneCount, preferredGrid, occupancyMatrix),
        grid: occupancyMatrix ? { cols: occupancyMatrix.cols, rows: occupancyMatrix.rows } : defaultTerminalGridSelection(existingPaneCount, preferredGrid),
      })
      setSelectedProfileId(activeProfileId)
    }
    onToggle()
  }

  return (
    <div ref={rootRef} className="new-terminal-launcher">
      <button ref={buttonRef} type="button" className="topbar-text-button" disabled={disabled} title="Add terminals by dragging over free grid cells" onClick={toggleLauncher}>
        <Plus size={14} /> <span>New</span>
      </button>
      {isOpen ? (
        <section className="new-terminal-popover" style={popoverPosition} aria-label="Add terminal panes">
          <header className="new-terminal-popover-header">
            <Grid3X3 size={14} />
            <span>Add panes</span>
          </header>
          <label className="new-terminal-profile">
            Profile
            <select
              value={effectiveProfileId}
              title={selectedProfileUnavailable ? `Install ${selectedAgentStatus?.displayName ?? effectiveProfileId} or pick another profile` : undefined}
              onChange={(event) => setSelectedProfileId(event.target.value)}
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
          <div className="new-terminal-summary">
            <strong>{selection.cols}×{selection.rows}</strong>
            <span>{existingPaneCount} occupied · {newPaneCount} new panes</span>
          </div>
          <div
            className="new-terminal-occupancy-grid"
            style={{ gridTemplateColumns: `repeat(${display.cols}, minmax(0, 1fr))` }}
            onPointerLeave={clearCellPreview}
          >
            {Array.from({ length: display.rows }).flatMap((_, row) => (
              Array.from({ length: display.cols }).map((__, col) => {
                const state = occupancyMatrix ? terminalOccupancyGridCellState(occupancyMatrix, visibleSelection, col, row) : terminalGridCellState(existingPaneCount, occupied, visibleSelection, col, row)
                const label = `${col + 1}×${row + 1} ${state}`
                return (
                  <button
                    key={`${row}:${col}`}
                    type="button"
                    className="new-terminal-cell"
                    data-state={state}
                    aria-label={label}
                    onPointerDown={(event) => { event.preventDefault(); setIsPointerSelecting(true); commitCell(col, row) }}
                    onPointerEnter={(event) => previewCell(col, row, isPointerSelecting || event.buttons > 0)}
                    onPointerMove={(event) => previewCell(col, row, isPointerSelecting || event.buttons > 0)}
                    onFocus={() => setPreviewSelection(selectionFromCell(col, row))}
                  />
                )
              })
            ))}
          </div>
          <div className="new-terminal-legend" aria-hidden="true">
            <span data-state="occupied">Occupied</span>
            <span data-state="available">Available</span>
            <span data-state="selected">Selected</span>
          </div>
          <div className="new-terminal-custom">
            <label>
              X
              <input type="number" min="1" max="20" value={selection.cols} onChange={(event) => commitDimensions(clampGridCols(Number(event.target.value)), selection.rows)} />
            </label>
            <label>
              Y
              <input type="number" min="1" max="10" value={selection.rows} onChange={(event) => commitDimensions(selection.cols, clampGridRows(Number(event.target.value)))} />
            </label>
            <button type="button" className="primary-action" disabled={newPaneCount <= 0 || selectedProfileUnavailable} onClick={launchSelection}>Create</button>
          </div>
        </section>
      ) : null}
    </div>
  )
}
