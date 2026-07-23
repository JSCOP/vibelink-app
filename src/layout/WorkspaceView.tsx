import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FunctionComponent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type GetTabContextMenuItemsParams,
  type IDockviewHeaderActionsProps,
  type IDockviewPanel,
  type IDockviewPanelProps,
} from 'dockview-react'
import { getGridLocation, type AddPanelOptions } from 'dockview-core'
import { Bot, FileCode2, GitBranch, GitCompare, Globe, LayoutGrid, ListTodo, MoreHorizontal, SquareTerminal, Workflow } from 'lucide-react'
import { WorkspaceContentTab } from '../components/WorkspaceContentTab'
import { NewTerminalLauncher } from '../components/NewTerminalLauncher'
import { QuickPick } from '../components/QuickPick'
import type { PickerEntry } from '../components/pickerModel'
import { KanbanBoard } from '../components/KanbanBoard'
import { TaskDiffView } from '../components/TaskDiffView'
import { WorkbenchContentPanel as WorkbenchPanel } from '../components/git/GitWindow'
import { ExplorerSidebarPanel } from '../components/explorer/ExplorerWindow'
import { PreviewContentPanel } from '../components/explorer/PreviewContentPanel'
import { SourceControlSidebar } from '../components/git/SourceControlSidebar'
import { GitHistorySidebar } from '../components/git/GitHistorySidebar'
import { GitBranchesSidebar } from '../components/git/GitBranchesSidebar'
import { GitWorkspaceProvider } from '../components/git/GitWorkspaceProvider'
import { AgentSessionsSidebar } from '../components/agent/AgentSessionsSidebar'
import { OrchestratorChat } from '../components/OrchestratorChat'
import { OrchestrationWorkspacePanel } from '../components/OrchestrationWorkspacePanel'
import { WorkspaceTodoPanel } from '../components/WorkspaceTodoPanel'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { ProLockedPanel } from '../components/ProLockedPanel'
import { BrowserContentPanel as NativeBrowserContentPanel } from '../browser/BrowserDockPanel'
import { closeBrowserContent } from '../browser/browserContentLifecycle'
import { browserAnnotationDeliveryPayload, publishBrowserAnnotationDraft } from '../browser/agentContext'
import type { BrowserPage, BrowserProfile } from '../browser/types'
import { EditorContentPanel } from '../editor/EditorContentPanel'
import {
  getEditorDocumentStore,
  requestEditorDocumentClose,
  type NativeSaveTextDocumentResult,
} from '../editor/documentStore'
import { sendToPane, submitAgentPrompt } from '../ipc/panes'
import type { DirEntryInfo, PaneMeta } from '../ipc/types'
import type { WorkspaceCreationInput } from '../ipc/providerIntegrations'
import { TerminalManager } from '../terminal/TerminalManager'
import { handleCapturedKeybindingEvent, type KeybindingActionId } from '../state/keybindings'
import { profileById, selectedProfileForWorkspace } from '../state/profiles'
import {
  getWorkspaceSessionEpoch,
  getWorkspaceSessionReadyEpoch,
  getWorkspaceSessionTargetId,
  isWorkspaceInitialPanePending,
  useWorkspaceStore,
} from '../state/store'
import {
  WorkspaceContentActionsContext,
  type OpenContentRequest,
  type WorkspaceContentActions,
  type WorkspaceContentOwnership,
  type WorkspaceContentChromeState,
} from './contentActions'
import { TerminalPanePanel } from './TerminalPanePanel'
import { WindowPanelShell } from './WindowPanelShell'
import { vibelinkDockviewTheme } from './dockviewTheme'
import { nearestPaneIdInDirection, paneIdsInReadingOrder, type PaneDirection } from './paneSwap'
import { expandGridRowsForPaneCount } from './paneGridPlan'
import { balancedGridForPaneCount, type GridSize } from './templatePlan'
import { settleDockviewOverlayLayout } from './splitOverlayLayout'
import { withSuppressedPanelRemoval } from './suppression'
import {
  isStructuralWorkspaceContentKind,
  normalizeWorkspaceRelativePath,
  parseWorkspaceContentParams,
  serializeWorkspaceLayoutEnvelope,
  workspaceContentPanelId,
  workspaceContentResourceKey,
  type WorkspaceContentKind,
  type WorkspaceContentParams,
} from './workspaceContentModel'
import {
  createDefaultWorkspaceDockviewLayout,
  createPreviewContentParams,
  createSingletonContentParams,
  createTerminalContentParams,
  normalizeWorkspaceLayoutState,
  planTerminalArrangement,
} from './workspaceLayoutModel'
import {
  centralGridIsEmpty,
  createWorkspaceResizeCoordinator,
  collapseStructuralWorkspacePanel,
  collapseWorkspaceEdgesForCenterWidth,
  ensureWorkspaceEdgeShell,
  registerWorkspaceEdgeGroups,
  resetWorkspaceEdgeDefaults,
  resolveWorkspaceContentGroup,
  updateOpenPreviewPanel,
  workspaceGroupShowsCreationControls,
  workspaceChromeStatesEqual,
  type WorkspaceResizeCoordinator,
} from './workspaceShellModel'
import { buildWorkspaceContentTabContextMenu } from './workspaceContentTabMenu'
import { finalizeLocalSplitSize, localSplitInitialSize } from './localSplitSizing'

type WorkspaceContentPanelProps = IDockviewPanelProps<WorkspaceContentParams>
type TerminalContentParams = Extract<WorkspaceContentParams, { kind: 'terminal' }>

export type WorkspaceContentPanelComponent = FunctionComponent<WorkspaceContentPanelProps>

export type WorkspaceContentComponentMap = Partial<Record<WorkspaceContentKind, WorkspaceContentPanelComponent>>

export type WorkspaceViewProps = {
  onApiReady?: (api: DockviewApi) => void
  onActionsReady?: (actions: WorkspaceContentActions | null) => void
  onChromeStateChange?: (state: WorkspaceContentChromeState) => void
  arrangeRequestId?: number
  contentRequest?: (OpenContentRequest & { requestId: number }) | null
  saveLayoutRequestId?: number
  contentComponents?: WorkspaceContentComponentMap
  onDeleteWorkspaceRequested?: (sessionId: string) => void | Promise<void>
  onWorkspaceInput?: (input: WorkspaceCreationInput) => void | Promise<void>
  workspaceInteractionSuspended?: boolean
  onWorkspaceInteractionSuspendedChange?: (suspended: boolean) => void
  nativeSurfacesSuspended?: boolean
}

type AddContentOptions = {
  targetGroupId?: string
  referencePanelId?: string
  direction?: 'right' | 'below'
  inactive?: boolean
}

type BrowserProjection = {
  profiles: BrowserProfile[]
  pages: BrowserPage[]
}

type FilePickerState = {
  sessionId: string
  sessionEpoch: number
  paths: string[]
  targetGroupId?: string
}

type WorkspaceLayoutOwner = {
  api: DockviewApi
  sessionId: string
  sessionEpoch: number
  epoch: number
}
type WorkspaceLayoutIdentity = Pick<WorkspaceLayoutOwner, 'sessionId' | 'sessionEpoch'>

function TerminalContentPanel(props: WorkspaceContentPanelProps) {
  const params = parseWorkspaceContentParams(props.params)
  return params?.kind === 'terminal'
    ? <TerminalPaneBoundary {...props} params={params} />
    : <div className="placeholder-panel">Terminal pane metadata is missing.</div>
}

function TerminalPaneBoundary(props: IDockviewPanelProps<TerminalContentParams>) {
  return <ErrorBoundary label="Terminal pane"><TerminalPanePanel {...props} /></ErrorBoundary>
}

function ProPanelBoundary({ feature, children }: { feature: string; children: ReactNode }) {
  const entitled = useWorkspaceStore((state) => Boolean(state.license.ready && state.license.status?.entitled))
  return entitled ? children : <ProLockedPanel feature={feature} />
}

function useEdgePanelState(api: WorkspaceContentPanelProps['api']) {
  const [state, setState] = useState(() => ({ active: api.isActive, collapsed: api.group.api.isCollapsed() }))
  useEffect(() => {
    const syncActive = () => setState((current) => ({ ...current, active: api.isActive }))
    const syncCollapsed = () => setState((current) => ({ ...current, collapsed: api.group.api.isCollapsed() }))
    const active = api.onDidActiveChange(syncActive)
    const collapsed = api.group.api.onDidCollapsedChange(syncCollapsed)
    syncActive()
    syncCollapsed()
    return () => {
      active.dispose()
      collapsed.dispose()
    }
  }, [api])
  return state
}

