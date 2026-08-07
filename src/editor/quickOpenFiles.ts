import { fuzzyScore } from '../components/palette/paletteModel'

export const QUICK_OPEN_RESULT_LIMIT = 100

export function rankQuickOpenFiles(paths: string[], query: string): string[] {
  const filter = query.trim()
  return paths
    .map((path, index) => {
      const basename = path.split('/').at(-1) ?? path
      const basenameScore = fuzzyScore(filter, basename)
      const pathScore = fuzzyScore(filter, path)
      // A fixed bonus makes filename matches beat matches found only in parent folders.
      const score = basenameScore >= 0 ? basenameScore + 10_000 : pathScore
      return { path, index, score }
    })
    .filter((result) => result.score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, QUICK_OPEN_RESULT_LIMIT)
    .map((result) => result.path)
}
