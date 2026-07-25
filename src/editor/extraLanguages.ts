import type * as Monaco from 'monaco-editor'

/**
 * Monaco 0.56 ships 89 Monarch grammars, but TOML and Makefile are NOT among
 * them (`monaco-editor/esm/vs/languages/definitions` has no `toml`/`makefile`
 * directory). `languageForPath` already maps `Cargo.toml`/`Cargo.lock`/`*.toml`
 * to `toml` and `Makefile` to `makefile`, so the editor reported the right
 * language in its toolbar while every token stayed default `mtk1` — the
 * "why is Cargo.toml not colored, but Markdown is?" bug. Markdown works because
 * Monaco DOES ship a `markdown` grammar.
 *
 * These definitions use the same token names our theme already maps in
 * `monacoTheme.ts`, so the colors match every VibeLink theme automatically.
 */

const tomlConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '#' },
  brackets: [['{', '}'], ['[', ']']],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '"', close: '"', notIn: ['string'] },
    { open: "'", close: "'", notIn: ['string'] },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
}

const tomlLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.toml',
  keywords: ['true', 'false'],
  // Order matters: table headers and keys must win before the generic
  // identifier rule, and dates must win before plain numbers.
  tokenizer: {
    root: [
      [/^\s*#.*$/, 'comment'],
      // [table] and [[array.of.tables]]
      [/^\s*\[\[.*?\]\]/, 'metatag'],
      [/^\s*\[.*?\]/, 'metatag'],
      // bare / quoted / dotted key before '='
      [/(^\s*)([\w.-]+|"[^"]*"|'[^']*')(\s*)(=)/, ['', 'string.key', '', 'delimiter']],
      // key inside an inline table
      [/([{,]\s*)([\w.-]+)(\s*)(=)/, ['delimiter', 'string.key', '', 'delimiter']],
      { include: '@value' },
    ],
    value: [
      [/#.*$/, 'comment'],
      // RFC 3339 date-times / dates / times — before @numbers so the dashes
      // and colons are not split into number + operator noise.
      [/\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?/, 'number'],
      [/\d{2}:\d{2}:\d{2}(\.\d+)?/, 'number'],
      [/\b(?:true|false)\b/, 'constant.language'],
      [/\b(?:inf|nan)\b/, 'constant.language'],
      [/0x[0-9A-Fa-f](?:[0-9A-Fa-f_]*)/, 'number.hex'],
      [/0o[0-7][0-7_]*/, 'number'],
      [/0b[01][01_]*/, 'number'],
      [/[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/, 'number'],
      [/"""/, 'string', '@multiLineBasic'],
      [/'''/, 'string', '@multiLineLiteral'],
      [/"/, 'string', '@basicString'],
      [/'/, 'string', '@literalString'],
      [/[[\]{}]/, 'delimiter.bracket'],
      [/[=,.]/, 'delimiter'],
    ],
    multiLineBasic: [
      [/[^"\\]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"""/, 'string', '@pop'],
      [/"/, 'string'],
    ],
    multiLineLiteral: [
      [/[^']+/, 'string'],
      [/'''/, 'string', '@pop'],
      [/'/, 'string'],
    ],
    basicString: [
      [/[^"\\]+/, 'string'],
      [/\\(?:[btnfr"\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/"/, 'string', '@pop'],
    ],
    literalString: [
      [/[^']+/, 'string'],
      [/'/, 'string', '@pop'],
    ],
  },
}

const makefileConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '#' },
  brackets: [['{', '}'], ['[', ']'], ['(', ')']],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
}

const makefileLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.make',
  keywords: [
    'define', 'endef', 'undefine', 'ifdef', 'ifndef', 'ifeq', 'ifneq',
    'else', 'endif', 'include', '-include', 'sinclude', 'override',
    'export', 'unexport', 'private', 'vpath',
  ],
  tokenizer: {
    root: [
      [/^\t.*$/, 'string'],
      [/#.*$/, 'comment'],
      [/^\.[A-Z][A-Z_]*\b/, 'keyword.flow'],
      [/^[-\w.]+(?=\s*:(?!=))/, 'type.identifier'],
      [/\$[({][^)}]*[)}]/, 'variable'],
      [/\$[@<^?*+%]/, 'variable.predefined'],
      [/^\s*([-\w.]+)\b/, {
        cases: { '@keywords': 'keyword', '@default': 'identifier' },
      }],
      [/[:+?!]?=/, 'delimiter'],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/'([^'\\]|\\.)*'/, 'string'],
      [/\b\d+\b/, 'number'],
      [/[:;|&]/, 'delimiter'],
    ],
  },
}

const extraLanguages = [
  {
    id: 'toml',
    extensions: ['.toml'],
    filenames: ['Cargo.lock', 'Cargo.toml', 'poetry.lock'],
    aliases: ['TOML', 'toml'],
    configuration: tomlConfiguration,
    language: tomlLanguage,
  },
  {
    id: 'makefile',
    extensions: ['.mak', '.mk'],
    filenames: ['Makefile', 'makefile', 'GNUmakefile', 'OCamlMakefile'],
    aliases: ['Makefile', 'makefile'],
    configuration: makefileConfiguration,
    language: makefileLanguage,
  },
]

/**
 * Registers only the languages Monaco does not ship. Idempotent: a language
 * already known to the registry (a future Monaco bump, or a second call) is
 * skipped so we never shadow an upstream grammar.
 *
 * The grammar and configuration are attached lazily through `onLanguage`, the
 * same way Monaco's own `register.js` files do it. Calling
 * `setMonarchTokensProvider` eagerly instantiates the standalone theme service
 * (it builds an icon stylesheet through `CSS.escape`), which is unavailable
 * outside a real browser and would make importing this module fail in jsdom.
 */
export function registerExtraMonacoLanguages(monaco: typeof Monaco): void {
  const known = new Set(monaco.languages.getLanguages().map((language) => language.id))
  for (const entry of extraLanguages) {
    if (known.has(entry.id)) continue
    monaco.languages.register({
      id: entry.id,
      extensions: entry.extensions,
      filenames: entry.filenames,
      aliases: entry.aliases,
    })
    monaco.languages.onLanguage(entry.id, () => {
      monaco.languages.setLanguageConfiguration(entry.id, entry.configuration)
      monaco.languages.setMonarchTokensProvider(entry.id, entry.language)
    })
  }
}
