import { Sizing, type SplitSizing } from 'dockview-core'

export type LocalSplitDirection = 'right' | 'below'

export type LocalSplitInitialSize = {
  initialWidth?: SplitSizing
  initialHeight?: SplitSizing
}

type ResizableDockviewGroup = {
  api: {
    setSize(size: { width?: number; height?: number }): void
  }
}

export function localSplitSiblingIndex(referenceLocation: readonly number[]): number {
  return Math.max(0, referenceLocation.at(-1) ?? 0)
}

/**
 * Dockview's default add-panel sizing redistributes every sibling on the same
 * axis. A direct terminal split should instead halve only the selected pane,
 * preserving the space owned by every unrelated pane.
 */
export function localSplitInitialSize(
  referenceLocation: readonly number[],
  direction: LocalSplitDirection,
): LocalSplitInitialSize {
  const sizing = Sizing.Split(localSplitSiblingIndex(referenceLocation))
  return direction === 'right'
    ? { initialWidth: sizing }
    : { initialHeight: sizing }
}

export function finalizeLocalSplitSize(
  referenceGroup: ResizableDockviewGroup,
  createdGroup: ResizableDockviewGroup,
  direction: LocalSplitDirection,
  referenceSize: number,
): void {
  const half = Math.max(1, Math.floor(referenceSize / 2))
  const size = direction === 'right' ? { width: half } : { height: half }
  referenceGroup.api.setSize(size)
  createdGroup.api.setSize(size)
}
