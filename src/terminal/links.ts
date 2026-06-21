import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'

export type CaptureLinkActions = {
  onOpenPath(path: string): void
  resolveMarker(paneId: string, n: number): string | undefined
}

const PATH_RE = /"([a-zA-Z]:[\\/][^"\r\n]+)"|([a-zA-Z]:[\\/][^\s"'<>|*?\r\n]+)/g
const MARKER_RE = /\[Image #(\d+)(?:,\s*\d+x\d+)?\]/g

export function findPathMatches(line: string): { index: number; text: string }[] {
  return [...line.matchAll(PATH_RE)].map((match) => ({
    index: match.index + (match[1] ? 1 : 0),
    text: match[1] ?? match[2],
  }))
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
      const links = findPathMatches(line).map(({ index, text }) => createLink(bufferLineNumber, index, text, (event) => {
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
  const decorations = { pointerCursor: false, underline: false }
  return {
    text,
    range: {
      start: { x: index + 1, y: bufferLineNumber },
      end: { x: index + text.length, y: bufferLineNumber },
    },
    decorations,
    hover(event) {
      const active = isModifiedClick(event)
      decorations.pointerCursor = active
      decorations.underline = active
    },
    leave() {
      decorations.pointerCursor = false
      decorations.underline = false
    },
    activate,
  }
}

function isModifiedClick(event: MouseEvent): boolean {
  return event.ctrlKey || event.metaKey
}
