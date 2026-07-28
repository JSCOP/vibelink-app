// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationRecord } from '../../ipc/notifications'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { NotificationCenter } from './NotificationCenter'

const historical: NotificationRecord = {
  id: 'notification-1',
  sequence: 1,
  kind: 'automation.completed',
  entityId: 'run-1',
  unread: true,
  acknowledgedAt: null,
  payload: {
    sessionId: 'session-1',
    automationId: 'automation-1',
    automationName: 'Nightly review',
    automationRunId: 'run-1',
    status: 'completed',
    worktreePath: null,
    branch: null,
    outputSummary: 'Initial review completed.',
    error: null,
  },
  createdAt: Date.now() - 1_000,
}

const arriving: NotificationRecord = {
  ...historical,
  id: 'notification-2',
  sequence: 2,
  entityId: 'run-2',
  payload: {
    ...historical.payload,
    automationRunId: 'run-2',
    outputSummary: 'New review completed.',
  },
  createdAt: Date.now(),
}

beforeEach(() => {
  vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' })
  invoke.mockReset()
  invoke.mockImplementation(async (_command: string, request: { method: string; payloadJson: string }) => {
    if (request.method === 'notifications.catchup') {
      const payload = JSON.parse(request.payloadJson)
      const data = payload.afterSequence === 0 ? [historical] : payload.afterSequence === 1 ? [arriving] : []
      return JSON.stringify({ ok: true, data })
    }
    if (request.method === 'notification.acknowledge') {
      return JSON.stringify({ ok: true, data: { ...arriving, unread: false, acknowledgedAt: Date.now() } })
    }
    throw new Error(`unexpected orchestration method ${request.method}`)
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('NotificationCenter', () => {
  it('does not toast history, then toasts and routes a newly arriving automation result', async () => {
    const onOpenAutomation = vi.fn(async () => undefined)
    render(<NotificationCenter onOpenAutomation={onOpenAutomation} />)

    expect(await screen.findByText('1')).toBeInTheDocument()
    expect(screen.queryByText('Initial review completed.')).not.toBeInTheDocument()

    fireEvent(window, new Event('focus'))
    const toastMessage = await screen.findByText('New review completed.')
    const toastButton = toastMessage.closest('button')
    if (!toastButton) throw new Error('notification toast button missing')
    fireEvent.click(toastButton)

    await waitFor(() => expect(onOpenAutomation).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      automationId: 'automation-1',
      automationRunId: 'run-2',
      status: 'completed',
    })))
    expect(invoke).toHaveBeenCalledWith('orchestration_request', expect.objectContaining({ method: 'notification.acknowledge' }))
  })
})
