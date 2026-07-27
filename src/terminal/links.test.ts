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

    it('keeps OMP Read line selectors inside the clickable path', () => {
      const line = 'Read E:/repo/src/App.tsx:120-230,410-450'

      expect(findPathMatches(line)).toEqual([
        { index: 5, text: 'E:/repo/src/App.tsx:120-230,410-450' },
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

    it('stops URL matches at adjacent CJK prose', () => {
      expect(findUrlMatches('그다음 http://10.40.20.2:30310/adx/console에서 확인')).toEqual([
        { index: 4, text: 'http://10.40.20.2:30310/adx/console' },
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

    it('routes a modified click to the first requested Read selector line', () => {
      const term = stubTerminal(80, [{ text: 'Read E:/repo/src/App.tsx:120-230,410-450' }])
      let opened: unknown
      const provider = createPathLinkProvider(term, () => ({
        onOpenPath: (target) => { opened = target },
        resolveMarker: () => undefined,
      }))
      let links: ILink[] | undefined
      provider.provideLinks(1, (found) => { links = found })

      ;(links?.[0].activate as (event: MouseEvent) => void)({ ctrlKey: true, metaKey: false } as MouseEvent)

      expect(opened).toEqual({
        path: 'E:/repo/src/App.tsx',
        location: { lineNumber: 120, column: 1 },
      })
    })

    it('underlines the exact URL cells after wide CJK glyphs', () => {
      // 그(2)다(2)음(2)␠(1) puts the URL at column 7 even though its string index is 4.
      const term = stubTerminal(40, [{ text: '그다음 http://x.com/a에서 확인' }])
      const provider = createPathLinkProvider(term, () => ({
        onOpenPath: () => {},
        resolveMarker: () => undefined,
      }))
      let links: ILink[] | undefined

      provider.provideLinks(1, (found) => {
        links = found
      })

      expect(links).toHaveLength(1)
      expect(links?.[0]).toMatchObject({
        text: 'http://x.com/a',
        range: {
          start: { x: 8, y: 1 },
          end: { x: 21, y: 1 },
        },
      })
    })

    it('extends the underline across a trailing wide glyph in a path', () => {
      const term = stubTerminal(40, [{ text: 'open E:\\캡처 done' }])
      const provider = createPathLinkProvider(term, () => ({
        onOpenPath: () => {},
        resolveMarker: () => undefined,
      }))
      let links: ILink[] | undefined

      provider.provideLinks(1, (found) => {
        links = found
      })

      expect(links).toHaveLength(1)
      expect(links?.[0]).toMatchObject({
        text: 'E:\\캡처',
        range: {
          start: { x: 6, y: 1 },
          end: { x: 12, y: 1 },
        },
      })
    })
  })
})

const WIDE_CHAR_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFF00-\uFF60]/

type StubCell = { chars: string; width: number }

function stubTerminal(cols: number, rows: { text: string; isWrapped?: boolean }[]): Terminal {
  const lines = rows.map(({ text, isWrapped }) => {
    const cells: StubCell[] = []
    for (const char of text) {
      const width = WIDE_CHAR_RE.test(char) ? 2 : 1
      cells.push({ chars: char, width })
      if (width === 2) cells.push({ chars: '', width: 0 })
    }
    while (cells.length < cols) cells.push({ chars: '', width: 1 })
    return {
      isWrapped: Boolean(isWrapped),
      getCell: (x: number) => {
        const cell = cells[x]
        return cell && {
          getChars: () => cell.chars,
          getWidth: () => cell.width,
        }
      },
    }
  })

  return {
    cols,
    buffer: {
      active: {
        length: lines.length,
        getLine: (index: number) => lines[index],
        getNullCell: () => ({}),
      },
    },
  } as unknown as Terminal
}
