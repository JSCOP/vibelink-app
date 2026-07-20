import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import type { CiStatus, HostingInfo, RepoInfo, WorkingStatus } from '../ipc/types'

export type GitTab = 'changes' | 'history' | 'branches' | 'pullRequests'
export type GitDiffArea = 'staged' | 'unstaged'

export type GitSessionState = {
  repoInfo: RepoInfo | null
  status: WorkingStatus | null
  refreshing: boolean
  error: string | null
  lastRefreshAt: number
  selectedPath: string | null
  selectedRepoRoot: string | null
  selectedArea: GitDiffArea | null
  activeTab: GitTab
  pathFilter: string | null
  hostingInfo: HostingInfo | null
  ciStatus: CiStatus | null
  hostingError: string | null
  lastHostingRefreshAt: number
}

type GitMutation = () => Promise<unknown>

type GitStore = {
  sessions: Record<string, GitSessionState>
  refreshGit: (sessionId: string, workspaceFolder: string | null | undefined) => Promise<void>
  runGitMutation: (sessionId: string, workspaceFolder: string, mutation: GitMutation) => Promise<void>
  refreshHosting: (sessionId: string, workspaceFolder: string | null | undefined, refName?: string, force?: boolean) => Promise<void>
  setSelectedPath: (sessionId: string, selectedPath: string | null, selectedRepoRoot?: string | null, selectedArea?: GitDiffArea | null) => void
  setActiveTab: (sessionId: string, activeTab: GitTab, pathFilter?: string | null) => void
  clearError: (sessionId: string) => void
}

const refreshGeneration = new Map<string, number>()

export const emptyGitSessionState: GitSessionState = {
  repoInfo: null,
  status: null,
  refreshing: false,
  error: null,
  lastRefreshAt: 0,
  selectedPath: null,
  selectedRepoRoot: null,
  selectedArea: null,
  activeTab: 'changes',
  pathFilter: null,
  hostingInfo: null,
  ciStatus: null,
  hostingError: null,
  lastHostingRefreshAt: 0,
}

export const useGitStore = create<GitStore>((set, get) => ({
  sessions: {},
  refreshGit: async (sessionId, workspaceFolder) => {
    if (!workspaceFolder) {
      set((state) => ({
        sessions: { ...state.sessions, [sessionId]: { ...emptyGitSessionState } },
      }))
      return
    }
    const generation = (refreshGeneration.get(sessionId) ?? 0) + 1
    refreshGeneration.set(sessionId, generation)
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: { ...(state.sessions[sessionId] ?? emptyGitSessionState), refreshing: true, error: null },
      },
    }))
    try {
      const [repoInfo, status] = await Promise.all([
        invoke<RepoInfo>('git_repo_info', { workspaceFolder }),
        invoke<WorkingStatus>('git_working_status', { workspaceFolder }),
      ])
      if (refreshGeneration.get(sessionId) !== generation) return
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...(state.sessions[sessionId] ?? emptyGitSessionState),
            repoInfo,
            status,
            refreshing: false,
            error: null,
            lastRefreshAt: Date.now(),
          },
        },
      }))
    } catch (reason) {
      if (refreshGeneration.get(sessionId) !== generation) return
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...(state.sessions[sessionId] ?? emptyGitSessionState),
            refreshing: false,
            error: String(reason),
          },
        },
      }))
    }
  },
  refreshHosting: async (sessionId, workspaceFolder, refName = 'HEAD', force = false) => {
    const current = get().sessions[sessionId] ?? emptyGitSessionState
    if (!workspaceFolder) {
      set((state) => ({ sessions: { ...state.sessions, [sessionId]: { ...current, hostingInfo: null, ciStatus: null, hostingError: null, lastHostingRefreshAt: Date.now() } } }))
      return
    }
    if (!force && Date.now() - current.lastHostingRefreshAt < 60_000) return
    let detectedHostingInfo: HostingInfo | null = null
    try {
      const hostingInfo = detectedHostingInfo = await invoke<HostingInfo>('hosting_detect', { workspaceFolder })
      let ciStatus: CiStatus | null = null
      if (hostingInfo.provider && hostingInfo.tokenPresent) {
        ciStatus = await invoke<CiStatus>('hosting_ci_status', { workspaceFolder, refName })
      }
      set((state) => ({ sessions: { ...state.sessions, [sessionId]: { ...(state.sessions[sessionId] ?? emptyGitSessionState), hostingInfo, ciStatus, hostingError: null, lastHostingRefreshAt: Date.now() } } }))
    } catch (reason) {
      const message = String(reason)
      set((state) => {
        const next = state.sessions[sessionId] ?? emptyGitSessionState
        const visibleHostingInfo = detectedHostingInfo ?? next.hostingInfo
        return { sessions: { ...state.sessions, [sessionId]: { ...next, hostingInfo: message.includes('AUTH:') && visibleHostingInfo ? { ...visibleHostingInfo, tokenPresent: false } : visibleHostingInfo, ciStatus: null, hostingError: message, lastHostingRefreshAt: Date.now() } } }
      })
    }
  },
  runGitMutation: async (sessionId, workspaceFolder, mutation) => {
    try {
      await mutation()
      await get().refreshGit(sessionId, workspaceFolder)
    } catch (reason) {
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...(state.sessions[sessionId] ?? emptyGitSessionState),
            refreshing: false,
            error: String(reason),
          },
        },
      }))
      throw reason
    }
  },
  setSelectedPath: (sessionId, selectedPath, selectedRepoRoot = null, selectedArea = null) => set((state) => ({
    sessions: {
      ...state.sessions,
      [sessionId]: { ...(state.sessions[sessionId] ?? emptyGitSessionState), selectedPath, selectedRepoRoot, selectedArea },
    },
  })),
  setActiveTab: (sessionId, activeTab, pathFilter = null) => set((state) => ({
    sessions: {
      ...state.sessions,
      [sessionId]: { ...(state.sessions[sessionId] ?? emptyGitSessionState), activeTab, pathFilter },
    },
  })),
  clearError: (sessionId) => set((state) => ({
    sessions: {
      ...state.sessions,
      [sessionId]: { ...(state.sessions[sessionId] ?? emptyGitSessionState), error: null },
    },
  })),
}))
