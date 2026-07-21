import { invoke } from '@tauri-apps/api/core'
import { Clipboard, ExternalLink, FolderPlus, LoaderCircle, RefreshCw, SquareKanban } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  providerAccounts,
  providerAssignedItems,
  providerCredentialStatus,
  providerWorkspaceInput,
  type AssignedProviderItem,
  type ProviderKind,
  type WorkspaceCreationInput,
} from '../../ipc/providerIntegrations'
import { tasksForSession } from '../../state/kanban'
import { useWorkspaceStore } from '../../state/store'
import './AssignedTab.css'

type AssignedFilter = 'local' | 'issues' | 'reviews'

type AssignedViewItem = {
  key: string
  provider: ProviderKind | 'local'
  providerId: string
  source: string
  sourceLabel: string
  kind: 'kanban' | 'todo' | 'issue' | 'review'
  identifier: string
  title: string
  state: string
  repository: string | null
  project: string | null
  url: string | null
  updatedAt: string | number | null
  workspaceInputCapable: boolean
  workspaceItem: AssignedProviderItem['workspaceItem']
}

export type AssignedTabProps = {
  sessionId: string
  reviewContent: ReactNode
  onWorkspaceInput?: (input: WorkspaceCreationInput) => void | Promise<void>
}

const providerKinds: ProviderKind[] = ['github', 'gitlab', 'linear']
const providerLabels: Record<ProviderKind, string> = { github: 'GitHub', gitlab: 'GitLab', linear: 'Linear' }
const sourceLabels: Record<string, string> = {
  githubAssignedIssue: 'GitHub · Assigned issue',
  githubAuthoredReview: 'GitHub · Authored PR',
  githubReviewRequested: 'GitHub · Review requested',
  gitlabAssignedIssue: 'GitLab · Assigned issue',
  gitlabAssignedReview: 'GitLab · Assigned MR',
  linearAssignedIssue: 'Linear · Assigned issue',
}

