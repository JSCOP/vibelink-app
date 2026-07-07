export type ResizePreviewInteraction = 'hover' | 'drag'

export function shouldShowResizeGuide(interaction: ResizePreviewInteraction, ctrlKey: boolean): boolean {
  return interaction === 'drag' || ctrlKey
}
