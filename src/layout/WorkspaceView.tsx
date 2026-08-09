import {
  createContext,
  lazy,
  Suspense,
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
import { FileCode2, Timer } from 'lucide-react'
import { WorkspaceContentTab } from '../components/WorkspaceContentTab'
import { WorkspaceAddMenu } from '../components/WorkspaceAddMenu'
import { QuickPick } from '../components/QuickPick'
import { isAppDialogOpen, promptDialog } from '../components/appDialogStore'
import type { PickerEntry } from '../components/pickerModel'
import { WorkbenchContentPanel as WorkbenchPanel } from '../components/git/GitWindow'
import { ExplorerSidebarPanel, WorkspaceFilesSidebarPanel } from '../components/explorer/ExplorerWindow'
import { PreviewContentPanel } from '../components/explorer/PreviewContentPanel'
import { SourceControlSidebar } from '../components/git/SourceControlSidebar'
import { WorkspacesSidebar } from '../components/workspaces/WorkspacesSidebar'
import { GitHistorySidebar } from '../components/git/GitHistorySidebar'
import { GitBranchesSidebar } from '../components/git/GitBranchesSidebar'
import { AutomationPanel } from '../components/AutomationPanel'
import { WorkspaceSidebarPanelShell } from '../components/WorkspaceSidebarPanelShell'
import { SidebarChromeContext } from '../components/sidebar/sidebarChrome'
import { GitWorkspaceProvider } from '../components/git/GitWorkspaceProvider'
import { AgentSessionsSidebar } from '../components/agent/AgentSessionsSidebar'
import { WorkspaceTodoPanel } from '../components/WorkspaceTodoPanel'
import { WorkspaceFolderPrompt } from '../components/WorkspaceFolderPrompt'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { ProLockedPanel } from '../components/ProLockedPanel'
import { closeBrowserContent } from '../browser/browserContentLifecycle'
import type { BrowserPage, BrowserProfile } from '../browser/types'
import {
  getEditorDocumentStore,
  requestEditorDocumentClose,
  type NativeSaveTextDocumentResult,
} from '../editor/documentStore'
import type { DirEntryInfo, PaneMeta } from '../ipc/types'
import type { WorkspaceCreationInput } from '../ipc/providerIntegrations'
import { TerminalManager } from '../terminal/TerminalManager'
import { waitForStableTerminalGrid } from '../terminal/geometry'
import { openTerminalSearch } from '../terminal/search'
import { isPaletteOpen, openPalette } from '../components/palette/paletteStore'
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
import { clearOpenContentSnapshot, publishOpenContentFromDockview } from './openContentRegistry'
import { TerminalPanePanel } from './TerminalPanePanel'
import { TerminalWindowPanel } from './TerminalWindowPanel'
import { WorkspaceWindowPanel } from './WorkspaceWindowPanel'
import { getTerminalWindow, listTerminalWindows, allWindowedPaneIds, findTerminalWindowForPane, type TerminalWindowHandle } from './terminalWindowRegistry'
import { findWorkspaceWindowForGroup, findWorkspaceWindowForPanel, getWorkspaceWindow, listWorkspaceWindows, type WorkspaceWindowHandle } from './workspaceWindowRegistry'
import { activeWorkspacePanel, focusActiveContentAfterLayout, registerActiveContentFocusOnWindowActivation } from './activeContentFocus'
import { WindowPanelShell } from './WindowPanelShell'
import { vibelinkDockviewTheme } from './dockviewTheme'
import { nearestPaneIdInDirection, paneIdsInReadingOrder, swapPanelsInDockviewApi, type PaneDirection } from './paneSwap'
import { paneIdFromEventTarget } from './paneActivation'
import { expandGridRowsForPaneCount, expandPaneIdsIntoGrid, occupiedGridForPaneCount } from './paneGridPlan'
import { arrangeTerminalPaneGrid } from './innerPaneLayout'
import { WorkspaceEmptyState } from './WorkspaceEmptyState'
import { balancedGridForPaneCount, type GridSize } from './templatePlan'
import { settleDockviewOverlayLayout, settleDockviewOverlayReposition } from './splitOverlayLayout'
import { isDividerResizeActive, isInteractiveResizeActive, onInteractiveResizeEnd } from './interactiveResize'
import { isLayoutParamsPersistActive, withSuppressedPanelRemoval } from './suppression'
import {
  AUTOMATION_PANE_ROLE,
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
  completeWorkspaceStructuralLayout,
  createPreviewContentParams,
  createSingletonContentParams,
  createTerminalContentParams,
  createTerminalWindowParams,
  normalizeWorkspaceLayoutState,
} from './workspaceLayoutModel'
import {
  centralGridIsEmpty,
  closeStrayTerminalPanels,
  createWorkspaceResizeCoordinator,
  collapseStructuralWorkspacePanel,
  toggleStructuralWorkspacePanel,
  toggleWorkspaceLeftSidebar,
  collapseWorkspaceEdgesForCenterWidth,
  ensureWorkspaceEdgeShell,
  registerWorkspaceEdgeGroups,
  rememberAuthoredLayout,
  resetWorkspaceEdgeDefaults,
  resolveWorkspaceContentGroup,
  updateOpenPreviewPanel,
  workspaceGroupShowsCreationControls,
  workspaceChromeStatesEqual,
  type WorkspaceResizeCoordinator,
} from './workspaceShellModel'
import { buildWorkspaceContentTabContextMenu } from './workspaceContentTabMenu'
import { finalizeLocalSplitLayout, finalizeLocalSplitSize, localSplitInitialSize } from './localSplitSizing'
import { resolvePaneZoomTarget } from './paneZoom'
import { dockviewOverlaysSettled, forceOverlayReposition } from './dockviewOverlay'
import { getContentRect, isDockElementMeasurable, nextContentAfterClose, reflowTerminalsAfterLayout, workspaceAspectRatio } from './workspaceDockGeometry'
const KanbanBoard = lazy(() => import('../components/KanbanBoard').then((module) => ({ default: module.KanbanBoard })))
const TaskDiffView = lazy(() => import('../components/TaskDiffView').then((module) => ({ default: module.TaskDiffView })))
const OrchestratorChat = lazy(() => import('../components/OrchestratorChat').then((module) => ({ default: module.OrchestratorChat })))
const OrchestrationWorkspacePanel = lazy(() => import('../components/OrchestrationWorkspacePanel').then((module) => ({ default: module.OrchestrationWorkspacePanel })))
const MemoryGraphPanel = lazy(() => import('../components/memory/MemoryGraphPanel').then((module) => ({ default: module.MemoryGraphPanel })))
const NativeBrowserContentPanel = lazy(() => import('../browser/BrowserDockPanel').then((module) => ({ default: module.BrowserContentPanel })))
const EditorContentPanel = lazy(() => import('../editor/EditorContentPanel').then((module) => ({ default: module.EditorContentPanel })))


type WorkspaceContentPanelProps = IDockviewPanelProps<WorkspaceContentParams>
type TerminalContentParams = Extract<WorkspaceContentParams, { kind: 'terminal' }>
/** Outer-panel-id prefix for a terminal pane living in a nested window. */
const TERMINAL_PANEL_ID_PREFIX = workspaceContentPanelId({ kind: 'terminal', instanceId: '' })

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
  onEditWorkspaceRequested?: (sessionId: string) => void
  onCreateWorkspaceRequested?: () => void
  onImportReposRequested?: () => void
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
/** A terminal panel already placed in a window, whose PTY has not spawned yet. */
type PendingPaneSpawn = { pending: PaneMeta; panelId: string }
type LocatedWorkspacePanel = { panel: IDockviewPanel; api: DockviewApi; workspaceWindow?: WorkspaceWindowHandle }

function findWorkspacePanel(api: DockviewApi, panelId: string): LocatedWorkspacePanel | null {
  const outerPanel = api.getPanel(panelId)
  if (outerPanel) return { panel: outerPanel, api }
  const workspaceWindow = findWorkspaceWindowForPanel(panelId)
  const innerApi = workspaceWindow?.getInnerApi()
  const panel = innerApi?.getPanel(panelId)
  return panel && innerApi ? { panel, api: innerApi, workspaceWindow } : null
}

function workspaceContentPanels(api: DockviewApi): IDockviewPanel[] {
  return api.panels.flatMap((panel) => {
    const content = parseWorkspaceContentParams(panel.params)
    return content?.kind === 'workspaceWindow'
      ? getWorkspaceWindow(content.instanceId)?.getInnerApi()?.panels ?? []
      : [panel]
  })
}



function TerminalContentPanel(props: WorkspaceContentPanelProps) {
  const params = parseWorkspaceContentParams(props.params)
  return params?.kind === 'terminal'
    ? <TerminalPaneBoundary {...props} params={params} />
    : <div className="placeholder-panel">Terminal pane metadata is missing.</div>
}

function TerminalPaneBoundary(props: IDockviewPanelProps<TerminalContentParams>) {
  return <ErrorBoundary label="Terminal pane"><TerminalPanePanel {...props} /></ErrorBoundary>
}

function TerminalWindowContentPanel(props: WorkspaceContentPanelProps) {
  const params = parseWorkspaceContentParams(props.params)
  return params?.kind === 'terminalWindow'
    ? <ErrorBoundary label="Terminal window"><TerminalWindowPanel {...props} params={params} /></ErrorBoundary>
    : <div className="placeholder-panel">Terminal window metadata is missing.</div>
}
function WorkspaceWindowContentPanel(props: WorkspaceContentPanelProps) {
  const params = parseWorkspaceContentParams(props.params)
  const integration = useContext(WorkspaceIntegrationContext)
  if (params?.kind !== 'workspaceWindow' || !integration.contentComponents || !integration.setCurrentMainGroupId) {
    return <div className="placeholder-panel">Workspace window metadata is missing.</div>
  }
  return (
    <ErrorBoundary label="Workspace window">
      <WorkspaceWindowPanel
        {...props}
        params={params}
        components={integration.contentComponents}
        leftHeaderActionsComponent={WorkspaceGroupActionsWithContext}
        onActiveGroupChange={integration.setCurrentMainGroupId}
      />
    </ErrorBoundary>
  )
}


function ProPanelBoundary({ feature, children }: { feature: string; children: ReactNode }) {
  const entitled = useWorkspaceStore((state) => Boolean(state.license.ready && state.license.status?.entitled))
  return entitled ? children : <ProLockedPanel feature={feature} />
}

/** `active` is dockview focus (drives the header accent); `visible` is "this
 * panel is the selected tab in its group". Content and data gating MUST use
 * `visible` — an unfocused edge panel is still on screen, and gating it on
 * `active` blanks the panel as soon as the user clicks a terminal. */
function useEdgePanelState(api: WorkspaceContentPanelProps['api']) {
  const [state, setState] = useState(() => ({ active: api.isActive, visible: api.isVisible, collapsed: api.group.api.isCollapsed() }))
  useEffect(() => {
    let collapsed: { dispose: () => void } | undefined
    const syncState = () => setState({ active: api.isActive, visible: api.isVisible, collapsed: api.group.api.isCollapsed() })
    const subscribeCollapsed = () => {
      collapsed?.dispose()
      collapsed = api.group.api.onDidCollapsedChange(({ isCollapsed }) => setState((current) => ({ ...current, collapsed: isCollapsed })))
      syncState()
    }
    const active = api.onDidActiveChange(syncState)
    const visible = api.onDidVisibilityChange(syncState)
    const group = api.onDidGroupChange(subscribeCollapsed)
    subscribeCollapsed()
    return () => {
      active.dispose()
      visible.dispose()
      group.dispose()
      collapsed?.dispose()
    }
  }, [api])
  return state
}

function WorkspacesContentPanel(props: WorkspaceContentPanelProps) {
  const state = useEdgePanelState(props.api)
  const integration = useContext(WorkspaceIntegrationContext)
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-workspaces"><ProPanelBoundary feature="Workspaces"><ErrorBoundary label="Workspaces panel"><SidebarChromeContext.Provider value={true}><WorkspacesSidebar active={state.active} collapsed={state.collapsed} onCollapse={() => props.api.group.api.collapse()} integration={integration} /></SidebarChromeContext.Provider></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

function SourceControlContentPanel(props: WorkspaceContentPanelProps) {
  const state = useEdgePanelState(props.api)
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-source-control"><ProPanelBoundary feature="Source Control"><ErrorBoundary label="Source Control panel"><SourceControlSidebar active={state.active} collapsed={state.collapsed} onCollapse={() => props.api.group.api.collapse()} /></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

function GitHistoryContentPanel(props: WorkspaceContentPanelProps) {
  const state = useEdgePanelState(props.api)
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-git-history"><ProPanelBoundary feature="Git History"><ErrorBoundary label="Git History panel"><GitHistorySidebar active={state.active} visible={state.visible} collapsed={state.collapsed} onCollapse={() => props.api.group.api.collapse()} /></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

function GitBranchesContentPanel(props: WorkspaceContentPanelProps) {
  const state = useEdgePanelState(props.api)
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-git-branches"><ProPanelBoundary feature="Git Branches"><ErrorBoundary label="Git Branches panel"><GitBranchesSidebar active={state.active} visible={state.visible} collapsed={state.collapsed} onCollapse={() => props.api.group.api.collapse()} /></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

/** Automations is a left-edge structural singleton. Unlike the Git sidebars,
 * which own their shell internally, the automation body is shell-agnostic, so
 * the narrow-sidebar chrome (header, collapse, state slots) is applied here. */
function AutomationContentPanel(props: WorkspaceContentPanelProps) {
  const state = useEdgePanelState(props.api)
  return (
    <WindowPanelShell panelId={props.api.id} className="workspace-window-automation">
      <ProPanelBoundary feature="Automations">
        <ErrorBoundary label="Automations panel">
          <SidebarChromeContext.Provider value={true}>
            <WorkspaceSidebarPanelShell
              title="Automations"
              icon={<Timer size={15} aria-hidden="true" />}
              active={state.active}
              collapsed={state.collapsed}
              onCollapse={() => props.api.group.api.collapse()}
            >
              <AutomationPanel active={state.visible && !state.collapsed} />
            </WorkspaceSidebarPanelShell>
          </SidebarChromeContext.Provider>
        </ErrorBoundary>
      </ProPanelBoundary>
    </WindowPanelShell>
  )
}

function AgentSessionsContentPanel(props: WorkspaceContentPanelProps) {
  const state = useEdgePanelState(props.api)
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-agent-sessions"><ProPanelBoundary feature="Agent Sessions"><ErrorBoundary label="Agent Sessions panel"><AgentSessionsSidebar active={state.active} visible={state.visible} collapsed={state.collapsed} onCollapse={() => props.api.group.api.collapse()} /></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

function AgentContentPanel(props: WorkspaceContentPanelProps) {
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-agent"><ProPanelBoundary feature="VibeLink Agent"><ErrorBoundary label="VibeLink Agent panel"><Suspense fallback={null}><OrchestratorChat /></Suspense></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

function OrchestrationContentPanel(props: WorkspaceContentPanelProps) {
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-orchestration"><ProPanelBoundary feature="Orchestration"><ErrorBoundary label="Orchestration panel"><Suspense fallback={null}><OrchestrationWorkspacePanel /></Suspense></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

function KanbanContentPanel(props: WorkspaceContentPanelProps) {
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-kanban"><ProPanelBoundary feature="Kanban"><ErrorBoundary label="Kanban panel"><Suspense fallback={null}><KanbanBoard /></Suspense></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

function MemoryContentPanel(props: WorkspaceContentPanelProps) {
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-memory"><ProPanelBoundary feature="Memory Graph"><ErrorBoundary label="Memory graph panel"><Suspense fallback={null}><MemoryGraphPanel /></Suspense></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

function TodoContentPanel(props: WorkspaceContentPanelProps) {
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-todo"><ProPanelBoundary feature="Todo orchestration"><ErrorBoundary label="Todo panel"><WorkspaceTodoPanel /></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

function DiffContentPanel(props: WorkspaceContentPanelProps) {
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-diff"><ProPanelBoundary feature="Task diff"><ErrorBoundary label="Diff panel"><Suspense fallback={null}><TaskDiffView /></Suspense></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

type WorkspaceIntegrationContextValue = {
  onDeleteWorkspaceRequested?: (sessionId: string) => void | Promise<void>
  onEditWorkspaceRequested?: (sessionId: string) => void
  onCreateWorkspaceRequested?: () => void
  onImportReposRequested?: () => void
  onWorkspaceInput?: (input: WorkspaceCreationInput) => void | Promise<void>
  openFilePicker?: (targetGroupId?: string) => void
  nativeSurfacesSuspended?: boolean
  layoutOwner?: WorkspaceLayoutIdentity | null
  setWorkspaceOverlayOpen?: (overlayId: string, open: boolean) => void
  currentMainGroupId?: string | null
  contentComponents?: Record<WorkspaceContentKind, WorkspaceContentPanelComponent>
  setCurrentMainGroupId?: (groupId: string | null) => void
}

const WorkspaceIntegrationContext = createContext<WorkspaceIntegrationContextValue>({})

function BrowserWorkspaceContentPanel(props: WorkspaceContentPanelProps) {
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

  // Stable, idempotent title updater. An inline arrow here recreated every
  // render, and BrowserPanel's title effect depends on its identity, so it
  // re-ran every render → updateParameters → re-render → infinite loop
  // ("Maximum update depth"). Keying on props.api (stable) and skipping the
  // update when the title is unchanged breaks the cycle at both ends.
  const handleBrowserTitleChange = useCallback((title: string) => {
    const nextTitle = title.trim() || 'Browser'
    const current = parseWorkspaceContentParams(props.api.getParameters())
    if (current?.kind !== 'browser' || current.title === nextTitle) return
    props.api.updateParameters({ ...current, title: nextTitle })
    props.api.setTitle(nextTitle)
  }, [props.api])

  if (!workspaceId || workspaceEpoch === null || params?.kind !== 'browser') {
    return <WindowPanelShell panelId={props.api.id}><div className="placeholder-panel">Browser content metadata is missing.</div></WindowPanelShell>
  }
  return (
    <WindowPanelShell panelId={props.api.id} className="workspace-window-browser">
      <ProPanelBoundary feature="Browser">
        <ErrorBoundary label="Browser panel">
          <Suspense fallback={null}>
            <NativeBrowserContentPanel
              workspaceId={workspaceId}
              pageId={params.pageId}
              profileId={params.profileId}
              active={panelState.active}
              focused={panelState.focused}
              workspaceVisible={panelState.visible && !nativeSurfacesSuspended}
              nativeSurfacesSuspended={nativeSurfacesSuspended}
              onTitleChange={handleBrowserTitleChange}
            />
          </Suspense>
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

type ContextualExplorerContentPanelProps = WorkspaceContentPanelProps & { variant: 'explorer' | 'workspaceFiles' }

function ContextualExplorerContentPanel({ variant, ...props }: ContextualExplorerContentPanelProps) {
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
  const workspaceFiles = variant === 'workspaceFiles'
  const Sidebar = workspaceFiles ? WorkspaceFilesSidebarPanel : ExplorerSidebarPanel
  const panelClass = workspaceFiles ? 'workspace-window-workspace-files' : 'workspace-window-explorer'
  const errorLabel = workspaceFiles ? 'Workspace files panel' : 'Explorer panel'
  const placeholder = workspaceFiles ? 'Select a workspace or worktree to browse its files.' : 'Select a workspace to browse files.'
  return (
    <WindowPanelShell panelId={props.api.id} className={panelClass}>
      <ProPanelBoundary feature="Explorer"><ErrorBoundary label={errorLabel}><SidebarChromeContext.Provider value={!workspaceFiles}>{sessionId && workspaceFolder ? <WorkspaceContentActionsContext.Provider value={scopedActions}><Sidebar sessionId={sessionId} workspaceFolder={workspaceFolder} onCollapse={() => props.api.group.api.collapse()} /></WorkspaceContentActionsContext.Provider> : sessionId ? <WorkspaceFolderPrompt sessionId={sessionId} /> : <div className="placeholder-panel">{placeholder}</div>}</SidebarChromeContext.Provider></ErrorBoundary></ProPanelBoundary>
    </WindowPanelShell>
  )
}

function ExplorerContentPanel(props: WorkspaceContentPanelProps) {
  return <ContextualExplorerContentPanel {...props} variant="explorer" />
}

function WorkspaceFilesContentPanel(props: WorkspaceContentPanelProps) {
  return <ContextualExplorerContentPanel {...props} variant="workspaceFiles" />
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
  return <WindowPanelShell panelId={props.api.id} className="workspace-window-editor"><ProPanelBoundary feature="Editor"><ErrorBoundary label="Editor panel"><Suspense fallback={null}><EditorContentPanel sessionId={sessionId} workspaceFolder={workspaceFolder} relPath={params.relPath} /></Suspense></ErrorBoundary></ProPanelBoundary></WindowPanelShell>
}

export const builtInContentComponents: Record<WorkspaceContentKind, WorkspaceContentPanelComponent> = {
  terminal: TerminalContentPanel,
  terminalWindow: TerminalWindowContentPanel,
  workspaceWindow: WorkspaceWindowContentPanel,
  browser: BrowserWorkspaceContentPanel,
  editor: EditorWorkspaceContentPanel,
  preview: PreviewWorkspaceContentPanel,
  workspaces: WorkspacesContentPanel,
  explorer: ExplorerContentPanel,
  workspaceFiles: WorkspaceFilesContentPanel,
  sourceControl: SourceControlContentPanel,
  gitHistory: GitHistoryContentPanel,
  gitBranches: GitBranchesContentPanel,
  automation: AutomationContentPanel,
  workbench: WorkbenchContentPanel,
  agent: AgentContentPanel,
  orchestration: OrchestrationContentPanel,
  kanban: KanbanContentPanel,
  todo: TodoContentPanel,
  diff: DiffContentPanel,
  agentSessions: AgentSessionsContentPanel,
  memory: MemoryContentPanel,
}

/** dockview-react re-runs `updateOptions` — a full `_layoutFromShell` plus a
 *  floating-overlay-host measurement — whenever this object's identity changes.
 *  Inline, that fired on every WorkspaceView render and taxed unrelated state
 *  updates with a forced dock relayout. */
const workspaceTabComponents = { workspaceContentTab: WorkspaceContentTab }

/** Group-local creation controls. The group is the placement authority, while
 * Dockview remains the only drag/drop and split-movement authority. */
export function WorkspaceGroupActions(props: IDockviewHeaderActionsProps) {
  return <WorkspaceGroupActionsWithContext {...props} />
}


function WorkspaceGroupActionsWithContext(props: IDockviewHeaderActionsProps & { fallbackActions?: WorkspaceContentActions | null }) {
  const actions = useContext(WorkspaceContentActionsContext) ?? props.fallbackActions ?? null
  const integration = useContext(WorkspaceIntegrationContext)
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const groupId = props.group.id
  const isWorkspaceWindowShell = props.group.panels.some((panel) => parseWorkspaceContentParams(panel.params)?.kind === 'workspaceWindow')
  const targetGroupId = isWorkspaceWindowShell ? integration.currentMainGroupId : groupId
  const menuOverlayId = `group-menu:${targetGroupId ?? groupId}`
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation()
  const isCurrentMainGroup = isWorkspaceWindowShell
    ? props.isGroupActive && Boolean(targetGroupId)
    : workspaceGroupShowsCreationControls(props.group.api.location.type, groupId, integration.currentMainGroupId)

  if (!isCurrentMainGroup || !targetGroupId) return null

  return (
    <div className="workspace-group-actions" onMouseDown={stop} onPointerDown={stop}>
      <WorkspaceAddMenu
        actions={actions}
        targetGroupId={targetGroupId}
        overlayId={menuOverlayId}
        disabled={!actions || !activeSessionId}
        openFilePicker={integration.openFilePicker}
        setWorkspaceOverlayOpen={integration.setWorkspaceOverlayOpen}
      />
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
  onEditWorkspaceRequested,
  onCreateWorkspaceRequested,
  onImportReposRequested,
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
  // Layout strings this view authored for the session it currently owns. The
  // store's layoutJson is written back by our own save_layout round trip, and
  // several persists can be in flight at once, so `loadedLayoutJsonRef` alone
  // cannot tell "someone else changed the layout" from "my own save landed out
  // of order". Rebuilding the dock for our own write is what made a workspace
  // open flicker: restore -> persist -> store update -> clear + fromJSON of the
  // older copy -> stale pane titles -> persist again, forever.
  const authoredLayoutsRef = useRef(new Set<string>())
  const suppressPanelRemovalRef = useRef(false)
  const saveTimerRef = useRef<number | undefined>()
  const apiDisposablesRef = useRef<Array<{ dispose: () => void }>>([])
  const resizeCoordinatorRef = useRef<WorkspaceResizeCoordinator | null>(null)
  const lastChromeStateRef = useRef<WorkspaceContentChromeState | null>(null)
  const resizeEpochRef = useRef(0)
  const resizeSettlingRef = useRef(false)
  const resizeSettlePendingRef = useRef(false)
  const edgeSettleEpochRef = useRef(0)
  // Set when the quiet timer wanted to settle while a drag was still running.
  const resizeSettleDeferredRef = useRef(false)
  const layoutLoadQueueRef = useRef<Promise<void>>(Promise.resolve())
  const layoutEpochRef = useRef(0)
  const layoutOwnerRef = useRef<WorkspaceLayoutOwner | null>(null)
  const applyingArrangeRequestRef = useRef<number | null>(null)
  const applyingContentRequestRef = useRef<number | null>(null)
  const applyingSaveRequestRef = useRef<number | null>(null)
  const pendingTerminalPaneIdsRef = useRef(new Set<string>())
  const lastMainGroupIdRef = useRef<string | null>(null)
  const [currentMainGroupId, setCurrentMainGroupId] = useState<string | null>(null)
  const updateCurrentMainGroupId = useCallback((groupId: string | null) => {
    lastMainGroupIdRef.current = groupId
    setCurrentMainGroupId(groupId)
  }, [])
  const [apiVersion, setApiVersion] = useState(0)
  const [dockApi, setDockApi] = useState<DockviewApi | null>(null)
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
  // The second predicate answers ONLY "may focus move into workspace content".
  // It MUST NOT consult `document.hasFocus()`: after Alt+Tab the frameless
  // window's WebView2 child HWND is exactly what has NOT been focused yet, so
  // that check is false in the one case this recovery exists for and the pane
  // would stay keyboard-dead until clicked.
  useEffect(() => registerActiveContentFocusOnWindowActivation(
    () => apiRef.current,
    () => !workspaceInteractionSuspendedRef.current,
  ), [])
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
    onDeleteWorkspaceRequested,
    onEditWorkspaceRequested,
    onCreateWorkspaceRequested,
    onImportReposRequested,
    onWorkspaceInput,
    openFilePicker,
    nativeSurfacesSuspended: effectiveNativeSurfacesSuspended,
    layoutOwner: loadedLayoutOwner,
    setWorkspaceOverlayOpen,
    currentMainGroupId,
    contentComponents: components,
    setCurrentMainGroupId: updateCurrentMainGroupId,
  }), [components, currentMainGroupId, effectiveNativeSurfacesSuspended, loadedLayoutOwner, onCreateWorkspaceRequested, onDeleteWorkspaceRequested, onEditWorkspaceRequested, onImportReposRequested, onWorkspaceInput, openFilePicker, setWorkspaceOverlayOpen, updateCurrentMainGroupId])

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
    loadedApiRef.current = owner.api
    loadedSessionEpochRef.current = owner.sessionEpoch
    // Record what we are about to write, but do NOT claim it as the loaded
    // layout yet: save_layout is async, so until it lands the store still holds
    // the previous string. Overwriting the ref here makes the very next render
    // see loaded != store and rebuild the dock from the older copy. The store's
    // echo is recognised through the authored history instead.
    rememberAuthoredLayout(authoredLayoutsRef.current, serialized)
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
    })
    if (owner && !ownsLayout(owner)) return
    for (const handle of listWorkspaceWindows()) {
      if (api.getPanel(handle.outerPanelId)) await handle.settle()
    }
    reflowTerminalsAfterLayout({ syncPty: options.syncPty, paneIds: options.paneIds })
    focusActiveContentAfterLayout(api, () => !workspaceInteractionSuspendedRef.current)
  }, [layoutDockview, ownsLayout])

  const settleEdgeLayout = useCallback(async (api: DockviewApi) => {
    const epoch = edgeSettleEpochRef.current + 1
    edgeSettleEpochRef.current = epoch
    await settleDockviewOverlayReposition({
      refresh: () => {
        if (edgeSettleEpochRef.current === epoch && apiRef.current === api) forceOverlayReposition(api)
      },
      isSettled: () => edgeSettleEpochRef.current !== epoch
        || apiRef.current !== api
        || dockviewOverlaysSettled(api),
    })
    if (edgeSettleEpochRef.current !== epoch || apiRef.current !== api) return
    for (const handle of listWorkspaceWindows()) {
      if (api.getPanel(handle.outerPanelId)) await handle.settle()
    }
    reflowTerminalsAfterLayout({ syncPty: true })
    focusActiveContentAfterLayout(api, () => !workspaceInteractionSuspendedRef.current)
  }, [])

  const getContentParams = useCallback((panelId: string) => {
    const api = apiRef.current
    return api ? parseWorkspaceContentParams(findWorkspacePanel(api, panelId)?.panel.params) : null
  }, [])

  const activateContent = useCallback((panelId: string) => {
    const api = apiRef.current
    if (!api) return
    const located = findWorkspacePanel(api, panelId)
    if (located) {
      const content = parseWorkspaceContentParams(located.panel.params)
      if (content && isStructuralWorkspaceContentKind(content.kind) && located.panel.group.api.location.type === 'edge') located.panel.group.api.expand()
      if (located.workspaceWindow) api.getPanel(located.workspaceWindow.outerPanelId)?.api.setActive()
      located.panel.api.setActive()
      if (content?.kind === 'workspaceWindow') getWorkspaceWindow(content.instanceId)?.focusActive()
      else if (content?.kind === 'terminalWindow') getTerminalWindow(content.instanceId)?.focusFirst()
      return
    }
    // Terminal panes live one level deeper inside a terminal window. Reveal the
    // owning workspace window, then its terminal window, then the pane itself.
    if (!panelId.startsWith(TERMINAL_PANEL_ID_PREFIX)) return
    const paneId = panelId.slice(TERMINAL_PANEL_ID_PREFIX.length)
    const handle = findTerminalWindowForPane(paneId)
    if (!handle) return
    const windowPanelId = workspaceContentPanelId({ kind: 'terminalWindow', instanceId: handle.windowId })
    const windowPanel = findWorkspacePanel(api, windowPanelId)
    if (windowPanel?.workspaceWindow) api.getPanel(windowPanel.workspaceWindow.outerPanelId)?.api.setActive()
    windowPanel?.panel.api.setActive()
    handle.getInnerApi()?.getPanel(panelId)?.api.setActive()
    useWorkspaceStore.getState().setActivePaneId(paneId)
    useWorkspaceStore.getState().clearPaneCompletionHighlight(paneId)
    // Dockview reveals a nested pane on the next frame; focusing it while hidden is ignored.
    requestAnimationFrame(() => {
      if (!workspaceInteractionSuspendedRef.current && handle.getInnerApi()?.activePanel?.id === panelId) TerminalManager.focus(paneId)
    })
  }, [])

  const addContentPanel = useCallback((params: WorkspaceContentParams, options: AddContentOptions = {}, targetApi?: DockviewApi): IDockviewPanel | null => {
    const rootApi = targetApi ?? apiRef.current
    if (!rootApi) return null
    const structural = isStructuralWorkspaceContentKind(params.kind)
    let api = rootApi
    let workspaceWindow = listWorkspaceWindows().find((handle) => handle.getInnerApi() === rootApi)
    if (!structural && params.kind !== 'workspaceWindow' && !workspaceWindow) {
      const candidates = listWorkspaceWindows().filter((handle) => Boolean(rootApi.getPanel(handle.outerPanelId)))
      const targetOwner = options.targetGroupId ? findWorkspaceWindowForGroup(options.targetGroupId) : undefined
      const referenceOwner = options.referencePanelId ? findWorkspaceWindowForPanel(options.referencePanelId) : undefined
      const activeOuter = parseWorkspaceContentParams(rootApi.activePanel?.params)
      const activeOwner = activeOuter?.kind === 'workspaceWindow' ? getWorkspaceWindow(activeOuter.instanceId) : undefined
      workspaceWindow = [targetOwner, referenceOwner, activeOwner, ...candidates].find((handle) => handle && rootApi.getPanel(handle.outerPanelId))
      const innerApi = workspaceWindow?.getInnerApi()
      if (!innerApi) return null
      api = innerApi
    }
    const panelId = workspaceContentPanelId(params)
    const existing = api.getPanel(panelId)
    if (existing) {
      if (!options.inactive) activateContent(existing.id)
      return existing
    }
    const targetGroup = resolveWorkspaceContentGroup(api, params.kind, options.targetGroupId, lastMainGroupIdRef.current)
    if (!targetGroup) return null
    const referencePanel = !structural && options.referencePanelId ? api.getPanel(options.referencePanelId) : undefined
    const localSplit = referencePanel && options.direction && referencePanel.group.api.location.type === 'grid'
      ? {
          beforeLayout: api.toJSON(),
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
    const panel = api.addPanel(panelOptions as AddPanelOptions<WorkspaceContentParams>)
    if (referencePanel && options.direction && localSplit) {
      if (!finalizeLocalSplitLayout(api, localSplit.beforeLayout, referencePanel.id, panel.id, options.direction)) {
        finalizeLocalSplitSize(referencePanel.group, panel.group, options.direction, localSplit.referenceSize)
      }
    }
    if (panel.group.api.location.type === 'grid' && (!options.inactive || !lastMainGroupIdRef.current)) {
      lastMainGroupIdRef.current = panel.group.id
      setCurrentMainGroupId(panel.group.id)
    }
    workspaceWindow?.persist()
    if (!options.inactive) activateContent(panel.id)
    return panel
  }, [activateContent])

  const resolveTerminalWindowId = useCallback((api: DockviewApi, options: { windowId?: string; targetGroupId?: string }): string | null => {
    if (options.windowId && getTerminalWindow(options.windowId)) return options.windowId
    if (options.targetGroupId) {
      const group = findWorkspaceWindowForGroup(options.targetGroupId)?.getInnerApi()?.groups.find((candidate) => candidate.id === options.targetGroupId)
      const params = parseWorkspaceContentParams(group?.panels.find((panel) => parseWorkspaceContentParams(panel.params)?.kind === 'terminalWindow')?.params)
      if (params?.kind === 'terminalWindow') return params.instanceId
    }
    const active = parseWorkspaceContentParams(activeWorkspacePanel(api)?.params)
    if (active?.kind === 'terminalWindow') return active.instanceId
    const activePaneId = useWorkspaceStore.getState().activePaneId
    if (activePaneId) {
      const owning = findTerminalWindowForPane(activePaneId)
      if (owning && findWorkspacePanel(api, workspaceContentPanelId({ kind: 'terminalWindow', instanceId: owning.windowId }))) return owning.windowId
    }
    const firstParams = parseWorkspaceContentParams(workspaceContentPanels(api).find((panel) => parseWorkspaceContentParams(panel.params)?.kind === 'terminalWindow')?.params)
    return firstParams?.kind === 'terminalWindow' ? firstParams.instanceId : null
  }, [])

  const waitForWorkspaceWindowPanels = useCallback(async (api: DockviewApi, sessionId: string, sessionEpoch: number): Promise<boolean> => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const windowIds = api.panels.flatMap((panel) => {
        const content = parseWorkspaceContentParams(panel.params)
        return content?.kind === 'workspaceWindow' ? [content.instanceId] : []
      })
      if (windowIds.length > 0 && windowIds.every((windowId) => Boolean(getWorkspaceWindow(windowId)?.getInnerApi()))) return true
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (apiRef.current !== api
        || useWorkspaceStore.getState().activeSessionId !== sessionId
        || getWorkspaceSessionEpoch() !== sessionEpoch
        || getWorkspaceSessionTargetId() !== sessionId) return false
    }
    return false
  }, [])

  const waitForTerminalWindow = useCallback(async (windowId: string, owner: WorkspaceLayoutOwner): Promise<TerminalWindowHandle | null> => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const handle = getTerminalWindow(windowId)
      if (handle && handle.getInnerApi()) return handle
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (!ownsLayout(owner)) return null
    }
    return null
  }, [ownsLayout])

  const ensureTerminalWindow = useCallback(async (owner: WorkspaceLayoutOwner, options: { windowId?: string; targetGroupId?: string; forceNew?: boolean } = {}): Promise<TerminalWindowHandle | null> => {
    const api = owner.api
    let windowId = options.forceNew ? null : resolveTerminalWindowId(api, options)
    if (!windowId) {
      const params = createTerminalWindowParams(crypto.randomUUID(), [], { cols: 1, rows: 1 })
      const panel = addContentPanel(params, { targetGroupId: options.targetGroupId }, api)
      if (!panel || !ownsLayout(owner)) return null
      windowId = params.instanceId
      await settleLayout({}, owner)
      if (!ownsLayout(owner)) return null
    }
    return waitForTerminalWindow(windowId, owner)
  }, [addContentPanel, ownsLayout, resolveTerminalWindowId, settleLayout, waitForTerminalWindow])

  /** Synchronously place a pending pane panel. Kept separate from the PTY spawn
   *  so grid creation can add every panel first, arrange the final grid, settle
   *  ONCE, and then spawn all PTYs concurrently. */
  const addPendingPane = useCallback((handle: TerminalWindowHandle, owner: WorkspaceLayoutOwner, options: { referencePaneId?: string; direction?: 'right' | 'below'; inactive?: boolean; profileId?: string | null; batch?: boolean } = {}): PendingPaneSpawn | null => {
    const profile = options.profileId === undefined
      ? selectedProfileForWorkspace(useWorkspaceStore.getState().settings, owner.sessionId)
      : profileById(useWorkspaceStore.getState().settings, options.profileId)
    const pending = pendingPaneMeta(crypto.randomUUID(), profile.name, profile.icon)
    const panelId = workspaceContentPanelId({ kind: 'terminal', instanceId: pending.id })
    pendingTerminalPaneIdsRef.current.add(pending.id)
    const panel = handle.addPane(createTerminalContentParams(pending), { referencePaneId: options.referencePaneId, direction: options.direction, inactive: options.inactive, batch: options.batch })
    if (!panel) {
      pendingTerminalPaneIdsRef.current.delete(pending.id)
      return null
    }
    return { pending, panelId }
  }, [])

  /** Measure the placed panel and spawn its PTY. The panel must already sit at
   *  its final geometry (one settle for a single pane, one for a whole grid). */
  const spawnIntoPendingPane = useCallback(async (handle: TerminalWindowHandle, owner: WorkspaceLayoutOwner, entry: PendingPaneSpawn, options: { inactive?: boolean; profileId?: string | null; cwd?: string | null; shell?: string | null; args?: string[]; title?: string; deferLayoutCommit?: boolean } = {}) => {
    const { pending, panelId } = entry
    let spawnedPaneId: string | null = null
    let committed = false
    try {
      if (!ownsLayout(owner) || !handle.getInnerApi()?.getPanel(panelId)) return ''
      const size = await measuredSpawnSize(pending.id)
      const spawned = await spawnPane(owner.sessionId, {
        paneId: pending.id,
        ...(options.profileId !== undefined ? { profileId: options.profileId } : {}),
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.shell !== undefined ? { shell: options.shell } : {}),
        ...(options.args !== undefined ? { args: options.args } : {}),
        title: options.title ?? pending.config.title ?? undefined,
        cols: size?.cols,
        rows: size?.rows,
      })
      spawnedPaneId = spawned.id
      if (!ownsLayout(owner)) return ''
      const livePanel = handle.getInnerApi()?.getPanel(panelId)
      if (!livePanel) return ''
      const liveParams = createTerminalContentParams(spawned)
      livePanel.update({ params: liveParams })
      livePanel.api.setTitle(liveParams.title)
      if (!options.inactive) {
        useWorkspaceStore.getState().setActivePaneId(spawned.id)
        if (!workspaceInteractionSuspendedRef.current) TerminalManager.focus(spawned.id)
      }
      if (!options.deferLayoutCommit) {
        reflowTerminalsAfterLayout({ syncPty: true, paneIds: [spawned.id] })
        handle.persist()
        persistLayoutSoon()
      }
      committed = true
      return panelId
    } catch (error) {
      if (ownsLayout(owner)) useWorkspaceStore.getState().setError(String(error))
      return ''
    } finally {
      try {
        if (!committed) {
          handle.removePane(pending.id)
          TerminalManager.dispose(pending.id)
          if (spawnedPaneId) await closePaneInStore(spawnedPaneId, owner.sessionId).catch(() => undefined)
        }
      } finally {
        pendingTerminalPaneIdsRef.current.delete(pending.id)
      }
    }
  }, [closePaneInStore, ownsLayout, persistLayoutSoon, spawnPane])

  const spawnTerminal = useCallback(async (owner: WorkspaceLayoutOwner, options: { windowId?: string; targetGroupId?: string; forceNewWindow?: boolean; referencePaneId?: string; direction?: 'right' | 'below'; inactive?: boolean; profileId?: string | null; cwd?: string | null; shell?: string | null; args?: string[]; title?: string; deferLayoutCommit?: boolean } = {}) => {
    if (!ownsLayout(owner)) return ''
    const handle = await ensureTerminalWindow(owner, { windowId: options.windowId, targetGroupId: options.targetGroupId, forceNew: options.forceNewWindow })
    if (!handle || !ownsLayout(owner)) return ''
    const entry = addPendingPane(handle, owner, { referencePaneId: options.referencePaneId, direction: options.direction, inactive: options.inactive, profileId: options.profileId })
    if (!entry) return ''
    await handle.settle()
    return spawnIntoPendingPane(handle, owner, entry, options)
  }, [addPendingPane, ensureTerminalWindow, ownsLayout, spawnIntoPendingPane])

  const replaceTerminalProcess = useCallback(async (owner: WorkspaceLayoutOwner, paneId: string, options: { cwd?: string | null; shell?: string | null; args?: string[]; title?: string } = {}) => {
    if (!ownsLayout(owner)) return ''
    const handle = findTerminalWindowForPane(paneId)
    const panelId = workspaceContentPanelId({ kind: 'terminal', instanceId: paneId })
    const panel = handle?.getInnerApi()?.getPanel(panelId)
    const pane = useWorkspaceStore.getState().panes[paneId]
    if (!handle || !panel || !pane?.alive) return ''

    pendingTerminalPaneIdsRef.current.add(paneId)
    let closed = false
    let committed = false
    try {
      const size = await measuredSpawnSize(paneId)
      await closePaneInStore(paneId, owner.sessionId)
      closed = true
      TerminalManager.dispose(paneId)
      if (!ownsLayout(owner) || !handle.getInnerApi()?.getPanel(panelId)) return ''

      const spawned = await spawnPane(owner.sessionId, {
        paneId,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.shell !== undefined ? { shell: options.shell } : {}),
        ...(options.args !== undefined ? { args: options.args } : {}),
        title: options.title ?? pane.config.title ?? undefined,
        cols: size?.cols ?? pane.config.cols,
        rows: size?.rows ?? pane.config.rows,
      })
      if (!ownsLayout(owner)) return ''
      const livePanel = handle.getInnerApi()?.getPanel(panelId)
      if (!livePanel) return ''

      const liveParams = createTerminalContentParams(spawned)
      livePanel.update({ params: liveParams })
      livePanel.api.setTitle(liveParams.title)
      livePanel.api.setActive()
      useWorkspaceStore.getState().setActivePaneId(spawned.id)
      if (!workspaceInteractionSuspendedRef.current) TerminalManager.focus(spawned.id)
      reflowTerminalsAfterLayout({ syncPty: true, paneIds: [spawned.id] })
      handle.persist()
      persistLayoutSoon()
      committed = true
      return panelId
    } catch (error) {
      if (ownsLayout(owner)) useWorkspaceStore.getState().setError(String(error))
      return ''
    } finally {
      if (closed && !committed && ownsLayout(owner)) {
        TerminalManager.dispose(paneId)
        handle.removePane(paneId)
        await handle.settle().catch(() => undefined)
        handle.persist()
        if (handle.paneIds().length === 0) {
          const windowPanel = findWorkspacePanel(owner.api, workspaceContentPanelId({ kind: 'terminalWindow', instanceId: handle.windowId }))
          if (windowPanel) await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => { windowPanel.panel.api.close() })
          windowPanel?.workspaceWindow?.persist()
        }
        persistLayoutSoon()
      }
      pendingTerminalPaneIdsRef.current.delete(paneId)
    }
  }, [closePaneInStore, ownsLayout, persistLayoutSoon, spawnPane])


  const findContentByResource = useCallback((params: WorkspaceContentParams, targetApi?: DockviewApi) => {
    const api = targetApi ?? apiRef.current
    return api ? workspaceContentPanels(api).find((panel) => {
      const current = parseWorkspaceContentParams(panel.params)
      return current ? workspaceContentResourceKey(current) === workspaceContentResourceKey(params) : false
    }) : undefined
  }, [])

  const arrangeTerminals = useCallback(async (requestedGrid?: GridSize | null, windowId?: string) => {
    const layoutOwner = currentLayoutOwner()
    if (!layoutOwner || !ownsLayout(layoutOwner)) return
    // A tab action targets its own terminal window. Keyboard/global requests keep
    // the active/first-window fallback.
    const api = layoutOwner.api
    const activeWindow = parseWorkspaceContentParams(activeWorkspacePanel(api)?.params)
    const handle = windowId
      ? getTerminalWindow(windowId)
      : activeWindow?.kind === 'terminalWindow'
        ? getTerminalWindow(activeWindow.instanceId)
        : listTerminalWindows()[0]
    const innerApi = handle?.getInnerApi()
    if (!handle || !innerApi) return
    const activePanelId = innerApi.activePanel?.id ?? null
    const terminalIds = paneIdsInReadingOrder(
      innerApi.panels.filter((panel) => parseWorkspaceContentParams(panel.params)?.kind === 'terminal').map((panel) => panel.id),
      getContentRect,
    )
    if (terminalIds.length < 2) return
    const preferred = requestedGrid ?? balancedGridForPaneCount(terminalIds.length, workspaceAspectRatio(dockRef.current))
    const grid = expandGridRowsForPaneCount(preferred, terminalIds.length)
    await TerminalManager.runLayoutTransaction(async () => {
      arrangeTerminalPaneGrid(innerApi, terminalIds, grid, activePanelId)
      if (!ownsLayout(layoutOwner)) return
      await handle.settle()
    })
    if (!ownsLayout(layoutOwner)) return
    handle.persist()
    persistLayoutSoon()
  }, [currentLayoutOwner, ownsLayout, persistLayoutSoon])

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
    if (request.kind === 'terminalWindow') {
      // Explicit new terminal window (from the + window-type menu).
      return spawnTerminal(owner, { targetGroupId: request.targetGroupId, forceNewWindow: true })
    }
    if (request.kind === 'terminal') {
      const replaceTarget = !request.newWindow && request.replacePaneId
        ? findTerminalWindowForPane(request.replacePaneId)?.getInnerApi()?.getPanel(workspaceContentPanelId({ kind: 'terminal', instanceId: request.replacePaneId }))
        : null
      if (replaceTarget && request.replacePaneId && useWorkspaceStore.getState().panes[request.replacePaneId]?.alive) {
        return replaceTerminalProcess(owner, request.replacePaneId, { cwd: request.cwd, shell: request.shell, args: request.args, title: request.title })
      }
      return spawnTerminal(owner, { windowId: request.windowId, targetGroupId: request.targetGroupId, forceNewWindow: request.newWindow, profileId: request.profileId, cwd: request.cwd, referencePaneId: request.referencePaneId, direction: request.split, shell: request.shell, args: request.args, title: request.title })
    }
    if (request.kind === 'terminal-grid') {
      // `cols × rows` is the TOTAL target grid. Capture the existing visual
      // order, create only the missing panes, then rebuild one flat row-major
      // topology (first row rightward, later rows below the same column).
      const requestedGrid = expandGridRowsForPaneCount({ cols: request.grid.cols, rows: request.grid.rows }, 0)
      const targetCount = requestedGrid.cols * requestedGrid.rows
      const handle = request.grid.windowId
        ? getTerminalWindow(request.grid.windowId)
        : await ensureTerminalWindow(owner, { targetGroupId: request.targetGroupId })
      const innerApi = handle?.getInnerApi()
      if (!handle || !innerApi || !ownsLayout(owner)) return ''
      const activePanelId = innerApi.activePanel?.id ?? null
      const existingPanelIds = paneIdsInReadingOrder(
        innerApi.panels.filter((panel) => parseWorkspaceContentParams(panel.params)?.kind === 'terminal').map((panel) => panel.id),
        getContentRect,
      )
      const additions: PendingPaneSpawn[] = []
      // No progress cover: the panels below are placed synchronously, so the
      // grid is on screen in the first frame and each pane's shell appears as
      // its PTY answers. Covering that hides exactly the per-pane cost this
      // path is tuned against.
      // Place every panel first. Each add is a pure layout mutation, so the
      // whole batch costs one Dockview pass instead of N settle/measure/IPC
      // round trips against a layout that is normalized below anyway.
      for (let index = existingPanelIds.length; index < targetCount; index += 1) {
        if (!ownsLayout(owner)) return ''
        const added = addPendingPane(handle, owner, { profileId: request.grid.profileId, inactive: true, batch: true })
        if (!added) break
        additions.push(added)
      }
      const newPanelIds = additions.map((entry) => entry.panelId)
      const occupied = occupiedGridForPaneCount(existingPanelIds.length, request.grid.occupiedGrid)
      const orderedPanelIds = expandPaneIdsIntoGrid(existingPanelIds, newPanelIds, occupied, requestedGrid)
      const includedPanelIds = new Set(orderedPanelIds)
      for (const panelId of [...existingPanelIds, ...newPanelIds]) {
        if (includedPanelIds.has(panelId)) continue
        includedPanelIds.add(panelId)
        orderedPanelIds.push(panelId)
      }
      const finalGrid = expandGridRowsForPaneCount(requestedGrid, orderedPanelIds.length)
      // One settle on the FINAL topology, so every PTY spawns at the size its
      // pane actually ends up with and no program redraws across a resize. The
      // transaction keeps the intermediate split geometry off the terminals
      // that already exist in this window.
      await TerminalManager.runLayoutTransaction(async () => {
        arrangeTerminalPaneGrid(innerApi, orderedPanelIds, finalGrid, activePanelId ?? orderedPanelIds[0] ?? null)
        if (!ownsLayout(owner)) return
        await handle.settle()
      })
      if (!ownsLayout(owner)) return ''
      const spawnedPanelIds = await Promise.all(additions.map((entry) => spawnIntoPendingPane(handle, owner, entry, { profileId: request.grid.profileId, inactive: true, deferLayoutCommit: true })))
      if (!ownsLayout(owner)) return ''
      handle.persist()
      persistLayoutSoon()
      return spawnedPanelIds.filter(Boolean).at(-1) ?? ''
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
        const ownedPageIds = new Set(workspaceContentPanels(owner.api).flatMap((panel) => {
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
            if (addedPanel && findWorkspacePanel(owner.api, addedPanel.id)?.panel === addedPanel) {
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
      if (findWorkspacePanel(owner.api, panel.id)?.panel === panel) panel.api.close()
      return ''
    }
    persistLayoutSoon()
    return panel.id
  }, [activateContent, addContentPanel, addPendingPane, ensureTerminalWindow, findContentByResource, ownsLayout, persistLayoutSoon, replaceTerminalProcess, settleLayout, spawnIntoPendingPane, spawnTerminal, waitForLayoutOwner])

  const requestCloseContent = useCallback(async (panelId: string, ownership?: WorkspaceContentOwnership): Promise<'closed' | 'cancelled'> => {
    const owner = currentLayoutOwner()
    if (ownership?.workspaceId && owner?.sessionId !== ownership.workspaceId) return 'cancelled'
    if (ownership?.workspaceEpoch !== undefined && owner?.sessionEpoch !== ownership.workspaceEpoch) return 'cancelled'
    const api = owner?.api
    if (!owner || !api) return 'cancelled'

    if (panelId.startsWith('content:terminal:')) {
      const paneId = panelId.slice('content:terminal:'.length)
      const handle = findTerminalWindowForPane(paneId)
      if (!handle) {
        const stray = findWorkspacePanel(api, panelId)
        if (!stray) return 'cancelled'
        pendingTerminalPaneIdsRef.current.add(paneId)
        TerminalManager.dispose(paneId)
        await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => { stray.panel.api.close() })
        stray.workspaceWindow?.persist()
        void closePaneInStore(paneId, owner.sessionId)
          .catch((error) => useWorkspaceStore.getState().setError(String(error)))
          .finally(() => pendingTerminalPaneIdsRef.current.delete(paneId))
        persistLayoutSoon()
        return 'closed'
      }
      pendingTerminalPaneIdsRef.current.add(paneId)
      TerminalManager.dispose(paneId)
      if (!ownsLayout(owner)) {
        void closePaneInStore(paneId, owner.sessionId)
          .catch((error) => useWorkspaceStore.getState().setError(String(error)))
          .finally(() => pendingTerminalPaneIdsRef.current.delete(paneId))
        return 'closed'
      }
      handle.removePane(paneId)
      void closePaneInStore(paneId, owner.sessionId)
        .catch((error) => useWorkspaceStore.getState().setError(String(error)))
        .finally(() => pendingTerminalPaneIdsRef.current.delete(paneId))
      await handle.settle()
      handle.persist()
      if (handle.paneIds().length === 0) {
        const windowPanel = findWorkspacePanel(api, workspaceContentPanelId({ kind: 'terminalWindow', instanceId: handle.windowId }))
        if (windowPanel) await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => { windowPanel.panel.api.close() })
        windowPanel?.workspaceWindow?.persist()
      }
      persistLayoutSoon()
      return 'closed'
    }

    const located = findWorkspacePanel(api, panelId)
    const panel = located?.panel
    const content = parseWorkspaceContentParams(panel?.params)
    if (!located || !panel || !content || content.kind === 'workspaceWindow') return 'cancelled'
    if (collapseStructuralWorkspacePanel(panel, content)) {
      persistLayoutSoon()
      return 'closed'
    }
    const nextPanelId = nextContentAfterClose(located.api, panelId)
    if (content.kind === 'editor') {
      const state = useWorkspaceStore.getState()
      const workspaceFolder = state.sessions.find((session) => session.id === owner.sessionId)?.workspaceFolder
      if (!workspaceFolder) return 'cancelled'
      if (await requestEditorDocumentClose(owner.sessionId, workspaceFolder, content.relPath) === 'cancelled') return 'cancelled'
      if (!ownsLayout(owner)) return 'cancelled'
    } else if (content.kind === 'browser') {
      try {
        const result = await closeBrowserContent(owner.sessionId, content.pageId)
        if (!result.closed) return 'cancelled'
        if (!ownsLayout(owner)) return 'closed'
      } catch (error) {
        useWorkspaceStore.getState().setError(String(error))
        return 'cancelled'
      }
    } else if (content.kind === 'terminalWindow') {
      const handle = getTerminalWindow(content.instanceId)
      for (const paneId of handle?.paneIds() ?? []) {
        await closePaneInStore(paneId, owner.sessionId).catch(() => undefined)
        TerminalManager.dispose(paneId)
      }
      if (!ownsLayout(owner)) return 'closed'
    }
    await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => { located.api.getPanel(panelId)?.api.close() })
    located.workspaceWindow?.persist()
    if (nextPanelId) requestAnimationFrame(() => activateContent(nextPanelId))
    persistLayoutSoon()
    return 'closed'
  }, [activateContent, closePaneInStore, currentLayoutOwner, ownsLayout, persistLayoutSoon])

  const splitTerminal = useCallback(async (paneId: string, direction: 'right' | 'below') => {
    const owner = currentLayoutOwner()
    if (!owner) return
    const handle = findTerminalWindowForPane(paneId)
    if (!handle) return
    await spawnTerminal(owner, { windowId: handle.windowId, referencePaneId: paneId, direction })
  }, [currentLayoutOwner, spawnTerminal])

  const clearTerminals = useCallback(async (windowId?: string) => {
    const windows = windowId ? [getTerminalWindow(windowId)].filter((handle) => handle !== undefined) : listTerminalWindows()
    for (const handle of windows) {
      for (const paneId of handle.paneIds()) await requestCloseContent(workspaceContentPanelId({ kind: 'terminal', instanceId: paneId }))
    }
  }, [requestCloseContent])

  const toggleMaximizeContent = useCallback((panelId: string) => {
    const api = apiRef.current
    const located = api ? findWorkspacePanel(api, panelId) : null
    if (!located) return
    if (located.panel.api.isMaximized()) located.panel.api.exitMaximized()
    else located.panel.api.maximize()
    void settleLayout({ syncPty: true })
  }, [settleLayout])

  /** Alt+Z zoom. A terminal window's panes live in its nested Dockview, so
   * maximizing the outer window panel is invisible whenever it already fills
   * the central grid; zoom the focused PANE against its siblings instead and
   * fall back to the plain outer toggle for everything else. */
  const toggleZoomContent = useCallback((panelId: string) => {
    const api = apiRef.current
    const located = api ? findWorkspacePanel(api, panelId) : null
    if (!located) return
    const panel = located.panel
    const content = parseWorkspaceContentParams(panel.params)
    const handle = content?.kind === 'terminalWindow' ? getTerminalWindow(content.instanceId) : undefined
    const innerApi = handle?.getInnerApi() ?? null
    const activePaneId = useWorkspaceStore.getState().activePaneId
    const activeInnerId = innerApi && activePaneId && handle?.paneIds().includes(activePaneId)
      ? workspaceContentPanelId({ kind: 'terminal', instanceId: activePaneId })
      : innerApi?.activePanel?.id ?? null
    const target = resolvePaneZoomTarget({
      outerMaximized: panel.api.isMaximized(),
      innerMaximized: Boolean(innerApi?.hasMaximizedGroup()),
      innerPaneCount: innerApi?.panels.length ?? 0,
      innerActivePanelId: activeInnerId,
    })
    if (target.scope === 'outerToggle') {
      toggleMaximizeContent(panelId)
      return
    }
    if (target.scope === 'innerRestore') innerApi?.exitMaximizedGroup()
    else innerApi?.getPanel(target.panelId)?.api.maximize()
    void handle?.settle()
  }, [toggleMaximizeContent])

  const toggleTerminalWindowTitles = useCallback((windowId: string) => {
    const api = apiRef.current
    const located = api ? findWorkspacePanel(api, workspaceContentPanelId({ kind: 'terminalWindow', instanceId: windowId })) : null
    const params = parseWorkspaceContentParams(located?.panel.params)
    if (!located || params?.kind !== 'terminalWindow') return
    located.panel.update({ params: { ...params, titlesHidden: !params.titlesHidden } })
    getTerminalWindow(windowId)?.persist()
    located.workspaceWindow?.persist()
    persistLayoutSoon()
  }, [persistLayoutSoon])

  const renameTerminal = useCallback(async (paneId: string, title: string) => {
    await renamePaneTitle(paneId, title, 'manual')
    const handle = findTerminalWindowForPane(paneId)
    const panel = handle?.getInnerApi()?.getPanel(workspaceContentPanelId({ kind: 'terminal', instanceId: paneId }))
    const params = parseWorkspaceContentParams(panel?.params)
    if (!panel || params?.kind !== 'terminal') return
    panel.update({ params: { ...params, title } })
    panel.api.setTitle(title)
    handle?.persist()
    persistLayoutSoon()
  }, [persistLayoutSoon, renamePaneTitle])

  const resetLayout = useCallback(async () => {
    const previousOwner = currentLayoutOwner()
    if (!previousOwner) return
    const api = previousOwner.api
    const owner: WorkspaceLayoutOwner = { api, sessionId: previousOwner.sessionId, sessionEpoch: previousOwner.sessionEpoch, epoch: ++layoutEpochRef.current }
    layoutOwnerRef.current = null
    const livePanes = Object.values(useWorkspaceStore.getState().panes).filter((pane) => pane.alive)
    const preservedContent = workspaceContentPanels(api).flatMap((panel) => {
      const params = parseWorkspaceContentParams(panel.params)
      return params && params.kind !== 'terminal' && params.kind !== 'terminalWindow' && params.kind !== 'workspaceWindow' && !isStructuralWorkspaceContentKind(params.kind) ? [params] : []
    })
    const rootWidth = dockRef.current?.getBoundingClientRect().width ?? 1280
    await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
      api.clear()
      api.fromJSON(createDefaultWorkspaceDockviewLayout(livePanes, rootWidth) as Parameters<DockviewApi['fromJSON']>[0])
      ensureWorkspaceEdgeShell(api)
      resetWorkspaceEdgeDefaults(api, rootWidth)
    })
    if (!await waitForWorkspaceWindowPanels(api, owner.sessionId, owner.sessionEpoch)) throw new Error('Workspace window did not mount after layout reset.')
    const workspaceWindow = listWorkspaceWindows().find((handle) => Boolean(api.getPanel(handle.outerPanelId)))
    let mainGroupId = workspaceWindow?.getInnerApi()?.activeGroup?.id
      ?? workspaceWindow?.getInnerApi()?.groups.find((group) => group.api.location.type === 'grid' && group.api.isVisible)?.id
    for (const params of preservedContent) {
      const panel = addContentPanel(params, { targetGroupId: mainGroupId, inactive: true }, api)
      if (panel?.group.api.location.type === 'grid' && !mainGroupId) mainGroupId = panel.group.id
    }
    lastMainGroupIdRef.current = mainGroupId ?? null
    setCurrentMainGroupId(mainGroupId ?? null)
    if (apiRef.current !== api
      || getWorkspaceSessionEpoch() !== owner.sessionEpoch
      || getWorkspaceSessionReadyEpoch() !== owner.sessionEpoch
      || getWorkspaceSessionTargetId() !== owner.sessionId
      || useWorkspaceStore.getState().activeSessionId !== owner.sessionId) return
    layoutOwnerRef.current = owner
    setLoadedLayoutOwner({ sessionId: owner.sessionId, sessionEpoch: owner.sessionEpoch })
    await settleLayout({ syncPty: true }, owner)
    if (ownsLayout(owner)) await persistLayoutNow()
  }, [addContentPanel, currentLayoutOwner, ownsLayout, persistLayoutNow, settleLayout, waitForWorkspaceWindowPanels])

  const actions = useMemo<WorkspaceContentActions>(() => ({
    openContent,
    activateContent,
    requestCloseContent,
    splitTerminal,
    arrangeTerminals,
    clearTerminals,
    toggleMaximizeContent,
    toggleZoomContent,
    toggleTerminalWindowTitles,
    renameTerminal,
    resetLayout,
    getContentParams,
  }), [activateContent, arrangeTerminals, clearTerminals, getContentParams, openContent, renameTerminal, requestCloseContent, resetLayout, splitTerminal, toggleMaximizeContent, toggleTerminalWindowTitles, toggleZoomContent])

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
      // Captured by `attachSession` from the daemon's raw string: `raw` here is
      // the already-normalized envelope, so a rejected layout reaches this point
      // as `dockview: null` with its panels gone. The arrangement is
      // unrecoverable, but the content is not.
      const salvaged = envelope.dockview === null ? useWorkspaceStore.getState().layoutSalvage : []
      const requiresFirstTerminalLayout = livePanes.length > 0 && centralGridIsEmpty(api)
      // A layout this view authored is already on screen — the store only echoed
      // our own save back (possibly an older in-flight one). Adopt the string and
      // skip the rebuild; clearing + restoring here would drop live pane titles
      // back to the persisted copy and start the save/restore flicker loop.
      const selfAuthored = loadedSessionRef.current === sessionId
        && loadedApiRef.current === api
        && loadedSessionEpochRef.current === sessionEpoch
        && typeof raw === 'string'
        && authoredLayoutsRef.current.has(raw)
      if (selfAuthored) loadedLayoutJsonRef.current = raw
      if (loadedSessionRef.current === sessionId
        && (loadedLayoutJsonRef.current === raw || selfAuthored)
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
      // Rebuilding the dock walks every pane through geometry it never lands
      // on. Dockview mounts a panel before the grid sizes it, and the mount's
      // own fit measured the container at 1014x62 — a 3-ROW fit, forwarded to
      // the PTY as a real SIGWINCH — before the pane landed back on 62 rows.
      // A normal-buffer agent TUI repaints for the 3-row grid, so the pane came
      // back with its prompt stranded at the top and dozens of blank rows under
      // it. The intermediate COLUMN steps are just as destructive: a narrow fit
      // rewraps the whole buffer and xterm never pulls those lines back out of
      // scrollback. Hold every fit until the final geometry, exactly as Arrange
      // and grid creation already do.
      return await TerminalManager.runLayoutTransaction(async () => {
        // A valid v3 layout can be restored even when the daemon's live terminal
        // set changed while the app was closed. Resource reconciliation below
        // removes stale UI owners and adds only resources proven live.
        const restore = envelope.dockview
        const rootWidth = dockRef.current?.getBoundingClientRect().width ?? 1280
        const restoreHasEdgeGroups = Boolean(restore?.edgeGroups)
        let applyEdgeDefaults = !restore || !restoreHasEdgeGroups
        await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
          const dockview = restore
            ? completeWorkspaceStructuralLayout(restore, rootWidth)
            : createDefaultWorkspaceDockviewLayout(livePanes, rootWidth)
          try {
            api.fromJSON(dockview as Parameters<DockviewApi['fromJSON']>[0], { reuseExistingPanels: true })
          } catch {
            api.clear()
            api.fromJSON(createDefaultWorkspaceDockviewLayout(livePanes, rootWidth) as Parameters<DockviewApi['fromJSON']>[0])
            applyEdgeDefaults = true
          }
          ensureWorkspaceEdgeShell(api)
          // Legacy layouts (panes as outer panels) upgrade in place: the seeded
          // window below adopts every LIVE pane, so any top-level terminal panel
          // left here is unreachable chrome. Drop it before the dock is handed to
          // the user; the healed layout is persisted by the tail of this run.
          closeStrayTerminalPanels(api)
          if (applyEdgeDefaults) resetWorkspaceEdgeDefaults(api, rootWidth)
          else collapseWorkspaceEdgesForCenterWidth(api, rootWidth)
        })
        if (!transactionIsCurrent()) return
        if (!await waitForWorkspaceWindowPanels(api, sessionId, sessionEpoch)) throw new Error('Workspace window did not mount after layout restore.')
        loadedSessionRef.current = sessionId
        loadedLayoutJsonRef.current = raw ?? null
        loadedApiRef.current = api
        loadedSessionEpochRef.current = owner.sessionEpoch
        layoutOwnerRef.current = owner
        setLoadedLayoutOwner({ sessionId: owner.sessionId, sessionEpoch: owner.sessionEpoch })
        const workspaceWindow = listWorkspaceWindows().find((handle) => Boolean(api.getPanel(handle.outerPanelId)))
        const mainGroup = workspaceWindow?.getInnerApi()?.activeGroup
          ?? workspaceWindow?.getInnerApi()?.groups.find((group) => group.api.location.type === 'grid' && group.api.isVisible)
        lastMainGroupIdRef.current = mainGroup?.id ?? null
        setCurrentMainGroupId(mainGroup?.id ?? null)
        // Runs here, not inside the fromJSON block: `addContentPanel` routes
        // central content through the workspace window's inner api, which only
        // exists once `waitForWorkspaceWindowPanels` above has resolved. Ahead of
        // the reconcilers so a salvaged browser still gets its live page state.
        if (salvaged.length > 0) {
          await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
            for (const params of salvaged) addContentPanel(params, { inactive: true }, api)
          })
        }
        await reconcileTerminalPanels(api, suppressPanelRemovalRef, addContentPanel, () => undefined)
        if (!ownsLayout(owner)) return
        await reconcileRestoredBrowserPanels(api, sessionId, suppressPanelRemovalRef, addContentPanel, () => ownsLayout(owner))
        if (!ownsLayout(owner)) return
        if (livePanes.length === 0 && isWorkspaceInitialPanePending(sessionId, sessionEpoch)) {
          await spawnTerminal(owner)
          return
        }
        TerminalManager.pruneWorkspaceCache(sessionId, new Set(livePanes.map((pane) => pane.id)))
        await settleLayout({ syncPty: true }, owner)
        if (!ownsLayout(owner)) return
        const paneIds = livePanes.map((pane) => pane.id)
        TerminalManager.reattachToDaemon(sessionId, paneIds, { force: false })
        await TerminalManager.waitForReplay(sessionId, paneIds)
        if (!ownsLayout(owner)) return
        await settleLayout({ syncPty: true, paneIds }, owner)
        if (!ownsLayout(owner)) return
        TerminalManager.recoverAllVisiblePanes(paneIds)
        setApiVersion((value) => value + 1)
        if (!restore || serializeCurrentLayout() !== raw) persistLayoutSoon()
      })
    }
    const result = layoutLoadQueueRef.current.then(run, run)
    layoutLoadQueueRef.current = result.catch((error) => { useWorkspaceStore.getState().setError(String(error)) })
    return layoutLoadQueueRef.current
  }, [addContentPanel, ownsLayout, persistLayoutSoon, saveLayout, serializeCurrentLayout, settleLayout, spawnTerminal, waitForWorkspaceWindowPanels])

  const syncOpenContentRegistry = useCallback(() => {
    const api = apiRef.current
    const state = useWorkspaceStore.getState()
    const sessionId = state.activeSessionId
    const sessionEpoch = getWorkspaceSessionEpoch()
    if (!api
      || !sessionId
      || loadedSessionRef.current !== sessionId
      || loadedApiRef.current !== api
      || loadedSessionEpochRef.current !== sessionEpoch
      || getWorkspaceSessionReadyEpoch() !== sessionEpoch
      || getWorkspaceSessionTargetId() !== sessionId) {
      clearOpenContentSnapshot()
      return
    }
    publishOpenContentFromDockview(api)
  }, [])


  const syncChromeState = useCallback(() => {
    const api = apiRef.current
    syncOpenContentRegistry()
    const active = api ? activeWorkspacePanel(api) : null
    const content = parseWorkspaceContentParams(active?.params)
    const next: WorkspaceContentChromeState = {
      contentCount: api ? workspaceContentPanels(api).length : 0,
      activeContentKind: content?.kind ?? null,
      activePanelId: active?.id ?? null,
      activeGroupId: active?.group.id ?? null,
    }
    if (workspaceChromeStatesEqual(lastChromeStateRef.current, next)) return
    lastChromeStateRef.current = next
    onChromeStateChange?.(next)
  }, [onChromeStateChange, syncOpenContentRegistry])

  const runLiveWorkspaceResize = useCallback((rootWidth: number, shouldLayoutDockview: boolean) => {
    const api = apiRef.current
    if (!api || !isDockElementMeasurable(dockRef.current)) return
    collapseWorkspaceEdgesForCenterWidth(api, rootWidth)
    // A divider drag is Dockview's OWN gesture: its pointermove already resized
    // the splitview and repositioned every view this frame. Re-running the
    // forced layout here re-applies the proportions saved at the previous
    // sash end, which snaps every pane back to its pre-drag size before the
    // next pointermove drags it out again — the divider visibly lags the
    // pointer. A window drag-resize genuinely changed the container, so it
    // still needs the layout.
    if (shouldLayoutDockview && !isDividerResizeActive()) layoutDockview(api)
    forceOverlayReposition(api)
    TerminalManager.scheduleLayoutPass()
  }, [layoutDockview])

  const finishLiveWorkspaceResize = useCallback(() => {
    const api = apiRef.current
    const root = dockRef.current
    const sessionId = useWorkspaceStore.getState().activeSessionId
    const sessionEpoch = getWorkspaceSessionEpoch()
    if (!api || !sessionId || !isDockElementMeasurable(root)) return
    // The quiet timer fires ~140 ms into a still-running drag. Settling there
    // forces a layout mid-gesture, which re-applies the pre-drag proportions
    // and snaps the panes back. The drag end publishes an interaction-end
    // event that runs this settle once, on the geometry the drag landed on.
    if (isInteractiveResizeActive()) {
      resizeSettleDeferredRef.current = true
      return
    }
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

  // A drag end is the only moment the geometry is final. Run the settle the
  // quiet timer deferred, so overlays, terminal fits, and PTY sizes land once
  // on the size the drag actually finished at.
  useEffect(() => onInteractiveResizeEnd(() => {
    if (!resizeSettleDeferredRef.current) return
    resizeSettleDeferredRef.current = false
    finishLiveWorkspaceResize()
  }), [finishLiveWorkspaceResize])

  const handleReady = useCallback((event: DockviewReadyEvent) => {
    for (const disposable of apiDisposablesRef.current) disposable.dispose()
    layoutEpochRef.current += 1
    layoutOwnerRef.current = null
    setLoadedLayoutOwner(null)
    apiRef.current = event.api
    setDockApi(event.api)
    lastChromeStateRef.current = null
    clearOpenContentSnapshot()
    const rootWidth = dockRef.current?.getBoundingClientRect().width ?? 1280
    registerWorkspaceEdgeGroups(event.api, rootWidth)
    setApiVersion((value) => value + 1)
    onApiReady?.(event.api)
    apiDisposablesRef.current = [
      event.api.onDidLayoutChange(() => {
        if (suppressPanelRemovalRef.current || resizeSettlingRef.current) return
        syncChromeState()
        // A nested window persisting its serialized layout into this panel's
        // params fires the same event as a real grid change. Reacting would arm
        // the 140 ms quiet timer and re-settle every window and terminal for a
        // write that moved nothing.
        if (isLayoutParamsPersistActive()) return
        requestLiveWorkspaceResize(false)
      }),
      event.api.onDidMovePanel(() => {
        if (suppressPanelRemovalRef.current) return
        syncChromeState()
        void settleLayout({ syncPty: true })
        persistLayoutSoon()
      }),
      event.api.onDidAddPanel(() => {
        if (suppressPanelRemovalRef.current) return
        syncChromeState()
      }),
      event.api.onDidActiveGroupChange((group) => {
        if (group?.api.location.type !== 'grid') return
        const active = parseWorkspaceContentParams(group.activePanel?.params)
        const innerGroupId = active?.kind === 'workspaceWindow' ? getWorkspaceWindow(active.instanceId)?.getInnerApi()?.activeGroup?.id : null
        lastMainGroupIdRef.current = innerGroupId ?? group.id
        setCurrentMainGroupId(innerGroupId ?? group.id)
      }),
      event.api.onDidActivePanelChange((panel) => {
        const content = parseWorkspaceContentParams(panel?.params)
        // Defer outer-window refocus so an explicit nested pane selection can
        // finish before the previously focused terminal tries to reactivate.
        if (content?.kind === 'workspaceWindow') focusActiveContentAfterLayout(event.api, () => !workspaceInteractionSuspendedRef.current)
        syncChromeState()
      }),
      event.api.onDidRemovePanel((removedPanel) => {
        // Dockview fires removal during fromJSON, native DnD and group moves.
        // It is never resource-close authority. Reconciliation restores a live
        // resource if a UI-only removal escaped an explicit close request.
        if (suppressPanelRemovalRef.current) return
        syncChromeState()
        const removed = parseWorkspaceContentParams(removedPanel.params)
        requestAnimationFrame(() => {
          const owner = layoutOwnerRef.current
          if (!owner || owner.api !== event.api || !ownsLayout(owner)) return
          // Terminal panes are never outer-dock resources. A live pane whose
          // panel disappears is re-adopted by its window's pane sync, so
          // re-adding it here would recreate exactly the unreachable top-level
          // pane panel the restore path removes.
          if (removed && (removed.kind === 'browser' || removed.kind === 'editor') && !event.api.getPanel(removedPanel.id)) {
            addContentPanel(removed, { inactive: true }, event.api)
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
        // Dockview resizes the center grid synchronously but leaves always-
        // rendered overlays at their previous bounds. Coalesce rapid toggles,
        // reposition overlays after paint, then fit/sync terminals exactly once.
        const edge = event.api.getEdgeGroup(position)
        if (!edge) return []
        return [edge.onDidCollapsedChange(() => {
          if (suppressPanelRemovalRef.current) return
          syncChromeState()
          void settleEdgeLayout(event.api)
          persistLayoutSoon()
        })]
      }),
    ]
    requestAnimationFrame(() => { void loadActiveSessionLayout() })
  }, [addContentPanel, loadActiveSessionLayout, onApiReady, ownsLayout, persistLayoutSoon, requestLiveWorkspaceResize, settleEdgeLayout, settleLayout, syncChromeState])

  useEffect(() => {
    onActionsReady?.(actions)
    return () => onActionsReady?.(null)
  }, [actions, onActionsReady])

  useEffect(() => useWorkspaceStore.subscribe((state, previousState) => {
    if (state.activeSessionId !== previousState.activeSessionId
      || state.workspaceEpoch !== previousState.workspaceEpoch
      || state.workspaceReadyEpoch !== previousState.workspaceReadyEpoch) {
      layoutEpochRef.current += 1
      clearOpenContentSnapshot()
      layoutOwnerRef.current = null
      setLoadedLayoutOwner(null)
      // Authored layouts belong to the workspace/epoch that produced them.
      authoredLayoutsRef.current.clear()
      lastChromeStateRef.current = null
      lastMainGroupIdRef.current = null
      setCurrentMainGroupId(null)
      setWorkspaceOverlayIds(new Set())
      setFilePicker(null)
      return
    }
    if (state.activePaneId !== previousState.activePaneId) syncOpenContentRegistry()
  }), [syncOpenContentRegistry])

  useEffect(() => {
    const sync = () => {
      syncChromeState()
      persistLayoutSoon()
    }
    window.addEventListener('vibelink:terminal-window-persist', sync)
    window.addEventListener('vibelink:workspace-window-change', sync)
    return () => {
      window.removeEventListener('vibelink:terminal-window-persist', sync)
      window.removeEventListener('vibelink:workspace-window-change', sync)
      clearOpenContentSnapshot()
    }
  }, [persistLayoutSoon, syncChromeState])

  useEffect(() => {
    if (!apiRef.current) return
    void loadActiveSessionLayout()
  }, [activeSessionId, apiVersion, layoutJson, loadActiveSessionLayout, panes, workspaceEpoch, workspaceReadyEpoch])

  useEffect(() => {
    if (!apiRef.current) {
      clearOpenContentSnapshot()
      return
    }
    const frame = requestAnimationFrame(syncChromeState)
    return () => cancelAnimationFrame(frame)
  }, [activeSessionId, apiVersion, panes, syncChromeState, workspaceEpoch, workspaceReadyEpoch])

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
    const windows = listTerminalWindows()
    if (windows.length === 0) {
      // No registered window yet. If an outer terminalWindow panel exists it is
      // still mounting — wait. If there is truly no window but live panes exist,
      // seed one so the panes have a home.
      const hasPanel = workspaceContentPanels(api).some((panel) => parseWorkspaceContentParams(panel.params)?.kind === 'terminalWindow')
      if (!hasPanel && livePanes.length > 0 && !suppressPanelRemovalRef.current) {
        const terminalParams = livePanes.map(createTerminalContentParams)
        const grid = occupiedGridForPaneCount(terminalParams.length)
        const windowParams = createTerminalWindowParams(crypto.randomUUID(), terminalParams, grid.cols > 0 ? grid : { cols: 1, rows: 1 })
        void withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => { addContentPanel(windowParams, { inactive: false }) }).then(() => persistLayoutSoon())
      }
      return
    }
    // Refresh pane titles across windows and drop panes whose PTY died. Only
    // touch what actually changed, and only persist/settle when something did —
    // otherwise persist writes new params that re-run this effect in a loop.
    const owned = allWindowedPaneIds()
    let changed = false
    const layoutChangedWindows = new Set<TerminalWindowHandle>()
    for (const handle of windows) {
      const innerApi = handle.getInnerApi()
      if (!innerApi) continue
      for (const paneId of handle.paneIds()) {
        const pane = livePanes.find((candidate) => candidate.id === paneId)
        const panel = innerApi.getPanel(workspaceContentPanelId({ kind: 'terminal', instanceId: paneId }))
        if (!panel) continue
        if (pane) {
          const params = createTerminalContentParams(pane)
          if (panel.api.title !== params.title) {
            panel.update({ params })
            panel.api.setTitle(params.title)
            changed = true
          }
        } else if (!livePaneIds.has(paneId) && !pendingTerminalPaneIdsRef.current.has(paneId)) {
          TerminalManager.dispose(paneId)
          handle.removePane(paneId)
          layoutChangedWindows.add(handle)
          changed = true
        }
      }
    }
    const firstWindow = windows[0]
    for (const pane of livePanes) {
      if (owned.has(pane.id) || pendingTerminalPaneIdsRef.current.has(pane.id)) continue
      // An automation run gets its OWN window. The daemon only spawns a pane
      // (`role: 'automation-agent'`); without this it is adopted by whichever
      // window happens to be first, so a scheduled run lands in the middle of
      // the panes the user is working in.
      if (pane.config.role === AUTOMATION_PANE_ROLE) {
        pendingTerminalPaneIdsRef.current.add(pane.id)
        const windowParams = createTerminalWindowParams(
          crypto.randomUUID(),
          [createTerminalContentParams(pane)],
          { cols: 1, rows: 1 },
        )
        void withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => { addContentPanel(windowParams, { inactive: false }) })
          .then(() => {
            persistLayoutSoon()
            // Release the guard only after the window has had a frame to mount
            // and register, otherwise this effect re-runs first and spawns a
            // second window for the same pane.
            requestAnimationFrame(() => pendingTerminalPaneIdsRef.current.delete(pane.id))
          })
        changed = true
        continue
      }
      if (firstWindow.getInnerApi() && firstWindow.addPane(createTerminalContentParams(pane), { inactive: true })) {
        layoutChangedWindows.add(firstWindow)
        changed = true
      }
    }
    if (!changed) return
    for (const handle of windows) handle.persist()
    for (const handle of layoutChangedWindows) void handle.settle()
    persistLayoutSoon()
  }, [activeSessionId, addContentPanel, apiVersion, panes, persistLayoutSoon])

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
      if (effectiveWorkspaceInteractionSuspended || isAppDialogOpen() || isPaletteOpen()) return
      const api = apiRef.current
      const active = api ? activeWorkspacePanel(api) : null
      // An empty centre area has no active panel, and gating the WHOLE handler
      // on one made Ctrl+N dead exactly when it was the only way back in.
      // Shortcuts that act on the focused content still check `active` below.
      if (!api) return
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
          if (!active) return
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
              void promptDialog({ title: 'Save As', label: 'Workspace-relative path', defaultValue: content.relPath, confirmLabel: 'Save' }).then(async (target) => {
                // The prompt is asynchronous, so the workspace can change while
                // it is open; re-check ownership before writing anywhere.
                if (!target || getWorkspaceSessionReadyEpoch() !== sessionEpoch || getWorkspaceSessionTargetId() !== sessionId) return
                const result: NativeSaveTextDocumentResult = await store.saveAs(content.relPath, target)
                if (result.status === 'saved') await actions.openContent({ kind: 'editor', relPath: target, targetGroupId: active.group.id, workspaceId: sessionId, workspaceEpoch: sessionEpoch })
              }).catch((error: unknown) => useWorkspaceStore.getState().setError(String(error)))
            } else {
              void store.save(content.relPath).catch((error: unknown) => useWorkspaceStore.getState().setError(String(error)))
            }
            return
          }
        }
      }
      // Every configurable keybinding acts on the focused content, so those
      // stay gated on a live panel; the empty state offers buttons instead.
      if (active) handleCapturedKeybindingEvent(keybindings, event, (action) => runKeybindingAction(action, api, active, actions, onDeleteWorkspaceRequested, persistLayoutNow))
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
  // The `+` palette belongs immediately after the tab strip, not pinned to the
  // far right of the header: Dockview appends `leftHeaderActions` right after
  // the tabs and only then the flexible void spacer + right actions.
  const leftHeaderActionsComponent = useMemo(() => function HeaderActions(props: IDockviewHeaderActionsProps) {
    return <WorkspaceGroupActionsWithContext {...props} fallbackActions={actions} />
  }, [actions])

  return (
    <WorkspaceIntegrationContext.Provider value={integration}>
      <WorkspaceContentActionsContext.Provider value={actions}>
        <ErrorBoundary label="Workspace" resetKey={`${activeSessionId ?? 'none'}:${workspaceReadyEpoch}`}>
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
          // Open-content rows activate their target on click. Activating the
          // owning sidebar panel first makes the terminal group flash inactive.
          if (target?.closest('[data-open-content-panel-id]')) return
          const terminalBodyPaneId = paneIdFromEventTarget(event.target)
          if (terminalBodyPaneId) {
            // Renderer overlays sit outside Dockview's ordinary group content
            // activation path. Explicitly activate the nested pane before
            // repairing/focusing it so body clicks behave like title clicks.
            activateContent(workspaceContentPanelId({ kind: 'terminal', instanceId: terminalBodyPaneId }))
            TerminalManager.repairAfterPointerActivation(terminalBodyPaneId)
            return
          }
          const shell = target?.closest<HTMLElement>('[data-content-panel-id]')
          const panelId = shell?.dataset.contentPanelId
          if (!panelId) return
          // Inner terminal panes carry their own data-pane-id and are activated
          // by the inner Dockview; only repair the renderer here.
          const paneId = shell?.dataset.paneId
          if (paneId) {
            TerminalManager.repairAfterPointerActivation(paneId)
            return
          }
          const params = getContentParams(panelId)
          if (params?.kind === 'terminal') TerminalManager.repairAfterPointerActivation(params.paneId)
          activateContent(panelId)
        }}
        >
          <WorkspaceEmptyState api={dockApi} actions={actions} variant="no-workspace" />
          <DockviewReact
          components={components}
          tabComponents={workspaceTabComponents}
          defaultTabComponent={WorkspaceContentTab}
          leftHeaderActionsComponent={leftHeaderActionsComponent}
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
        </ErrorBoundary>
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
  const livePanes = Object.values(panes).filter((candidate) => candidate.alive)
  const contentPanels = workspaceContentPanels(api)
  const strayTerminals = contentPanels.filter((panel) => parseWorkspaceContentParams(panel.params)?.kind === 'terminal')
  if (strayTerminals.length > 0) {
    await withSuppressedPanelRemoval(suppression, async () => {
      for (const panel of strayTerminals) panel.api.close()
    })
  }
  if (livePanes.length === 0) {
    persist()
    return
  }
  const hasTerminalWindow = contentPanels.some((panel) => parseWorkspaceContentParams(panel.params)?.kind === 'terminalWindow')
  if (hasTerminalWindow) {
    persist()
    return
  }
  // Live panes but no window (e.g. a v3 layout upgraded in place): seed a single
  // terminal window pre-populated with every live pane.
  const terminalParams = livePanes.map(createTerminalContentParams)
  const grid = occupiedGridForPaneCount(terminalParams.length)
  const windowParams = createTerminalWindowParams(crypto.randomUUID(), terminalParams, grid.cols > 0 ? grid : { cols: 1, rows: 1 })
  await withSuppressedPanelRemoval(suppression, async () => { addPanel(windowParams, { inactive: false }) })
  persist()
}

