import type { SerializedDockview } from 'dockview-core'

export type { SerializedDockview }

export const workspaceContentSchema = 1 as const

export type WorkspaceContentKind =
  | 'terminal'
  | 'browser'
  | 'editor'
  | 'explorer'
  | 'workbench'
  | 'agent'
  | 'kanban'
  | 'todo'
  | 'diff'

export type WorkspaceContentParams =
  | { schema: 1; kind: 'terminal'; instanceId: string; title: string; icon: string; paneId: string }
  | { schema: 1; kind: 'browser'; instanceId: string; title: string; icon: string; pageId: string; profileId: string }
  | { schema: 1; kind: 'editor'; instanceId: string; title: string; icon: string; relPath: string }
  | { schema: 1; kind: 'explorer' | 'workbench' | 'agent' | 'kanban' | 'todo' | 'diff'; instanceId: string; title: string; icon: string }

export type WorkspaceLayoutEnvelope = {
  version: 3
  dockview: SerializedDockview | null
}

export type WorkspaceContentInstancePolicy = 'multi-resource' | 'one-per-resource' | 'singleton'

export const workspaceContentInstancePolicies: Record<WorkspaceContentKind, WorkspaceContentInstancePolicy> = {
  terminal: 'one-per-resource',
  browser: 'one-per-resource',
  editor: 'one-per-resource',
  explorer: 'singleton',
  workbench: 'singleton',
  agent: 'singleton',
  kanban: 'singleton',
  todo: 'singleton',
  diff: 'singleton',
}

const singletonKinds: Partial<Record<WorkspaceContentKind, true>> = {
  explorer: true,
  workbench: true,
  agent: true,
  kanban: true,
  todo: true,
  diff: true,
}
const contentKinds: Record<WorkspaceContentKind, true> = {
  terminal: true,
  browser: true,
  editor: true,
  explorer: true,
  workbench: true,
  agent: true,
  kanban: true,
  todo: true,
  diff: true,
}

export function workspaceContentPanelId(params: Pick<WorkspaceContentParams, 'kind' | 'instanceId'>): string {
  return `content:${params.kind}:${params.instanceId}`
}

export function workspaceContentResourceKey(params: WorkspaceContentParams): string {
  if (params.kind === 'terminal') return `terminal:${params.paneId}`
  if (params.kind === 'browser') return `browser:${params.pageId}`
  if (params.kind === 'editor') return `editor:${params.relPath}`
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

  const resources = new Set<string>()
  for (const [panelId, panel] of Object.entries(panels)) {
    if (!isRecord(panel)) return freshWorkspaceLayoutEnvelope()
    const params = parseWorkspaceContentParams(panel.params)
    if (
      !params
      || panelId !== workspaceContentPanelId(params)
      || panel.contentComponent !== params.kind
      || panel.tabComponent !== 'workspaceContentTab'
      || panel.renderer !== 'always'
    ) return freshWorkspaceLayoutEnvelope()
    const resourceKey = workspaceContentResourceKey(params)
    if (resources.has(resourceKey)) return freshWorkspaceLayoutEnvelope()
    resources.add(resourceKey)
  }

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
