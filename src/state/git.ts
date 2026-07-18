import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import type { RepoInfo, WorkingStatus } from '../ipc/types'

export type GitTab = 'changes' | 'history' | 'branches' | 'pullRequests'

export type GitSessionState = {
  repoInfo: RepoInfo | null
  status: WorkingStatus | null
  refreshing: boolean
  error: string | null
  lastRefreshAt: number
  selectedPath: string | null
  activeTab: GitTab
  pathFilter: string | null
}

type GitMutation = () => Promise<unknown>

type GitStore = {
  sessions: Record<string, GitSessionState>
  refreshGit: (sessionId: string, workspaceFolder: string | null | undefined) => Promise<void>
  runGitMutation: (sessionId: string, workspaceFolder: string, mutation: GitMutation) => Promise<void>
  setSelectedPath: (sessionId: string, selectedPath: string | null) => void
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
  activeTab: 'changes',
  pathFilter: null,
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
  setSelectedPath: (sessionId, selectedPath) => set((state) => ({
    sessions: {
      ...state.sessions,
      [sessionId]: { ...(state.sessions[sessionId] ?? emptyGitSessionState), selectedPath },
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
