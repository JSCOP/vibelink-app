import { shouldRestoreDockviewLayout } from './layoutRestore'

export type WorkspaceWindowKind = 'terminal' | 'agent' | 'kanban' | 'diff' | 'todo'

export type WorkspaceLayoutPage = {
  id: string
  name: string
  layoutJson: string | null
  createdAt: number
  updatedAt: number
}

export type WorkspaceLayoutState = {
  version: 2
  activePageId: string
  pages: WorkspaceLayoutPage[]
}

export type WorkspaceWindowDescriptor = {
  kind: WorkspaceWindowKind
  panelId: string
  component: string
  title: string
  icon: string
  singleton: boolean
}

type WorkspaceLayoutBlob = Partial<WorkspaceLayoutState> & {
  version?: unknown
  activePageId?: unknown
  pages?: unknown
}

type NormalizeOptions = {
  now?: number
  terminalPaneIds?: string[]
  legacyKanbanLayoutJson?: string | null
}

export const workspaceWindowDescriptors: Record<WorkspaceWindowKind, WorkspaceWindowDescriptor> = {
  terminal: {
    kind: 'terminal',
    panelId: 'terminal-window',
    component: 'terminalWindow',
    title: 'Terminal',
    icon: 'terminal',
    singleton: true,
  },
  agent: {
    kind: 'agent',
    panelId: 'vibelink-agent',
    component: 'agent',
    title: 'VibeLink Agent',
    icon: 'bot',
    singleton: true,
  },
  kanban: {
    kind: 'kanban',
    panelId: 'kanban',
    component: 'kanban',
    title: 'Kanban',
    icon: 'layout-grid',
    singleton: true,
  },
  diff: {
    kind: 'diff',
    panelId: 'diff',
    component: 'diff',
    title: 'Diff',
    icon: 'git-compare',
    singleton: true,
  },
  todo: {
    kind: 'todo',
    panelId: 'todo-list',
    component: 'todo',
    title: 'Todo List',
    icon: 'list-todo',
    singleton: true,
  },
}

export const workspaceWindowKindByPanelId: Record<string, WorkspaceWindowKind> = Object.fromEntries(
  Object.values(workspaceWindowDescriptors).map((descriptor) => [descriptor.panelId, descriptor.kind]),
)

const fallbackPageId = 'workspace'

export function normalizeWorkspaceLayoutState(raw: string | null | undefined, options: NormalizeOptions = {}): WorkspaceLayoutState {
  const now = options.now ?? Date.now()
  const parsed = parseJson(raw)
  if (isWorkspaceLayoutBlob(parsed)) {
    const pages = normalizePages(parsed.pages, now, options.terminalPaneIds ?? [])
    if (pages.length > 0) {
      const requested = typeof parsed.activePageId === 'string' ? parsed.activePageId : ''
      const activePageId = pages.some((page) => page.id === requested) ? requested : pages[0].id
      return { version: 2, activePageId, pages }
    }
  }

  const legacyPages: WorkspaceLayoutPage[] = []
  if (raw && isLegacyDockviewLayout(parsed, options.terminalPaneIds ?? [])) {
    legacyPages.push(createPage('terminal', 'Terminal', wrapTerminalLayout(raw) ?? raw, now))
  }

  const planningLayout = migrateKanbanDockLayout(options.legacyKanbanLayoutJson)
  if (planningLayout) {
    legacyPages.push(createPage('planning', 'Planning', planningLayout, now))
  }

  if (legacyPages.length > 0) {
    return { version: 2, activePageId: legacyPages[0].id, pages: legacyPages }
  }

  return {
    version: 2,
    activePageId: fallbackPageId,
    pages: [createPage(fallbackPageId, 'Workspace', null, now)],
  }
}

export function serializeWorkspaceLayoutState(state: WorkspaceLayoutState): string {
  return JSON.stringify(normalizeWorkspaceLayoutState(JSON.stringify(state)))
}

export function activeWorkspaceLayoutPage(state: WorkspaceLayoutState): WorkspaceLayoutPage {
  return state.pages.find((page) => page.id === state.activePageId) ?? state.pages[0]
}

export function createWorkspaceLayoutPage(existing: WorkspaceLayoutState, name?: string, layoutJson: string | null = null): WorkspaceLayoutState {
  const now = Date.now()
  const page = createPage(nextPageId(existing.pages, 'layout'), nextPageName(existing.pages, name), layoutJson, now)
  return {
    version: 2,
    activePageId: page.id,
    pages: [...existing.pages, page],
  }
}

