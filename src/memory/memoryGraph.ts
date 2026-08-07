import type { MemoryEntry, MemorySnapshot } from '../ipc/memory'

export type MemoryNodeKind = 'workspace' | 'document' | 'entry' | 'tag' | 'agent' | 'file'
export type MemoryGraphNode = {
  id: string
  kind: MemoryNodeKind
  label: string
  weight: number
  entryIds: string[]
}
export type MemoryEdgeKind = 'contains' | 'tagged' | 'reads' | 'references'
export type MemoryGraphEdge = {
  id: string
  source: string
  target: string
  kind: MemoryEdgeKind
}
export type MemoryGraph = {
  nodes: MemoryGraphNode[]
  edges: MemoryGraphEdge[]
}

type MutableNode = MemoryGraphNode & { entries: Set<string> }

const kindOrder: Record<MemoryNodeKind, number> = {
  workspace: 0,
  document: 1,
  entry: 2,
  tag: 3,
  agent: 4,
  file: 5,
}

function workspaceKey(entry: MemoryEntry): string {
  return entry.sessionId ?? '__global__'
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function buildMemoryGraph(snapshot: MemorySnapshot): MemoryGraph {
  const nodes = new Map<string, MutableNode>()
  const edges = new Map<string, MemoryGraphEdge>()
  const workspaceNames = new Map(snapshot.workspaces.map((workspace) => [workspace.sessionId, workspace.name]))
  const storedDocuments = new Map<string, Set<string>>()
  const agentIds = new Set<string>()

  const addNode = (id: string, kind: MemoryNodeKind, label: string, entryId?: string) => {
    const node = nodes.get(id)
    if (node) {
      if (entryId) node.entries.add(entryId)
      return
    }
    nodes.set(id, { id, kind, label, weight: 0, entryIds: [], entries: new Set(entryId ? [entryId] : []) })
  }
  const addEdge = (kind: MemoryEdgeKind, source: string, target: string) => {
    const id = `${kind}:${source}->${target}`
    edges.set(id, { id, source, target, kind })
  }

  for (const workspace of snapshot.workspaces) {
    addNode(`workspace:${workspace.sessionId}`, 'workspace', workspace.name)
  }

  for (const entry of snapshot.entries) {
    const sessionId = workspaceKey(entry)
    const workspaceId = `workspace:${sessionId}`
    const sourcePath = entry.origin.kind === 'harvest' ? entry.origin.sourcePath ?? '__harvest__' : '__vibelink__'
    const documentId = `document:${sessionId}:${sourcePath}`
    const entryId = `entry:${sessionId}:${entry.id}`

    addNode(workspaceId, 'workspace', sessionId === '__global__' ? 'Global' : workspaceNames.get(sessionId) ?? sessionId, entry.id)
    addNode(documentId, 'document', sourcePath === '__vibelink__' ? 'VibeLink Memory' : sourcePath, entry.id)
    addNode(entryId, 'entry', entry.title, entry.id)
    addEdge('contains', workspaceId, documentId)
    addEdge('contains', documentId, entryId)

    if (sourcePath === '__vibelink__') {
      const documentEntries = storedDocuments.get(documentId) ?? new Set<string>()
      documentEntries.add(entry.id)
      storedDocuments.set(documentId, documentEntries)
    }

    for (const tag of entry.tags) {
      const tagId = `tag:${tag}`
      addNode(tagId, 'tag', tag, entry.id)
      addEdge('tagged', entryId, tagId)
    }
    for (const ref of entry.refs) {
      const fileId = `file:${sessionId}:${ref}`
      addNode(fileId, 'file', ref, entry.id)
      addEdge('references', entryId, fileId)
    }
    for (const agentId of entry.readers) {
      const agentNodeId = `agent:${agentId}`
      addNode(agentNodeId, 'agent', agentId, entry.id)
      addEdge('reads', agentNodeId, documentId)
      agentIds.add(agentId)
    }
  }

  for (const [documentId, entryIds] of storedDocuments) {
    for (const agentId of agentIds) {
      const agentNodeId = `agent:${agentId}`
      addEdge('reads', agentNodeId, documentId)
      const agentNode = nodes.get(agentNodeId)!
      for (const entryId of entryIds) agentNode.entries.add(entryId)
    }
  }

  for (const edge of edges.values()) {
    nodes.get(edge.source)!.weight += 1
    nodes.get(edge.target)!.weight += 1
  }

  return {
    nodes: [...nodes.values()]
      .sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || compareText(a.id, b.id))
      .map(({ entries, ...node }) => ({ ...node, entryIds: [...entries].sort(compareText) })),
    edges: [...edges.values()].sort((a, b) => compareText(a.id, b.id)),
  }
}
