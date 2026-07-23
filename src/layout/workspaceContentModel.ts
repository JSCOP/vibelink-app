import type { SerializedDockview } from 'dockview-core'

export type { SerializedDockview }

export const workspaceContentSchema = 1 as const

export type WorkspaceContentKind =
  | 'terminal'
  | 'terminalWindow'
  | 'browser'
  | 'editor'
  | 'preview'
  | 'explorer'
  | 'sourceControl'
  | 'gitHistory'
  | 'gitBranches'
  | 'workbench'
  | 'agent'
  | 'orchestration'
  | 'kanban'
  | 'todo'
  | 'diff'
  | 'agentSessions'

export type WorkspaceContentParams =
  | { schema: 1; kind: 'terminal'; instanceId: string; title: string; icon: string; paneId: string }
  | { schema: 1; kind: 'terminalWindow'; instanceId: string; title: string; icon: string; inner: SerializedDockview | null; titlesHidden: boolean }
  | { schema: 1; kind: 'browser'; instanceId: string; title: string; icon: string; pageId: string; profileId: string }
  | { schema: 1; kind: 'editor'; instanceId: string; title: string; icon: string; relPath: string }
  | { schema: 1; kind: 'preview'; instanceId: 'preview'; title: string; icon: 'file-search'; relPath: string }
  | { schema: 1; kind: 'explorer' | 'sourceControl' | 'gitHistory' | 'gitBranches' | 'workbench' | 'agent' | 'orchestration' | 'kanban' | 'todo' | 'diff' | 'agentSessions'; instanceId: string; title: string; icon: string }

export type WorkspaceLayoutEnvelope = {
  version: 3
  dockview: SerializedDockview | null
}

export type WorkspaceContentInstancePolicy = 'multi-resource' | 'one-per-resource' | 'singleton'

export const workspaceContentInstancePolicies: Record<WorkspaceContentKind, WorkspaceContentInstancePolicy> = {
  terminal: 'one-per-resource',
  terminalWindow: 'multi-resource',
  browser: 'one-per-resource',
  editor: 'one-per-resource',
  preview: 'singleton',
  explorer: 'singleton',
  sourceControl: 'singleton',
  gitHistory: 'singleton',
  gitBranches: 'singleton',
  workbench: 'singleton',
  agent: 'singleton',
  orchestration: 'singleton',
  kanban: 'singleton',
  todo: 'singleton',
  diff: 'singleton',
  agentSessions: 'singleton',
}

const singletonKinds: Partial<Record<WorkspaceContentKind, true>> = {
  explorer: true,
  sourceControl: true,
  gitHistory: true,
  gitBranches: true,
  workbench: true,
  agent: true,
  orchestration: true,
  kanban: true,
  todo: true,
  diff: true,
  agentSessions: true,
}
const contentKinds: Record<WorkspaceContentKind, true> = {
  terminal: true,
  terminalWindow: true,
  browser: true,
  editor: true,
  preview: true,
  explorer: true,
  sourceControl: true,
  gitHistory: true,
  gitBranches: true,
  workbench: true,
  agent: true,
  orchestration: true,
  kanban: true,
  todo: true,
  diff: true,
  agentSessions: true,
}

const leftStructuralKinds: Partial<Record<WorkspaceContentKind, true>> = {
  explorer: true,
  sourceControl: true,
  gitHistory: true,
  gitBranches: true,
}

const rightStructuralKinds: Partial<Record<WorkspaceContentKind, true>> = {
  agentSessions: true,
}

export function isLeftStructuralWorkspaceContentKind(kind: WorkspaceContentKind): boolean {
  return Boolean(leftStructuralKinds[kind])
}

export function isRightStructuralWorkspaceContentKind(kind: WorkspaceContentKind): boolean {
  return Boolean(rightStructuralKinds[kind])
}

export function isStructuralWorkspaceContentKind(kind: WorkspaceContentKind): boolean {
  return isLeftStructuralWorkspaceContentKind(kind) || isRightStructuralWorkspaceContentKind(kind)
}

