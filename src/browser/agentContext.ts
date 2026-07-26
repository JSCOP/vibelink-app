import type { BrowserAnnotation } from './types'

export function formatBrowserAnnotation(annotation: BrowserAnnotation): string {
  const attributes = annotation.attributes.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(', ')
  const styles = annotation.computedStyles.map(([name, value]) => `${name}: ${value}`).join('; ')
  return [
    'Update the selected browser element in this workspace and verify the result in VibeLink Browser.',
    `Annotation: ${annotation.id}`,
    `Workspace: ${annotation.workspaceId}`,
    `Page: ${annotation.pageId}`,
    `Navigation generation: ${annotation.navigationGeneration}`,
    `URL: ${annotation.url}`,
    `Element: ${annotation.browserRef}`,
    `Accessible name: ${annotation.accessibleName || '(none)'}`,
    `DOM ancestry: ${annotation.domAncestry.join(' > ')}`,
    `Bounds: x=${annotation.bounds.x}, y=${annotation.bounds.y}, width=${annotation.bounds.width}, height=${annotation.bounds.height}`,
    `Screenshot crop: ${annotation.screenshot?.path ?? '(unavailable)'}`,
    `Comment: ${annotation.comment.trim() || '(none)'}`,
    `Text: ${annotation.text || '(none)'}`,
    `Attributes: ${attributes || '(none)'}`,
    `Computed styles: ${styles || '(none)'}`,
    `Source hints: ${annotation.sourceHints.join(', ') || '(none)'}`,
  ].join('\n')
}
