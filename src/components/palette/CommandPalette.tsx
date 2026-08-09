import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { AppWindow, FileCode2, FileSearch, FolderKanban, SquareTerminal } from 'lucide-react'
import { getOpenContentSnapshot, subscribeOpenContent } from '../../layout/openContentRegistry'
import type { WorkspaceContentActions } from '../../layout/contentActions'
import { rankQuickOpenFiles } from '../../editor/quickOpenFiles'
import { listWorkspaceFiles } from '../../ipc/fs'
import { useWorkspaceStore } from '../../state/store'
import { buildAttentionByWorkspace, deriveVisibleWorkspaceOrder } from '../../state/worktreeAttention'
import { repositoryStateFor, useGitStore } from '../../state/git'
import { flattenWorktreeNodes } from '../../state/workspaceGroups'
import { filterPaletteItems, orderWithRecents, paletteCategoryTitle, type PaletteCategory, type PaletteItem } from './paletteModel'
import { closePalette, paletteStore, readPaletteRecents, recordPaletteRecent } from './paletteStore'
import { ProfileIcon } from '../ProfileIcon'
import { profileIconForPane } from '../../state/profiles'
import './palette.css'

export type CommandPaletteProps = {
  contentActions: WorkspaceContentActions | null
  /** App-level commands (open settings, capture, resource monitor…). */
  commands?: PaletteItem[]
}

const MAX_VISIBLE = 12
const RESULT_CATEGORY_ORDER: PaletteItem['category'][] = ['group', 'project', 'workspace', 'content', 'terminal', 'command']
/** Stable empty list so the ranking memo does not re-run on every render. */
const NO_FILES: string[] = []

export function CommandPaletteHost({ contentActions, commands = [] }: CommandPaletteProps) {
  const { open } = useSyncExternalStore(paletteStore.subscribe, paletteStore.getSnapshot, paletteStore.getSnapshot)
  if (!open) return null
  return <CommandPaletteContents contentActions={contentActions} commands={commands} />
}

