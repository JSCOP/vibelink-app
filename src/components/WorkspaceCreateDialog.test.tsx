import { renderToString } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { defaultSettings } from '../state/profiles'
import { WorkspaceCreateDialog } from './WorkspaceCreateDialog'

describe('WorkspaceCreateDialog', () => {
  test('creates a workspace without offering a starting terminal grid', () => {
    const html = renderToString(
      <WorkspaceCreateDialog
        profiles={defaultSettings.profiles}
        defaultProfileId={defaultSettings.defaultProfileId}
        onCreate={() => undefined}
        onClose={() => undefined}
      />,
    )

    expect(html).toContain('Create a workspace')
    expect(html).toContain('Create workspace')
    expect(html).not.toContain('Choose a starting grid')
    expect(html).not.toContain('workspace-template-grid')
    expect(html).not.toContain(' panes')
  })
})
