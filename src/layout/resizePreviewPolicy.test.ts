import { describe, expect, it } from 'vitest'
import { shouldShowResizeGuide } from './resizePreviewPolicy'

describe('resize preview policy', () => {
  it('hides connected resize guides on plain hover', () => {
    expect(shouldShowResizeGuide('hover', false)).toBe(false)
  })

  it('shows single-pane guides while Ctrl-hovering a handle', () => {
    expect(shouldShowResizeGuide('hover', true)).toBe(true)
  })

  it('shows resize guides during drag regardless of Ctrl', () => {
    expect(shouldShowResizeGuide('drag', false)).toBe(true)
    expect(shouldShowResizeGuide('drag', true)).toBe(true)
  })
})
