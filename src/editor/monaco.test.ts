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

  // Monaco 0.56 ships no TOML or Makefile grammar, so files that
  // `languageForPath` maps to those ids rendered completely uncolored while the
  // toolbar still claimed the right language. These must stay registered.
  test('registers the TOML and Makefile grammars Monaco does not ship', async () => {
    const { monaco } = await import('./monaco')
    const byId = new Map(monaco.languages.getLanguages().map((language) => [language.id, language]))

    expect(byId.get('toml')?.filenames).toEqual(expect.arrayContaining(['Cargo.toml', 'Cargo.lock']))
    expect(byId.get('toml')?.extensions).toContain('.toml')
    expect(byId.get('makefile')?.filenames).toEqual(expect.arrayContaining(['Makefile']))
  }, 20_000)
})
