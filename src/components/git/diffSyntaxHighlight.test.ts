// @vitest-environment jsdom
import { describe, expect, test } from 'vitest'
import { terminalThemeDefinitionById } from '../../state/terminalThemes'
import { buildDiffHighlightMap } from './diffSyntaxHighlight'

Object.defineProperty(document, 'queryCommandSupported', { configurable: true, value: () => false })
Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { escape: (value: string) => value } })
Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }) })

describe('Git diff syntax highlighting', () => {
  test('uses the selected VibeLink Monaco theme and emits distinct Markdown token colors', async () => {
    const themeId = 'monokai'
    const theme = terminalThemeDefinitionById(themeId)
    const map = await buildDiffHighlightMap(
      'README.md',
      '# Heading\n\n```ts\nconst value = "text"\n```\n',
      '# Heading changed\n\n```ts\nconst value = "next"\n```\n',
      themeId,
    )

    expect(map).not.toBeNull()
    expect(map?.get('# Heading')).toMatch(/class="mtk\d+/)
    const tokenClasses = new Set(
      [...(map?.values() ?? [])].flatMap((html) => [...html.matchAll(/class="(mtk\d+)/g)].map((match) => match[1])),
    )
    expect(tokenClasses.size).toBeGreaterThan(1)

    const monacoCss = [...document.querySelectorAll('style.monaco-colors')].map((style) => style.textContent ?? '').join('\n').toLowerCase()
    expect(monacoCss).toContain(theme.terminal.blue.toLowerCase())
    expect(monacoCss).toContain(theme.terminal.green.toLowerCase())
    // Loads the real Monaco bundle transitively; see monaco.test.ts.
  }, 60_000)
})
