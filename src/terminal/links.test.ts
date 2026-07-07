import { describe, expect, it } from 'vitest'
import { findImageMarkerMatches, findPathMatches, findTerminalLinkMatches, findUrlMatches } from './links'

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
})