export function isCentralWorkspaceContentKind(kind: WorkspaceContentKind): boolean {
  return !isStructuralWorkspaceContentKind(kind)
}

export function workspaceContentPanelId(params: Pick<WorkspaceContentParams, 'kind' | 'instanceId'>): string {
  return `content:${params.kind}:${params.instanceId}`
}

export function workspaceContentResourceKey(params: WorkspaceContentParams): string {
  if (params.kind === 'terminal') return `terminal:${params.paneId}`
  if (params.kind === 'terminalWindow') return `terminalWindow:${params.instanceId}`
  if (params.kind === 'browser') return `browser:${params.pageId}`
  if (params.kind === 'editor') return `editor:${params.relPath}`
  if (params.kind === 'preview') return 'preview'
  return params.kind
}

export function normalizeWorkspaceRelativePath(value: string): string | null {
  const trimmed = value.trim().replaceAll('\\', '/')
  if (!trimmed || trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed) || trimmed.includes('\0')) return null
  const segments = trimmed.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return segments.join('/')
}

export function parseWorkspaceContentParams(value: unknown): WorkspaceContentParams | null {
  if (!isRecord(value) || value.schema !== workspaceContentSchema || typeof value.kind !== 'string' || !contentKinds[value.kind as WorkspaceContentKind]) return null
  const kind = value.kind as WorkspaceContentKind
  const instanceId = readIdentifier(value.instanceId)
  const title = readDisplayString(value.title)
  const icon = readDisplayString(value.icon)
  if (!instanceId || !title || !icon) return null

  if (kind === 'terminal') {
    if (!hasExactKeys(value, ['schema', 'kind', 'instanceId', 'title', 'icon', 'paneId'])) return null
    const paneId = readIdentifier(value.paneId)
    return paneId && paneId === instanceId ? { schema: 1, kind, instanceId, title, icon, paneId } : null
  }
  if (kind === 'terminalWindow') {
    if (!hasExactKeys(value, ['schema', 'kind', 'instanceId', 'title', 'icon', 'inner', 'titlesHidden'])) return null
    if (typeof value.titlesHidden !== 'boolean') return null
    // Inner nested-Dockview layout is stored opaquely; TerminalWindowPanel
    // rebuilds from live panes if it fails to rehydrate.
    const inner = value.inner === null || isRecord(value.inner) ? (value.inner as SerializedDockview | null) : undefined
    if (inner === undefined) return null
    return { schema: 1, kind, instanceId, title, icon, inner, titlesHidden: value.titlesHidden }
  }
  if (kind === 'browser') {
    if (!hasExactKeys(value, ['schema', 'kind', 'instanceId', 'title', 'icon', 'pageId', 'profileId'])) return null
    const pageId = readIdentifier(value.pageId)
    const profileId = readIdentifier(value.profileId)
    return pageId && pageId === instanceId && profileId ? { schema: 1, kind, instanceId, title, icon, pageId, profileId } : null
  }
  if (kind === 'editor') {
    if (!hasExactKeys(value, ['schema', 'kind', 'instanceId', 'title', 'icon', 'relPath'])) return null
    const relPath = typeof value.relPath === 'string' ? normalizeWorkspaceRelativePath(value.relPath) : null
    return relPath && instanceId === relPath ? { schema: 1, kind, instanceId, title, icon, relPath } : null
  }
  if (kind === 'preview') {
    if (!hasExactKeys(value, ['schema', 'kind', 'instanceId', 'title', 'icon', 'relPath'])) return null
    const relPath = typeof value.relPath === 'string' ? normalizeWorkspaceRelativePath(value.relPath) : null
    return relPath && instanceId === 'preview' && icon === 'file-search'
      ? { schema: 1, kind, instanceId: 'preview', title, icon: 'file-search', relPath }
      : null
  }
  if (!hasExactKeys(value, ['schema', 'kind', 'instanceId', 'title', 'icon'])) return null
  if (!singletonKinds[kind] || instanceId !== kind) return null
  return { schema: 1, kind, instanceId, title, icon }
}

