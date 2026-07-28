import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'

export type RemotePaneLeaseStatus = {
  sessionId: string
  paneId: string
  deviceId: string
  cols: number
  rows: number
  expiresAt: number
}

export type RemotePaneLeaseEvent = {
  sessionId: string
  paneId: string
  deviceId: string
  leased: boolean
  cols?: number
  rows?: number
  expiresAt: number
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
    ? {
        sessionId: event.sessionId,
        paneId: event.paneId,
        deviceId: event.deviceId,
        cols: event.cols,
        rows: event.rows,
        expiresAt: event.expiresAt,
      }
    : null
  useRemotePaneLeaseStore.getState().setLease(event.paneId, lease)
  return lease
}

export async function refreshRemotePaneLease(paneId: string): Promise<RemotePaneLeaseStatus | null> {
  const lease = await invoke<RemotePaneLeaseStatus | null>('remote_get_pane_lease', { paneId })
  useRemotePaneLeaseStore.getState().setLease(paneId, lease)
  return lease
}

export async function reclaimRemotePaneLease(sessionId: string, paneId: string): Promise<void> {
  await invoke('remote_reclaim_pane_lease', { sessionId, paneId })
  useRemotePaneLeaseStore.getState().setLease(paneId, null)
}

/**
 * A phone that walks through several panes leaves each of them phone-shaped.
 * Reclaiming them one cover at a time is busywork, so the cover offers one
 * action that takes every leased pane back; partial failures are reported.
 */
export async function reclaimAllRemotePaneLeases(): Promise<{ reclaimed: number; failures: string[] }> {
  const leases = Object.values(useRemotePaneLeaseStore.getState().leases)
  const failures: string[] = []
  let reclaimed = 0
  for (const lease of leases) {
    try {
      await reclaimRemotePaneLease(lease.sessionId, lease.paneId)
      reclaimed += 1
    } catch (error) {
      failures.push(String(error))
    }
  }
  return { reclaimed, failures }
}