function SourceControlContentPanel(props: WorkspaceContentPanelProps) {
  const state = useEdgePanelState(props.api)
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-source-control"><ProPanelBoundary feature="Source Control"><ErrorBoundary label="Source Control panel"><SourceControlSidebar active={state.active} collapsed={state.collapsed} onCollapse={() => props.api.group.api.collapse()} /></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

function GitHistoryContentPanel(props: WorkspaceContentPanelProps) {
  const state = useEdgePanelState(props.api)
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-git-history"><ProPanelBoundary feature="Git History"><ErrorBoundary label="Git History panel"><GitHistorySidebar active={state.active} collapsed={state.collapsed} onCollapse={() => props.api.group.api.collapse()} /></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

function GitBranchesContentPanel(props: WorkspaceContentPanelProps) {
  const state = useEdgePanelState(props.api)
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-git-branches"><ProPanelBoundary feature="Git Branches"><ErrorBoundary label="Git Branches panel"><GitBranchesSidebar active={state.active} collapsed={state.collapsed} onCollapse={() => props.api.group.api.collapse()} /></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

function AgentSessionsContentPanel(props: WorkspaceContentPanelProps) {
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-agent-sessions"><ProPanelBoundary feature="Agent Sessions"><ErrorBoundary label="Agent Sessions panel"><AgentSessionsSidebar onCollapse={() => props.api.group.api.collapse()} /></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

function AgentContentPanel(props: WorkspaceContentPanelProps) {
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-agent"><ProPanelBoundary feature="VibeLink Agent"><ErrorBoundary label="VibeLink Agent panel"><OrchestratorChat /></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

function OrchestrationContentPanel(props: WorkspaceContentPanelProps) {
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-orchestration"><ProPanelBoundary feature="Orchestration"><ErrorBoundary label="Orchestration panel"><OrchestrationWorkspacePanel /></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

function KanbanContentPanel(props: WorkspaceContentPanelProps) {
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-kanban"><ProPanelBoundary feature="Kanban"><ErrorBoundary label="Kanban panel"><KanbanBoard /></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

function TodoContentPanel(props: WorkspaceContentPanelProps) {
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-todo"><ProPanelBoundary feature="Todo orchestration"><ErrorBoundary label="Todo panel"><WorkspaceTodoPanel /></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

function DiffContentPanel(props: WorkspaceContentPanelProps) {
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-diff"><ProPanelBoundary feature="Task diff"><ErrorBoundary label="Diff panel"><TaskDiffView /></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

type WorkspaceIntegrationContextValue = {
  onWorkspaceInput?: (input: WorkspaceCreationInput) => void | Promise<void>
  openFilePicker?: (targetGroupId?: string) => void
  nativeSurfacesSuspended?: boolean
  layoutOwner?: WorkspaceLayoutIdentity | null
  setWorkspaceOverlayOpen?: (overlayId: string, open: boolean) => void
  currentMainGroupId?: string | null
}

const WorkspaceIntegrationContext = createContext<WorkspaceIntegrationContextValue>({})

function BrowserWorkspaceContentPanel(props: WorkspaceContentPanelProps) {
  const actions = useContext(WorkspaceContentActionsContext)
  const { layoutOwner, nativeSurfacesSuspended = false } = useContext(WorkspaceIntegrationContext)
  const params = parseWorkspaceContentParams(props.params)
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const workspaceId = layoutOwner
    && activeSessionId === layoutOwner.sessionId
    && getWorkspaceSessionEpoch() === layoutOwner.sessionEpoch
    && getWorkspaceSessionReadyEpoch() === layoutOwner.sessionEpoch
    && getWorkspaceSessionTargetId() === layoutOwner.sessionId
    ? layoutOwner.sessionId
    : null
  const workspaceEpoch = workspaceId ? layoutOwner?.sessionEpoch ?? null : null
  const [panelState, setPanelState] = useState(() => ({
    active: props.api.isActive,
    visible: props.api.isVisible,
    focused: props.api.isActive && (typeof document === 'undefined' || document.hasFocus()),
  }))

  useEffect(() => {
    const sync = () => setPanelState({ active: props.api.isActive, visible: props.api.isVisible, focused: props.api.isActive && document.hasFocus() })
    const active = props.api.onDidActiveChange(sync)
    const visible = props.api.onDidVisibilityChange(sync)
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    return () => {
      active.dispose()
      visible.dispose()
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
    }
  }, [props.api])

  if (!workspaceId || workspaceEpoch === null || params?.kind !== 'browser') {
    return <WindowPanelShell panelId={props.api.id}><div className="placeholder-panel">Browser content metadata is missing.</div></WindowPanelShell>
  }
  const targetGroupId = props.api.group.id
  return (
    <WindowPanelShell panelId={props.api.id} className="workspace-window-browser">
      <ProPanelBoundary feature="Browser">
        <ErrorBoundary label="Browser panel">
          <NativeBrowserContentPanel
            workspaceId={workspaceId}
            pageId={params.pageId}
            profileId={params.profileId}
            active={panelState.active}
            focused={panelState.focused}
            workspaceVisible={panelState.visible && !nativeSurfacesSuspended}
            nativeSurfacesSuspended={nativeSurfacesSuspended}
            onTitleChange={(title) => {
              const nextTitle = title.trim() || 'Browser'
              const next = { ...params, title: nextTitle }
              props.api.updateParameters(next)
              props.api.setTitle(nextTitle)
            }}
            onDeliverAnnotation={async (annotation, destination) => {
              if (!actions) throw new Error('Workspace content actions are unavailable.')
              const payload = browserAnnotationDeliveryPayload(annotation, destination)
              if (destination.kind === 'agent') {
                const panelId = await actions.openContent({ kind: 'agent', targetGroupId, workspaceId, workspaceEpoch })
                if (getWorkspaceSessionEpoch() !== workspaceEpoch || getWorkspaceSessionReadyEpoch() !== workspaceEpoch || getWorkspaceSessionTargetId() !== workspaceId) return
                if (panelId) actions.activateContent(panelId)
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
                if (getWorkspaceSessionEpoch() !== workspaceEpoch || getWorkspaceSessionReadyEpoch() !== workspaceEpoch || getWorkspaceSessionTargetId() !== workspaceId) return
                publishBrowserAnnotationDraft(annotation)
                return
              }
              if (destination.kind === 'copy') {
                await navigator.clipboard.writeText(payload.prompt)
                return
              }
              if (getWorkspaceSessionEpoch() !== workspaceEpoch || getWorkspaceSessionReadyEpoch() !== workspaceEpoch || getWorkspaceSessionTargetId() !== workspaceId) throw new Error('The browser workspace changed before delivery completed.')
              const pane = useWorkspaceStore.getState().panes[destination.paneId]
              if (!pane?.alive || !payload.paneId) throw new Error('The selected terminal destination is no longer live.')
              await sendToPane(workspaceId, payload.paneId, payload.prompt, false)
              if (getWorkspaceSessionEpoch() !== workspaceEpoch || getWorkspaceSessionReadyEpoch() !== workspaceEpoch || getWorkspaceSessionTargetId() !== workspaceId) return
              await submitAgentPrompt(workspaceId, payload.paneId)
              if (getWorkspaceSessionEpoch() !== workspaceEpoch || getWorkspaceSessionReadyEpoch() !== workspaceEpoch || getWorkspaceSessionTargetId() !== workspaceId) return
              actions.activateContent(workspaceContentPanelId({ kind: 'terminal', instanceId: payload.paneId }))
            }}
          />
        </ErrorBoundary>
      </ProPanelBoundary>
    </WindowPanelShell>
  )
}

function WorkbenchContentPanel(props: WorkspaceContentPanelProps) {
  const { onWorkspaceInput } = useContext(WorkspaceIntegrationContext)
  const actions = useContext(WorkspaceContentActionsContext)
  const targetGroupId = props.api.group.id
  const scopedActions = useMemo<WorkspaceContentActions | null>(() => actions ? {
    ...actions,
    openContent: (request) => actions.openContent({ ...request, targetGroupId: request.targetGroupId ?? targetGroupId }),
  } : null, [actions, targetGroupId])
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-git"><ProPanelBoundary feature="Workbench"><ErrorBoundary label="Workbench panel"><WorkspaceContentActionsContext.Provider value={scopedActions}><WorkbenchPanel onWorkspaceInput={onWorkspaceInput} /></WorkspaceContentActionsContext.Provider></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

function ExplorerContentPanel(props: WorkspaceContentPanelProps) {
  const actions = useContext(WorkspaceContentActionsContext)
  const { layoutOwner } = useContext(WorkspaceIntegrationContext)
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const ownedLayout = layoutOwner?.sessionId === activeSessionId ? layoutOwner : null
  const sessionId = ownedLayout?.sessionId ?? null
  const workspaceFolder = useWorkspaceStore((state) => state.sessions.find((session) => session.id === sessionId)?.workspaceFolder ?? null)
  const ownership = useMemo<WorkspaceContentOwnership | null>(() => ownedLayout
    ? { workspaceId: ownedLayout.sessionId, workspaceEpoch: ownedLayout.sessionEpoch }
    : null, [ownedLayout])
  const scopedActions = useMemo<WorkspaceContentActions | null>(() => actions && ownership ? {
    ...actions,
    openContent: (request) => actions.openContent({ ...request, ...ownership }),
    requestCloseContent: (panelId) => actions.requestCloseContent(panelId, ownership),
  } : null, [actions, ownership])
  return (
    <WindowPanelShell panelId={props.api.id} className="workspace-window-explorer">
      <ProPanelBoundary feature="Explorer"><ErrorBoundary label="Explorer panel">{sessionId && workspaceFolder ? <WorkspaceContentActionsContext.Provider value={scopedActions}><ExplorerSidebarPanel sessionId={sessionId} workspaceFolder={workspaceFolder} onCollapse={() => props.api.group.api.collapse()} /></WorkspaceContentActionsContext.Provider> : <div className="placeholder-panel">Select a local workspace to browse files.</div>}</ErrorBoundary></ProPanelBoundary>
    </WindowPanelShell>
  )
}

function PreviewWorkspaceContentPanel(props: WorkspaceContentPanelProps) {
  const params = parseWorkspaceContentParams(props.params)
  const sessionId = useWorkspaceStore((state) => state.activeSessionId)
  const workspaceFolder = useWorkspaceStore((state) => state.sessions.find((session) => session.id === state.activeSessionId)?.workspaceFolder ?? null)
  if (!sessionId || !workspaceFolder || params?.kind !== 'preview') {
    return <WindowPanelShell panelId={props.api.id}><div className="placeholder-panel">Preview content metadata is missing.</div></WindowPanelShell>
  }
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-preview"><ProPanelBoundary feature="Preview"><ErrorBoundary label="Preview panel"><PreviewContentPanel sessionId={sessionId} workspaceFolder={workspaceFolder} relPath={params.relPath} /></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

function EditorWorkspaceContentPanel(props: WorkspaceContentPanelProps) {
  const params = parseWorkspaceContentParams(props.params)
  const sessionId = useWorkspaceStore((state) => state.activeSessionId)
  const workspaceFolder = useWorkspaceStore((state) => state.sessions.find((session) => session.id === state.activeSessionId)?.workspaceFolder ?? null)
  if (!sessionId || !workspaceFolder || params?.kind !== 'editor') {
    return <WindowPanelShell panelId={props.api.id}><div className="placeholder-panel">Editor content metadata is missing.</div></WindowPanelShell>
  }
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-editor"><ProPanelBoundary feature="Editor"><ErrorBoundary label="Editor panel"><EditorContentPanel sessionId={sessionId} workspaceFolder={workspaceFolder} relPath={params.relPath} /></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

const builtInContentComponents: Record<WorkspaceContentKind, WorkspaceContentPanelComponent> = {
  terminal: TerminalContentPanel,
  browser: BrowserWorkspaceContentPanel,
  editor: EditorWorkspaceContentPanel,
  preview: PreviewWorkspaceContentPanel,
  explorer: ExplorerContentPanel,
  sourceControl: SourceControlContentPanel,
  gitHistory: GitHistoryContentPanel,
  gitBranches: GitBranchesContentPanel,
  workbench: WorkbenchContentPanel,
  agent: AgentContentPanel,
  orchestration: OrchestrationContentPanel,
  kanban: KanbanContentPanel,
  todo: TodoContentPanel,
  diff: DiffContentPanel,
  agentSessions: AgentSessionsContentPanel,
}

/** Group-local creation controls. The group is the placement authority, while
 * Dockview remains the only drag/drop and split-movement authority. */
export function WorkspaceGroupActions(props: IDockviewHeaderActionsProps) {
  return <WorkspaceGroupActionsWithContext {...props} />
}


function WorkspaceGroupActionsWithContext(props: IDockviewHeaderActionsProps & { fallbackActions?: WorkspaceContentActions | null }) {
  const actions = useContext(WorkspaceContentActionsContext) ?? props.fallbackActions ?? null
  const integration = useContext(WorkspaceIntegrationContext)
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const settings = useWorkspaceStore((state) => state.settings)
  const setDefaultProfile = useWorkspaceStore((state) => state.setDefaultProfile)
  const [menuOpen, setMenuOpen] = useState(false)
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [menuAnchor, setMenuAnchor] = useState<{ right: number; bottom: number } | null>(null)
  const groupId = props.group.id
  const menuOverlayId = `group-menu:${groupId}`
  const launcherOverlayId = `group-new:${groupId}`
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation()
  const open = (request: OpenContentRequest) => {
    setMenuOpen(false)
    void actions?.openContent({ ...request, targetGroupId: groupId })
  }
  const activeProfile = selectedProfileForWorkspace(settings, activeSessionId)
  const terminalCount = props.containerApi.panels.filter((panel) => parseWorkspaceContentParams(panel.params)?.kind === 'terminal').length
  const isCurrentMainGroup = workspaceGroupShowsCreationControls(props.group.api.location.type, groupId, integration.currentMainGroupId)

  useEffect(() => {
    integration.setWorkspaceOverlayOpen?.(menuOverlayId, menuOpen)
    integration.setWorkspaceOverlayOpen?.(launcherOverlayId, launcherOpen)
    if (!menuOpen && !launcherOpen) return () => {
      integration.setWorkspaceOverlayOpen?.(menuOverlayId, false)
      integration.setWorkspaceOverlayOpen?.(launcherOverlayId, false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
      setLauncherOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      integration.setWorkspaceOverlayOpen?.(menuOverlayId, false)
      integration.setWorkspaceOverlayOpen?.(launcherOverlayId, false)
    }
  }, [integration, launcherOpen, launcherOverlayId, menuOpen, menuOverlayId])

  if (!isCurrentMainGroup) return null

  return (
    <div className="workspace-group-actions" onMouseDown={stop} onPointerDown={stop}>
      <NewTerminalLauncher
        isOpen={launcherOpen}
        disabled={!actions || !activeSessionId}
        existingPaneCount={terminalCount}
        profiles={settings.profiles}
        activeProfileId={activeProfile.id}
        onToggle={() => { setMenuOpen(false); setLauncherOpen((openState) => !openState) }}
        onClose={() => setLauncherOpen(false)}
        onLaunch={(grid) => {
          setLauncherOpen(false)
          const profileId = grid.profileId?.trim()
          if (profileId) setDefaultProfile(profileId)
          void actions?.openContent({ kind: 'terminal-grid', targetGroupId: groupId, grid })
        }}
      />
      <button
        type="button"
        title="Add workspace content"
        aria-label="Add workspace content"
        aria-expanded={menuOpen}
        onClick={(event) => {
          if (!menuOpen) {
            const rect = event.currentTarget.getBoundingClientRect()
            setMenuAnchor({ right: rect.right, bottom: rect.bottom })
          }
          setLauncherOpen(false)
          setMenuOpen((value) => !value)
        }}
      ><MoreHorizontal size={14} aria-hidden="true" /></button>
      {menuOpen && menuAnchor && typeof document !== 'undefined' ? createPortal(
        <>
          <div className="workspace-group-menu-backdrop" onMouseDown={() => setMenuOpen(false)} />
          <div className="workspace-group-menu" role="menu" style={{ right: Math.max(8, window.innerWidth - menuAnchor.right), top: menuAnchor.bottom + 2 }}>
            <button type="button" role="menuitem" onClick={() => open({ kind: 'terminal' })}><SquareTerminal size={13} aria-hidden="true" /> Terminal</button>
            <button type="button" role="menuitem" onClick={() => open({ kind: 'browser' })}><Globe size={13} aria-hidden="true" /> Browser</button>
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); integration.openFilePicker?.(groupId) }}><FileCode2 size={13} aria-hidden="true" /> Editor</button>
            <button type="button" role="menuitem" onClick={() => open({ kind: 'agent' })}><Bot size={13} aria-hidden="true" /> VibeLink Agent</button>
            <button type="button" role="menuitem" onClick={() => open({ kind: 'orchestration' })}><Workflow size={13} aria-hidden="true" /> Orchestration</button>
            <button type="button" role="menuitem" onClick={() => open({ kind: 'workbench' })}><GitBranch size={13} aria-hidden="true" /> Workbench</button>
            <button type="button" role="menuitem" onClick={() => open({ kind: 'kanban' })}><LayoutGrid size={13} aria-hidden="true" /> Kanban</button>
            <button type="button" role="menuitem" onClick={() => open({ kind: 'todo' })}><ListTodo size={13} aria-hidden="true" /> Todo List</button>
            <button type="button" role="menuitem" onClick={() => open({ kind: 'diff' })}><GitCompare size={13} aria-hidden="true" /> Task Diff</button>
            <div className="workspace-group-menu-separator" role="separator" />
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void actions?.arrangeTerminals() }}>Arrange Terminals</button>
          </div>
        </>,
        document.body,
      ) : null}
    </div>
  )
}


export function WorkspaceView({
  onApiReady,
  onActionsReady,
  onChromeStateChange,
  arrangeRequestId = 0,
  contentRequest = null,
  saveLayoutRequestId = 0,
  contentComponents,
  onDeleteWorkspaceRequested,
  onWorkspaceInput,
  onWorkspaceInteractionSuspendedChange,
  workspaceInteractionSuspended = false,
  nativeSurfacesSuspended = false,
}: WorkspaceViewProps) {
  const apiRef = useRef<DockviewApi | null>(null)
  const dockRef = useRef<HTMLDivElement | null>(null)
  const loadedSessionRef = useRef<string | null>(null)
  const loadedLayoutJsonRef = useRef<string | null>(null)
  const loadedApiRef = useRef<DockviewApi | null>(null)
  const loadedSessionEpochRef = useRef<number | null>(null)
  const suppressPanelRemovalRef = useRef(false)
  const saveTimerRef = useRef<number | undefined>()
  const apiDisposablesRef = useRef<Array<{ dispose: () => void }>>([])
  const resizeCoordinatorRef = useRef<WorkspaceResizeCoordinator | null>(null)
  const lastChromeStateRef = useRef<WorkspaceContentChromeState | null>(null)
  const resizeEpochRef = useRef(0)
  const resizeSettlingRef = useRef(false)
  const resizeSettlePendingRef = useRef(false)
  const layoutLoadQueueRef = useRef<Promise<void>>(Promise.resolve())
  const layoutEpochRef = useRef(0)
  const layoutOwnerRef = useRef<WorkspaceLayoutOwner | null>(null)
  const applyingArrangeRequestRef = useRef<number | null>(null)
  const applyingContentRequestRef = useRef<number | null>(null)
  const applyingSaveRequestRef = useRef<number | null>(null)
  const pendingTerminalPaneIdsRef = useRef(new Set<string>())
  const lastMainGroupIdRef = useRef<string | null>(null)
  const [currentMainGroupId, setCurrentMainGroupId] = useState<string | null>(null)
  const [apiVersion, setApiVersion] = useState(0)
  const [filePicker, setFilePicker] = useState<FilePickerState | null>(null)
  const [loadedLayoutOwner, setLoadedLayoutOwner] = useState<WorkspaceLayoutIdentity | null>(null)
  const [workspaceOverlayIds, setWorkspaceOverlayIds] = useState<ReadonlySet<string>>(() => new Set())
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const workspaceEpoch = useWorkspaceStore((state) => state.workspaceEpoch)
  const workspaceReadyEpoch = useWorkspaceStore((state) => state.workspaceReadyEpoch)
  const activeFilePicker = filePicker
    && filePicker.sessionId === activeSessionId
    && filePicker.sessionEpoch === workspaceReadyEpoch
    && filePicker.sessionEpoch === workspaceEpoch
    ? filePicker
    : null
  const layoutJson = useWorkspaceStore((state) => state.layoutJson)
  const panes = useWorkspaceStore((state) => state.panes)
  const keybindings = useWorkspaceStore((state) => state.settings.keybindings)
  const spawnPane = useWorkspaceStore((state) => state.spawnPane)
  const closePaneInStore = useWorkspaceStore((state) => state.closePane)
  const saveLayout = useWorkspaceStore((state) => state.saveLayout)
  const renamePaneTitle = useWorkspaceStore((state) => state.renamePaneTitle)
  const setWorkspaceOverlayOpen = useCallback((overlayId: string, open: boolean) => {
    setWorkspaceOverlayIds((current) => {
      if (open === current.has(overlayId)) return current
      const next = new Set(current)
      if (open) next.add(overlayId)
      else next.delete(overlayId)
      return next
    })
  }, [])
  const workspaceLocalOverlaySuspended = Boolean(activeFilePicker) || workspaceOverlayIds.size > 0
  const effectiveWorkspaceInteractionSuspended = workspaceInteractionSuspended || workspaceLocalOverlaySuspended
  const effectiveNativeSurfacesSuspended = nativeSurfacesSuspended || workspaceLocalOverlaySuspended
  const workspaceInteractionSuspendedRef = useRef(effectiveWorkspaceInteractionSuspended)
  useLayoutEffect(() => {
    workspaceInteractionSuspendedRef.current = effectiveWorkspaceInteractionSuspended
  }, [effectiveWorkspaceInteractionSuspended])
  useEffect(() => {
    onWorkspaceInteractionSuspendedChange?.(workspaceLocalOverlaySuspended)
    return () => onWorkspaceInteractionSuspendedChange?.(false)
  }, [onWorkspaceInteractionSuspendedChange, workspaceLocalOverlaySuspended])
  const components = useMemo(() => {
    const merged = { ...builtInContentComponents }
    for (const [kind, component] of Object.entries(contentComponents ?? {})) {
      if (component) merged[kind as WorkspaceContentKind] = component
    }
    return merged
  }, [contentComponents])

  const ownsLayout = useCallback((owner: WorkspaceLayoutOwner) => {
    const current = layoutOwnerRef.current
    return current?.epoch === owner.epoch
      && current.sessionId === owner.sessionId
      && current.api === owner.api
      && current.sessionEpoch === owner.sessionEpoch
      && getWorkspaceSessionEpoch() === owner.sessionEpoch
      && getWorkspaceSessionReadyEpoch() === owner.sessionEpoch
      && getWorkspaceSessionTargetId() === owner.sessionId
      && layoutEpochRef.current === owner.epoch
      && apiRef.current === owner.api
      && loadedSessionRef.current === owner.sessionId
      && useWorkspaceStore.getState().activeSessionId === owner.sessionId
  }, [])

  const currentLayoutOwner = useCallback(() => {
    const owner = layoutOwnerRef.current
    return owner && ownsLayout(owner) ? owner : null
  }, [ownsLayout])

  const waitForLayoutOwner = useCallback(async (sessionId: string): Promise<WorkspaceLayoutOwner | null> => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (useWorkspaceStore.getState().activeSessionId !== sessionId) return null
      const owner = currentLayoutOwner()
      if (owner?.sessionId === sessionId) return owner
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (useWorkspaceStore.getState().activeSessionId !== sessionId) return null
    }
    if (useWorkspaceStore.getState().activeSessionId === sessionId) {
      useWorkspaceStore.getState().setError('The workspace layout is not ready yet.')
    }
    return null
  }, [currentLayoutOwner])
  const openFilePicker = useCallback((targetGroupId?: string) => {
    const state = useWorkspaceStore.getState()
    const sessionId = state.activeSessionId
    const workspaceFolder = state.sessions.find((session) => session.id === sessionId)?.workspaceFolder
    const sessionEpoch = getWorkspaceSessionEpoch()
    if (!sessionId || !workspaceFolder || getWorkspaceSessionReadyEpoch() !== sessionEpoch || getWorkspaceSessionTargetId() !== sessionId) return
    void listContainedWorkspaceFiles(workspaceFolder)
      .then((paths) => {
        if (useWorkspaceStore.getState().activeSessionId === sessionId
          && getWorkspaceSessionEpoch() === sessionEpoch
          && getWorkspaceSessionReadyEpoch() === sessionEpoch
          && getWorkspaceSessionTargetId() === sessionId) setFilePicker({ sessionId, sessionEpoch, paths, targetGroupId })
      })
      .catch((error) => {
        if (useWorkspaceStore.getState().activeSessionId === sessionId && getWorkspaceSessionEpoch() === sessionEpoch) useWorkspaceStore.getState().setError(String(error))
      })
  }, [])
  const integration = useMemo<WorkspaceIntegrationContextValue>(() => ({
    onWorkspaceInput,
    openFilePicker,
    nativeSurfacesSuspended: effectiveNativeSurfacesSuspended,
    layoutOwner: loadedLayoutOwner,
    setWorkspaceOverlayOpen,
    currentMainGroupId,
  }), [currentMainGroupId, effectiveNativeSurfacesSuspended, loadedLayoutOwner, onWorkspaceInput, openFilePicker, setWorkspaceOverlayOpen])

  const layoutDockview = useCallback((api: DockviewApi) => {
    const root = dockRef.current
    if (!isDockElementMeasurable(root)) return false
    const rect = root.getBoundingClientRect()
    api.layout(rect.width, rect.height, true)
    return true
  }, [])

  const serializeCurrentLayout = useCallback(() => {
    const api = apiRef.current
    if (!api) return null
    const dockview = api.toJSON()
    const serialized = serializeWorkspaceLayoutEnvelope({ version: 3, dockview })
    return normalizeWorkspaceLayoutState(serialized).dockview ? serialized : null
  }, [])

  const persistLayoutNow = useCallback(async () => {
    const owner = currentLayoutOwner()
    if (!owner || suppressPanelRemovalRef.current || pendingTerminalPaneIdsRef.current.size > 0 || !isDockElementMeasurable(dockRef.current)) return
    const serialized = serializeCurrentLayout()
    if (!serialized) return
    loadedSessionRef.current = owner.sessionId
    loadedLayoutJsonRef.current = serialized
    loadedApiRef.current = owner.api
    loadedSessionEpochRef.current = owner.sessionEpoch
    await saveLayout(owner.sessionId, serialized)
    if (!ownsLayout(owner)) return
  }, [currentLayoutOwner, ownsLayout, saveLayout, serializeCurrentLayout])

  const persistLayoutSoon = useCallback(() => {
    if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = undefined
      void persistLayoutNow().catch((error) => useWorkspaceStore.getState().setError(String(error)))
    }, 120)
  }, [persistLayoutNow])

  const settleLayout = useCallback(async (options: { syncPty?: boolean; paneIds?: string[] } = {}, owner?: WorkspaceLayoutOwner) => {
    const api = owner?.api ?? apiRef.current
    if (!api) return
    await settleDockviewOverlayLayout({
      layout: () => { if (!owner || ownsLayout(owner)) layoutDockview(api) },
      refresh: () => { if (!owner || ownsLayout(owner)) forceOverlayReposition(api) },
      isSettled: () => owner ? !ownsLayout(owner) || dockviewOverlaysSettled(api) : dockviewOverlaysSettled(api),
      complete: () => {
        if (owner && !ownsLayout(owner)) return
        reflowTerminalsAfterLayout({ syncPty: options.syncPty, paneIds: options.paneIds })
        focusActiveContentAfterLayout(api, () => !workspaceInteractionSuspendedRef.current)
      },
    })
  }, [layoutDockview, ownsLayout])

  const getContentParams = useCallback((panelId: string) => parseWorkspaceContentParams(apiRef.current?.getPanel(panelId)?.params), [])

  const activateContent = useCallback((panelId: string) => {
    const panel = apiRef.current?.getPanel(panelId)
    if (!panel) return
    const content = parseWorkspaceContentParams(panel.params)
    if (content && isStructuralWorkspaceContentKind(content.kind) && panel.group.api.location.type === 'edge') panel.group.api.expand()
    panel.api.setActive()
    if (content?.kind === 'terminal') {
      useWorkspaceStore.getState().setActivePaneId(content.paneId)
      useWorkspaceStore.getState().clearPaneCompletionHighlight(content.paneId)
      if (!workspaceInteractionSuspendedRef.current) TerminalManager.focus(content.paneId)
    }
  }, [])

  const addContentPanel = useCallback((params: WorkspaceContentParams, options: AddContentOptions = {}, targetApi?: DockviewApi): IDockviewPanel | null => {
    const api = targetApi ?? apiRef.current
    if (!api) return null
    const panelId = workspaceContentPanelId(params)
    const existing = api.getPanel(panelId)
    if (existing) {
      if (!options.inactive) activateContent(existing.id)
      return existing
    }
    const structural = isStructuralWorkspaceContentKind(params.kind)
    const targetGroup = resolveWorkspaceContentGroup(api, params.kind, options.targetGroupId, lastMainGroupIdRef.current)
    if (!targetGroup) return null
    const referencePanel = !structural && options.referencePanelId ? api.getPanel(options.referencePanelId) : undefined
    const localSplit = referencePanel && options.direction && referencePanel.group.api.location.type === 'grid'
      ? {
          initialSize: localSplitInitialSize(getGridLocation(referencePanel.group.element), options.direction),
          referenceSize: options.direction === 'right' ? referencePanel.group.api.width : referencePanel.group.api.height,
        }
      : null
    const panelOptions = {
      id: panelId,
      component: params.kind,
      tabComponent: 'workspaceContentTab',
      title: params.title,
      params,
      renderer: 'always',
      inactive: options.inactive,
      position: referencePanel
        ? { referencePanel, direction: options.direction ?? 'right' }
        : { referenceGroup: targetGroup, ...(structural ? {} : { direction: options.direction }) },
      ...(localSplit?.initialSize ?? {}),
    }
    // Dockview 6.6.1 accepts its public Sizing.Split value at this boundary,
    // but AddPanelOptions narrows initialWidth/initialHeight to number. Keep the
    // compatibility cast contained here so ordinary panel creation stays typed.
    const panel = api.addPanel(panelOptions as AddPanelOptions<WorkspaceContentParams>)
    if (referencePanel && options.direction && localSplit) {
      finalizeLocalSplitSize(referencePanel.group, panel.group, options.direction, localSplit.referenceSize)
    }
    if (panel.group.api.location.type === 'grid' && (!options.inactive || !lastMainGroupIdRef.current)) {
      lastMainGroupIdRef.current = panel.group.id
      setCurrentMainGroupId(panel.group.id)
    }
    if (!options.inactive) activateContent(panel.id)
    return panel
  }, [activateContent])

  const spawnTerminal = useCallback(async (owner: WorkspaceLayoutOwner, options: AddContentOptions & { profileId?: string | null; cwd?: string | null; shell?: string | null; args?: string[]; title?: string } = {}) => {
    if (!ownsLayout(owner)) return ''
    const profile = profileById(useWorkspaceStore.getState().settings, options.profileId)
    const pending = pendingPaneMeta(crypto.randomUUID(), profile.name, profile.icon)
    pendingTerminalPaneIdsRef.current.add(pending.id)
    let panelId = ''
    let spawnedPaneId: string | null = null
    let committed = false
    try {
      const panel = addContentPanel(createTerminalContentParams(pending), options, owner.api)
      if (!panel || !ownsLayout(owner)) return ''
      panelId = panel.id
      await settleLayout({}, owner)
      if (!ownsLayout(owner) || !owner.api.getPanel(panel.id)) return ''
      const size = await measuredSpawnSize(pending.id)
      const spawned = await spawnPane(owner.sessionId, {
        paneId: pending.id,
        profileId: options.profileId,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.shell !== undefined ? { shell: options.shell } : {}),
        ...(options.args !== undefined ? { args: options.args } : {}),
        title: options.title ?? pending.config.title ?? undefined,
        cols: size?.cols,
        rows: size?.rows,
      })
      spawnedPaneId = spawned.id
      if (!ownsLayout(owner)) return ''
      const livePanel = owner.api.getPanel(panel.id)
      if (!livePanel) return ''
      const liveParams = createTerminalContentParams(spawned)
      livePanel.update({ params: liveParams })
      livePanel.api.setTitle(liveParams.title)
      useWorkspaceStore.getState().setActivePaneId(spawned.id)
      if (!workspaceInteractionSuspendedRef.current) TerminalManager.focus(spawned.id)
      reflowTerminalsAfterLayout({ syncPty: true, paneIds: [spawned.id] })
      persistLayoutSoon()
      committed = true
      return panel.id
    } catch (error) {
      if (ownsLayout(owner)) useWorkspaceStore.getState().setError(String(error))
      return ''
    } finally {
      try {
        if (!committed) {
          if (panelId) {
            const panel = owner.api.getPanel(panelId)
            if (panel) {
              try {
                if (ownsLayout(owner)) await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => { panel.api.close() })
                else panel.api.close()
              } catch {
                // Native resource cleanup below remains authoritative.
              }
            }
          }
          TerminalManager.dispose(pending.id)
          if (spawnedPaneId) await closePaneInStore(spawnedPaneId, owner.sessionId).catch(() => undefined)
        }
      } finally {
        pendingTerminalPaneIdsRef.current.delete(pending.id)
      }
    }
  }, [addContentPanel, closePaneInStore, ownsLayout, persistLayoutSoon, settleLayout, spawnPane])

  const findContentByResource = useCallback((params: WorkspaceContentParams, targetApi?: DockviewApi) => (targetApi ?? apiRef.current)?.panels.find((panel) => {
    const current = parseWorkspaceContentParams(panel.params)
    return current ? workspaceContentResourceKey(current) === workspaceContentResourceKey(params) : false
  }), [])

  const arrangeTerminals = useCallback(async (requestedGrid?: GridSize | null, persist = true, owner?: WorkspaceLayoutOwner) => {
    const api = owner?.api ?? apiRef.current
    if (!api || (owner && !ownsLayout(owner))) return
    const activePanelId = api.activePanel?.id ?? null
    const terminalIds = paneIdsInReadingOrder(
      api.panels.filter((panel) => parseWorkspaceContentParams(panel.params)?.kind === 'terminal').map((panel) => panel.id),
      getContentRect,
    )
    if (terminalIds.length < 2) return
    const preferred = requestedGrid ?? balancedGridForPaneCount(terminalIds.length, workspaceAspectRatio(dockRef.current))
    const grid = expandGridRowsForPaneCount(preferred, terminalIds.length)
    await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
      const anchor = api.getPanel(terminalIds[0])
      if (!anchor) return
      if (anchor.group.panels.some((panel) => parseWorkspaceContentParams(panel.params)?.kind !== 'terminal')) {
        anchor.api.moveTo({ group: anchor.group, position: 'right', skipSetActive: true })
      }
      for (const step of planTerminalArrangement(terminalIds, grid)) {
        const panel = api.getPanel(step.panelId)
        const reference = api.getPanel(step.referencePanelId)
        if (panel && reference) panel.api.moveTo({ group: reference.group, position: step.position, skipSetActive: true })
      }
      if (activePanelId) api.getPanel(activePanelId)?.api.setActive()
    })
    if (owner && !ownsLayout(owner)) return
    await settleLayout({ syncPty: true }, owner)
    if ((!owner || ownsLayout(owner)) && persist) persistLayoutSoon()
  }, [ownsLayout, persistLayoutSoon, settleLayout])

  const openContent = useCallback(async (request: OpenContentRequest): Promise<string> => {
    const currentEpoch = getWorkspaceSessionEpoch()
    const activeSessionId = useWorkspaceStore.getState().activeSessionId
    if (request.workspaceId && request.workspaceId !== activeSessionId) return ''
    if (request.workspaceEpoch !== undefined && request.workspaceEpoch !== currentEpoch) return ''
    const requestedSessionId = request.workspaceId ?? activeSessionId
    if (!requestedSessionId) return ''
    const owner = await waitForLayoutOwner(requestedSessionId)
    if (!owner || !ownsLayout(owner)) return ''
    if (request.workspaceEpoch !== undefined && owner.sessionEpoch !== request.workspaceEpoch) return ''
    if (request.kind === 'terminal') {
      return spawnTerminal(owner, { targetGroupId: request.targetGroupId, profileId: request.profileId, cwd: request.cwd, direction: request.split, shell: request.shell, args: request.args, title: request.title })
    }
    if (request.kind === 'terminal-grid') {
      const api = owner.api
      const existing = api.panels.filter((panel) => parseWorkspaceContentParams(panel.params)?.kind === 'terminal').length
      const targetCount = Math.max(1, request.grid.cols * request.grid.rows)
      const missing = Math.max(0, targetCount - existing)
      const profile = profileById(useWorkspaceStore.getState().settings, request.grid.profileId)
      const pending = Array.from({ length: missing }, (_, index) => pendingPaneMeta(crypto.randomUUID(), `${profile.name} ${existing + index + 1}`, profile.icon))
      for (const pane of pending) pendingTerminalPaneIdsRef.current.add(pane.id)
      const pendingPanelIds: string[] = []
      const spawnedPaneIds: string[] = []
      const launchGroup = request.targetGroupId
        ? api.groups.find((group) => group.id === request.targetGroupId)
        : api.activeGroup
      const restorePanelId = launchGroup?.activePanel?.id ?? api.activePanel?.id ?? ''
      let createdPanelId = ''
      let committed = false
      try {
        for (const pane of pending) {
          if (!ownsLayout(owner)) return ''
          const panel = addContentPanel(createTerminalContentParams(pane), { targetGroupId: request.targetGroupId, inactive: true }, api)
          pendingPanelIds.push(panel?.id ?? '')
        }
        if (!ownsLayout(owner)) return ''
        const total = existing + pendingPanelIds.filter(Boolean).length
        const requested = request.grid.occupiedGrid
          ? { cols: request.grid.cols, rows: Math.max(request.grid.rows, request.grid.occupiedGrid.rows) }
          : { cols: request.grid.cols, rows: request.grid.rows }
        await arrangeTerminals(expandGridRowsForPaneCount(requested, total), false, owner)
        if (!ownsLayout(owner)) return ''
        await settleLayout({}, owner)
        if (!ownsLayout(owner)) return ''
        for (const [index, pane] of pending.entries()) {
          const panelId = pendingPanelIds[index]
          if (!panelId || !api.getPanel(panelId)) continue
          const size = await measuredSpawnSize(pane.id)
          if (!ownsLayout(owner)) return ''
          const spawned = await spawnPane(owner.sessionId, {
            paneId: pane.id,
            profileId: request.grid.profileId,
            title: pane.config.title ?? undefined,
            cols: size?.cols,
            rows: size?.rows,
          })
          spawnedPaneIds.push(spawned.id)
          if (!ownsLayout(owner)) return ''
          const panel = api.getPanel(panelId)
          if (panel) {
            const params = createTerminalContentParams(spawned)
            panel.update({ params })
            panel.api.setTitle(params.title)
            createdPanelId = panel.id
          }
        }
        if (!ownsLayout(owner)) return ''
        const activationPanelId = restorePanelId && api.getPanel(restorePanelId) ? restorePanelId : createdPanelId
        if (activationPanelId) activateContent(activationPanelId)
        reflowTerminalsAfterLayout({ syncPty: true })
        persistLayoutSoon()
        committed = true
        return createdPanelId || restorePanelId
      } catch (error) {
        if (ownsLayout(owner)) useWorkspaceStore.getState().setError(String(error))
        return ''
      } finally {
        try {
          if (!committed) {
            const closePendingPanels = async () => {
              for (const panelId of pendingPanelIds) {
                if (panelId) api.getPanel(panelId)?.api.close()
              }
            }
            try {
              if (ownsLayout(owner)) await withSuppressedPanelRemoval(suppressPanelRemovalRef, closePendingPanels)
              else await closePendingPanels()
            } catch {
              // Exact PTY cleanup below must still run for every created pane.
            }
            for (const pane of pending) TerminalManager.dispose(pane.id)
            for (const paneId of spawnedPaneIds) await closePaneInStore(paneId, owner.sessionId).catch(() => undefined)
          }
        } finally {
          for (const pane of pending) pendingTerminalPaneIdsRef.current.delete(pane.id)
        }
      }
    }

    if (request.kind === 'browser') {
      let createdPageId: string | null = null
      let addedPanel: IDockviewPanel | null = null
      let committed = false
      try {
        const projection = await invoke<BrowserProjection>('browser_initialize', { workspaceId: owner.sessionId })
        if (!ownsLayout(owner)) return ''
        let profileId = request.profileId?.trim() || `workspace-${owner.sessionId}`
        if (request.private) {
          const profile = await invoke<BrowserProfile>('browser_create_profile', { workspaceId: owner.sessionId, kind: 'incognito' })
          if (!ownsLayout(owner)) return ''
          profileId = profile.id
        } else if (!projection.profiles.some((profile) => profile.id === profileId)) {
          profileId = projection.profiles.find((profile) => profile.workspaceId === owner.sessionId)?.id ?? profileId
        }
        const ownedPageIds = new Set(owner.api.panels.flatMap((panel) => {
          const current = parseWorkspaceContentParams(panel.params)
          return current?.kind === 'browser' ? [current.pageId] : []
        }))
        let page = !request.private
          ? projection.pages.find((candidate) => candidate.workspaceId === owner.sessionId && candidate.profileId === profileId && !ownedPageIds.has(candidate.id))
          : undefined
        if (!page) {
          page = await invoke<BrowserPage>('browser_create_tab', { workspaceId: owner.sessionId, profileId })
          createdPageId = page.id
          if (!ownsLayout(owner)) return ''
        }
        const params: WorkspaceContentParams = { schema: 1, kind: 'browser', instanceId: page.id, title: page.title?.trim() || (request.private ? 'Private Browser' : 'Browser'), icon: 'globe', pageId: page.id, profileId: page.profileId }
        const existing = findContentByResource(params, owner.api)
        if (existing) {
          activateContent(existing.id)
          committed = true
          return existing.id
        }
        addedPanel = addContentPanel(params, { targetGroupId: request.targetGroupId }, owner.api)
        if (!addedPanel || !ownsLayout(owner)) return ''
        await settleLayout({}, owner)
        if (!ownsLayout(owner)) return ''
        persistLayoutSoon()
        committed = true
        return addedPanel.id
      } catch (error) {
        if (ownsLayout(owner)) useWorkspaceStore.getState().setError(String(error))
        return ''
      } finally {
        if (!committed) {
          try {
            if (addedPanel && owner.api.getPanel(addedPanel.id) === addedPanel) {
              if (ownsLayout(owner)) await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => { addedPanel?.api.close() })
              else addedPanel.api.close()
            }
          } catch {
            // Exact native page cleanup below remains authoritative.
          } finally {
            if (createdPageId) await closeBrowserContent(owner.sessionId, createdPageId).catch(() => undefined)
          }
        }
      }
    }

    if (request.kind === 'preview') {
      const params = createPreviewContentParams(request.relPath)
      const existing = findContentByResource(params, owner.api)
      if (existing) {
        const panelId = updateOpenPreviewPanel(existing, params, request.activate !== false)
        persistLayoutSoon()
        return panelId
      }
      if (request.activate === false) return ''
      const panel = addContentPanel(params, { targetGroupId: request.targetGroupId }, owner.api)
      if (!panel || !ownsLayout(owner)) return ''
      await settleLayout({}, owner)
      if (!ownsLayout(owner)) return ''
      persistLayoutSoon()
      return panel.id
    }

    let params: WorkspaceContentParams
    if (request.kind === 'editor') {
      const relPath = normalizeWorkspaceRelativePath(request.relPath)
      if (!relPath) throw new Error('Editor paths must be workspace-relative and cannot contain parent segments.')
      params = { schema: 1, kind: 'editor', instanceId: relPath, title: relPath.split('/').at(-1) ?? relPath, icon: 'file-code', relPath }
    } else {
      params = createSingletonContentParams(request.kind)
    }
    if (!ownsLayout(owner)) return ''
    const existing = findContentByResource(params, owner.api)
    if (existing) {
      activateContent(existing.id)
      return existing.id
    }
    const panel = addContentPanel(params, { targetGroupId: request.targetGroupId }, owner.api)
    if (!panel || !ownsLayout(owner)) return ''
    await settleLayout({}, owner)
    if (!ownsLayout(owner)) {
      if (owner.api.getPanel(panel.id) === panel) {
        panel.api.close()
      }
      return ''
    }
    persistLayoutSoon()
    return panel.id
  }, [activateContent, addContentPanel, arrangeTerminals, closePaneInStore, findContentByResource, ownsLayout, persistLayoutSoon, settleLayout, spawnPane, spawnTerminal, waitForLayoutOwner])

  const requestCloseContent = useCallback(async (panelId: string, ownership?: WorkspaceContentOwnership): Promise<'closed' | 'cancelled'> => {
    const owner = currentLayoutOwner()
    if (ownership?.workspaceId && owner?.sessionId !== ownership.workspaceId) return 'cancelled'
    if (ownership?.workspaceEpoch !== undefined && owner?.sessionEpoch !== ownership.workspaceEpoch) return 'cancelled'
    const api = owner?.api
    const panel = api?.getPanel(panelId)
    const content = parseWorkspaceContentParams(panel?.params)
    if (!owner || !api || !panel || !content) return 'cancelled'
    if (collapseStructuralWorkspacePanel(panel, content)) {
      persistLayoutSoon()
      return 'closed'
    }
    const nextPanelId = nextContentAfterClose(api, panelId)
    if (content.kind === 'editor') {
      const state = useWorkspaceStore.getState()
      const workspaceFolder = state.sessions.find((session) => session.id === owner.sessionId)?.workspaceFolder
      if (!workspaceFolder) return 'cancelled'
      if (await requestEditorDocumentClose(owner.sessionId, workspaceFolder, content.relPath) === 'cancelled') return 'cancelled'
      if (!ownsLayout(owner)) return 'cancelled'
    } else if (content.kind === 'browser') {
      try {
        // Browser is native-owned. Remove the Dockview panel only after the
        // exact page close transaction commits successfully.
        const result = await closeBrowserContent(owner.sessionId, content.pageId)
        if (!result.closed) return 'cancelled'
        if (!ownsLayout(owner)) return 'closed'
      } catch (error) {
        useWorkspaceStore.getState().setError(String(error))
        return 'cancelled'
      }
    } else if (content.kind === 'terminal') {
      try {
        // Close native ownership first. A failed native close must leave its
        // panel and renderer intact so the live PTY cannot become orphaned.
        await closePaneInStore(content.paneId, owner.sessionId)
      } catch (error) {
        useWorkspaceStore.getState().setError(String(error))
        return 'cancelled'
      }
      TerminalManager.dispose(content.paneId)
      if (!ownsLayout(owner)) return 'closed'
    }
    await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => { api.getPanel(panelId)?.api.close() })
    if (nextPanelId) requestAnimationFrame(() => activateContent(nextPanelId))
    persistLayoutSoon()
    return 'closed'
  }, [activateContent, closePaneInStore, currentLayoutOwner, ownsLayout, persistLayoutSoon])

  const splitTerminal = useCallback(async (paneId: string, direction: 'right' | 'below') => {
    const owner = currentLayoutOwner()
    if (!owner) return
    const referencePanelId = workspaceContentPanelId({ kind: 'terminal', instanceId: paneId })
    if (!owner.api.getPanel(referencePanelId)) return
    await spawnTerminal(owner, { referencePanelId, direction })
  }, [currentLayoutOwner, spawnTerminal])

  const clearTerminals = useCallback(async () => {
    const api = apiRef.current
    if (!api) return
    const terminalPanelIds = api.panels.flatMap((panel) => {
      const params = parseWorkspaceContentParams(panel.params)
      return params?.kind === 'terminal' ? [panel.id] : []
    })
    for (const panelId of terminalPanelIds) await requestCloseContent(panelId)
  }, [requestCloseContent])

  const toggleMaximizeContent = useCallback((panelId: string) => {
    const panel = apiRef.current?.getPanel(panelId)
    if (!panel) return
    if (panel.api.isMaximized()) panel.api.exitMaximized()
    else panel.api.maximize()
    void settleLayout({ syncPty: true })
  }, [settleLayout])

  const renameTerminal = useCallback(async (paneId: string, title: string) => {
    await renamePaneTitle(paneId, title, 'manual')
    const panel = apiRef.current?.getPanel(workspaceContentPanelId({ kind: 'terminal', instanceId: paneId }))
    const params = parseWorkspaceContentParams(panel?.params)
    if (!panel || params?.kind !== 'terminal') return
    const next = { ...params, title }
    panel.update({ params: next })
    panel.api.setTitle(title)
    persistLayoutSoon()
  }, [persistLayoutSoon, renamePaneTitle])

  const resetLayout = useCallback(async () => {
    const previousOwner = currentLayoutOwner()
    if (!previousOwner) return
    const api = previousOwner.api
    const owner: WorkspaceLayoutOwner = { api, sessionId: previousOwner.sessionId, sessionEpoch: previousOwner.sessionEpoch, epoch: ++layoutEpochRef.current }
    layoutOwnerRef.current = null
    const livePanes = Object.values(useWorkspaceStore.getState().panes).filter((pane) => pane.alive)
    const preservedContent = api.panels.flatMap((panel) => {
      const params = parseWorkspaceContentParams(panel.params)
      return params && params.kind !== 'terminal' && !isStructuralWorkspaceContentKind(params.kind) ? [params] : []
    })
    const rootWidth = dockRef.current?.getBoundingClientRect().width ?? 1280
    await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
      api.clear()
      api.fromJSON(createDefaultWorkspaceDockviewLayout(livePanes, rootWidth) as Parameters<DockviewApi['fromJSON']>[0])
      ensureWorkspaceEdgeShell(api)
      resetWorkspaceEdgeDefaults(api, rootWidth)
      let mainGroupId = api.activeGroup?.api.location.type === 'grid'
        ? api.activeGroup.id
        : api.groups.find((group) => group.api.location.type === 'grid' && group.api.isVisible)?.id
      for (const params of preservedContent) {
        const panel = addContentPanel(params, { targetGroupId: mainGroupId, inactive: true }, api)
        if (panel?.group.api.location.type === 'grid' && !mainGroupId) mainGroupId = panel.group.id
      }
      lastMainGroupIdRef.current = mainGroupId ?? null
      setCurrentMainGroupId(mainGroupId ?? null)
    })
    if (apiRef.current !== api
      || getWorkspaceSessionEpoch() !== owner.sessionEpoch
      || getWorkspaceSessionReadyEpoch() !== owner.sessionEpoch
      || getWorkspaceSessionTargetId() !== owner.sessionId
      || useWorkspaceStore.getState().activeSessionId !== owner.sessionId) return
    layoutOwnerRef.current = owner
    setLoadedLayoutOwner({ sessionId: owner.sessionId, sessionEpoch: owner.sessionEpoch })
    await settleLayout({ syncPty: true }, owner)
    if (ownsLayout(owner)) await persistLayoutNow()
  }, [addContentPanel, currentLayoutOwner, ownsLayout, persistLayoutNow, settleLayout])

  const actions = useMemo<WorkspaceContentActions>(() => ({
    openContent,
    activateContent,
    requestCloseContent,
    splitTerminal,
    arrangeTerminals,
    clearTerminals,
    toggleMaximizeContent,
    renameTerminal,
    resetLayout,
    getContentParams,
  }), [activateContent, arrangeTerminals, clearTerminals, getContentParams, openContent, renameTerminal, requestCloseContent, resetLayout, splitTerminal, toggleMaximizeContent])

  const loadActiveSessionLayout = useCallback(() => {
    const run = async () => {
      const api = apiRef.current
      const sessionId = useWorkspaceStore.getState().activeSessionId
      const raw = useWorkspaceStore.getState().layoutJson
      if (!api || !sessionId || !isDockElementMeasurable(dockRef.current)) return
      if (getWorkspaceSessionReadyEpoch() !== getWorkspaceSessionEpoch() || getWorkspaceSessionTargetId() !== sessionId) return
      const sessionEpoch = getWorkspaceSessionEpoch()
      const livePanes = Object.values(useWorkspaceStore.getState().panes).filter((pane) => pane.alive)
      const envelope = normalizeWorkspaceLayoutState(raw)
      const requiresFirstTerminalLayout = livePanes.length > 0 && centralGridIsEmpty(api)
      if (!envelope.dockview && livePanes.length === 0 && isWorkspaceInitialPanePending(sessionId, sessionEpoch)) return
      if (loadedSessionRef.current === sessionId
        && loadedLayoutJsonRef.current === raw
        && loadedApiRef.current === api
        && loadedSessionEpochRef.current === sessionEpoch
        && !requiresFirstTerminalLayout) return
      const epoch = ++layoutEpochRef.current
      const owner: WorkspaceLayoutOwner = { api, sessionId, sessionEpoch, epoch }
      layoutOwnerRef.current = null
      setLoadedLayoutOwner(null)
      const transactionIsCurrent = () => layoutEpochRef.current === epoch
        && apiRef.current === api
        && getWorkspaceSessionEpoch() === owner.sessionEpoch
        && getWorkspaceSessionReadyEpoch() === owner.sessionEpoch
        && getWorkspaceSessionTargetId() === sessionId
        && useWorkspaceStore.getState().activeSessionId === sessionId
      if (loadedSessionRef.current && loadedSessionRef.current !== sessionId && !suppressPanelRemovalRef.current) {
        const previous = serializeCurrentLayout()
        if (previous) void saveLayout(loadedSessionRef.current, previous).catch(() => undefined)
      }
      // A valid v3 layout can be restored even when the daemon's live terminal
      // set changed while the app was closed. Resource reconciliation below
      // removes stale UI owners and adds only resources proven live.
      const restore = envelope.dockview
      const rootWidth = dockRef.current?.getBoundingClientRect().width ?? 1280
      const restoreHasEdgeGroups = Boolean(restore?.edgeGroups)
      let applyEdgeDefaults = !restore || !restoreHasEdgeGroups
      await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
        api.clear()
        const dockview = restore ?? createDefaultWorkspaceDockviewLayout(livePanes, rootWidth)
        try {
          api.fromJSON(dockview as Parameters<DockviewApi['fromJSON']>[0])
        } catch {
          api.clear()
          api.fromJSON(createDefaultWorkspaceDockviewLayout(livePanes, rootWidth) as Parameters<DockviewApi['fromJSON']>[0])
          applyEdgeDefaults = true
        }
        ensureWorkspaceEdgeShell(api)
        if (applyEdgeDefaults) resetWorkspaceEdgeDefaults(api, rootWidth)
        else collapseWorkspaceEdgesForCenterWidth(api, rootWidth)
      })
      if (!transactionIsCurrent()) return
      loadedSessionRef.current = sessionId
      loadedLayoutJsonRef.current = raw ?? null
      loadedApiRef.current = api
      loadedSessionEpochRef.current = owner.sessionEpoch
      layoutOwnerRef.current = owner
      setLoadedLayoutOwner({ sessionId: owner.sessionId, sessionEpoch: owner.sessionEpoch })
      const mainGroup = api.activeGroup?.api.location.type === 'grid'
        ? api.activeGroup
        : api.groups.find((group) => group.api.location.type === 'grid' && group.api.isVisible)
      lastMainGroupIdRef.current = mainGroup?.id ?? null
      setCurrentMainGroupId(mainGroup?.id ?? null)
      await reconcileTerminalPanels(api, suppressPanelRemovalRef, addContentPanel, () => undefined)
      if (!ownsLayout(owner)) return
      await reconcileRestoredBrowserPanels(api, sessionId, suppressPanelRemovalRef, addContentPanel, () => ownsLayout(owner))
      if (!ownsLayout(owner)) return
      TerminalManager.pruneStale(new Set(livePanes.map((pane) => pane.id)))
      await settleLayout({ syncPty: true }, owner)
      if (!ownsLayout(owner)) return
      setApiVersion((value) => value + 1)
      if (!restore || serializeCurrentLayout() !== raw) persistLayoutSoon()
    }
    const result = layoutLoadQueueRef.current.then(run, run)
    layoutLoadQueueRef.current = result.catch((error) => { useWorkspaceStore.getState().setError(String(error)) })
    return layoutLoadQueueRef.current
  }, [addContentPanel, ownsLayout, persistLayoutSoon, saveLayout, serializeCurrentLayout, settleLayout])

  const syncChromeState = useCallback(() => {
    const api = apiRef.current
    const active = api?.activePanel
    const content = parseWorkspaceContentParams(active?.params)
    const next: WorkspaceContentChromeState = {
      contentCount: api?.totalPanels ?? 0,
      activeContentKind: content?.kind ?? null,
      activePanelId: active?.id ?? null,
      activeGroupId: active?.group.id ?? null,
    }
    if (workspaceChromeStatesEqual(lastChromeStateRef.current, next)) return
    lastChromeStateRef.current = next
    onChromeStateChange?.(next)
  }, [onChromeStateChange])

  const runLiveWorkspaceResize = useCallback((rootWidth: number, shouldLayoutDockview: boolean) => {
    const api = apiRef.current
    if (!api || !isDockElementMeasurable(dockRef.current)) return
    collapseWorkspaceEdgesForCenterWidth(api, rootWidth)
    if (shouldLayoutDockview) layoutDockview(api)
    forceOverlayReposition(api)
    TerminalManager.scheduleLayoutPass()
  }, [layoutDockview])

  const finishLiveWorkspaceResize = useCallback(() => {
    const api = apiRef.current
    const root = dockRef.current
    const sessionId = useWorkspaceStore.getState().activeSessionId
    const sessionEpoch = getWorkspaceSessionEpoch()
    if (!api || !sessionId || !isDockElementMeasurable(root)) return
    const hasLoadedSessionLayout = loadedSessionRef.current === sessionId
      && loadedApiRef.current === api
      && loadedSessionEpochRef.current === sessionEpoch
    if (!hasLoadedSessionLayout) {
      void loadActiveSessionLayout()
      return
    }
    if (resizeSettlingRef.current) {
      resizeSettlePendingRef.current = true
      return
    }
    const resizeEpoch = resizeEpochRef.current
    resizeSettlingRef.current = true
    void settleLayout({ syncPty: true }).then(() => {
      if (resizeEpoch !== resizeEpochRef.current || apiRef.current !== api) return
      syncChromeState()
      persistLayoutSoon()
    }).catch((error) => useWorkspaceStore.getState().setError(String(error))).finally(() => {
      resizeSettlingRef.current = false
      if (!resizeSettlePendingRef.current) return
      resizeSettlePendingRef.current = false
      const currentRoot = dockRef.current
      if (isDockElementMeasurable(currentRoot)) resizeCoordinatorRef.current?.request(currentRoot.getBoundingClientRect().width, false)
    })
  }, [loadActiveSessionLayout, persistLayoutSoon, settleLayout, syncChromeState])

  const requestLiveWorkspaceResize = useCallback((shouldLayoutDockview: boolean) => {
    const root = dockRef.current
    if (!isDockElementMeasurable(root)) return
    const width = root.getBoundingClientRect().width
    resizeEpochRef.current += 1
    const coordinator = resizeCoordinatorRef.current
    if (coordinator) coordinator.request(width, shouldLayoutDockview)
    else runLiveWorkspaceResize(width, shouldLayoutDockview)
  }, [runLiveWorkspaceResize])

  useEffect(() => {
    const coordinator = createWorkspaceResizeCoordinator({
      onLive: runLiveWorkspaceResize,
      onSettled: finishLiveWorkspaceResize,
    })
    resizeCoordinatorRef.current = coordinator
    return () => {
      coordinator.dispose()
      if (resizeCoordinatorRef.current === coordinator) resizeCoordinatorRef.current = null
    }
  }, [finishLiveWorkspaceResize, runLiveWorkspaceResize])

  const handleReady = useCallback((event: DockviewReadyEvent) => {
    for (const disposable of apiDisposablesRef.current) disposable.dispose()
    layoutEpochRef.current += 1
    layoutOwnerRef.current = null
    setLoadedLayoutOwner(null)
    apiRef.current = event.api
    lastChromeStateRef.current = null
    const rootWidth = dockRef.current?.getBoundingClientRect().width ?? 1280
    registerWorkspaceEdgeGroups(event.api, rootWidth)
    setApiVersion((value) => value + 1)
    onApiReady?.(event.api)
    apiDisposablesRef.current = [
      event.api.onDidLayoutChange(() => {
        if (suppressPanelRemovalRef.current || resizeSettlingRef.current) return
        requestLiveWorkspaceResize(false)
      }),
      event.api.onDidMovePanel(() => {
        if (suppressPanelRemovalRef.current) return
        void settleLayout({ syncPty: true })
        persistLayoutSoon()
      }),
      event.api.onDidActiveGroupChange((group) => {
        if (group?.api.location.type !== 'grid') return
        lastMainGroupIdRef.current = group.id
        setCurrentMainGroupId(group.id)
      }),
      event.api.onDidActivePanelChange((panel) => {
        const content = parseWorkspaceContentParams(panel?.params)
        if (content?.kind === 'terminal') {
          useWorkspaceStore.getState().setActivePaneId(content.paneId)
          if (!workspaceInteractionSuspendedRef.current) TerminalManager.focus(content.paneId)
        }
        syncChromeState()
      }),
      event.api.onDidRemovePanel((removedPanel) => {
        // Dockview fires removal during fromJSON, native DnD and group moves.
        // It is never resource-close authority. Reconciliation restores a live
        // resource if a UI-only removal escaped an explicit close request.
        if (suppressPanelRemovalRef.current) return
        const removed = parseWorkspaceContentParams(removedPanel.params)
        requestAnimationFrame(() => {
          const owner = layoutOwnerRef.current
          if (!owner || owner.api !== event.api || !ownsLayout(owner)) return
          if (removed && (removed.kind === 'terminal' || removed.kind === 'browser' || removed.kind === 'editor')) {
            const resourceIsLive = removed.kind !== 'terminal' || Boolean(useWorkspaceStore.getState().panes[removed.paneId]?.alive)
            if (resourceIsLive && !event.api.getPanel(removedPanel.id)) addContentPanel(removed, { inactive: true }, event.api)
          }
          void reconcileTerminalPanels(
            event.api,
            suppressPanelRemovalRef,
            (params, options) => addContentPanel(params, options, event.api),
            () => { if (ownsLayout(owner)) persistLayoutSoon() },
          )
        })
      }),
      ...(['left', 'right'] as const).flatMap((position) => {
        // Collapsing/expanding a structural edge sidebar resizes the center grid
        // but does NOT emit onDidLayoutChange, so the terminal's absolutely
        // positioned Dockview render overlay is never repositioned to the freed
        // width. The pane then fits to the stale overlay (one toggle behind) and
        // only corrects on a manual click. Route edge collapse through the same
        // settle pipeline every other layout mutation uses: retry overlay
        // reposition until it matches the owning group, then reflow + sync PTY.
        const edge = event.api.getEdgeGroup(position)
        if (!edge) return []
        return [edge.onDidCollapsedChange(() => {
          if (suppressPanelRemovalRef.current) return
          void settleLayout({ syncPty: true })
        })]
      }),
    ]
    requestAnimationFrame(() => { void loadActiveSessionLayout() })
  }, [addContentPanel, loadActiveSessionLayout, onApiReady, ownsLayout, persistLayoutSoon, requestLiveWorkspaceResize, settleLayout, syncChromeState])

  useEffect(() => {
    onActionsReady?.(actions)
    return () => onActionsReady?.(null)
  }, [actions, onActionsReady])

  useEffect(() => useWorkspaceStore.subscribe((state, previousState) => {
    if (state.activeSessionId !== previousState.activeSessionId
      || state.workspaceEpoch !== previousState.workspaceEpoch
      || state.workspaceReadyEpoch !== previousState.workspaceReadyEpoch) {
      layoutEpochRef.current += 1
      layoutOwnerRef.current = null
      setLoadedLayoutOwner(null)
      lastChromeStateRef.current = null
      lastMainGroupIdRef.current = null
      setCurrentMainGroupId(null)
      setWorkspaceOverlayIds(new Set())
      setFilePicker(null)
    }
  }), [])

  useEffect(() => {
    if (!apiRef.current) return
    void loadActiveSessionLayout()
  }, [activeSessionId, apiVersion, layoutJson, loadActiveSessionLayout, panes, workspaceEpoch, workspaceReadyEpoch])

  useEffect(() => {
    const root = dockRef.current
    if (!root) return
    const observer = new ResizeObserver(() => requestLiveWorkspaceResize(true))
    observer.observe(root)
    return () => observer.disconnect()
  }, [apiVersion, requestLiveWorkspaceResize])


  useEffect(() => {
    const api = apiRef.current
    if (!api || loadedSessionRef.current !== activeSessionId || suppressPanelRemovalRef.current) return
    const livePanes = Object.values(panes).filter((pane) => pane.alive)
    const livePaneIds = new Set(livePanes.map((pane) => pane.id))
    void withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
      for (const pane of livePanes) {
        const id = workspaceContentPanelId({ kind: 'terminal', instanceId: pane.id })
        const panel = api.getPanel(id)
        if (!panel) addContentPanel(createTerminalContentParams(pane), { inactive: true })
        else {
          const params = createTerminalContentParams(pane)
          panel.update({ params })
          if (panel.api.title !== params.title) panel.api.setTitle(params.title)
        }
      }
      for (const panel of [...api.panels]) {
        const params = parseWorkspaceContentParams(panel.params)
        if (params?.kind !== 'terminal' || livePaneIds.has(params.paneId) || pendingTerminalPaneIdsRef.current.has(params.paneId)) continue
        TerminalManager.dispose(params.paneId)
        panel.api.close()
      }
      ensureWorkspaceEdgeShell(api)
    }).then(() => {
      void settleLayout({ syncPty: true })
      persistLayoutSoon()
    }).catch(() => undefined)
  }, [activeSessionId, addContentPanel, apiVersion, panes, persistLayoutSoon, settleLayout])

  useEffect(() => {
    if (!arrangeRequestId || applyingArrangeRequestRef.current === arrangeRequestId) return
    applyingArrangeRequestRef.current = arrangeRequestId
    void arrangeTerminals()
  }, [arrangeRequestId, arrangeTerminals])

  useEffect(() => {
    if (!contentRequest || applyingContentRequestRef.current === contentRequest.requestId) return
    applyingContentRequestRef.current = contentRequest.requestId
    void openContent(contentRequest)
  }, [contentRequest, openContent])

  useEffect(() => {
    if (!saveLayoutRequestId || applyingSaveRequestRef.current === saveLayoutRequestId) return
    applyingSaveRequestRef.current = saveLayoutRequestId
    void persistLayoutNow()
  }, [persistLayoutNow, saveLayoutRequestId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (effectiveWorkspaceInteractionSuspended) return
      const api = apiRef.current
      const active = api?.activePanel
      if (!api || !active) return
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        const key = event.key.toLowerCase()
        if (key === 'n' && !event.shiftKey) {
          event.preventDefault()
          event.stopPropagation()
          void actions.openContent({ kind: 'terminal', targetGroupId: lastMainGroupIdRef.current ?? undefined })
          return
        }
        if (key === 'p' && !event.shiftKey) {
          event.preventDefault()
          event.stopPropagation()
          openFilePicker(lastMainGroupIdRef.current ?? undefined)
          return
        }
        if (key === 's') {
          const content = parseWorkspaceContentParams(active.params)
          if (content?.kind === 'editor') {
            event.preventDefault()
            event.stopPropagation()
            const state = useWorkspaceStore.getState()
            const sessionId = state.activeSessionId
            const sessionEpoch = getWorkspaceSessionEpoch()
            const workspaceFolder = state.sessions.find((session) => session.id === sessionId)?.workspaceFolder
            if (!sessionId || !workspaceFolder || getWorkspaceSessionReadyEpoch() !== sessionEpoch || getWorkspaceSessionTargetId() !== sessionId) return
            const store = getEditorDocumentStore(sessionId, workspaceFolder)
            if (event.shiftKey) {
              const target = window.prompt('Save As (workspace-relative path)', content.relPath)?.trim()
              if (!target) return
              void store.saveAs(content.relPath, target).then((result: NativeSaveTextDocumentResult) => {
                if (result.status === 'saved') void actions.openContent({ kind: 'editor', relPath: target, targetGroupId: active.group.id, workspaceId: sessionId, workspaceEpoch: sessionEpoch })
              }).catch((error: unknown) => useWorkspaceStore.getState().setError(String(error)))
            } else {
              void store.save(content.relPath).catch((error: unknown) => useWorkspaceStore.getState().setError(String(error)))
            }
            return
          }
        }
      }
      handleCapturedKeybindingEvent(keybindings, event, (action) => runKeybindingAction(action, api, active, actions, onDeleteWorkspaceRequested, persistLayoutNow))
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [actions, effectiveWorkspaceInteractionSuspended, keybindings, onDeleteWorkspaceRequested, openFilePicker, persistLayoutNow])

  useEffect(() => () => {
    layoutEpochRef.current += 1
    layoutOwnerRef.current = null
    if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current)
    for (const disposable of apiDisposablesRef.current) disposable.dispose()
    apiDisposablesRef.current = []
  }, [])

  const getTabContextMenuItems = useCallback((params: GetTabContextMenuItemsParams) => buildWorkspaceContentTabContextMenu(params, actions), [actions])
  const rightHeaderActionsComponent = useMemo(() => function HeaderActions(props: IDockviewHeaderActionsProps) {
    return <WorkspaceGroupActionsWithContext {...props} fallbackActions={actions} />
  }, [actions])

  return (
    <WorkspaceIntegrationContext.Provider value={integration}>
      <WorkspaceContentActionsContext.Provider value={actions}>
        <GitWorkspaceProvider>
        <div
        ref={dockRef}
        className="workspace-dock dockview-theme-vibelink"
        onPointerDownCapture={(event) => {
          const target = event.target as HTMLElement | null
          // Dockview owns edge-rail tab expand/collapse toggling. Intercepting
          // the pointerdown here activates and expands the edge group before
          // Dockview's click handler runs, which then toggles the now-active
          // group straight back to collapsed, so the sidebar never opens.
          if (target?.closest('.workspace-edge-rail-tab')) return
          const shell = target?.closest<HTMLElement>('[data-content-panel-id]')
          const panelId = shell?.dataset.contentPanelId
          if (!panelId) return
          const params = getContentParams(panelId)
          if (params?.kind === 'terminal') TerminalManager.repairAfterPointerActivation(params.paneId)
          activateContent(panelId)
        }}
        >
          <DockviewReact
          components={components}
          tabComponents={{ workspaceContentTab: WorkspaceContentTab }}
          defaultTabComponent={WorkspaceContentTab}
          rightHeaderActionsComponent={rightHeaderActionsComponent}
          getTabContextMenuItems={getTabContextMenuItems}
          onReady={handleReady}
          defaultRenderer="always"
          dndStrategy="pointer"
          theme={vibelinkDockviewTheme}
          />
          {activeFilePicker ? (
            <QuickPick
              value={activeFilePicker.paths[0] ?? ''}
              ariaLabel="Open workspace file"
              placeholder="Search workspace files"
              icon={<FileCode2 size={15} />}
              noMatchLabel="files"
              entriesForFilter={(filter) => filePickerEntries(activeFilePicker.paths, filter)}
              renderItem={(item) => <><span>{item.name}</span>{item.description ? <small>{item.description}</small> : null}</>}
              onPreview={() => undefined}
              onSelect={(relPath) => {
                setFilePicker(null)
                if (relPath) void actions.openContent({
                  kind: 'editor',
                  relPath,
                  targetGroupId: activeFilePicker.targetGroupId,
                  workspaceId: activeFilePicker.sessionId,
                  workspaceEpoch: activeFilePicker.sessionEpoch,
                })
              }}
              onCancel={() => setFilePicker(null)}
            />
          ) : null}
        </div>
        </GitWorkspaceProvider>
      </WorkspaceContentActionsContext.Provider>
    </WorkspaceIntegrationContext.Provider>
  )
}

