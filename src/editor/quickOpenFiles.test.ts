import { describe, expect, it } from 'vitest'
import { QUICK_OPEN_RESULT_LIMIT, rankQuickOpenFiles } from './quickOpenFiles'

describe('rankQuickOpenFiles', () => {
  it('ranks basename matches above directory-only matches', () => {
    expect(rankQuickOpenFiles([
      'button/archive/index.ts',
      'src/button.test.ts',
    ], 'button')).toEqual([
      'src/button.test.ts',
      'button/archive/index.ts',
    ])
  })

  it('returns no results when the query does not match', () => {
    expect(rankQuickOpenFiles(['src/App.tsx', 'README.md'], 'missing')).toEqual([])
  })

  it('caps the result count', () => {
    const paths = Array.from({ length: QUICK_OPEN_RESULT_LIMIT + 10 }, (_, index) => `src/file-${index}.ts`)
    expect(rankQuickOpenFiles(paths, 'file')).toHaveLength(QUICK_OPEN_RESULT_LIMIT)
  })

  it('keeps input order when scores are equal', () => {
    expect(rankQuickOpenFiles([
      'src/shared/config.ts',
      'test/shared/config.ts',
    ], 'config')).toEqual([
      'src/shared/config.ts',
      'test/shared/config.ts',
    ])
  })
})
