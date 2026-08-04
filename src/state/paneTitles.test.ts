import { describe, expect, it } from 'vitest'
import { loadManualPaneTitles, normalizePaneTitle, persistManualPaneTitles, shouldApplyAutoTitle } from './paneTitles'

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

  it('persists only manual title locks', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }
    persistManualPaneTitles({ 'pane-1': true, 'pane-2': false }, storage)
    expect(loadManualPaneTitles(storage)).toEqual({ 'pane-1': true })
  })
})
