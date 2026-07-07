import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'

export type CaptureLinkActions = {
  onOpenPath(path: string): void
  resolveMarker(paneId: string, n: number): string | undefined
}

const URL_RE = /\b((?:https?|file):\/\/[^\s"'<>]+)/gi
const PATH_RE = /"((?:[a-zA-Z]:[\\/]|\\\\|\/|~[\\/])[^"\r\n]+)"|((?:[a-zA-Z]:[\\/]|\\\\)[^\s"'<>|*?\r\n]+|~[\\/][^\s"'<>|*?\r\n]+)/g
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
    const quoted = match[1]
    const text = trimTrailingLinkPunctuation(quoted ?? match[2])
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
  return {
    provideLinks(bufferLineNumber, callback) {
      const line = lineText(term, bufferLineNumber)
      if (!line) {
        callback(undefined)
        return
      }
      const links = findTerminalLinkMatches(line).map(({ index, text }) => createLink(bufferLineNumber, index, text, (event) => {
        if (!isModifiedClick(event)) return
        getActions().onOpenPath(text)
      }))
      callback(links.length > 0 ? links : undefined)
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
        return createLink(bufferLineNumber, index, text, (event) => {
          if (!isModifiedClick(event)) return
          const path = getActions().resolveMarker(paneId, n)
          if (path) getActions().onOpenPath(path)
        })
      })
      callback(links.length > 0 ? links : undefined)
    },
  }
}

function lineText(term: Terminal, bufferLineNumber: number): string | undefined {
  return term.buffer.active.getLine(bufferLineNumber - 1)?.translateToString(true)
}

function createLink(bufferLineNumber: number, index: number, text: string, activate: (event: MouseEvent) => void): ILink {
  const decorations = { pointerCursor: true, underline: true }
  return {
    text,
    range: {
      start: { x: index + 1, y: bufferLineNumber },
      end: { x: index + text.length, y: bufferLineNumber },
    },
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
