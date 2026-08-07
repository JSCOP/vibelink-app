import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, Link2, PanelRightClose, PanelRightOpen, Pin, PinOff, Plus, RotateCw, Search, Trash2, X } from 'lucide-react'
import {
  addMemory,
  fetchMemorySnapshot,
  fetchProjectionStatus,
  removeMemory,
  setMemoryLink,
  setMemoryPinned,
  type MemoryEntry,
  type MemoryProjectionStatus,
  type MemoryScope,
  type MemorySnapshot,
  type MemoryWorkspaceRef,
} from '../../ipc/memory'
import { buildMemoryGraph, type MemoryGraph, type MemoryGraphNode, type MemoryNodeKind } from '../../memory/memoryGraph'
import { layoutMemoryGraph } from '../../memory/memoryGraphLayout'
import { useWorkspaceContentActions } from '../../layout/contentActions'
import { useWorkspaceStore } from '../../state/store'
import { ProfileIcon } from '../ProfileIcon'

/** Layout box in graph units. The SVG `viewBox` maps it onto whatever pixel
 *  size the tab happens to have, so the simulation never depends on DOM size. */
const LAYOUT_WIDTH = 1280
const LAYOUT_HEIGHT = 800
const MIN_SCALE = 0.2
const MAX_SCALE = 4
/** Below this weight a node only gets a label while selected or hovered —
 *  otherwise a full snapshot paints 1,500 `<text>` elements nobody can read. */
const LABEL_WEIGHT = 3
const SEARCH_DEBOUNCE_MS = 200
const ADD_COMMAND = 'vibelink memory add --title "<fact>" --body "<detail>" [--tag <tag>] [--ref <path>]'

const FILTER_KINDS: MemoryNodeKind[] = ['document', 'entry', 'tag', 'agent', 'file']
const GLOBAL_SESSION = '__global__'
/** Stable identity so a graph with no dragged node never invalidates memos. */
const EMPTY_POSITIONS: Record<string, { x: number; y: number }> = {}

type ViewBox = { x: number; y: number; w: number; h: number }
type Drag =
  | { kind: 'pan'; pointerX: number; pointerY: number; view: ViewBox }
  | { kind: 'node'; id: string; pointerX: number; pointerY: number; originX: number; originY: number }

function entryMatches(entry: MemoryEntry, query: string): boolean {
  if (entry.title.toLowerCase().includes(query)) return true
  if (entry.body.toLowerCase().includes(query)) return true
  if (entry.tags.some((tag) => tag.includes(query))) return true
  return entry.refs.some((ref) => ref.toLowerCase().includes(query))
}

/** Harvested ids (`harvest:AGENTS.md:0`) repeat across workspaces, so an entry
 *  id alone is not unique. Workspace-anchored node ids carry the session that
 *  disambiguates them; `tag:`/`agent:` nodes are shared and match every session. */
function nodeSessionId(nodeId: string): string | null {
  const [kind, session] = nodeId.split(':')
  if (kind === 'tag' || kind === 'agent') return null
  return session ?? null
}

function nodeRadius(weight: number): number {
  return 4 + Math.min(10, weight)
}

