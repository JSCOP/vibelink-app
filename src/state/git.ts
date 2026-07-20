import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import type { CiStatus, HostingInfo, RepoInfo, WorkingStatus } from '../ipc/types'

export type GitTab = 'changes' | 'history' | 'branches' | 'pullRequests'
export type GitDiffArea = 'staged' | 'unstaged'

export type GitRepositoryState = {
  repoInfo: RepoInfo | null
  status: WorkingStatus | null
  refreshing: boolean
  error: string | null
  lastRefreshAt: number
  hostingInfo: HostingInfo | null
  ciStatus: CiStatus | null
  hostingError: string | null
  lastHostingRefreshAt: number
}

export type GitSessionState = {
  repositories: Record<string, GitRepositoryState>
  activeRepoRoot: string
  selectedPath: string | null
  selectedRepoRoot: string
  selectedArea: GitDiffArea | null
  activeTab: GitTab
  pathFilter: string | null
}

type GitMutation = () => Promise<unknown>

type GitStore = {
  sessions: Record<string, GitSessionState>
  refreshGit: (sessionId: string, workspaceFolder: string | null | undefined) => Promise<void>
  refreshRepository: (sessionId: string, workspaceFolder: string | null | undefined, repoRoot?: string) => Promise<void>
  runGitMutation: (sessionId: string, workspaceFolder: string, mutation: GitMutation, repoRoot?: string) => Promise<void>
  refreshHosting: (sessionId: string, workspaceFolder: string | null | undefined, refName?: string, force?: boolean, repoRoot?: string) => Promise<void>
  setActiveRepository: (sessionId: string, repoRoot: string) => void
  setSelectedPath: (sessionId: string, selectedPath: string | null, selectedRepoRoot?: string, selectedArea?: GitDiffArea | null) => void
  setActiveTab: (sessionId: string, activeTab: GitTab, pathFilter?: string | null) => void
  clearError: (sessionId: string) => void
}

const refreshGeneration = new Map<string, number>()

export const emptyGitRepositoryState: GitRepositoryState = {
  repoInfo: null,
  status: null,
  refreshing: false,
  error: null,
  lastRefreshAt: 0,
  hostingInfo: null,
  ciStatus: null,
  hostingError: null,
  lastHostingRefreshAt: 0,
}

export const emptyGitSessionState: GitSessionState = {
  repositories: {},
  activeRepoRoot: '',
  selectedPath: null,
  selectedRepoRoot: '',
  selectedArea: null,
  activeTab: 'changes',
  pathFilter: null,
}

