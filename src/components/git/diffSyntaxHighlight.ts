import { languageForPath } from '../../editor/languageForPath'
import { registerVibeLinkMonacoThemes } from '../../editor/monacoTheme'
import type { MonacoModule } from '../../editor/monacoTheme'

/**
 * Per-line syntax highlighting for the Git diff view.
 *
 * `react-diff-viewer-continued` exposes a synchronous `renderContent(source)`
 * hook, but Monaco's `editor.colorize` is asynchronous. We therefore colorize
 * the whole old/new documents ahead of time (which preserves multi-line token
 * context such as block comments and template strings), split the resulting
 * HTML — Monaco joins colorized lines with `<br/>` — and index each line's HTML
 * by its exact source text. `renderContent` then does a synchronous lookup.
 *
 * A line-text key can collide across the two sides or repeat within a file; the
 * highlighting is identical for identical text in the vast majority of cases,
 * so a shared map is correct in practice and only ever loses context on rare
 * duplicate lines that open/close multi-line tokens differently.
 */
export type DiffHighlightMap = Map<string, string>

const TAB_SIZE = 2

function stripTrailingNewline(value: string): string[] {
  const normalized = value.endsWith('\n') ? value.slice(0, -1) : value
  return normalized.split('\n')
}

async function colorizeInto(map: DiffHighlightMap, text: string, languageId: string, monaco: MonacoModule): Promise<void> {
  if (!text) return
  const html = await monaco.editor.colorize(text, languageId, { tabSize: TAB_SIZE })
  const htmlLines = html.split('<br/>')
  const sourceLines = stripTrailingNewline(text)
  const count = Math.min(htmlLines.length, sourceLines.length)
  for (let index = 0; index < count; index += 1) {
    const source = sourceLines[index]
    // Keep the first mapping for a given source line; later duplicates are
    // visually equivalent and re-inserting only churns the map.
    if (!map.has(source)) map.set(source, htmlLines[index])
  }
}

/**
 * Build a source-line -> colorized-HTML map for the two sides of a diff.
 * Returns `null` when the file is plaintext (nothing to highlight) or Monaco
 * colorization is unavailable (e.g. during tests), so callers fall back to
 * the library's default plain-text rendering.
 */
export async function buildDiffHighlightMap(
  path: string | null,
  oldValue: string,
  newValue: string,
  terminalThemeId: string,
): Promise<DiffHighlightMap | null> {
  if (!path) return null
  const languageId = languageForPath(path)
  if (languageId === 'plaintext') return null
  try {
    // Monaco is intentionally lazy here: eager editor bootstrap breaks the
    // diff module's non-DOM tests and loads the full editor in plain-text diffs.
    const { monaco } = await import('../../editor/monaco')
    const themeName = registerVibeLinkMonacoThemes(monaco, terminalThemeId)
    monaco.editor.setTheme(themeName)
    const map: DiffHighlightMap = new Map()
    await colorizeInto(map, oldValue, languageId, monaco)
    await colorizeInto(map, newValue, languageId, monaco)
    return map.size > 0 ? map : null
  } catch {
    return null
  }
}
