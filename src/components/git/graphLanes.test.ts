import { describe, expect, test } from 'vitest'
import type { CommitInfo } from '../../ipc/types'
import { computeGraphLanes } from './graphLanes'

function commit(sha: string, parents: string[] = []): CommitInfo {
  return { sha, parents, refs: [], authorName: 'A', authorEmail: 'a@example.com', authorDate: '2026-01-01T00:00:00Z', subject: sha }
}

function lanes(commits: CommitInfo[]): Record<string, number> {
  return Object.fromEntries(computeGraphLanes(commits).laneOf)
}

describe('computeGraphLanes', () => {
  test('keeps a linear history on lane zero', () => {
    const graph = computeGraphLanes([commit('A', ['B']), commit('B', ['C']), commit('C')])
    expect(Object.fromEntries(graph.laneOf)).toEqual({ A: 0, B: 0, C: 0 })
    expect(graph.laneCount).toBe(1)
  })

  test('allocates and rejoins a branch at a merge', () => {
    const graph = computeGraphLanes([
      commit('M', ['A', 'B']),
      commit('A', ['R']),
      commit('B', ['R']),
      commit('R'),
    ])
    expect(Object.fromEntries(graph.laneOf)).toEqual({ M: 0, A: 0, B: 1, R: 0 })
    expect(graph.edges).toContainEqual({ fromSha: 'B', toSha: 'R', fromLane: 1, toLane: 0 })
    expect(graph.laneCount).toBe(2)
  })

  test('assigns one lane per octopus parent', () => {
    const graph = computeGraphLanes([
      commit('M', ['A', 'B', 'C']),
      commit('A'),
      commit('B'),
      commit('C'),
    ])
    expect(Object.fromEntries(graph.laneOf)).toEqual({ M: 0, A: 0, B: 1, C: 2 })
    expect(graph.laneCount).toBe(3)
  })

  test('reuses the lowest lane for disconnected roots', () => {
    expect(lanes([commit('A'), commit('B')])).toEqual({ A: 0, B: 0 })
  })
})
