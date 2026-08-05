import { describe, expect, it } from 'vitest'
import { formatBrowserAnnotation } from './agentContext'
import type { BrowserAnnotation } from './types'

const annotation: BrowserAnnotation = {
  id: 'annotation-1',
  workspaceId: 'workspace-1',
  pageId: 'page-1',
  navigationGeneration: 4,
  url: 'https://www.naver.com/',
  browserRef: 'span#shortcutArea',
  tagName: 'span',
  selector: 'span.service_icon.type_news',
  fullPath: 'body > div#wrap > ul.shortcut_list > span.service_icon.type_news',
  role: 'span',
  reactComponents: '<withErrorBoundary.>',
  htmlSnippet: '<span class="service_icon type_news"></span>',
  accessibleName: 'Save',
  nearbyText: ['뉴스', '증권'],
  ancestorPath: ['a', 'li', 'ul', 'div[role=navigation]'],
  bounds: { x: 10, y: 20, width: 44.4, height: 43.6, scaleFactorMilli: 1000 },
  text: 'Save changes',
  attributes: [['id', 'save']],
  computedStyles: [
    ['display', 'block'],
    ['position', 'relative'],
    ['font-size', '14.7px'],
    ['color', 'rgb(46, 46, 46)'],
    ['background-color', 'rgba(0, 0, 0, 0)'],
  ],
  sourceHints: ['src/App.tsx:12:4'],
  comment: 'Use the primary accent.',
  screenshot: { path: 'C:/artifacts/design-crop.png', contentType: 'image/png', bytes: 321, expiresAtMs: Number.MAX_SAFE_INTEGER, truncated: false },
}

function omit(patch: Partial<BrowserAnnotation>): BrowserAnnotation {
  return { ...annotation, ...patch }
}

describe('browser annotation formatting', () => {
  it('leads with the page and the element identity an agent needs to act', () => {
    const prompt = formatBrowserAnnotation(annotation)

    expect(prompt.startsWith('Attached browser context from https://www.naver.com/\n')).toBe(true)
    expect(prompt).toContain('Selected element:\nspan\n')
    expect(prompt).toContain('Accessible name: "Save"')
    expect(prompt).toContain('Role: span')
    expect(prompt).toContain('Selector: span.service_icon.type_news')
    expect(prompt).toContain('Source: src/App.tsx:12:4')
    expect(prompt).toContain('React: <withErrorBoundary.>')
  })

  it('rounds the rendered box so fractional layout does not leak into the prompt', () => {
    expect(formatBrowserAnnotation(annotation)).toContain('Dimensions: 44x44')
  })

  it('lists nearby siblings and both DOM paths', () => {
    const prompt = formatBrowserAnnotation(annotation)

    expect(prompt).toContain('Nearby context:\n- 뉴스\n- 증권')
    expect(prompt).toContain('Ancestor path: a > li > ul > div[role=navigation]')
    expect(prompt).toContain('Full DOM path: body > div#wrap > ul.shortcut_list > span.service_icon.type_news')
  })

  it('reports only computed styles that differ from their default', () => {
    const prompt = formatBrowserAnnotation(annotation)

    expect(prompt).toContain('  display: block')
    expect(prompt).toContain('  position: relative')
    expect(prompt).toContain('  font-size: 14.7px')
    expect(prompt).toContain('  color: rgb(46, 46, 46)')
    // A fully transparent background says nothing about how the element looks.
    expect(prompt).not.toContain('background:')
  })

  it('drops the whole computed-styles block when every value is a default', () => {
    const prompt = formatBrowserAnnotation(omit({
      computedStyles: [
        ['display', 'inline'],
        ['position', 'static'],
        ['background-color', 'rgba(0, 0, 0, 0)'],
        ['font-size', ''],
        ['color', '   '],
      ],
    }))

    expect(prompt).not.toContain('Computed styles:')
  })

  it('omits optional sections instead of printing empty headings', () => {
    const prompt = formatBrowserAnnotation(omit({
      accessibleName: '',
      role: '',
      reactComponents: '',
      htmlSnippet: '',
      text: '',
      nearbyText: [],
      ancestorPath: [],
      fullPath: '',
      sourceHints: [],
      comment: '   ',
      screenshot: null,
    }))

    for (const heading of ['Accessible name:', 'Role:', 'React:', 'Text content:', 'Nearby context:', 'HTML:', 'Ancestor path:', 'Full DOM path:', 'Source:', 'Comment:', 'Screenshot crop:']) {
      expect(prompt, heading).not.toContain(heading)
    }
    // The element still has to be identifiable.
    expect(prompt).toContain('Selector: span.service_icon.type_news')
  })

  it('carries the VibeLink comment and captured crop when the user supplied them', () => {
    const prompt = formatBrowserAnnotation(annotation)

    expect(prompt).toContain('Comment: Use the primary accent.')
    expect(prompt).toContain('Screenshot crop: C:/artifacts/design-crop.png')
  })

  it('falls back to the short ref when the page yielded no tag name', () => {
    expect(formatBrowserAnnotation(omit({ tagName: '' }))).toContain('Selected element:\nspan#shortcutArea')
  })
})
