import type { IBufferCell, ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { parseTerminalOpenTarget, type TerminalOpenTarget } from './fileLinkNavigation'

export type CaptureLinkActions = {
  onOpenPath(target: TerminalOpenTarget): void
  resolveMarker(paneId: string, n: number): string | undefined
}

// URLs are ASCII by RFC 3986 (non-ASCII must be percent-encoded); excluding
// non-ASCII keeps adjacent prose such as "<url>에서" out of the link.
const URL_RE = /\b((?:https?|file):\/\/[^\s"'<>\u0080-\uffff]+)/gi
const PATH_RE = /"((?:[a-zA-Z]:[\\/]|\\\\|\/|~[\\/])[^"\r\n]+)"|'((?:[a-zA-Z]:[\\/]|\\\\|\/|~[\\/])[^'\r\n]+)'|((?:[a-zA-Z]:[\\/]|\\\\)[^\s"'<>|*?\r\n]+|~[\\/][^\s"'<>|*?\r\n]+)/g
const MARKER_RE = /\[Image #(\d+)(?:,\s*\d+x\d+)?\]/g
const TRAILING_LINK_PUNCTUATION_RE = /[.,;:!?)}\]]+$/

type LinkMatch = { index: number; text: string }
type PathLinkSpec = { range: ILink['range']; text: string; target: TerminalOpenTarget }

// Joined buffer text with, per UTF-16 unit, the 0-based virtual column of its
// cell and that cell's width. Wide (CJK) glyphs occupy two columns but one
// string unit, so match indexes cannot be used as columns directly.
type MappedLineText = { text: string; columns: number[]; widths: number[] }

export function findUrlMatches(line: string): LinkMatch[] {
  return [...line.matchAll(URL_RE)].flatMap((match) => {
    const text = match[1]
    const trimmed = trimTrailingLinkPunctuation(text)
    return trimmed.length > 0 ? [{ index: match.index, text: trimmed }] : []
  })
}

export function findPathMatches(line: string): LinkMatch[] {
  return [...line.matchAll(PATH_RE)].flatMap((match) => {
    const quoted = match[1] ?? match[2]
    const unquoted = match[3]
    const text = trimTrailingLinkPunctuation(quoted ?? unquoted)
    return text.length > 0
      ? [{ index: match.index + (quoted ? 1 : 0), text }]
      : []
  })
}

export function findTerminalLinkMatches(line: string): LinkMatch[] {
  const urls = findUrlMatches(line)
  const paths = findPathMatches(line).filter((path) => !urls.some((url) => rangesOverlap(path, url)))
  return [...urls, ...paths].sort((a, b) => a.index - b.index)
}

export function findImageMarkerMatches(line: string): { index: number; text: string; n: number }[] {
  return [...line.matchAll(MARKER_RE)].map((match) => ({
    index: match.index,
    text: match[0],
    n: Number(match[1]),
  }))
}

export function createPathLinkProvider(term: Terminal, getActions: () => CaptureLinkActions): ILinkProvider {
  let cachedGroup: { key: string; links: PathLinkSpec[] | undefined } | undefined

  return {
    provideLinks(bufferLineNumber, callback) {
      const group = wrappedLineGroup(term, bufferLineNumber)
      if (!group) {
        callback(undefined)
        return
      }

      const key = `${term.cols}:${group.start}:${group.end}:${group.text}`
      if (!cachedGroup || cachedGroup.key !== key) {
        const links = findTerminalLinkMatches(group.text).map(({ index, text }) => ({
          range: rangeForMappedSpan(group, group.start, term.cols, index, text.length),
          text,
          target: parseTerminalOpenTarget(text),
        }))
        cachedGroup = { key, links: links.length > 0 ? links : undefined }
      }

      callback(cachedGroup.links?.map(({ range, text, target }) => createLink(range, text, (event) => {
        if (!isModifiedClick(event)) return
        getActions().onOpenPath(target)
      })))
    },
  }
}

