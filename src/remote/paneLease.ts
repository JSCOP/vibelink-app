import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'

export type RemotePaneLeaseStatus = {
  sessionId: string
  paneId: string
  cols: number
  rows: number
}

export type RemotePaneLeaseEvent = {
  sessionId: string
  paneId: string
  leased: boolean
  cols?: number
  rows?: number
}

type RemotePaneLeaseState = {
  leases: Record<string, RemotePaneLeaseStatus>
  setLease: (paneId: string, lease: RemotePaneLeaseStatus | null) => void
}

export const useRemotePaneLeaseStore = create<RemotePaneLeaseState>((set) => ({
  leases: {},
  setLease: (paneId, lease) => set((state) => {
    if (lease) return { leases: { ...state.leases, [paneId]: lease } }
    if (!(paneId in state.leases)) return state
    const leases = { ...state.leases }
    delete leases[paneId]
    return { leases }
  }),
}))

export function applyRemotePaneLeaseEvent(event: RemotePaneLeaseEvent): RemotePaneLeaseStatus | null {
  const lease = event.leased && event.cols !== undefined && event.rows !== undefined
    ? { sessionId: event.sessionId, paneId: event.paneId, cols: event.cols, rows: event.rows }
    : null
  useRemotePaneLeaseStore.getState().setLease(event.paneId, lease)
  return lease
}

export async function refreshRemotePaneLease(paneId: string): Promise<RemotePaneLeaseStatus | null> {
  const lease = await invoke<RemotePaneLeaseStatus | null>('remote_get_pane_lease', { paneId })
  useRemotePaneLeaseStore.getState().setLease(paneId, lease)
  return lease
}