export function renameWorkspaceLayoutPage(existing: WorkspaceLayoutState, pageId: string, name: string): WorkspaceLayoutState {
  const trimmed = name.trim()
  if (!trimmed) return existing
  const now = Date.now()
  return {
    ...existing,
    pages: existing.pages.map((page) => page.id === pageId ? { ...page, name: trimmed, updatedAt: now } : page),
  }
}

export function replaceWorkspaceLayoutPage(existing: WorkspaceLayoutState, pageId: string, layoutJson: string | null): WorkspaceLayoutState {
  const now = Date.now()
  return {
    ...existing,
    pages: existing.pages.map((page) => page.id === pageId ? { ...page, layoutJson, updatedAt: now } : page),
  }
}

export function duplicateWorkspaceLayoutPage(existing: WorkspaceLayoutState, pageId: string): WorkspaceLayoutState {
  const source = existing.pages.find((page) => page.id === pageId) ?? activeWorkspaceLayoutPage(existing)
  const now = Date.now()
  const page = createPage(nextPageId(existing.pages, source.id), nextPageName(existing.pages, `${source.name} Copy`), source.layoutJson, now)
  return {
    version: 2,
    activePageId: page.id,
    pages: [...existing.pages, page],
  }
}

export function deleteWorkspaceLayoutPage(existing: WorkspaceLayoutState, pageId: string): WorkspaceLayoutState {
  if (existing.pages.length <= 1) return existing
  const index = existing.pages.findIndex((page) => page.id === pageId)
  if (index < 0) return existing
  const pages = existing.pages.filter((page) => page.id !== pageId)
  const activePageId = existing.activePageId === pageId
    ? pages[Math.max(0, index - 1)]?.id ?? pages[0].id
    : existing.activePageId
  return { version: 2, activePageId, pages }
}

export function setActiveWorkspaceLayoutPage(existing: WorkspaceLayoutState, pageId: string): WorkspaceLayoutState {
  if (!existing.pages.some((page) => page.id === pageId)) return existing
  return { ...existing, activePageId: pageId }
}

export function resetWorkspaceLayoutPage(existing: WorkspaceLayoutState, pageId: string): WorkspaceLayoutState {
  return replaceWorkspaceLayoutPage(existing, pageId, null)
}

function normalizePages(value: unknown, now: number, terminalPaneIds: string[]): WorkspaceLayoutPage[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const pages: WorkspaceLayoutPage[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const id = readNonEmptyString(item.id)
    const name = readNonEmptyString(item.name)
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    const rawLayoutJson = typeof item.layoutJson === 'string' && item.layoutJson.trim() ? item.layoutJson : null
    pages.push({
      id,
      name,
      layoutJson: normalizeWorkspaceDockLayoutJson(rawLayoutJson, terminalPaneIds),
      createdAt: readTimestamp(item.createdAt, now),
      updatedAt: readTimestamp(item.updatedAt, now),
    })
  }
  return pages
}

function migrateKanbanDockLayout(raw: string | null | undefined): string | null {
  const layout = parseJson(raw)
  if (!isRecord(layout)) return null
  const migrated = structuredClone(layout)
  replacePanelId(migrated, 'orchestrator', workspaceWindowDescriptors.agent.panelId)
  replacePanelId(migrated, 'board', workspaceWindowDescriptors.kanban.panelId)
  rewritePanel(migrated, workspaceWindowDescriptors.agent)
  rewritePanel(migrated, workspaceWindowDescriptors.kanban)
  rewritePanel(migrated, workspaceWindowDescriptors.diff)
  return JSON.stringify(migrated)
}

function normalizeWorkspaceDockLayoutJson(raw: string | null, terminalPaneIds: string[]): string | null {
  if (!raw) return null
  const layout = parseJson(raw)
  if (!isRecord(layout) || !isRecord(layout.panels)) return raw
  if (layoutHasTopLevelTerminalPanes(layout, terminalPaneIds)) return wrapTerminalLayout(raw) ?? raw
  if (isRecord(layout.vibelinkTerminalLayout) && !isRecord(layout.panels[workspaceWindowDescriptors.terminal.panelId])) {
    const migrated = structuredClone(layout)
    rewritePanel(migrated, workspaceWindowDescriptors.terminal)
    appendPanelToLeft(migrated, workspaceWindowDescriptors.terminal.panelId)
    return JSON.stringify(migrated)
  }
  return raw
}

