import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'

export type CaptureLinkActions = {
  onOpenPath(path: string): void
  resolveMarker(paneId: string, n: number): string | undefined
}

const URL_RE = /\b((?:https?|file):\/\/[^\s"'<>]+)/gi
const PATH_RE = /"((?:[a-zA-Z]:[\\/]|\\\\|\/|~[\\/])[^"\r\n]+)"|'((?:[a-zA-Z]:[\\/]|\\\\|\/|~[\\/])[^'\r\n]+)'|((?:[a-zA-Z]:[\\/]|\\\\)[^\s"'<>|*?\r\n]+|~[\\/][^\s"'<>|*?\r\n]+)/g
const MARKER_RE = /\[Image #(\d+)(?:,\s*\d+x\d+)?\]/g
const TRAILING_LINK_PUNCTUATION_RE = /[.,;:!?)}\]]+$/

type LinkMatch = { index: number; text: string }

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
  let cachedGroup: { key: string; links: ILink[] | undefined } | undefined

  return {
    provideLinks(bufferLineNumber, callback) {
      const group = wrappedLineGroup(term, bufferLineNumber)
      if (!group) {
        callback(undefined)
        return
      }

      const key = `${group.start}:${group.end}:${group.text}`
      if (!cachedGroup || cachedGroup.key !== key) {
        const links = findTerminalLinkMatches(group.text).map(({ index, text }) => createLink(
          rangeForVirtualSpan(group.start, term.cols, index, text.length),
          text,
          (event) => {
            if (!isModifiedClick(event)) return
            getActions().onOpenPath(text)
          },
        ))
        cachedGroup = { key, links: links.length > 0 ? links : undefined }
      }

      callback(cachedGroup.links)
    },
  }
}

export function createImageMarkerLinkProvider(term: Terminal, paneId: string, getActions: () => CaptureLinkActions): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const line = lineText(term, bufferLineNumber)
      if (!line) {
        callback(undefined)
        return
      }
      const links = findImageMarkerMatches(line).flatMap(({ index, text, n }) => {
        if (!getActions().resolveMarker(paneId, n)) return []
        return createSingleRowLink(bufferLineNumber, index, text, (event) => {
          if (!isModifiedClick(event)) return
          const path = getActions().resolveMarker(paneId, n)
          if (path) getActions().onOpenPath(path)
        })
      })
      callback(links.length > 0 ? links : undefined)
    },
  }
}

function wrappedLineGroup(term: Terminal, bufferLineNumber: number): { start: number; end: number; text: string } | undefined {
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

  const rows: string[] = []
  for (let index = startIndex; index <= endIndex; index += 1) {
    const line = buffer.getLine(index)
    if (!line) return undefined
    // Keep exactly one terminal-width slice per row; translateToString(true) would
    // trim cells and break the virtual column-to-x-coordinate mapping.
    rows.push(line.translateToString(false, 0, term.cols))
  }

  return { start: startIndex + 1, end: endIndex + 1, text: rows.join('') }
}

function rangeForVirtualSpan(startBufferLineNumber: number, cols: number, index: number, length: number): ILink['range'] {
  const endIndex = index + length - 1
  return {
    start: {
      x: (index % cols) + 1,
      y: startBufferLineNumber + Math.floor(index / cols),
    },
    end: {
      x: (endIndex % cols) + 1,
      y: startBufferLineNumber + Math.floor(endIndex / cols),
    },
  }
}

function lineText(term: Terminal, bufferLineNumber: number): string | undefined {
  return term.buffer.active.getLine(bufferLineNumber - 1)?.translateToString(true)
}

function createSingleRowLink(bufferLineNumber: number, index: number, text: string, activate: (event: MouseEvent) => void): ILink {
  return createLink({
    start: { x: index + 1, y: bufferLineNumber },
    end: { x: index + text.length, y: bufferLineNumber },
  }, text, activate)
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
