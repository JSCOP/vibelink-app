import { describe, expect, it } from 'vitest'
import { desktopSelectionPayload } from './desktopSelection'

describe('desktopSelectionPayload', () => {
  it('projects the active workspace and pane', () => {
    expect(desktopSelectionPayload('workspace-1', 'pane-1')).toEqual({
      workspaceId: 'workspace-1',
      paneId: 'pane-1',
    })
  })

  it('keeps a workspace selection when no terminal pane is active', () => {
    expect(desktopSelectionPayload('workspace-1', undefined)).toEqual({
      workspaceId: 'workspace-1',
      paneId: null,
    })
  })

  it('clears a stale pane whenever the workspace is cleared', () => {
    expect(desktopSelectionPayload(undefined, 'stale-pane')).toEqual({
      workspaceId: null,
      paneId: null,
    })
  })
})