function layoutHasTopLevelTerminalPanes(layout: Record<string, unknown>, terminalPaneIds: string[]): boolean {
  if (!isRecord(layout.panels)) return false
  const livePaneSet = new Set(terminalPaneIds)
  for (const [panelId, value] of Object.entries(layout.panels)) {
    if (!isRecord(value)) continue
    const component = typeof value.contentComponent === 'string' ? value.contentComponent : ''
    if (component === 'terminal' || livePaneSet.has(panelId)) return true
  }
  return false
}

function wrapTerminalLayout(raw: string): string | null {
  const layout = parseJson(raw)
  if (!isRecord(layout) || !isRecord(layout.grid) || !isRecord(layout.panels)) return null
  const wrapped: Record<string, unknown> = {
    vibelinkTerminalLayout: layout,
    panels: {},
  }
  rewritePanel(wrapped, workspaceWindowDescriptors.terminal)
  rewritePanel(wrapped, workspaceWindowDescriptors.agent)
  const total = 1000
  wrapped.grid = {
    root: {
      type: 'branch',
      data: [
        makeWindowLeaf(workspaceWindowDescriptors.terminal.panelId, 700),
        makeWindowLeaf(workspaceWindowDescriptors.agent.panelId, 300),
      ],
      size: total,
    },
    width: total,
    height: 600,
    orientation: 'HORIZONTAL',
  }
  wrapped.activeGroup = `window-${workspaceWindowDescriptors.terminal.panelId}`
  return JSON.stringify(wrapped)
}

function appendPanelToLeft(layout: Record<string, unknown>, panelId: string): void {
  const grid = layout.grid
  if (!isRecord(grid) || !isRecord(grid.root)) return
  const root = grid.root
  const rootSize = readPositiveNumber(root.size) ?? readPositiveNumber(grid.width) ?? 1000
  const windowSize = Math.max(240, Math.round(rootSize * 0.62))
  const primarySize = Math.max(1, rootSize - windowSize)
  grid.root = {
    type: 'branch',
    data: [
      makeWindowLeaf(panelId, windowSize),
      { ...root, size: primarySize },
    ],
    size: rootSize,
  }
  grid.orientation = 'HORIZONTAL'
  if (!readPositiveNumber(grid.width)) grid.width = rootSize
}

function makeWindowLeaf(panelId: string, size: number): Record<string, unknown> {
  return {
    type: 'leaf',
    data: { views: [panelId], activeView: panelId, id: `window-${panelId}` },
    size,
  }
}

function replacePanelId(value: unknown, from: string, to: string): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === from) value[index] = to
      else replacePanelId(value[index], from, to)
    }
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (child === from) value[key] = to
    else replacePanelId(child, from, to)
  }
  if (isRecord(value.panels) && from in value.panels) {
    value.panels[to] = value.panels[from]
    delete value.panels[from]
  }
}

function rewritePanel(layout: unknown, descriptor: WorkspaceWindowDescriptor): void {
  if (!isRecord(layout) || !isRecord(layout.panels)) return
  const panelValue = layout.panels[descriptor.panelId]
  const current: Record<string, unknown> = isRecord(panelValue) ? panelValue : {}
  layout.panels[descriptor.panelId] = {
    ...current,
    id: descriptor.panelId,
    contentComponent: descriptor.component,
    tabComponent: 'props.defaultTabComponent',
    params: {
      ...(isRecord(current.params) ? current.params : {}),
      kind: descriptor.kind,
      title: descriptor.title,
      icon: descriptor.icon,
    },
    title: descriptor.title,
    renderer: 'always',
  }
}

function isLegacyDockviewLayout(value: unknown, terminalPaneIds: string[]): boolean {
  if (!isRecord(value) || !isRecord(value.panels)) return false
  if (terminalPaneIds.length === 0) return true
  return shouldRestoreDockviewLayout(JSON.stringify(value), terminalPaneIds)
}

function createPage(id: string, name: string, layoutJson: string | null, now: number): WorkspaceLayoutPage {
  return { id, name, layoutJson, createdAt: now, updatedAt: now }
}

function nextPageId(pages: WorkspaceLayoutPage[], seed: string): string {
  const base = slugify(seed) || 'layout'
  const used = new Set(pages.map((page) => page.id))
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

function nextPageName(pages: WorkspaceLayoutPage[], requested?: string): string {
  const base = requested?.trim() || `Layout ${pages.length + 1}`
  const used = new Set(pages.map((page) => page.name.toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  let suffix = 2
  while (used.has(`${base} ${suffix}`.toLowerCase())) suffix += 1
  return `${base} ${suffix}`
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function isWorkspaceLayoutBlob(value: unknown): value is WorkspaceLayoutBlob {
  return isRecord(value) && value.version === 2 && Array.isArray(value.pages)
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function readPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
