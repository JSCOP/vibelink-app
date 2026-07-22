import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>())

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import {
  applyRemotePaneLeaseEvent,
  reclaimRemotePaneLease,
  useRemotePaneLeaseStore,
  type RemotePaneLeaseStatus,
} from './paneLease'

const lease: RemotePaneLeaseStatus = {
  sessionId: 'session-1',
  paneId: 'pane-1',
  deviceId: 'device-remote',
  cols: 52,
  rows: 31,
  expiresAt: 1_800_000_000_000,
}

describe('remote pane lease projection', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(undefined)
    useRemotePaneLeaseStore.setState({ leases: {} })
  })

  it('projects device identity and expiry and clears a released or lost lease event', () => {
    expect(applyRemotePaneLeaseEvent({ ...lease, leased: true })).toEqual(lease)
    expect(useRemotePaneLeaseStore.getState().leases[lease.paneId]).toEqual(lease)

    expect(applyRemotePaneLeaseEvent({
      sessionId: lease.sessionId,
      paneId: lease.paneId,
      deviceId: lease.deviceId,
      leased: false,
      expiresAt: lease.expiresAt,
    })).toBeNull()
    expect(useRemotePaneLeaseStore.getState().leases).toEqual({})
  })

  it('reclaims with the exact desktop command payload and clears state after success', async () => {
    useRemotePaneLeaseStore.getState().setLease(lease.paneId, lease)

    await reclaimRemotePaneLease(lease.sessionId, lease.paneId)

    expect(invokeMock).toHaveBeenCalledOnce()
    expect(invokeMock).toHaveBeenCalledWith('remote_reclaim_pane_lease', {
      sessionId: lease.sessionId,
      paneId: lease.paneId,
    })
    expect(useRemotePaneLeaseStore.getState().leases).toEqual({})
  })

  it('keeps the lease visible when reclaim fails so the cover can show the error and retry', async () => {
    invokeMock.mockRejectedValueOnce(new Error('lease is busy'))
    useRemotePaneLeaseStore.getState().setLease(lease.paneId, lease)

    await expect(reclaimRemotePaneLease(lease.sessionId, lease.paneId)).rejects.toThrow('lease is busy')

    expect(useRemotePaneLeaseStore.getState().leases[lease.paneId]).toEqual(lease)
  })
})
