import { afterEach, describe, expect, test, vi } from 'vitest'
import { applyThemeToDocument } from './themePreview'

describe('applyThemeToDocument', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('applies highlight colors after theme variables and preserves them across theme changes', () => {
    const properties: Record<string, string> = {}
    const dataset: Record<string, string> = {}
    const setProperty = vi.fn((name: string, value: string) => {
      properties[name] = value
    })
    const root = {
      dataset,
      style: {
        colorScheme: '',
        setProperty,
      },
    }
    vi.stubGlobal('document', { documentElement: root })

    applyThemeToDocument('tokyoNight', '#112233', '#445566', '#778899')

    expect(setProperty.mock.calls.slice(-3).map(([name]) => name)).toEqual([
      '--vibelink-selected-pane-highlight',
      '--vibelink-alarm-highlight',
      '--vibelink-reviewed-pane-highlight',
    ])
    expect(properties['--vibelink-selected-pane-highlight']).toBe('#112233')
    expect(properties['--vibelink-alarm-highlight']).toBe('#445566')
    expect(properties['--vibelink-reviewed-pane-highlight']).toBe('#778899')

    applyThemeToDocument('solarizedLight', '#112233', '#445566', '#778899')

    expect(root.dataset.vibelinkTheme).toBe('solarizedLight')
    expect(root.style.colorScheme).toBe('light')
    expect(properties['--vibelink-selected-pane-highlight']).toBe('#112233')
    expect(properties['--vibelink-alarm-highlight']).toBe('#445566')
    expect(properties['--vibelink-reviewed-pane-highlight']).toBe('#778899')
    expect(setProperty.mock.calls.slice(-3).map(([name]) => name)).toEqual([
      '--vibelink-selected-pane-highlight',
      '--vibelink-alarm-highlight',
      '--vibelink-reviewed-pane-highlight',
    ])
  })
})
