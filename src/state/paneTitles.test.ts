import { describe, expect, it } from 'vitest'
import { normalizePaneTitle, shouldApplyAutoTitle } from './paneTitles'

describe('pane title policy', () => {
  it('normalizes agent-emitted OSC titles', () => {
    expect(normalizePaneTitle('  Codex: implement workspace drawer  ')).toBe('Codex: implement workspace drawer')
  })

  it('rejects empty auto titles', () => {
    expect(normalizePaneTitle('\n\t')).toBeNull()
  })

  it('does not overwrite a manually renamed pane with auto title updates', () => {
    expect(shouldApplyAutoTitle('pane-1', { 'pane-1': true })).toBe(false)
    expect(shouldApplyAutoTitle('pane-2', { 'pane-1': true })).toBe(true)
  })
})
