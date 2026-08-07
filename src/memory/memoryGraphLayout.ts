import type { MemoryGraph, MemoryGraphEdge, MemoryGraphNode } from './memoryGraph'

export type LaidOutNode = MemoryGraphNode & { x: number; y: number }

export function layoutMemoryGraph(
  graph: MemoryGraph,
  options: { width: number; height: number; iterations?: number },
): { nodes: LaidOutNode[]; edges: MemoryGraphEdge[] } {
  const { width, height } = options
  const iterations = options.iterations ?? 120
  const count = graph.nodes.length
  if (count === 0) return { nodes: [], edges: graph.edges }

  const radiusScale = 0.45 * Math.min(width, height)
  const nodes: LaidOutNode[] = graph.nodes.map((node, index) => {
    const angle = index * 2.399963229728653
    const radius = radiusScale * Math.sqrt(index / count)
    return {
      ...node,
      x: width / 2 + Math.cos(angle) * radius,
      y: height / 2 + Math.sin(angle) * radius,
    }
  })
  const nodeIndexes = new Map(nodes.map((node, index) => [node.id, index]))
  const k = Math.max(0.01, Math.sqrt((width * height) / count))

  // ponytail: O(n²) per iteration, capped at MEMORY_SNAPSHOT_MAX nodes; Barnes-Hut only if a real workspace exceeds it.
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const dx = new Array<number>(count).fill(0)
    const dy = new Array<number>(count).fill(0)

    for (let a = 0; a < count; a += 1) {
      for (let b = a + 1; b < count; b += 1) {
        const deltaX = nodes[a].x - nodes[b].x
        const deltaY = nodes[a].y - nodes[b].y
        const distance = Math.max(0.01, Math.hypot(deltaX, deltaY))
        const force = (k * k) / distance
        const forceX = (deltaX / distance) * force
        const forceY = (deltaY / distance) * force
        dx[a] += forceX
        dy[a] += forceY
        dx[b] -= forceX
        dy[b] -= forceY
      }
    }

    for (const edge of graph.edges) {
      const source = nodeIndexes.get(edge.source)
      const target = nodeIndexes.get(edge.target)
      if (source === undefined || target === undefined) continue
      const deltaX = nodes[source].x - nodes[target].x
      const deltaY = nodes[source].y - nodes[target].y
      const distance = Math.max(0.01, Math.hypot(deltaX, deltaY))
      const force = (distance * distance) / k
      const forceX = (deltaX / distance) * force
      const forceY = (deltaY / distance) * force
      dx[source] -= forceX
      dy[source] -= forceY
      dx[target] += forceX
      dy[target] += forceY
    }

    const temperature = (width / 10) * (1 - iteration / Math.max(1, iterations - 1))
    for (let index = 0; index < count; index += 1) {
      const displacement = Math.max(0.01, Math.hypot(dx[index], dy[index]))
      const step = Math.min(displacement, temperature)
      nodes[index].x = Math.max(0, Math.min(width, nodes[index].x + (dx[index] / displacement) * step))
      nodes[index].y = Math.max(0, Math.min(height, nodes[index].y + (dy[index] / displacement) * step))
    }
  }

  return { nodes, edges: graph.edges }
}
