import { describe, expect, it } from 'vitest'
import { findImageMarkerMatches, findPathMatches } from './links'

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
