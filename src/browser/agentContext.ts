import type { DesignGrabSelection } from './types'

const AGENT_DRAFT_EVENT = 'vibelink:agent-draft'

export function publishBrowserSelectionDraft(selection: DesignGrabSelection, url: string): void {
  const attributes = selection.attributes.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(', ')
  const styles = selection.computedStyles.map(([name, value]) => `${name}: ${value}`).join('; ')
  const lines = [
    'Update the selected browser element in this workspace and verify the result in VibeLink Browser.',
    `URL: ${url}`,
    `Element: ${selection.browserRef}`,
    `Accessible name: ${selection.accessibleName || '(none)'}`,
    `DOM ancestry: ${selection.domAncestry.join(' > ')}`,
    `Bounds: x=${selection.bounds.x}, y=${selection.bounds.y}, width=${selection.bounds.width}, height=${selection.bounds.height}`,
    `Screenshot crop: ${selection.screenshotCrop?.path ?? '(unavailable)'}`,
    `Text: ${selection.text || '(none)'}`,
    `Attributes: ${attributes || '(none)'}`,
    `Computed styles: ${styles || '(none)'}`,
    `Source hints: ${selection.sourceHints.join(', ') || '(none)'}`,
  ]
  window.dispatchEvent(new CustomEvent<string>(AGENT_DRAFT_EVENT, { detail: lines.join('\n') }))
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