export function normalizeWorkspaceLayoutEnvelope(raw: string | null | undefined): WorkspaceLayoutEnvelope {
  const parsed = parseJson(raw)
  if (!isRecord(parsed) || parsed.version !== 3 || !(parsed.dockview === null || isRecord(parsed.dockview))) return freshWorkspaceLayoutEnvelope()
  if (parsed.dockview === null) return freshWorkspaceLayoutEnvelope()

  const panels = parsed.dockview.panels
  const grid = parsed.dockview.grid
  if (!isRecord(panels) || !isRecord(grid) || !isRecord(grid.root)) return freshWorkspaceLayoutEnvelope()

  const rootIsEmpty = grid.root.type === 'branch' && Array.isArray(grid.root.data) && grid.root.data.length === 0
  const panelIds = new Set(Object.keys(panels))
  const resources = new Set<string>()
  for (const [panelId, panel] of Object.entries(panels)) {
    if (!isRecord(panel)) return freshWorkspaceLayoutEnvelope()
    const params = parseWorkspaceContentParams(panel.params)
    if (
      !params
      || panelId !== workspaceContentPanelId(params)
      || panel.id !== panelId
      || panel.contentComponent !== params.kind
      || panel.tabComponent !== 'workspaceContentTab'
      || panel.renderer !== 'always'
    ) return freshWorkspaceLayoutEnvelope()
    const resourceKey = workspaceContentResourceKey(params)
    if (resources.has(resourceKey)) return freshWorkspaceLayoutEnvelope()
    resources.add(resourceKey)
  }

  if (!isPositiveNumber(grid.width) || !isPositiveNumber(grid.height) || !isOrientation(grid.orientation)) return freshWorkspaceLayoutEnvelope()
  const referencedPanels = new Set<string>()
  const groupIds = new Set<string>()
  if (!validateGridNode(grid.root, panelIds, referencedPanels, groupIds, true)) return freshWorkspaceLayoutEnvelope()
  if (!validateAdditionalGroups(parsed.dockview, panelIds, referencedPanels, groupIds)) return freshWorkspaceLayoutEnvelope()
  if (referencedPanels.size !== panelIds.size || [...panelIds].some((panelId) => !referencedPanels.has(panelId))) return freshWorkspaceLayoutEnvelope()
  if (grid.maximizedNode !== undefined && (rootIsEmpty || !validateMaximizedNode(grid.root, grid.maximizedNode))) return freshWorkspaceLayoutEnvelope()
  if (parsed.dockview.activeGroup !== undefined && (rootIsEmpty || typeof parsed.dockview.activeGroup !== 'string' || !groupIds.has(parsed.dockview.activeGroup))) return freshWorkspaceLayoutEnvelope()

  return { version: 3, dockview: parsed.dockview as unknown as SerializedDockview }
}

export function serializeWorkspaceLayoutEnvelope(envelope: WorkspaceLayoutEnvelope): string {
  return JSON.stringify(normalizeWorkspaceLayoutEnvelope(JSON.stringify(envelope)))
}

export function freshWorkspaceLayoutEnvelope(): WorkspaceLayoutEnvelope {
  return { version: 3, dockview: null }
}

export function isControlCharacterCode(code: number): boolean {
  return code >= 0 && code <= 0x1f
}

function readIdentifier(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && !containsControlCharacter(value) ? value : null
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (isControlCharacterCode(value.charCodeAt(index))) return true
  }
  return false
}