export function createImageMarkerLinkProvider(term: Terminal, paneId: string, getActions: () => CaptureLinkActions): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const row: MappedLineText = { text: '', columns: [], widths: [] }
      if (!appendMappedRow(row, term, bufferLineNumber - 1, 0, term.buffer.active.getNullCell())) {
        callback(undefined)
        return
      }
      const links = findImageMarkerMatches(row.text).flatMap(({ index, text, n }) => {
        if (!getActions().resolveMarker(paneId, n)) return []
        return createLink(rangeForMappedSpan(row, bufferLineNumber, term.cols, index, text.length), text, (event) => {
          if (!isModifiedClick(event)) return
          const path = getActions().resolveMarker(paneId, n)
          if (path) getActions().onOpenPath({ path })
        })
      })
      callback(links.length > 0 ? links : undefined)
    },
  }
}

function wrappedLineGroup(term: Terminal, bufferLineNumber: number): (MappedLineText & { start: number; end: number }) | undefined {
  const buffer = term.buffer.active
  const lineIndex = bufferLineNumber - 1
  if (!buffer.getLine(lineIndex)) return undefined

  let startIndex = lineIndex
  while (startIndex > 0 && buffer.getLine(startIndex)?.isWrapped) {
    startIndex -= 1
  }

  let endIndex = lineIndex
  while (endIndex + 1 < buffer.length && buffer.getLine(endIndex + 1)?.isWrapped) {
    endIndex += 1
  }

  const group: MappedLineText & { start: number; end: number } = { start: startIndex + 1, end: endIndex + 1, text: '', columns: [], widths: [] }
  const cell = buffer.getNullCell()
  for (let index = startIndex; index <= endIndex; index += 1) {
    if (!appendMappedRow(group, term, index, (index - startIndex) * term.cols, cell)) return undefined
  }
  return group
}

// Appends exactly one terminal-width row so the joined text keeps a precise
// unit-to-column mapping: width-0 filler cells behind wide glyphs are skipped
// and empty cells become spaces.
function appendMappedRow(target: MappedLineText, term: Terminal, lineIndex: number, columnOffset: number, cell: IBufferCell): boolean {
  const line = term.buffer.active.getLine(lineIndex)
  if (!line) return false
  for (let x = 0; x < term.cols; x += 1) {
    const loaded = line.getCell(x, cell)
    if (!loaded) break
    const width = loaded.getWidth()
    if (width === 0) continue
    const chars = loaded.getChars() || ' '
    for (let unit = 0; unit < chars.length; unit += 1) {
      target.columns.push(columnOffset + x)
      target.widths.push(width)
    }
    target.text += chars
  }
  return true
}

function rangeForMappedSpan(mapped: MappedLineText, startBufferLineNumber: number, cols: number, index: number, length: number): ILink['range'] {
  const lastIndex = index + length - 1
  const startColumn = mapped.columns[index]
  const endColumn = mapped.columns[lastIndex] + mapped.widths[lastIndex] - 1
  return {
    start: {
      x: (startColumn % cols) + 1,
      y: startBufferLineNumber + Math.floor(startColumn / cols),
    },
    end: {
      x: (endColumn % cols) + 1,
      y: startBufferLineNumber + Math.floor(endColumn / cols),
    },
  }
}

function createLink(range: ILink['range'], text: string, activate: (event: MouseEvent) => void): ILink {
  const decorations = { pointerCursor: true, underline: true }
  return {
    text,
    range,
    decorations,
    activate,
  }
}

function isModifiedClick(event: MouseEvent): boolean {
  return event.ctrlKey || event.metaKey
}

function trimTrailingLinkPunctuation(text: string): string {
  return text.replace(TRAILING_LINK_PUNCTUATION_RE, '')
}

function rangesOverlap(a: LinkMatch, b: LinkMatch): boolean {
  return a.index < b.index + b.text.length && b.index < a.index + a.text.length
}
