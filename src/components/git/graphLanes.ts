import type { CommitInfo } from '../../ipc/types'

export type GraphEdge = {
  fromSha: string
  toSha: string
  fromLane: number
  toLane: number
}

export type GraphLanes = {
  laneOf: Map<string, number>
  edges: GraphEdge[]
  laneCount: number
}

export function computeGraphLanes(commits: CommitInfo[]): GraphLanes {
  const active: Array<string | null> = []
  const laneOf = new Map<string, number>()
  const edges: GraphEdge[] = []
  let laneCount = 0

  for (const commit of commits) {
    let lane = active.indexOf(commit.sha)
    if (lane < 0) lane = firstFreeLane(active)
    laneOf.set(commit.sha, lane)
    laneCount = Math.max(laneCount, lane + 1)

    for (let index = 0; index < active.length; index += 1) {
      if (index !== lane && active[index] === commit.sha) active[index] = null
    }

    const [firstParent, ...additionalParents] = commit.parents
    if (firstParent) {
      const existingParentLane = active.findIndex((expected, index) => index !== lane && expected === firstParent)
      if (existingParentLane >= 0) {
        active[lane] = null
        edges.push({ fromSha: commit.sha, toSha: firstParent, fromLane: lane, toLane: existingParentLane })
      } else {
        active[lane] = firstParent
        edges.push({ fromSha: commit.sha, toSha: firstParent, fromLane: lane, toLane: lane })
      }
    } else {
      active[lane] = null
    }

    for (const parent of additionalParents) {
      let parentLane = active.indexOf(parent)
      if (parentLane < 0) {
        parentLane = firstFreeLane(active)
        active[parentLane] = parent
      }
      laneCount = Math.max(laneCount, parentLane + 1)
      edges.push({ fromSha: commit.sha, toSha: parent, fromLane: lane, toLane: parentLane })
    }

    trimTrailingFreeLanes(active)
  }

  return { laneOf, edges, laneCount }
}

function firstFreeLane(active: Array<string | null>): number {
  const lane = active.indexOf(null)
  if (lane >= 0) return lane
  active.push(null)
  return active.length - 1
}

function trimTrailingFreeLanes(active: Array<string | null>): void {
  while (active.length > 0 && active[active.length - 1] === null) active.pop()
}
