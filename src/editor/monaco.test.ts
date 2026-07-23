// @vitest-environment jsdom
import { describe, expect, test } from 'vitest'

Object.defineProperty(document, 'queryCommandSupported', { configurable: true, value: () => false })

describe('Monaco runtime', () => {
  test('registers tokenizers for mapped source and Markdown languages', async () => {
    const { monaco } = await import('./monaco')
    const registered = monaco.languages.getLanguages().map((language) => language.id)

    expect(registered).toEqual(expect.arrayContaining([
      'markdown', 'typescript', 'rust', 'python', 'yaml', 'shell',
    ]))

  }, 20_000)
})