async function reconcileTerminalPanels(
  api: DockviewApi,
  suppression: { current: boolean },
  addPanel: (params: WorkspaceContentParams, options?: AddContentOptions) => IDockviewPanel | null,
  persist: () => void,
): Promise<void> {
  if (suppression.current) return
  const panes = useWorkspaceStore.getState().panes
  await withSuppressedPanelRemoval(suppression, async () => {
    for (const pane of Object.values(panes).filter((candidate) => candidate.alive)) {
      const panelId = workspaceContentPanelId({ kind: 'terminal', instanceId: pane.id })
      if (!api.getPanel(panelId)) addPanel(createTerminalContentParams(pane), { inactive: true })
    }
  })
  persist()
}

async function reconcileRestoredBrowserPanels(
  api: DockviewApi,
  sessionId: string,
  suppression: { current: boolean },
  addPanel: (params: WorkspaceContentParams, options?: AddContentOptions) => IDockviewPanel | null,
  isCurrent: () => boolean,
): Promise<void> {
  const restored = api.panels.flatMap((panel) => {
    const params = parseWorkspaceContentParams(panel.params)
    return params?.kind === 'browser' ? [{ panel, params }] : []
  })
  const projection = await invoke<BrowserProjection>('browser_initialize', { workspaceId: sessionId })
  if (!isCurrent()) return
  const pages = new Map(projection.pages.filter((page) => page.workspaceId === sessionId).map((page) => [page.id, page]))
  await withSuppressedPanelRemoval(suppression, async () => {
    const ownedPageIds = new Set<string>()
    for (const { panel, params } of restored) {
      const page = pages.get(params.pageId)
      if (!page) {
        panel.api.close()
        continue
      }
      ownedPageIds.add(page.id)
      const next: WorkspaceContentParams = {
        ...params,
        profileId: page.profileId,
        title: page.title?.trim() || params.title,
      }
      panel.update({ params: next })
      if (panel.api.title !== next.title) panel.api.setTitle(next.title)
    }
    for (const page of pages.values()) {
      if (ownedPageIds.has(page.id)) continue
      addPanel({
        schema: 1,
        kind: 'browser',
        instanceId: page.id,
        title: page.title?.trim() || 'Browser',
        icon: 'globe',
        pageId: page.id,
        profileId: page.profileId,
      }, { inactive: true })
    }
  })
}