export function MemoryGraphPanel() {
  const sessions = useWorkspaceStore((state) => state.sessions)
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const { openContent } = useWorkspaceContentActions()

  const [scope, setScope] = useState<'workspace' | 'all'>('workspace')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [hiddenKinds, setHiddenKinds] = useState<readonly MemoryNodeKind[]>([])
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [view, setView] = useState<ViewBox>({ x: 0, y: 0, w: LAYOUT_WIDTH, h: LAYOUT_HEIGHT })
  /** Dragged node positions, tagged with the node set they were taken against.
   *  A different node set makes them stale, so they are discarded on read
   *  instead of through an effect that would cascade a second render. */
  const [pinned, setPinned] = useState<{ signature: string; positions: Record<string, { x: number; y: number }> }>({ signature: '', positions: {} })
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const [syncOpen, setSyncOpen] = useState(false)
  const [syncStatus, setSyncStatus] = useState<MemoryProjectionStatus | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)

  const [addOpen, setAddOpen] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const dragRef = useRef<Drag | null>(null)
  const draggedRef = useRef(false)

  const activeSession = useMemo(() => sessions.find((session) => session.id === activeSessionId) ?? null, [sessions, activeSessionId])
  const activeFolder = activeSession?.workspaceFolder ?? null
  const folderOf = useCallback(
    (sessionId: string | null) => (sessionId ? sessions.find((session) => session.id === sessionId)?.workspaceFolder ?? null : null),
    [sessions],
  )

  const workspaceRefs = useMemo<MemoryWorkspaceRef[]>(() => {
    const selected = scope === 'all' ? sessions : sessions.filter((session) => session.id === activeSessionId)
    return selected.map((session) => ({ sessionId: session.id, name: session.name, workspaceFolder: session.workspaceFolder ?? null }))
  }, [scope, sessions, activeSessionId])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setSnapshot(await fetchMemorySnapshot(workspaceRefs))
      setError(null)
    } catch (caught) {
      setError(String(caught))
    } finally {
      setLoading(false)
    }
  }, [workspaceRefs])

  useEffect(() => {
    // Fetch on mount and whenever the queried workspace set changes. `load`
    // owns its own loading/error state; there is no derived-state cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim().toLowerCase()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  const entries = useMemo(() => snapshot?.entries ?? [], [snapshot])
  const graph = useMemo<MemoryGraph>(
    () => (snapshot ? buildMemoryGraph(snapshot) : { nodes: [], edges: [] }),
    [snapshot],
  )

  const filteredGraph = useMemo<MemoryGraph>(() => {
    const matched = query === '' ? null : new Set(entries.filter((entry) => entryMatches(entry, query)).map((entry) => entry.id))
    const nodes = graph.nodes.filter((node) => {
      if (node.kind !== 'workspace' && hiddenKinds.includes(node.kind)) return false
      if (!matched) return true
      if (node.label.toLowerCase().includes(query)) return true
      return node.entryIds.some((entryId) => matched.has(entryId))
    })
    const kept = new Set(nodes.map((node) => node.id))
    return { nodes, edges: graph.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target)) }
  }, [graph, hiddenKinds, query, entries])

  // The simulation is the expensive part, so it runs only when the filtered
  // graph itself changes. Dragging a node writes to `fixedPositions` instead.
  const layout = useMemo(() => layoutMemoryGraph(filteredGraph, { width: LAYOUT_WIDTH, height: LAYOUT_HEIGHT }), [filteredGraph])

  const nodeSignature = useMemo(() => filteredGraph.nodes.map((node) => node.id).join('|'), [filteredGraph])
  const fixedPositions = pinned.signature === nodeSignature ? pinned.positions : EMPTY_POSITIONS

  const positionOf = useCallback(
    (node: { id: string; x: number; y: number }) => fixedPositions[node.id] ?? { x: node.x, y: node.y },
    [fixedPositions],
  )

  const selectedNode = useMemo<MemoryGraphNode | null>(
    () => layout.nodes.find((node) => node.id === selectedId) ?? null,
    [layout, selectedId],
  )

  const selectedEntries = useMemo<MemoryEntry[]>(() => {
    if (!selectedNode) return []
    const session = nodeSessionId(selectedNode.id)
    const wanted = new Set(selectedNode.entryIds)
    return entries.filter((entry) => wanted.has(entry.id) && (session === null || (entry.sessionId ?? GLOBAL_SESSION) === session))
  }, [selectedNode, entries])

  const activeNodeId = hoveredId ?? selectedId

  // Sync popover ------------------------------------------------------------

  useEffect(() => {
    if (!syncOpen || !activeSessionId || !activeFolder) return
    let cancelled = false
    fetchProjectionStatus(activeSessionId, activeFolder)
      .then((status) => {
        if (cancelled) return
        setSyncStatus(status)
        setSyncError(null)
      })
      .catch((caught) => {
        if (!cancelled) setSyncError(String(caught))
      })
    return () => {
      cancelled = true
    }
  }, [syncOpen, activeSessionId, activeFolder])

  const toggleLink = useCallback(
    async (target: string, enabled: boolean) => {
      if (!activeSessionId || !activeFolder) return
      setSyncBusy(true)
      try {
        setSyncStatus(await setMemoryLink(activeSessionId, activeFolder, target, enabled))
        setSyncError(null)
      } catch (caught) {
        setSyncError(String(caught))
      } finally {
        setSyncBusy(false)
      }
    },
    [activeSessionId, activeFolder],
  )

  // Entry mutations ---------------------------------------------------------

  const togglePinned = useCallback(
    async (entry: MemoryEntry) => {
      try {
        const updated = await setMemoryPinned(entry.id, entry.sessionId, entry.scope, !entry.pinned, folderOf(entry.sessionId))
        setSnapshot((current) => (current
          ? { ...current, entries: current.entries.map((candidate) => (candidate.id === entry.id && candidate.sessionId === entry.sessionId ? updated : candidate)) }
          : current))
      } catch (caught) {
        setError(String(caught))
      }
    },
    [folderOf],
  )

  const deleteEntry = useCallback(
    async (entry: MemoryEntry) => {
      setConfirmDeleteId(null)
      try {
        await removeMemory(entry.id, entry.sessionId, entry.scope, folderOf(entry.sessionId))
        await load()
      } catch (caught) {
        setError(String(caught))
      }
    },
    [folderOf, load],
  )

  // Graph interaction -------------------------------------------------------

  const toViewUnits = useCallback((element: SVGSVGElement, dx: number, dy: number) => {
    const rect = element.getBoundingClientRect()
    return { dx: (dx * view.w) / (rect.width || 1), dy: (dy * view.h) / (rect.height || 1) }
  }, [view])

  const onPointerDownBackground = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return
    draggedRef.current = false
    dragRef.current = { kind: 'pan', pointerX: event.clientX, pointerY: event.clientY, view }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onPointerDownNode = (event: React.PointerEvent<SVGCircleElement>, node: MemoryGraphNode & { x: number; y: number }) => {
    if (event.button !== 0) return
    event.stopPropagation()
    draggedRef.current = false
    const position = positionOf(node)
    dragRef.current = { kind: 'node', id: node.id, pointerX: event.clientX, pointerY: event.clientY, originX: position.x, originY: position.y }
    event.currentTarget.ownerSVGElement?.setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const rawX = event.clientX - drag.pointerX
    const rawY = event.clientY - drag.pointerY
    if (Math.abs(rawX) > 3 || Math.abs(rawY) > 3) draggedRef.current = true
    const { dx, dy } = toViewUnits(event.currentTarget, rawX, rawY)
    if (drag.kind === 'pan') {
      setView({ x: drag.view.x - dx, y: drag.view.y - dy, w: drag.view.w, h: drag.view.h })
      return
    }
    setPinned((current) => ({
      signature: nodeSignature,
      positions: { ...(current.signature === nodeSignature ? current.positions : EMPTY_POSITIONS), [drag.id]: { x: drag.originX + dx, y: drag.originY + dy } },
    }))
  }

  /** Selection happens here, not through a `click` handler on the circle:
   *  `setPointerCapture` retargets `pointerup` to the SVG, so the browser
   *  computes the click target as the SVG and a circle-level `onClick` never
   *  fires for a real mouse press. */
  const endDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    if (drag && event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    dragRef.current = null
    if (event.type === 'pointerup' && drag?.kind === 'node' && !draggedRef.current) selectNode(drag.id)
  }

  const onWheel = (event: React.WheelEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const px = (event.clientX - rect.left) / (rect.width || 1)
    const py = (event.clientY - rect.top) / (rect.height || 1)
    setView((current) => {
      const zoomed = current.w * Math.exp(event.deltaY * 0.0015)
      const nextW = Math.min(LAYOUT_WIDTH / MIN_SCALE, Math.max(LAYOUT_WIDTH / MAX_SCALE, zoomed))
      const nextH = current.h * (nextW / current.w)
      return { x: current.x + (current.w - nextW) * px, y: current.y + (current.h - nextH) * py, w: nextW, h: nextH }
    })
  }

  const selectNode = (nodeId: string) => {
    if (draggedRef.current) return
    setSelectedId((current) => (current === nodeId ? null : nodeId))
    setSidebarOpen(true)
  }

  const positioned = layout.nodes.map((node) => ({ node, ...positionOf(node) }))
  const positionById = new Map(positioned.map((item) => [item.node.id, item]))

  // Render ------------------------------------------------------------------

  return (
    <div className="memory-graph-panel">
      <div className="memory-toolbar">
        <select className="memory-scope-select" aria-label="Memory scope" value={scope} onChange={(event) => setScope(event.target.value as 'workspace' | 'all')}>
          <option value="workspace">This workspace</option>
          <option value="all">All workspaces</option>
        </select>
        <label className="memory-search">
          <Search size={13} aria-hidden="true" />
          <input aria-label="Search memory" placeholder="Search memory" spellCheck={false} value={search} onChange={(event) => setSearch(event.target.value)} />
          {search !== '' ? <button type="button" className="memory-search-clear" aria-label="Clear search" onClick={() => setSearch('')}><X size={11} /></button> : null}
        </label>
        <div className="memory-kind-filters">
          {FILTER_KINDS.map((kind) => {
            const shown = !hiddenKinds.includes(kind)
            return (
              <button
                key={kind}
                type="button"
                className="memory-chip"
                data-kind={kind}
                data-active={shown}
                aria-pressed={shown}
                onClick={() => setHiddenKinds((current) => (current.includes(kind) ? current.filter((value) => value !== kind) : [...current, kind]))}
              >
                {kind}
              </button>
            )
          })}
        </div>
        <span className="memory-toolbar-spacer" />
        <button type="button" disabled={loading} onClick={() => void load()}><RotateCw size={13} aria-hidden="true" /> Refresh</button>
        <button type="button" onClick={() => setAddOpen(true)}><Plus size={13} aria-hidden="true" /> Add memory</button>
        {activeSessionId && activeFolder ? (
          <span className="memory-sync-anchor">
            <button type="button" aria-expanded={syncOpen} onClick={() => setSyncOpen((current) => !current)}><Link2 size={13} aria-hidden="true" /> Sync</button>
            {syncOpen ? (
              <section className="memory-sync-popover" role="dialog" aria-label="Memory sync targets">
                <p>Let every agent read this workspace&apos;s memory automatically.</p>
                {syncError ? <p className="memory-sync-error">{syncError}</p> : null}
                {syncStatus?.targets.map((target) => {
                  const missing = !target.exists && target.id !== 'digest'
                  return (
                    <label key={target.id} className="memory-sync-row">
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={target.relativePath}
                        checked={target.enabled}
                        disabled={missing || syncBusy}
                        onChange={(event) => void toggleLink(target.id, event.target.checked)}
                      />
                      <code>{target.relativePath}</code>
                      {missing ? <small>Not in this workspace</small> : null}
                    </label>
                  )
                })}
              </section>
            ) : null}
          </span>
        ) : null}
        <button type="button" aria-label={sidebarOpen ? 'Hide details' : 'Show details'} onClick={() => setSidebarOpen((current) => !current)}>
          {sidebarOpen ? <PanelRightClose size={13} aria-hidden="true" /> : <PanelRightOpen size={13} aria-hidden="true" />}
        </button>
      </div>

      {snapshot?.truncated ? <div className="memory-notice">Showing the 1500 most recent entries.</div> : null}

      {error ? (
        <div className="memory-error">
          <p>{error}</p>
          <button type="button" onClick={() => void load()}><RotateCw size={13} aria-hidden="true" /> Retry</button>
        </div>
      ) : snapshot && entries.length === 0 ? (
        <div className="memory-empty">
          <p>No memory yet. Agents record memory with <code>vibelink memory add</code>.</p>
          <code>{ADD_COMMAND}</code>
          <button type="button" onClick={() => setAddOpen(true)}><Plus size={13} aria-hidden="true" /> Add the first entry</button>
        </div>
      ) : (
        <div className="memory-body">
          <div className="memory-canvas">
            <svg
              className="memory-graph"
              aria-label="Memory graph"
              viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
              preserveAspectRatio="xMidYMid meet"
              onPointerDown={onPointerDownBackground}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerLeave={endDrag}
              onWheel={onWheel}
              onDoubleClick={() => setView({ x: 0, y: 0, w: LAYOUT_WIDTH, h: LAYOUT_HEIGHT })}
            >
              {layout.edges.map((edge) => {
                const source = positionById.get(edge.source)
                const target = positionById.get(edge.target)
                if (!source || !target) return null
                const incident = activeNodeId === edge.source || activeNodeId === edge.target
                return (
                  <line
                    key={edge.id}
                    className={`memory-edge memory-edge-${edge.kind}${incident ? ' is-incident' : ''}`}
                    x1={source.x}
                    y1={source.y}
                    x2={target.x}
                    y2={target.y}
                  />
                )
              })}
              {positioned.map(({ node, x, y }) => (
                <circle
                  key={node.id}
                  className={`memory-node memory-node-${node.kind}${selectedId === node.id ? ' is-selected' : ''}`}
                  cx={x}
                  cy={y}
                  r={nodeRadius(node.weight)}
                  aria-label={node.label}
                  onPointerDown={(event) => onPointerDownNode(event, { ...node, x, y })}
                  onPointerEnter={() => setHoveredId(node.id)}
                  onPointerLeave={() => setHoveredId((current) => (current === node.id ? null : current))}
                />
              ))}
              {positioned
                .filter(({ node }) => node.weight >= LABEL_WEIGHT || node.id === selectedId || node.id === hoveredId)
                .map(({ node, x, y }) => (
                  <text
                    key={node.id}
                    className={`memory-node-label${node.id === activeNodeId ? ' is-active' : ''}`}
                    x={x + nodeRadius(node.weight) + 5}
                    y={y + 3.5}
                  >
                    {node.label}
                  </text>
                ))}
            </svg>
          </div>

          {sidebarOpen ? (
            <aside className="memory-detail" aria-label="Memory details">
              {selectedNode ? (
                <>
                  <header className="memory-detail-header">
                    <strong>{selectedNode.label}</strong>
                    <span className="memory-detail-kind" data-kind={selectedNode.kind}>{selectedNode.kind} · {selectedEntries.length} {selectedEntries.length === 1 ? 'entry' : 'entries'}</span>
                  </header>
                  <div className="memory-detail-list">
                    {selectedEntries.length === 0 ? <p className="memory-detail-empty">This node has no entries in the current snapshot.</p> : null}
                    {selectedEntries.map((entry) => {
                      const harvested = entry.origin.kind === 'harvest'
                      const sourcePath = entry.origin.sourcePath ?? null
                      return (
                        <article key={`${entry.sessionId ?? GLOBAL_SESSION}:${entry.id}`} className="memory-entry">
                          <strong>{entry.title}</strong>
                          <p className="memory-entry-body">{entry.body}</p>
                          {entry.tags.length > 0 ? (
                            <div className="memory-entry-tags">{entry.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
                          ) : null}
                          <div className="memory-entry-meta">
                            <span className="memory-entry-origin">
                              {entry.origin.agentId ? <ProfileIcon name={entry.origin.agentId} size={12} /> : null}
                              {entry.origin.agentId ?? entry.origin.kind}
                            </span>
                            <span>{new Date(entry.updatedAt).toLocaleString()}</span>
                          </div>
                          {harvested ? (
                            <>
                              <span className="memory-entry-readonly">Read-only · {sourcePath ?? 'unknown source'}</span>
                              <div className="memory-entry-actions">
                                {sourcePath ? (
                                  <button type="button" onClick={() => void openContent({ kind: 'editor', relPath: sourcePath })}>
                                    <ExternalLink size={12} aria-hidden="true" /> Open file
                                  </button>
                                ) : null}
                              </div>
                            </>
                          ) : (
                            <div className="memory-entry-actions">
                              <button type="button" className={entry.pinned ? 'is-pinned' : undefined} onClick={() => void togglePinned(entry)}>
                                {entry.pinned ? <PinOff size={12} aria-hidden="true" /> : <Pin size={12} aria-hidden="true" />}
                                {entry.pinned ? 'Unpin' : 'Pin'}
                              </button>
                              {confirmDeleteId === entry.id ? (
                                <>
                                  <button type="button" className="is-danger" onClick={() => void deleteEntry(entry)}>Confirm delete</button>
                                  <button type="button" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                                </>
                              ) : (
                                <button type="button" className="is-danger" aria-label={`Delete ${entry.title}`} onClick={() => setConfirmDeleteId(entry.id)}>
                                  <Trash2 size={12} aria-hidden="true" /> Delete
                                </button>
                              )}
                            </div>
                          )}
                        </article>
                      )
                    })}
                  </div>
                </>
              ) : (
                <p className="memory-detail-empty">Select a node to read the memory entries behind it.</p>
              )}
            </aside>
          ) : null}
        </div>
      )}

      {addOpen ? (
        <AddMemoryDialog
          defaultSessionId={activeSessionId ?? null}
          workspaceFolder={activeFolder}
          onClose={() => setAddOpen(false)}
          onAdded={() => {
            setAddOpen(false)
            void load()
          }}
        />
      ) : null}
    </div>
  )
}

