import type { BrowserAnnotation, BrowserAnnotationDestination } from './types'

const AGENT_DRAFT_EVENT = 'vibelink:agent-draft'

export type BrowserAnnotationDeliveryPayload = {
  destination: BrowserAnnotationDestination
  prompt: string
  artifactPath: string | null
  paneId: string | null
}

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

export function browserAnnotationDeliveryPayload(
  annotation: BrowserAnnotation,
  destination: BrowserAnnotationDestination,
): BrowserAnnotationDeliveryPayload {
  return {
    destination,
    prompt: formatBrowserAnnotation(annotation),
    artifactPath: annotation.screenshot?.path ?? null,
    paneId: destination.kind === 'terminal' ? destination.paneId : null,
  }
}

export function publishBrowserAnnotationDraft(annotation: BrowserAnnotation): void {
  window.dispatchEvent(new CustomEvent<string>(AGENT_DRAFT_EVENT, { detail: formatBrowserAnnotation(annotation) }))
}

export function subscribeAgentDraft(listener: (draft: string) => void): () => void {
  const handler = (event: Event) => {
    if (event instanceof CustomEvent && typeof event.detail === 'string' && event.detail.trim()) {
      listener(event.detail)
    }
  }
  window.addEventListener(AGENT_DRAFT_EVENT, handler)
  return () => window.removeEventListener(AGENT_DRAFT_EVENT, handler)
}