async function listContainedWorkspaceFiles(workspaceFolder: string): Promise<string[]> {
  const files: string[] = []
  const pending = ['']
  const ignoredDirectories = new Set(['.git', '.next', 'dist', 'node_modules', 'target'])
  while (pending.length > 0 && files.length < 5000) {
    const relPath = pending.shift() ?? ''
    const entries = await invoke<DirEntryInfo[]>('fs_list_dir', { workspaceFolder, relPath })
    for (const entry of entries) {
      if (entry.isSymlink) continue
      const child = normalizeWorkspaceRelativePath(relPath ? `${relPath}/${entry.name}` : entry.name)
      if (!child) continue
      if (entry.isDir) {
        if (!ignoredDirectories.has(entry.name)) pending.push(child)
      } else {
        files.push(child)
        if (files.length >= 5000) break
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right))
}

function filePickerEntries(paths: string[], filter: string): PickerEntry[] {
  const normalized = filter.trim().toLowerCase()
  return paths
    .filter((path) => !normalized || path.toLowerCase().includes(normalized))
    .slice(0, 250)
    .map((path) => {
      const segments = path.split('/')
      return { kind: 'item' as const, id: path, name: segments.at(-1) ?? path, description: segments.slice(0, -1).join('/') }
    })
}

async function runKeybindingAction(
  action: KeybindingActionId,
  api: DockviewApi,
  active: IDockviewPanel,
  actions: WorkspaceContentActions,
  onDeleteWorkspaceRequested: ((sessionId: string) => void | Promise<void>) | undefined,
  persistLayout: () => Promise<void>,
) {
  const content = parseWorkspaceContentParams(active.params)
  const directionForAction = (value: KeybindingActionId): PaneDirection | null => {
    if (value.endsWith('Left')) return 'left'
    if (value.endsWith('Right')) return 'right'
    if (value.endsWith('Up')) return 'up'
    if (value.endsWith('Down')) return 'down'
    return null
  }
  switch (action) {
    case 'splitRight':
      if (content?.kind === 'terminal') await actions.splitTerminal(content.paneId, 'right')
      return
    case 'splitDown':
      if (content?.kind === 'terminal') await actions.splitTerminal(content.paneId, 'below')
      return
    case 'closePane':
      await actions.requestCloseContent(active.id)
      return
    case 'closeWorkspace': {
      const sessionId = useWorkspaceStore.getState().activeSessionId
      if (!sessionId) return
      await persistLayout()
      await onDeleteWorkspaceRequested?.(sessionId)
      return
    }
    case 'toggleMaximize':
      actions.toggleMaximizeContent(active.id)
      return
    case 'togglePaneReviewed':
      if (content?.kind === 'terminal') useWorkspaceStore.getState().togglePaneReviewed(content.paneId)
      return
    case 'arrangePanes':
      await actions.arrangeTerminals()
      return
    case 'nextTab':
    case 'previousTab': {
      const ordered = paneIdsInReadingOrder(api.panels.map((panel) => panel.id), getContentRect)
      const index = ordered.indexOf(active.id)
      const targetIndex = action === 'nextTab' ? index + 1 : index - 1
      const target = index >= 0 && targetIndex >= 0 && targetIndex < ordered.length ? ordered[targetIndex] : undefined
      if (target) actions.activateContent(target)
      return
    }
    case 'focusLeft':
    case 'focusRight':
    case 'focusUp':
    case 'focusDown': {
      const direction = directionForAction(action)
      const target = direction ? nearestPaneIdInDirection(active.id, api.panels.map((panel) => panel.id), direction, getContentRect) : null
      if (target) actions.activateContent(target)
      return
    }
    case 'moveLeft':
    case 'moveRight':
    case 'moveUp':
    case 'moveDown': {
      const direction = directionForAction(action)
      const targetId = direction ? nearestPaneIdInDirection(active.id, api.panels.map((panel) => panel.id), direction, getContentRect) : null
      const target = targetId ? api.getPanel(targetId) : undefined
      if (!target) return
      active.api.moveTo({ group: target.group, position: 'center' })
      actions.activateContent(active.id)
      return
    }
    case 'copyTerminalContents':
      if (content?.kind === 'terminal') TerminalManager.copyContentsToClipboard(content.paneId)
      return
    case 'copyTerminalSelection':
      if (content?.kind === 'terminal') TerminalManager.copySelectionToClipboard(content.paneId)
      return
    case 'captureImage':
    case 'captureQuickImage':
    case 'captureVideo':
      return
  }
}

function pendingPaneMeta(paneId: string, title: string | null, icon?: string | null): PaneMeta {
  return {
    id: paneId,
    alive: true,
    config: { paneId, shell: null, args: [], cwd: null, env: [], title, icon: icon ?? null, profileId: null, cols: 120, rows: 32 },
  }
}

async function measuredSpawnSize(paneId: string, attempts = 30): Promise<{ cols: number; rows: number } | undefined> {
  for (let index = 0; index < attempts; index += 1) {
    const size = TerminalManager.measureForSpawn(paneId)
    if (size) return size
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
  return undefined
}

function reflowTerminalsAfterLayout(options: { syncPty?: boolean; paneIds?: string[] } = {}): void {
  requestAnimationFrame(() => TerminalManager.scheduleLayoutPass({ paneIds: options.paneIds, syncPty: options.syncPty, force: true }))
}

function getContentRect(panelId: string): DOMRect | null {
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(panelId) : panelId.replaceAll('"', '\\"')
  const element = document.querySelector<HTMLElement>(`.terminal-panel-shell[data-content-panel-id="${escaped}"], .workspace-window-panel[data-content-panel-id="${escaped}"]`)
  return element?.getBoundingClientRect() ?? null
}

function nextContentAfterClose(api: DockviewApi, panelId: string): string | null {
  const closing = api.getPanel(panelId)
  if (!closing) return null
  const groupPanels = closing.group.panels.filter((panel) => panel.id !== panelId)
  if (groupPanels.length > 0) return groupPanels[0].id
  const candidates = api.panels.filter((panel) => panel.id !== panelId)
  if (candidates.length === 0) return null
  const closingRect = getContentRect(panelId)
  if (!closingRect) return candidates[0].id
  let best: { id: string; distance: number } | null = null
  for (const panel of candidates) {
    const rect = getContentRect(panel.id)
    if (!rect) continue
    const distance = Math.hypot((rect.left + rect.width / 2) - (closingRect.left + closingRect.width / 2), (rect.top + rect.height / 2) - (closingRect.top + closingRect.height / 2))
    if (!best || distance < best.distance) best = { id: panel.id, distance }
  }
  return best?.id ?? candidates[0].id
}

function workspaceAspectRatio(element: HTMLElement | null): number {
  const rect = element?.getBoundingClientRect()
  return rect && rect.height > 0 ? rect.width / rect.height : 16 / 9
}

function isDockElementMeasurable(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || element.offsetParent === null) return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

type DockviewOverlayRenderContainer = {
  map?: Record<string, { element?: HTMLElement }>
  updateAllPositions: () => void
}

function dockviewOverlayRenderContainer(api: DockviewApi): DockviewOverlayRenderContainer | null {
  const holder: unknown = api
  if (!holder || typeof holder !== 'object' || !('component' in holder)) return null
  const component = holder.component
  if (!component || typeof component !== 'object' || !('overlayRenderContainer' in component)) return null
  const container = component.overlayRenderContainer
  if (!container || typeof container !== 'object' || !('updateAllPositions' in container) || typeof container.updateAllPositions !== 'function') return null
  return container as DockviewOverlayRenderContainer
}

function forceOverlayReposition(api: DockviewApi): void {
  dockviewOverlayRenderContainer(api)?.updateAllPositions()
}

function dockviewOverlaysSettled(api: DockviewApi): boolean {
  const container = dockviewOverlayRenderContainer(api)
  if (!container?.map) return false
  for (const panel of api.panels) {
    if (!panel.api.isVisible || panel.api.renderer !== 'always') continue
    const overlay = container.map[panel.id]?.element
    const owner = panel.group.element.querySelector<HTMLElement>('.dv-content-container')
    if (!overlay || !owner || overlay.style.visibility === 'hidden') return false
    const overlayRect = overlay.getBoundingClientRect()
    const ownerRect = owner.getBoundingClientRect()
    if (ownerRect.width <= 0 || ownerRect.height <= 0 || !rectsMatch(overlayRect, ownerRect)) return false
  }
  return true
}

function focusActiveContentAfterLayout(api: DockviewApi, canFocus: () => boolean): void {
  requestAnimationFrame(() => {
    if (!canFocus()) return
    const content = parseWorkspaceContentParams(api.activePanel?.params)
    if (content?.kind === 'terminal') TerminalManager.focus(content.paneId)
  })
}

function rectsMatch(left: DOMRect, right: DOMRect, tolerance = 1): boolean {
  return Math.abs(left.left - right.left) <= tolerance
    && Math.abs(left.top - right.top) <= tolerance
    && Math.abs(left.width - right.width) <= tolerance
    && Math.abs(left.height - right.height) <= tolerance
}