type AddMemoryDialogProps = {
  defaultSessionId: string | null
  workspaceFolder: string | null
  onClose: () => void
  onAdded: () => void
}

function AddMemoryDialog({ defaultSessionId, workspaceFolder, onClose, onAdded }: AddMemoryDialogProps) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tags, setTags] = useState('')
  const [scope, setScope] = useState<MemoryScope>(defaultSessionId ? 'workspace' : 'global')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    try {
      await addMemory(
        {
          title: title.trim(),
          body: body.trim(),
          tags: tags.split(',').map((tag) => tag.trim().toLowerCase()).filter((tag) => tag !== ''),
          scope,
          sessionId: scope === 'workspace' ? defaultSessionId : null,
          origin: { kind: 'user' },
        },
        workspaceFolder,
      )
      onAdded()
    } catch (caught) {
      setError(String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="memory-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="memory-dialog" role="dialog" aria-modal="true" aria-label="Add memory" onMouseDown={(event) => event.stopPropagation()}>
        <h2>Add memory</h2>
        <label>
          Title
          <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="One durable fact" />
        </label>
        <label>
          Body
          <textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Why it matters and where to look" />
        </label>
        <label>
          Tags
          <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="comma, separated, tags" />
        </label>
        <label>
          Scope
          <select value={scope} onChange={(event) => setScope(event.target.value as MemoryScope)}>
            <option value="workspace" disabled={!defaultSessionId}>Workspace</option>
            <option value="global">Global</option>
          </select>
        </label>
        {error ? <p className="memory-dialog-error">{error}</p> : null}
        <div className="memory-dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" disabled={busy || title.trim() === '' || body.trim() === ''} onClick={() => void submit()}>Add memory</button>
        </div>
      </div>
    </div>
  )
}
