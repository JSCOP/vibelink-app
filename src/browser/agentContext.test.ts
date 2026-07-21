// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { publishBrowserSelectionDraft, subscribeAgentDraft } from './agentContext'
import type { DesignGrabSelection } from './types'

const selection: DesignGrabSelection = {
  pageId: 'page-a',
  navigationGeneration: 1,
  snapshotId: 'design-1',
  browserRef: 'button#save',
  screenshotCrop: { path: 'C:/artifacts/design-crop.png', contentType: 'image/png', bytes: 321, expiresAtMs: 1234, truncated: false },
  domAncestry: ['html', 'body', 'button#save'],
  accessibleName: 'Save',
  bounds: { x: 10, y: 20, width: 80, height: 32, scaleFactorMilli: 1000 },
  computedStyles: [['color', 'rgb(255, 255, 255)']],
  attributes: [['id', 'save']],
  text: 'Save changes',
  sourceHints: ['src/App.tsx'],
}

describe('browser Agent context bridge', () => {
  it('publishes structured selected-element context without auto-sending it', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeAgentDraft(listener)
    publishBrowserSelectionDraft(selection, 'http://localhost:5173/settings')
    unsubscribe()

    expect(listener).toHaveBeenCalledTimes(1)
    const draft = listener.mock.calls[0][0] as string
    expect(draft).toContain('URL: http://localhost:5173/settings')
    expect(draft).toContain('Element: button#save')
    expect(draft).toContain('Source hints: src/App.tsx')
    expect(draft).toContain('Screenshot crop: C:/artifacts/design-crop.png')
  })
})
