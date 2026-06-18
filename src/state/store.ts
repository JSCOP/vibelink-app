import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import type { AttachedSession, PaneConfig, PaneMeta, SessionMeta } from '../ipc/types'
import { defaultSettings, normalizeSettings, paneOverridesFromProfile, selectedProfile } from './profiles'
import type { Settings } from './profiles'

type Status = 'booting' | 'ready' | 'error'

type WorkspaceState = {
  sessions: SessionMeta[]
  activeSessionId?: string
  panes: Record<string, PaneMeta>
  layoutJson?: string | null
  status: Status
  error?: string
  settings: Settings
  bootstrap: () => Promise<void>
  refreshSessions: () => Promise<void>
  attachSession: (sessionId: string) => Promise<AttachedSession>
  createSession: (name?: string) => Promise<SessionMeta>
  renameSession: (sessionId: string, name: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  spawnPane: (sessionId: string, overrides?: Partial<PaneConfig>) => Promise<PaneMeta>
  closePane: (paneId: string) => Promise<void>
  saveLayout: (sessionId: string, layoutJson: string) => Promise<void>
  setError: (error: string) => void
  clearError: () => void
  updateSettings: (settings: Partial<Settings>) => void
  setDefaultProfile: (profileId: string) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  sessions: [],
  panes: {},
  status: 'booting',
  settings: loadSettings(),

  bootstrap: async () => {
    set({ status: 'booting', error: undefined })
    try {
      let sessions = await invoke<SessionMeta[]>('list_sessions')
      if (sessions.length === 0) {
        const created = await invoke<SessionMeta>('create_session', { name: 'Workspace 1' })
        sessions = [created]
      }

      const lastActive = window.localStorage.getItem('awt:lastActiveSessionId')
      const target = sessions.find((session) => session.id === lastActive) ?? sessions[0]
      const attached = await get().attachSession(target.id)
      if (attached.panes.length === 0) {
        await get().spawnPane(target.id)
      }
      await get().refreshSessions()
      set({ status: 'ready' })
    } catch (error) {
      set({ status: 'error', error: String(error) })
    }
  },

  refreshSessions: async () => {
    const sessions = await invoke<SessionMeta[]>('list_sessions')
    set({ sessions })
  },

  attachSession: async (sessionId: string) => {
    const attached = await invoke<AttachedSession>('attach_session', { sessionId })
    const panes = Object.fromEntries(attached.panes.map((pane) => [pane.id, pane]))
    window.localStorage.setItem('awt:lastActiveSessionId', sessionId)
    set({ activeSessionId: sessionId, panes, layoutJson: attached.layoutJson ?? null })
    return attached
  },

  createSession: async (name?: string) => {
    const fallbackName = `Workspace ${get().sessions.length + 1}`
    const created = await invoke<SessionMeta>('create_session', { name: name ?? fallbackName })
    await get().refreshSessions()
    await get().attachSession(created.id)
    await get().spawnPane(created.id)
    return created
  },

  renameSession: async (sessionId: string, name: string) => {
    await invoke('rename_session', { sessionId, name })
    await get().refreshSessions()
  },

  deleteSession: async (sessionId: string) => {
    await invoke('delete_session', { sessionId })
    let sessions = await invoke<SessionMeta[]>('list_sessions')
    if (sessions.length === 0) {
      const created = await invoke<SessionMeta>('create_session', { name: 'Workspace 1' })
      sessions = [created]
    }
    set({ sessions })
    const next = sessions[0]
    await get().attachSession(next.id)
    if (Object.keys(get().panes).length === 0) {
      await get().spawnPane(next.id)
    }
  },

  spawnPane: async (sessionId: string, overrides?: Partial<PaneConfig>) => {
    const paneId = overrides?.paneId ?? crypto.randomUUID()
    const profileDefaults = paneOverridesFromProfile(selectedProfile(get().settings))
    const hasShellOverride = Boolean(overrides && 'shell' in overrides)
    const hasCwdOverride = Boolean(overrides && 'cwd' in overrides)
    const hasTitleOverride = Boolean(overrides && 'title' in overrides)
    const cfg: PaneConfig = {
      paneId,
      shell: hasShellOverride ? overrides?.shell ?? null : profileDefaults.shell,
      args: overrides?.args ? [...overrides.args] : profileDefaults.args,
      cwd: hasCwdOverride ? overrides?.cwd ?? null : profileDefaults.cwd,
      env: overrides?.env ? overrides.env.map(([key, value]) => [key, value]) : profileDefaults.env,
      title: hasTitleOverride ? overrides?.title ?? null : profileDefaults.title,
      cols: overrides?.cols ?? 120,
      rows: overrides?.rows ?? 32,
    }
    const pane = await invoke<PaneMeta>('spawn_pane', { sessionId, cfg })
    set((state) => ({ panes: { ...state.panes, [pane.id]: pane } }))
    await get().refreshSessions()
    return pane
  },

  closePane: async (paneId: string) => {
    await invoke('close_pane', { paneId })
    set((state) => {
      const { [paneId]: _removed, ...panes } = state.panes
      return { panes }
    })
    await get().refreshSessions()
  },

  saveLayout: async (sessionId: string, layoutJson: string) => {
    await invoke('save_layout', { sessionId, layoutJson })
    if (get().activeSessionId === sessionId) {
      set({ layoutJson })
    }
  },

  setError: (error: string) => set({ error, status: 'error' }),
  clearError: () => set({ error: undefined, status: 'ready' }),
  updateSettings: (patch: Partial<Settings>) => {
    const settings = normalizeSettings({ ...get().settings, ...patch })
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('awt:settings', JSON.stringify(settings))
    }
    set({ settings })
  },
  setDefaultProfile: (profileId: string) => {
    get().updateSettings({ defaultProfileId: profileId })
  },
}))

function loadSettings(): Settings {
  if (typeof window === 'undefined') return defaultSettings

  try {
    const raw = window.localStorage.getItem('awt:settings')
    return normalizeSettings(raw ? JSON.parse(raw) : null)
  } catch {
    return defaultSettings
  }
}