// A closed palette must observe nothing: attention refreshes every 15s and Git root
// polling publishes refreshing/result twice per 30s, which re-rendered the closed host
// for no visible result. External-store hooks cannot be called conditionally, so every
// subscription lives in a component that mounts only while the palette is open.
function CommandPaletteContents({ contentActions, commands }: { contentActions: WorkspaceContentActions | null; commands: PaletteItem[] }) {
  const sessions = useWorkspaceStore((state) => state.sessions)
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const workspaceReadyEpoch = useWorkspaceStore((state) => state.workspaceReadyEpoch)
  const settings = useWorkspaceStore((state) => state.settings)
  const worktrees = useWorkspaceStore((state) => state.worktreeProjections)
  const gitSessions = useGitStore((state) => state.sessions)
  const attentionSnapshot = useWorkspaceStore((state) => state.attentionSnapshot)
  const hermesStatus = useWorkspaceStore((state) => state.hermesStatus)
  const hermesPermissions = useWorkspaceStore((state) => state.hermesPermissions)
  const paneCompletionHighlights = useWorkspaceStore((state) => state.paneCompletionHighlights)
  const paneReviewMarkers = useWorkspaceStore((state) => state.paneReviewMarkers)
  const openSession = useWorkspaceStore((state) => state.openSession)
  const openContent = useSyncExternalStore(subscribeOpenContent, getOpenContentSnapshot, getOpenContentSnapshot)

  const items = useMemo<PaletteItem[]>(() => {
    const attentionByWorkspace = buildAttentionByWorkspace(sessions, worktrees, attentionSnapshot, {
      completionHighlights: paneCompletionHighlights,
      hermesStatus,
      hermesPermissions,
      reviewedPaneIds: new Set(Object.keys(paneReviewMarkers)),
      conflictSessionIds: new Set(worktrees.flatMap((projection) => projection.native?.hasConflicts && projection.record?.sessionId ? [projection.record.sessionId] : [])),
    })
    const ordered = deriveVisibleWorkspaceOrder(
      sessions,
      settings.workspaceGroups,
      settings.workspaceGroupIds,
      worktrees,
      settings.workspaceSortMode,
      attentionByWorkspace,
      settings.workspaceOrder,
    )
    const groupBySessionId = new Map<string, string>()
    for (const row of ordered.rows) {
      if (row.kind !== 'group') continue
      for (const node of row.sessions) {
        groupBySessionId.set(node.session.id, row.group.name)
        for (const worktree of flattenWorktreeNodes(node.worktrees)) groupBySessionId.set(worktree.session.id, row.group.name)
      }
    }
    const projectionBySessionId = new Map(worktrees.flatMap((projection) => projection.record?.sessionId ? [[projection.record.sessionId, projection] as const] : []))
    const repositoryPathBySessionId = new Map<string, string>()
    for (const projection of worktrees) {
      const record = projection.record
      if (!record) continue
      if (record.sessionId) repositoryPathBySessionId.set(record.sessionId, record.repositoryPath)
      if (record.parentSessionId && !repositoryPathBySessionId.has(record.parentSessionId)) repositoryPathBySessionId.set(record.parentSessionId, record.repositoryPath)
    }

    const workspaces: PaletteItem[] = ordered.sessions.map((session) => {
      const projection = projectionBySessionId.get(session.id)
      const metadataSessionIds = [session.id, projection?.record?.parentSessionId].filter((id): id is string => Boolean(id))
      const hosting = metadataSessionIds
        .map((sessionId) => gitSessions[sessionId])
        .flatMap((gitSession) => gitSession ? [repositoryStateFor(gitSession, '').hostingInfo ?? repositoryStateFor(gitSession).hostingInfo] : [])
        .find(Boolean)
      const repositoryPath = repositoryPathBySessionId.get(session.id)
      const project = hosting?.repo ?? repositoryPath?.replace(/^.*[\\/]/, '')
      const host = hosting?.host ?? undefined
      const group = groupBySessionId.get(session.id)
      return {
        id: `ws:${session.id}`,
        category: group ? 'group' : project ? 'project' : 'workspace',
        label: session.name,
        detail: session.workspaceFolder ?? undefined,
        host,
        project,
        group,
        searchText: [host, project, group].filter(Boolean).join(' ') || undefined,
        icon: FolderKanban,
        run: () => {
          if (session.id === activeSessionId) return
          void openSession(session.id).catch(() => undefined)
        },
      }
    })

    const content: PaletteItem[] = openContent
      .filter((item) => !item.active)
      .map((item) => ({
        id: `content:${item.panelId}`,
        category: 'content',
        label: item.title,
        detail: item.kind,
        iconName: item.icon,
        run: () => contentActions?.activateContent(item.panelId),
      }))

    const terminals: PaletteItem[] = settings.profiles.map((profile) => ({
      id: `term:${profile.id}`,
      category: 'terminal',
      label: profile.name,
      detail: profile.command || profile.shell || 'Terminal',
      iconName: profileIconForPane(profile),
      run: () => { void contentActions?.openContent({ kind: 'terminal', profileId: profile.id }) },
    }))

    return [...RESULT_CATEGORY_ORDER.flatMap((category) => workspaces.filter((item) => item.category === category)), ...content, ...terminals, ...commands]
  }, [sessions, activeSessionId, settings, worktrees, attentionSnapshot, hermesStatus, hermesPermissions, paneCompletionHighlights, paneReviewMarkers, openSession, openContent, contentActions, commands, gitSessions])

  const activeWorkspaceFolder = sessions.find((session) => session.id === activeSessionId)?.workspaceFolder ?? null
  return (
    <PaletteSurface
      items={items}
      activeSessionId={activeSessionId ?? null}
      workspaceFolder={activeWorkspaceFolder}
      workspaceEpoch={workspaceReadyEpoch}
      contentActions={contentActions}
    />
  )
}