async function reconcileRestoredBrowserPanels(
  api: DockviewApi,
  sessionId: string,
  suppression: { current: boolean },
  addPanel: (params: WorkspaceContentParams, options?: AddContentOptions) => IDockviewPanel | null,
  isCurrent: () => boolean,
): Promise<void> {
  const restored = workspaceContentPanels(api).flatMap((panel) => {
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
  const activePaneId = activeTerminalPaneId(content)
  // Directional focus / move / tab-cycle operate on the ACTIVE terminal window's
  // inner panes when a terminal window is focused (panes live in a nested
  // Dockview, not the outer api). Otherwise they operate on outer panels.
  const terminalWindowNavContext = (): { panelIds: string[]; activeId: string; api: DockviewApi; activate: (id: string) => void } => {
    if (content?.kind === 'terminalWindow') {
      const handle = getTerminalWindow(content.instanceId)
      const innerApi = handle?.getInnerApi()
      if (innerApi) {
        const activePaneId = useWorkspaceStore.getState().activePaneId
        const activeInnerId = activePaneId && handle?.paneIds().includes(activePaneId)
          ? workspaceContentPanelId({ kind: 'terminal', instanceId: activePaneId })
          : innerApi.activePanel?.id ?? ''
        return {
          panelIds: innerApi.panels.map((panel) => panel.id),
          activeId: activeInnerId,
          api: innerApi,
          activate: (id) => {
            const panel = innerApi.getPanel(id)
            if (!panel) return
            panel.api.setActive()
            const paneContent = parseWorkspaceContentParams(panel.params)
            if (paneContent?.kind === 'terminal') TerminalManager.focus(paneContent.paneId)
          },
        }
      }
    }
    const workspaceWindow = findWorkspaceWindowForPanel(active.id)
    const contentApi = workspaceWindow?.getInnerApi() ?? api
    return { panelIds: contentApi.panels.map((panel) => panel.id), activeId: active.id, api: contentApi, activate: (id) => actions.activateContent(id) }
  }
  switch (action) {
    case 'splitRight':
      if (activePaneId) await actions.splitTerminal(activePaneId, 'right')
      return
    case 'splitDown':
      if (activePaneId) await actions.splitTerminal(activePaneId, 'below')
      return
    case 'toggleWorkspaces':
      toggleStructuralWorkspacePanel(api, 'workspaces')
      return
    case 'toggleLeftSidebar':
      toggleWorkspaceLeftSidebar(api)
      return
    case 'terminalSearch':
      if (activePaneId) openTerminalSearch(activePaneId)
      return
    case 'openCommandPalette':
      openPalette()
      return
    case 'closePane':
      await actions.requestCloseContent(activePaneId ? workspaceContentPanelId({ kind: 'terminal', instanceId: activePaneId }) : active.id)
      return
    case 'closeWorkspace': {
      const sessionId = useWorkspaceStore.getState().activeSessionId
      if (!sessionId) return
      await persistLayout()
      await onDeleteWorkspaceRequested?.(sessionId)
      return
    }
    case 'toggleMaximize':
      actions.toggleZoomContent(active.id)
      return
    case 'togglePaneReviewed':
      if (activePaneId) useWorkspaceStore.getState().togglePaneReviewed(activePaneId)
      return
    case 'arrangePanes':
      await actions.arrangeTerminals()
      return
    case 'nextTab':
    case 'previousTab': {
      // Inside a terminal window, cycle its panes; otherwise cycle outer panels.
      const nav = terminalWindowNavContext()
      const ordered = paneIdsInReadingOrder(nav.panelIds, getContentRect)
      const index = ordered.indexOf(nav.activeId)
      const targetIndex = action === 'nextTab' ? index + 1 : index - 1
      const target = index >= 0 && targetIndex >= 0 && targetIndex < ordered.length ? ordered[targetIndex] : undefined
      if (target) nav.activate(target)
      return
    }
    case 'focusLeft':
    case 'focusRight':
    case 'focusUp':
    case 'focusDown': {
      const direction = directionForAction(action)
      const nav = terminalWindowNavContext()
      const target = direction ? nearestPaneIdInDirection(nav.activeId, nav.panelIds, direction, getContentRect) : null
      if (target) nav.activate(target)
      return
    }
    case 'moveLeft':
    case 'moveRight':
    case 'moveUp':
    case 'moveDown': {
      const direction = directionForAction(action)
      const nav = terminalWindowNavContext()
      const targetId = direction ? nearestPaneIdInDirection(nav.activeId, nav.panelIds, direction, getContentRect) : null
      if (!targetId || !swapPanelsInDockviewApi(nav.api, nav.activeId, targetId)) return
      nav.activate(nav.activeId)
      if (content?.kind === 'terminalWindow') {
        const handle = getTerminalWindow(content.instanceId)
        await handle?.settle()
        handle?.persist()
      } else {
        const workspaceWindow = findWorkspaceWindowForPanel(active.id)
        await workspaceWindow?.settle()
        workspaceWindow?.persist()
        if (!workspaceWindow) await persistLayout()
      }
      return
    }
    case 'copyTerminalContents':
      if (activePaneId) TerminalManager.copyContentsToClipboard(activePaneId)
      return
    case 'copyTerminalSelection':
      if (activePaneId) TerminalManager.copySelectionToClipboard(activePaneId)
      return
    case 'captureImage':
    case 'captureQuickImage':
    case 'captureVideo':
      return
  }
}

/** The active terminal pane id: the store's active pane when the outer active
 * panel is a terminal window, else the pane behind a direct terminal panel. */
function activeTerminalPaneId(content: WorkspaceContentParams | null): string | null {
  if (content?.kind === 'terminal') return content.paneId
  if (content?.kind !== 'terminalWindow') return null
  const activePaneId = useWorkspaceStore.getState().activePaneId
  if (!activePaneId) return null
  const handle = getTerminalWindow(content.instanceId)
  return handle?.paneIds().includes(activePaneId) ? activePaneId : (handle?.paneIds()[0] ?? null)
}

function pendingPaneMeta(paneId: string, title: string | null, icon?: string | null): PaneMeta {
  return {
    id: paneId,
    alive: true,
    config: { paneId, shell: null, args: [], cwd: null, env: [], title, icon: icon ?? null, profileId: null, cols: 120, rows: 32 },
  }
}

async function measuredSpawnSize(paneId: string, attempts = 30): Promise<{ cols: number; rows: number } | undefined> {
  return waitForStableTerminalGrid(
    () => TerminalManager.measureForSpawn(paneId),
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    attempts,
  )
}
