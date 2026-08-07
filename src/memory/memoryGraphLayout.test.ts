import { describe, expect, it } from 'vitest'
import type { MemoryGraph } from './memoryGraph'
import { layoutMemoryGraph } from './memoryGraphLayout'

const graph: MemoryGraph = {
  nodes: [
    { id: 'entry:a', kind: 'entry', label: 'A', weight: 1, entryIds: ['a'] },
    { id: 'entry:b', kind: 'entry', label: 'B', weight: 1, entryIds: ['b'] },
    { id: 'entry:c', kind: 'entry', label: 'C', weight: 0, entryIds: ['c'] },
  ],
  edges: [
    { id: 'contains:entry:a->entry:b', source: 'entry:a', target: 'entry:b', kind: 'contains' },
  ],
}

function distance(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

describe('memory graph layout', () => {
  it('is byte-identical across repeated runs', () => {
    const options = { width: 800, height: 600, iterations: 80 }

    expect(JSON.stringify(layoutMemoryGraph(graph, options))).toBe(JSON.stringify(layoutMemoryGraph(graph, options)))
  })

  it('places connected nodes closer than unconnected nodes', () => {
    const result = layoutMemoryGraph(graph, { width: 800, height: 600 })
    const nodes = new Map(result.nodes.map((node) => [node.id, node]))
    const a = nodes.get('entry:a')!
    const b = nodes.get('entry:b')!
    const c = nodes.get('entry:c')!

    expect(distance(a, b)).toBeLessThan(distance(a, c))
    expect(distance(a, b)).toBeLessThan(distance(b, c))
  })
})