export function AssignedTab({ sessionId, reviewContent, onWorkspaceInput }: AssignedTabProps) {
  const [filter, setFilter] = useState<AssignedFilter>('local')
  const [hostedItems, setHostedItems] = useState<AssignedProviderItem[]>([])
  const [providerState, setProviderState] = useState<Record<ProviderKind, string>>({ github: 'Not connected', gitlab: 'Not connected', linear: 'Not connected' })
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const local = useWorkspaceStore(useShallow((state) => ({
    tasks: tasksForSession(state.kanban, sessionId).filter((task) => task.status !== 'done'),
    todos: state.workspaceTodos?.[sessionId] ?? [],
  })))
  const createTask = useWorkspaceStore((state) => state.createTask)
  const injectTodos = useWorkspaceStore((state) => state.injectWorkspaceTodosToKanban)

  const refreshHosted = useCallback(async () => {
    setRefreshing(true)
    setMessage(null)
    const nextItems: AssignedProviderItem[] = []
    const nextState: Record<ProviderKind, string> = { github: 'Not connected', gitlab: 'Not connected', linear: 'Not connected' }
    await Promise.all(providerKinds.map(async (provider) => {
      try {
        const credential = await providerCredentialStatus(provider, providerAccounts[provider])
        if (!credential) return
        nextState[provider] = `Connected · ${credential.scopes.length} scopes`
        const result = await providerAssignedItems(credential)
        nextItems.push(...result.items)
        if (result.failures.length > 0) {
          nextState[provider] = result.failures.map(({ failure }) => failure.message).join(' · ')
        }
      } catch (error) {
        nextState[provider] = errorMessage(error)
      }
    }))
    nextItems.sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))
    setHostedItems(nextItems)
    setProviderState(nextState)
    setLastRefreshAt(Date.now())
    setRefreshing(false)
  }, [])

  useEffect(() => {
    const refreshWhenFocused = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) void refreshHosted()
    }
    const timer = window.setTimeout(refreshWhenFocused, 0)
    window.addEventListener('focus', refreshWhenFocused)
    document.addEventListener('visibilitychange', refreshWhenFocused)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', refreshWhenFocused)
      document.removeEventListener('visibilitychange', refreshWhenFocused)
    }
  }, [refreshHosted])

  const localItems = useMemo<AssignedViewItem[]>(() => [
    ...local.tasks.map((task): AssignedViewItem => ({
      key: `kanban:${task.id}`, provider: 'local', providerId: task.id,
      source: 'localKanban', sourceLabel: 'Local · Kanban', kind: 'kanban',
      identifier: `#${task.id.slice(0, 8)}`, title: task.title, state: task.status,
      repository: null, project: null, url: null, updatedAt: task.updatedAt,
      workspaceInputCapable: false, workspaceItem: null,
    })),
    ...local.todos.map((todo): AssignedViewItem => ({
      key: `todo:${todo.id}`, provider: 'local', providerId: todo.id,
      source: 'localTodo', sourceLabel: 'Local · Todo', kind: 'todo',
      identifier: `#${todo.id.slice(0, 8)}`, title: todo.text,
      state: todo.kanbanTaskId ? 'Added to Kanban' : 'Todo', repository: null, project: null,
      url: null, updatedAt: todo.updatedAt, workspaceInputCapable: false, workspaceItem: null,
    })),
  ].sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt)), [local.tasks, local.todos])

  const hostedViewItems = useMemo<AssignedViewItem[]>(() => hostedItems.map((item) => ({
    key: `${item.provider}:${item.source}:${item.providerId}`,
    provider: item.provider,
    providerId: item.providerId,
    source: item.source,
    sourceLabel: sourceLabels[item.source] ?? `${providerLabels[item.provider]} · Assigned`,
    kind: item.kind,
    identifier: item.identifier,
    title: item.title,
    state: item.state,
    repository: item.repository,
    project: item.project,
    url: item.webUrl,
    updatedAt: item.updatedAt,
    workspaceInputCapable: item.workspaceInputCapable,
    workspaceItem: item.workspaceItem,
  })), [hostedItems])

  const items = filter === 'local' ? localItems : hostedViewItems.filter((item) => item.kind === (filter === 'issues' ? 'issue' : 'review'))

  const addToKanban = async (item: AssignedViewItem) => {
    setMessage(null)
    try {
      if (item.kind === 'todo') {
        const created = await injectTodos(sessionId, [item.providerId])
        setMessage(created.length > 0 ? 'Todo added to local Kanban.' : 'Todo is already linked to local Kanban.')
        return
      }
      if (item.provider === 'local') return
      await createTask(sessionId, { title: `${item.identifier} ${item.title}`, description: `${item.sourceLabel}\n${item.url ?? ''}`.trim() })
      setMessage('Provider item added to local Kanban.')
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  const createOrOpenWorkspace = async (item: AssignedViewItem) => {
    if (item.provider === 'local' || !item.workspaceItem || !onWorkspaceInput) return
    setMessage(null)
    try {
      const input = await providerWorkspaceInput(item.provider, item.workspaceItem)
      await onWorkspaceInput(input)
      setMessage('Workspace input sent to the existing workspace flow.')
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  return (
    <section className="assigned-tab" data-git-tab="assigned">
      <header className="assigned-tab-header">
        <div>
          <h2>Assigned</h2>
          <p>Read-only aggregation. Sources refresh only while this panel is visible and focused, or when you refresh manually.</p>
        </div>
        <button type="button" onClick={() => void refreshHosted()} disabled={refreshing}>
          {refreshing ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
          Refresh hosted
        </button>
      </header>

      <nav className="assigned-filters" aria-label="Assigned item filters">
        {(['local', 'issues', 'reviews'] as AssignedFilter[]).map((value) => (
          <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {value === 'local' ? 'Local' : value === 'issues' ? 'Issues' : 'Reviews'}
          </button>
        ))}
      </nav>

      {filter !== 'local' ? (
        <div className="assigned-provider-state" aria-label="Provider connection status">
          {providerKinds.map((provider) => <span key={provider}><strong>{providerLabels[provider]}</strong>{providerState[provider]}</span>)}
          {lastRefreshAt ? <time dateTime={new Date(lastRefreshAt).toISOString()}>Updated {new Date(lastRefreshAt).toLocaleTimeString()}</time> : null}
        </div>
      ) : null}

      <div className="assigned-items" role="list">
        {items.map((item) => (
          <article key={item.key} className="assigned-item" role="listitem" data-source={item.source}>
            <div className="assigned-item-main">
              <div className="assigned-item-source"><span>{item.sourceLabel}</span><code>{item.providerId}</code></div>
              <h3><span>{item.identifier}</span>{item.title}</h3>
              <p>{item.state}{item.repository ? ` · ${item.repository}` : item.project ? ` · ${item.project}` : ''}</p>
              {item.updatedAt ? <time dateTime={typeof item.updatedAt === 'string' ? item.updatedAt : new Date(item.updatedAt).toISOString()}>Updated {formatUpdatedAt(item.updatedAt)}</time> : null}
            </div>
            <div className="assigned-item-actions">
              {item.url ? <button type="button" onClick={() => void invoke('open_path', { path: item.url })}><ExternalLink size={13} /> Open URL</button> : null}
              {item.url ? <button type="button" onClick={() => void navigator.clipboard.writeText(item.url!)}><Clipboard size={13} /> Copy URL</button> : null}
              {item.kind !== 'kanban' ? <button type="button" disabled={item.kind === 'todo' && item.state === 'Added to Kanban'} onClick={() => void addToKanban(item)}><SquareKanban size={13} /> Add to local Kanban</button> : null}
              {item.workspaceInputCapable ? <button type="button" disabled={!onWorkspaceInput} title={onWorkspaceInput ? undefined : 'Workspace input wiring is unavailable'} onClick={() => void createOrOpenWorkspace(item)}><FolderPlus size={13} /> Create/Open Workspace</button> : null}
            </div>
          </article>
        ))}
        {items.length === 0 ? <p className="assigned-empty">No {filter === 'local' ? 'local Kanban or Todo' : filter} items.</p> : null}
      </div>

      {message ? <div className="assigned-message" role="status">{message}</div> : null}
      {filter === 'reviews' && reviewContent ? <section className="assigned-review-detail"><header><h3>Repository review detail</h3><p>Existing pull/merge request detail for the active Git target.</p></header>{reviewContent}</section> : null}
    </section>
  )
}

function timestamp(value: string | number | null): number {
  if (typeof value === 'number') return value
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function formatUpdatedAt(value: string | number): string {
  const parsed = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : String(value)
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}
