import { describe, expect, it } from 'vitest'
import type { MemoryEntry, MemorySnapshot } from '../ipc/memory'
import { buildMemoryGraph } from './memoryGraph'

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'entry-1',
    scope: 'workspace',
    sessionId: 'workspace-1',
    title: 'Build notes',
    body: 'Use the shared build path.',
    tags: ['build'],
    refs: ['src/a.ts'],
    origin: { kind: 'harvest', sourcePath: 'AGENTS.md' },
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    readers: ['codex'],
    ...overrides,
  }
}

describe('memory graph', () => {
  it('builds the exact nodes and relationships for a harvested entry', () => {
    const snapshot: MemorySnapshot = {
      workspaces: [{ sessionId: 'workspace-1', name: 'Workspace One', workspaceFolder: 'C:/repo' }],
      entries: [entry()],
      truncated: false,
    }

    const graph = buildMemoryGraph(snapshot)

    expect(graph.nodes).toHaveLength(6)
    expect(graph.edges).toHaveLength(5)

    expect(graph.nodes.map((node) => node.id)).toEqual([
      'workspace:workspace-1',
      'document:workspace-1:AGENTS.md',
      'entry:workspace-1:entry-1',
      'tag:build',
      'agent:codex',
      'file:workspace-1:src/a.ts',
    ])
    expect(graph.edges.map((edge) => edge.id)).toEqual([
      'contains:document:workspace-1:AGENTS.md->entry:workspace-1:entry-1',
      'contains:workspace:workspace-1->document:workspace-1:AGENTS.md',
      'reads:agent:codex->document:workspace-1:AGENTS.md',
      'references:entry:workspace-1:entry-1->file:workspace-1:src/a.ts',
      'tagged:entry:workspace-1:entry-1->tag:build',
    ])
  })

  it('shares one tag node across workspaces and counts both incident edges', () => {
    const snapshot: MemorySnapshot = {
      workspaces: [
        { sessionId: 'workspace-1', name: 'Workspace One', workspaceFolder: 'C:/one' },
        { sessionId: 'workspace-2', name: 'Workspace Two', workspaceFolder: 'C:/two' },
      ],
      entries: [
        entry({ id: 'one', sessionId: 'workspace-1', readers: [] }),
        entry({ id: 'two', sessionId: 'workspace-2', readers: [] }),
      ],
      truncated: false,
    }

    const graph = buildMemoryGraph(snapshot)
    const tags = graph.nodes.filter((node) => node.id === 'tag:build')

    expect(tags).toHaveLength(1)
    expect(tags[0]).toMatchObject({ weight: 2, entryIds: ['one', 'two'] })
  })
})
