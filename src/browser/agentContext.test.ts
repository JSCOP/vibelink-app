import { describe, expect, it } from 'vitest'
import { browserAnnotationDeliveryPayload, formatBrowserAnnotation } from './agentContext'
import type { BrowserAnnotation } from './types'

const annotation: BrowserAnnotation = {
  id: 'annotation-1',
  workspaceId: 'workspace-1',
  pageId: 'page-1',
  navigationGeneration: 4,
  url: 'http://localhost:1420',
  browserRef: 'button#save',
  accessibleName: 'Save',
  domAncestry: ['html', 'body', 'button#save'],
  bounds: { x: 10, y: 20, width: 120, height: 32, scaleFactorMilli: 1000 },
  text: 'Save changes',
  attributes: [['id', 'save']],
  computedStyles: [['display', 'block']],
  sourceHints: ['src/App.tsx'],
  comment: 'Use the primary accent.',
  screenshot: { path: 'C:/artifacts/design-crop.png', contentType: 'image/png', bytes: 321, expiresAtMs: Number.MAX_SAFE_INTEGER, truncated: false },
}

describe('browser annotation formatting', () => {
  it('keeps exact page/generation/artifact identity in the structured prompt', () => {
    const prompt = formatBrowserAnnotation(annotation)
    expect(prompt).toContain('Annotation: annotation-1')
    expect(prompt).toContain('Navigation generation: 4')
    expect(prompt).toContain('Screenshot crop: C:/artifacts/design-crop.png')
    expect(prompt).toContain('Comment: Use the primary accent.')
  })

  it('returns the exact pane transport payload without using clipboard as transport', () => {
    expect(browserAnnotationDeliveryPayload(annotation, { kind: 'terminal', paneId: 'pane-1', title: 'Codex', role: 'Builder' })).toEqual({
      destination: { kind: 'terminal', paneId: 'pane-1', title: 'Codex', role: 'Builder' },
      prompt: formatBrowserAnnotation(annotation),
      artifactPath: 'C:/artifacts/design-crop.png',
      paneId: 'pane-1',
    })
  })
})
