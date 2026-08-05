import type { BrowserAnnotation } from './types'

/** Computed-style rows worth showing, in Orca's order, with the "this is the
 *  default, say nothing" rule for each. A grabbed element normally carries all
 *  16 captured properties; printing them all buries the two or three that
 *  actually describe how the element looks. */
const REPORTED_STYLES: Array<{ property: string; label: string; skip?: string }> = [
  { property: 'display', label: 'display', skip: 'inline' },
  { property: 'position', label: 'position', skip: 'static' },
  { property: 'font-size', label: 'font-size' },
  { property: 'color', label: 'color' },
  { property: 'background-color', label: 'background', skip: 'rgba(0, 0, 0, 0)' },
]

/** Structured page context for the clipboard, matching the Orca benchmark's
 *  grab format so the same block can be pasted into any agent. Sections whose
 *  data the page did not provide are omitted rather than printed empty. */
export function formatBrowserAnnotation(annotation: BrowserAnnotation): string {
  const lines: string[] = []

  lines.push(`Attached browser context from ${annotation.url}`)
  lines.push('')

  lines.push('Selected element:')
  lines.push(annotation.tagName || annotation.browserRef)
  if (annotation.accessibleName) lines.push(`Accessible name: "${annotation.accessibleName}"`)
  if (annotation.role) lines.push(`Role: ${annotation.role}`)
  if (annotation.selector) lines.push(`Selector: ${annotation.selector}`)
  if (annotation.sourceHints.length > 0) lines.push(`Source: ${annotation.sourceHints.join(', ')}`)
  if (annotation.reactComponents) lines.push(`React: ${annotation.reactComponents}`)
  lines.push(`Dimensions: ${Math.round(annotation.bounds.width)}x${Math.round(annotation.bounds.height)}`)
  lines.push('')

  if (annotation.text) {
    lines.push('Text content:')
    lines.push(annotation.text)
    lines.push('')
  }

  if (annotation.nearbyText.length > 0) {
    lines.push('Nearby context:')
    for (const text of annotation.nearbyText) lines.push(`- ${text}`)
    lines.push('')
  }

  const styles = new Map(annotation.computedStyles)
  const styleLines = REPORTED_STYLES.flatMap(({ property, label, skip }) => {
    const value = styles.get(property)?.trim()
    return !value || value === skip ? [] : [`  ${label}: ${value}`]
  })
  if (styleLines.length > 0) {
    lines.push('Computed styles:')
    lines.push(...styleLines)
    lines.push('')
  }

  if (annotation.htmlSnippet) {
    lines.push('HTML:')
    lines.push(annotation.htmlSnippet)
    lines.push('')
  }

  if (annotation.ancestorPath.length > 0) {
    lines.push(`Ancestor path: ${annotation.ancestorPath.join(' > ')}`)
  }
  if (annotation.fullPath) lines.push(`Full DOM path: ${annotation.fullPath}`)

  // VibeLink-only trailing context. Orca's grab has no comment or managed crop,
  // so these stay out of the block entirely unless the user supplied them.
  if (annotation.comment.trim()) lines.push(`Comment: ${annotation.comment.trim()}`)
  if (annotation.screenshot) lines.push(`Screenshot crop: ${annotation.screenshot.path}`)

  return lines.join('\n').trimEnd()
}
