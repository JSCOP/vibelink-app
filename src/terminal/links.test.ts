import { describe, expect, it } from 'vitest'
import type { ILink, Terminal } from '@xterm/xterm'
import { createPathLinkProvider, findImageMarkerMatches, findPathMatches, findTerminalLinkMatches, findUrlMatches } from './links'

describe('terminal link matchers', () => {
  describe('findPathMatches', () => {
    it('matches a bare Windows path', () => {
      const line = 'saved E:\\a\\b.png'

      expect(findPathMatches(line)).toEqual([
        { index: 6, text: 'E:\\a\\b.png' },
      ])
    })

    it('matches a quoted path without including the quotes', () => {
      const line = 'open "E:\\a b\\c.png" now'

      expect(findPathMatches(line)).toEqual([
        { index: 6, text: 'E:\\a b\\c.png' },
      ])
    })

    it('matches a single-quoted path without including the quotes', () => {
      const line = "open 'C:\\Program Files\\nodejs\\node.EXE' now"

      expect(findPathMatches(line)).toEqual([
        { index: 6, text: 'C:\\Program Files\\nodejs\\node.EXE' },
      ])
    })

    it('matches two paths on one line', () => {
      const line = 'files E:\\a\\b.png and C:\\tmp\\video.mp4'

      expect(findPathMatches(line)).toEqual([
        { index: 6, text: 'E:\\a\\b.png' },
        { index: 21, text: 'C:\\tmp\\video.mp4' },
      ])
    })

    it('ignores plain prose', () => {
      expect(findPathMatches('this is just plain prose')).toEqual([])
    })

    it('matches UNC and home-relative paths', () => {
      const line = 'open \\\\server\\share\\clip.mp4 and ~/captures/image.png'

      expect(findPathMatches(line)).toEqual([
        { index: 5, text: '\\\\server\\share\\clip.mp4' },
        { index: 33, text: '~/captures/image.png' },
      ])
    })
  })

  describe('findUrlMatches', () => {
    it('matches http, https, and file URLs', () => {
      const line = 'see https://example.com/a?b=1 and file:///E:/captures/a.png'

      expect(findUrlMatches(line)).toEqual([
        { index: 4, text: 'https://example.com/a?b=1' },
        { index: 34, text: 'file:///E:/captures/a.png' },
      ])
    })

    it('trims sentence punctuation from URL bounds', () => {
      expect(findUrlMatches('open (https://example.com/a), next')).toEqual([
        { index: 6, text: 'https://example.com/a' },
      ])
    })
  })

  describe('findTerminalLinkMatches', () => {
    it('deduplicates paths inside file URLs', () => {
      const line = 'file file:///E:/captures/a.png and E:\\captures\\b.mp4'

      expect(findTerminalLinkMatches(line)).toEqual([
        { index: 5, text: 'file:///E:/captures/a.png' },
        { index: 35, text: 'E:\\captures\\b.mp4' },
      ])
    })

    it('matches a path in joined wrapped text', () => {
      const line = 'run C:\\very\\deep\\x.png'

      expect(findTerminalLinkMatches(line)).toEqual([
        { index: 4, text: 'C:\\very\\deep\\x.png' },
      ])
    })
  })

  describe('findImageMarkerMatches', () => {
    it('matches image markers with dimensions and without dimensions', () => {
      const line = 'images [Image #1, 363x153] and [Image #12]'

      expect(findImageMarkerMatches(line)).toEqual([
        { index: 7, text: '[Image #1, 363x153]', n: 1 },
        { index: 31, text: '[Image #12]', n: 12 },
      ])
    })
  })

  describe('createPathLinkProvider', () => {
    it('returns one multi-row link for a soft-wrapped path', () => {
      const term = stubTerminal(12, [
        { text: 'run C:\\very\\' },
        { text: 'deep\\x.png', isWrapped: true },
      ])
      const provider = createPathLinkProvider(term, () => ({
        onOpenPath: () => {},
        resolveMarker: () => undefined,
      }))
      let firstRowLinks: ILink[] | undefined
      let continuationLinks: ILink[] | undefined

      provider.provideLinks(1, (links) => {
        firstRowLinks = links
      })
      provider.provideLinks(2, (links) => {
        continuationLinks = links
      })

      expect(firstRowLinks).toHaveLength(1)
      expect(firstRowLinks?.[0]).toMatchObject({
        text: 'C:\\very\\deep\\x.png',
        range: {
          start: { x: 5, y: 1 },
          end: { x: 10, y: 2 },
        },
      })
      expect(continuationLinks).toBe(firstRowLinks)
    })
  })
})

function stubTerminal(cols: number, rows: { text: string; isWrapped?: boolean }[]): Terminal {
  const lines = rows.map(({ text, isWrapped }) => ({
    isWrapped: Boolean(isWrapped),
    translateToString: (trimRight = false, startColumn = 0, endColumn = text.length) => {
      const value = text.slice(startColumn, endColumn)
      return trimRight ? value.replace(/\s+$/, '') : value
    },
  }))

  return {
    cols,
    buffer: {
      active: {
        length: lines.length,
        getLine: (index: number) => lines[index],
      },
    },
  } as unknown as Terminal
}