function PaletteSurface({
  items,
  activeSessionId,
  workspaceFolder,
  workspaceEpoch,
  contentActions,
}: {
  items: PaletteItem[]
  activeSessionId: string | null
  workspaceFolder: string | null
  workspaceEpoch: number
  contentActions: WorkspaceContentActions | null
}) {
  const [mode, setMode] = useState<'commands' | 'files'>('commands')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [recents, setRecents] = useState<string[]>(() => readPaletteRecents())
  const [hostFilter, setHostFilter] = useState<string | null>(null)
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [fileRequest, setFileRequest] = useState(0)
  const [fileState, setFileState] = useState<{ key: string; files: string[]; error: string | null } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const paletteItems = useMemo<PaletteItem[]>(() => [...items, {
    id: 'go-to-file',
    category: 'command',
    label: 'Go to file',
    detail: 'Open a workspace file',
    icon: FileSearch,
    run: () => undefined,
  }], [items])

  // Quick Open state is derived from the request key, not written synchronously
  // in the effect: only the resolved fetch sets state, so loading/error/results
  // stay a pure function of (mode, workspaceFolder, fileRequest).
  const fileRequestKey = mode === 'files' && workspaceFolder ? `${fileRequest}:${workspaceFolder}` : null

  useEffect(() => {
    if (!fileRequestKey || !workspaceFolder) return
    let cancelled = false
    void listWorkspaceFiles(workspaceFolder)
      .then((paths) => { if (!cancelled) setFileState({ key: fileRequestKey, files: paths, error: null }) })
      .catch((reason: unknown) => {
        if (cancelled) return
        const message = reason instanceof Error ? reason.message : String(reason)
        setFileState({ key: fileRequestKey, files: [], error: message.toLowerCase().includes('not a git repository')
          ? 'This workspace is not a Git repository, so the file list is unavailable.'
          : `Could not load workspace files: ${message}` })
      })
    return () => { cancelled = true }
  }, [fileRequestKey, workspaceFolder])

  const settledFiles = fileRequestKey && fileState?.key === fileRequestKey ? fileState : null
  const files = settledFiles?.files ?? NO_FILES
  const filesLoading = fileRequestKey !== null && settledFiles === null
  const filesError = mode !== 'files'
    ? null
    : fileRequestKey === null
      ? 'Select a workspace with a workspace folder to list files.'
      : settledFiles?.error ?? null

  const hosts = useMemo(() => [...new Set(paletteItems.flatMap((item) => (!projectFilter || item.project === projectFilter) && item.host ? [item.host] : []))].sort((left, right) => left.localeCompare(right)), [paletteItems, projectFilter])
  const projects = useMemo(() => [...new Set(paletteItems.flatMap((item) => (!hostFilter || item.host === hostFilter) && item.project ? [item.project] : []))].sort((left, right) => left.localeCompare(right)), [hostFilter, paletteItems])
  const scopedItems = useMemo(() => paletteItems.filter((item) => (!hostFilter || item.host === hostFilter) && (!projectFilter || item.project === projectFilter)), [hostFilter, paletteItems, projectFilter])
  const { recents: recentItems, rest } = useMemo(() => orderWithRecents(filterPaletteItems(scopedItems, query), query.trim() ? [] : recents), [query, recents, scopedItems])
  const visible = useMemo(() => [...recentItems, ...RESULT_CATEGORY_ORDER.flatMap((category) => rest.filter((item) => item.category === category))].slice(0, MAX_VISIBLE * 3), [recentItems, rest])
  const fileResults = useMemo(() => rankQuickOpenFiles(files, query), [files, query])
  const selectedItem = visible[Math.min(selected, Math.max(visible.length - 1, 0))]
  const selectedFile = fileResults[Math.min(selected, Math.max(fileResults.length - 1, 0))]

  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [mode, selectedFile, selectedItem?.id])

  const runItem = (item: PaletteItem) => {
    if (item.id === 'go-to-file') {
      recordPaletteRecent(item.id)
      setRecents(readPaletteRecents())
      setFileRequest((current) => current + 1)
      setMode('files')
      setQuery('')
      setSelected(0)
      return
    }
    closePalette()
    recordPaletteRecent(item.id)
    setRecents(readPaletteRecents())
    void item.run()
  }

  const openFile = (relPath: string) => {
    if (!activeSessionId || !contentActions) return
    closePalette()
    void contentActions.openContent({ kind: 'editor', relPath, workspaceId: activeSessionId, workspaceEpoch })
  }

  let lastCategory: PaletteCategory | null = null
  const commandRows = visible.map((item, index) => {
    const category: PaletteCategory = recentItems.includes(item) ? 'recent' : item.category
    const header = category !== lastCategory ? <p key={`h-${category}`} className="command-palette-heading">{paletteCategoryTitle[category]}</p> : null
    lastCategory = category
    return (
      <div key={item.id}>
        {header}
        <button
          type="button"
          className="command-palette-item"
          data-selected={index === selected || undefined}
          onMouseEnter={() => setSelected(index)}
          onClick={() => runItem(item)}
        >
          <span className="command-palette-item-icon">
            {item.iconName
              ? <ProfileIcon name={item.iconName} size={15} />
              : item.icon
                ? <item.icon size={15} aria-hidden="true" />
                : <SquareTerminal size={15} aria-hidden="true" />}
          </span>
          <span className="command-palette-item-label">{item.label}</span>
          {item.detail ? <span className="command-palette-item-detail">{item.detail}</span> : null}
        </button>
      </div>
    )
  })
  if (visible.length === 0) {
    commandRows.push(<p key="empty" className="command-palette-empty">No matching workspaces, tabs, or commands.</p>)
  }

  const fileStatus = filesLoading
    ? 'Loading workspace files'
    : filesError
      ? 'File list unavailable'
      : `${fileResults.length} file result${fileResults.length === 1 ? '' : 's'}`

  return createPortal(
    <div className="command-palette-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) closePalette() }}>
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={inputRef}
          type="text"
          className="command-palette-input"
          placeholder={mode === 'files' ? 'Search workspace files…' : 'Switch workspace, open content, run a command…'}
          aria-label={mode === 'files' ? 'Go to file' : 'Command palette'}
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelected(0)
          }}
          onKeyDown={(event) => {
            event.stopPropagation()
            const resultCount = mode === 'files' ? fileResults.length : visible.length
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setSelected((current) => Math.min(current + 1, Math.max(resultCount - 1, 0)))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setSelected((current) => Math.max(current - 1, 0))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              if (mode === 'files') {
                if (selectedFile) openFile(selectedFile)
              } else if (selectedItem) runItem(selectedItem)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              if (mode === 'files') {
                setMode('commands')
                setQuery('')
                setSelected(0)
              } else {
                closePalette()
              }
            }
          }}
        />
        {mode === 'commands' && (hosts.length > 0 || projects.length > 0) ? (
          <div
            className="vl-set-chips"
            role="group"
            aria-label="Workspace filters"
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                inputRef.current?.focus()
                setSelected((current) => Math.min(current + 1, Math.max(visible.length - 1, 0)))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                inputRef.current?.focus()
                setSelected((current) => Math.max(current - 1, 0))
              } else if (event.key === 'Escape') {
                event.preventDefault()
                closePalette()
              }
            }}
          >
            <span className="vl-set-seg">
              <button
                type="button"
                aria-pressed={!hostFilter && !projectFilter}
                onClick={() => {
                  setHostFilter(null)
                  setProjectFilter(null)
                  setSelected(0)
                }}
              >All</button>
            </span>
            {hosts.length > 0 ? (
              <span className="vl-set-seg" role="group" aria-label="Host filters">
                {hosts.map((host) => (
                  <button
                    key={host}
                    type="button"
                    aria-pressed={hostFilter === host}
                    onClick={() => {
                      setHostFilter((current) => current === host ? null : host)
                      setSelected(0)
                    }}
                  >Host: {host}</button>
                ))}
              </span>
            ) : null}
            {projects.length > 0 ? (
              <span className="vl-set-seg" role="group" aria-label="Project filters">
                {projects.map((project) => (
                  <button
                    key={project}
                    type="button"
                    aria-pressed={projectFilter === project}
                    onClick={() => {
                      setProjectFilter((current) => current === project ? null : project)
                      setSelected(0)
                    }}
                  >Project: {project}</button>
                ))}
              </span>
            ) : null}
          </div>
        ) : null}
        <div ref={listRef} className="command-palette-list" role="listbox" aria-label={mode === 'files' ? 'File results' : 'Results'}>
          {mode === 'files' ? (
            <>
              <p className="command-palette-heading" aria-live="polite">{fileStatus}</p>
              {filesLoading ? (
                <p className="command-palette-empty">Loading workspace files…</p>
              ) : filesError ? (
                <p className="command-palette-empty">{filesError}</p>
              ) : fileResults.length === 0 ? (
                <p className="command-palette-empty">{query.trim() ? 'No matching files.' : 'No workspace files found.'}</p>
              ) : fileResults.map((path, index) => {
                const segments = path.split('/')
                const basename = segments.at(-1) ?? path
                const directory = segments.slice(0, -1).join('/')
                return (
                  <div key={path}>
                    <button
                      type="button"
                      className="command-palette-item"
                      data-selected={index === selected || undefined}
                      onMouseEnter={() => setSelected(index)}
                      onClick={() => openFile(path)}
                    >
                      <span className="command-palette-item-icon"><FileCode2 size={15} aria-hidden="true" /></span>
                      <span className="command-palette-item-label">{basename}</span>
                      {directory ? <span className="command-palette-item-detail">{directory}</span> : null}
                    </button>
                  </div>
                )
              })}
            </>
          ) : commandRows}
        </div>
        <p className="command-palette-hint"><AppWindow size={12} aria-hidden="true" /> ↑↓ choose · Enter {mode === 'files' ? 'open · Esc back' : 'run · Esc close'}</p>
      </div>
    </div>,
    document.body,
  )
}