export const useGitStore = create<GitStore>((set, get) => ({
  sessions: {},
  refreshGit: async (sessionId, workspaceFolder) => get().refreshRepository(sessionId, workspaceFolder, ''),
  refreshRepository: async (sessionId, workspaceFolder, repoRoot = '') => {
    if (!workspaceFolder) {
      if (!repoRoot) set((state) => ({ sessions: { ...state.sessions, [sessionId]: { ...emptyGitSessionState } } }))
      return
    }
    const folder = repositoryFolder(workspaceFolder, repoRoot)
    const generationKey = `${sessionId}:${repoRoot}`
    const generation = (refreshGeneration.get(generationKey) ?? 0) + 1
    refreshGeneration.set(generationKey, generation)
    set((state) => updateRepository(state.sessions, sessionId, repoRoot, { refreshing: true, error: null }))
    try {
      const [repoInfo, status] = await Promise.all([
        invoke<RepoInfo>('git_repo_info', { workspaceFolder: folder }),
        invoke<WorkingStatus>('git_working_status', { workspaceFolder: folder }),
      ])
      if (refreshGeneration.get(generationKey) !== generation) return
      set((state) => updateRepository(state.sessions, sessionId, repoRoot, {
        repoInfo,
        status,
        refreshing: false,
        error: null,
        lastRefreshAt: Date.now(),
      }))
    } catch (reason) {
      if (refreshGeneration.get(generationKey) !== generation) return
      set((state) => updateRepository(state.sessions, sessionId, repoRoot, {
        refreshing: false,
        error: String(reason),
      }))
    }
  },
  refreshHosting: async (sessionId, workspaceFolder, refName = 'HEAD', force = false, repoRoot = '') => {
    if (!workspaceFolder) return
    const session = get().sessions[sessionId] ?? emptyGitSessionState
    const current = repositoryStateFor(session, repoRoot)
    if (!force && Date.now() - current.lastHostingRefreshAt < 60_000) return
    const folder = repositoryFolder(workspaceFolder, repoRoot)
    let detectedHostingInfo: HostingInfo | null = null
    try {
      const hostingInfo = detectedHostingInfo = await invoke<HostingInfo>('hosting_detect', { workspaceFolder: folder })
      let ciStatus: CiStatus | null = null
      if (hostingInfo.provider && hostingInfo.tokenPresent) {
        ciStatus = await invoke<CiStatus>('hosting_ci_status', { workspaceFolder: folder, refName })
      }
      set((state) => updateRepository(state.sessions, sessionId, repoRoot, {
        hostingInfo,
        ciStatus,
        hostingError: null,
        lastHostingRefreshAt: Date.now(),
      }))
    } catch (reason) {
      const message = String(reason)
      set((state) => {
        const nextSession = state.sessions[sessionId] ?? emptyGitSessionState
        const next = repositoryStateFor(nextSession, repoRoot)
        const visibleHostingInfo = detectedHostingInfo ?? next.hostingInfo
        return updateRepository(state.sessions, sessionId, repoRoot, {
          hostingInfo: message.includes('AUTH:') && visibleHostingInfo ? { ...visibleHostingInfo, tokenPresent: false } : visibleHostingInfo,
          ciStatus: null,
          hostingError: message,
          lastHostingRefreshAt: Date.now(),
        })
      })
    }
  },
  runGitMutation: async (sessionId, workspaceFolder, mutation, repoRoot = '') => {
    try {
      await mutation()
      const refreshes = [get().refreshRepository(sessionId, workspaceFolder, repoRoot)]
      if (repoRoot) refreshes.push(get().refreshRepository(sessionId, workspaceFolder, ''))
      await Promise.all(refreshes)
    } catch (reason) {
      set((state) => updateRepository(state.sessions, sessionId, repoRoot, {
        refreshing: false,
        error: String(reason),
      }))
      throw reason
    }
  },
  setActiveRepository: (sessionId, repoRoot) => set((state) => {
    const current = state.sessions[sessionId] ?? emptyGitSessionState
    const changed = current.activeRepoRoot !== repoRoot
    return {
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...current,
          activeRepoRoot: repoRoot,
          selectedPath: changed ? null : current.selectedPath,
          selectedRepoRoot: changed ? repoRoot : current.selectedRepoRoot,
          selectedArea: changed ? null : current.selectedArea,
          pathFilter: changed ? null : current.pathFilter,
        },
      },
    }
  }),
  setSelectedPath: (sessionId, selectedPath, selectedRepoRoot, selectedArea = null) => set((state) => {
    const current = state.sessions[sessionId] ?? emptyGitSessionState
    return {
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...current,
          selectedPath,
          selectedRepoRoot: selectedRepoRoot ?? current.activeRepoRoot,
          selectedArea,
        },
      },
    }
  }),
  setActiveTab: (sessionId, activeTab, pathFilter = null) => set((state) => ({
    sessions: {
      ...state.sessions,
      [sessionId]: { ...(state.sessions[sessionId] ?? emptyGitSessionState), activeTab, pathFilter },
    },
  })),
  clearError: (sessionId) => set((state) => {
    const session = state.sessions[sessionId] ?? emptyGitSessionState
    return updateRepository(state.sessions, sessionId, session.activeRepoRoot, { error: null })
  }),
}))

export function repositoryStateFor(session: GitSessionState, repoRoot = session.activeRepoRoot): GitRepositoryState {
  return session.repositories[repoRoot] ?? emptyGitRepositoryState
}

export function repositoryFolder(workspaceFolder: string, repoRoot: string): string {
  return repoRoot ? `${workspaceFolder.replace(/[\\/]+$/, '')}/${repoRoot}` : workspaceFolder
}

function updateRepository(
  sessions: Record<string, GitSessionState>,
  sessionId: string,
  repoRoot: string,
  patch: Partial<GitRepositoryState>,
): { sessions: Record<string, GitSessionState> } {
  const session = sessions[sessionId] ?? emptyGitSessionState
  const repository = repositoryStateFor(session, repoRoot)
  return {
    sessions: {
      ...sessions,
      [sessionId]: {
        ...session,
        repositories: {
          ...session.repositories,
          [repoRoot]: { ...repository, ...patch },
        },
      },
    },
  }
}