function readDisplayString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function validateGridNode(
  node: unknown,
  panelIds: Set<string>,
  referencedPanels: Set<string>,
  groupIds: Set<string>,
  allowEmptyRoot = false,
): boolean {
  if (!isRecord(node) || !isPositiveNumber(node.size)) return false
  if (node.visible !== undefined && typeof node.visible !== 'boolean') return false
  if (node.type === 'leaf') return validateGroupState(node.data, panelIds, referencedPanels, groupIds)
  if (node.type !== 'branch' || !Array.isArray(node.data)) return false
  if (node.data.length === 0) return allowEmptyRoot
  return node.data.every((child) => validateGridNode(child, panelIds, referencedPanels, groupIds, false))
}

function validateGroupState(
  value: unknown,
  panelIds: Set<string>,
  referencedPanels: Set<string>,
  groupIds: Set<string>,
): boolean {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || groupIds.has(value.id) || !Array.isArray(value.views) || value.views.length === 0) return false
  const localViews = new Set<string>()
  for (const panelId of value.views) {
    if (typeof panelId !== 'string' || !panelIds.has(panelId) || localViews.has(panelId) || referencedPanels.has(panelId)) return false
    localViews.add(panelId)
  }
  if (value.activeView !== undefined && (typeof value.activeView !== 'string' || !localViews.has(value.activeView))) return false
  groupIds.add(value.id)
  for (const panelId of localViews) referencedPanels.add(panelId)
  return true
}

function validateAdditionalGroups(
  dockview: Record<string, unknown>,
  panelIds: Set<string>,
  referencedPanels: Set<string>,
  groupIds: Set<string>,
): boolean {
  if (dockview.floatingGroups !== undefined) {
    if (!Array.isArray(dockview.floatingGroups)) return false
    for (const entry of dockview.floatingGroups) {
      if (!isRecord(entry) || !validateAnchoredBox(entry.position) || !validateGroupState(entry.data, panelIds, referencedPanels, groupIds)) return false
    }
  }
  if (dockview.popoutGroups !== undefined) {
    if (!Array.isArray(dockview.popoutGroups)) return false
    for (const entry of dockview.popoutGroups) {
      if (!isRecord(entry) || !(entry.position === null || validateBox(entry.position)) || !validateGroupState(entry.data, panelIds, referencedPanels, groupIds)) return false
      if (entry.gridReferenceGroup !== undefined && typeof entry.gridReferenceGroup !== 'string') return false
      if (entry.url !== undefined && typeof entry.url !== 'string') return false
    }
  }
  if (dockview.edgeGroups !== undefined) {
    if (!isRecord(dockview.edgeGroups)) return false
    for (const position of ['top', 'bottom', 'left', 'right']) {
      const entry = dockview.edgeGroups[position]
      if (entry === undefined) continue
      if (!isRecord(entry) || !isPositiveNumber(entry.size) || typeof entry.visible !== 'boolean') return false
      if (entry.collapsed !== undefined && typeof entry.collapsed !== 'boolean') return false
      if (entry.group !== undefined && !validateGroupState(entry.group, panelIds, referencedPanels, groupIds)) return false
    }
  }
  return true
}


function validateMaximizedNode(root: unknown, value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.location) || value.location.length === 0) return false
  let node = root
  for (const index of value.location) {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || !isRecord(node) || node.type !== 'branch' || !Array.isArray(node.data) || index >= node.data.length) return false
    node = node.data[index]
  }
  return isRecord(node) && node.type === 'leaf'
}

function validateAnchoredBox(value: unknown): boolean {
  if (!isRecord(value) || !isPositiveNumber(value.width) || !isPositiveNumber(value.height)) return false
  const horizontal = isFiniteNumber(value.left) !== isFiniteNumber(value.right)
  const vertical = isFiniteNumber(value.top) !== isFiniteNumber(value.bottom)
  return horizontal && vertical
}

function validateBox(value: unknown): boolean {
  return isRecord(value)
    && isFiniteNumber(value.left)
    && isFiniteNumber(value.top)
    && isPositiveNumber(value.width)
    && isPositiveNumber(value.height)
}

function isOrientation(value: unknown): boolean {
  return value === 'HORIZONTAL' || value === 'VERTICAL'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys)
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key))
}
