// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,qr') } }))

import { RemoteSettings } from './RemoteSettings'

const status = {
  enabled: true,
  running: true,
  port: 42811,
  fingerprint: 'abcdefghijklmnopqrstuvwxyz',
  hosts: ['192.168.1.10'],
  devices: [{ id: 'device-1', name: 'Pixel', createdAt: 1, lastSeenAt: 2 }],
}

describe('RemoteSettings', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockImplementation(async (command: string) => {
      if (command === 'remote_get_status') return status
      if (command === 'remote_firewall_status') return true
      if (command === 'remote_create_pairing') return { code: '12345678', expiresAt: Math.floor(Date.now() / 1000) + 300, qrPayload: '{}' }
      if (command === 'remote_revoke_device') return null
      return status
    })
  })

  afterEach(() => cleanup())

  it('renders native status and creates a pairing QR', async () => {
    render(<RemoteSettings />)
    expect(await screen.findByText('running')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /페어링 QR 표시/ }))
    expect(await screen.findByText('12345678')).toBeInTheDocument()
    expect(screen.getByAltText('VibeLink Mobile pairing QR')).toHaveAttribute('src', 'data:image/png;base64,qr')
    expect(invoke).toHaveBeenCalledWith('remote_create_pairing')
  })

  it('revokes a paired device and refreshes status', async () => {
    render(<RemoteSettings />)
    const revoke = await screen.findByRole('button', { name: /^Revoke$/ })
    fireEvent.click(revoke)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_revoke_device', { deviceId: 'device-1' }))
    await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === 'remote_get_status')).toHaveLength(2))
  })

  it('auto-starts a stopped server before creating the pairing QR', async () => {
    const stopped = { ...status, enabled: false, running: false }
    const started = { ...status, enabled: true, running: true }
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'remote_get_status') return stopped
      if (command === 'remote_firewall_status') return true
      if (command === 'remote_set_enabled' && args?.enabled === true) return started
      if (command === 'remote_create_pairing') return { code: '87654321', expiresAt: Math.floor(Date.now() / 1000) + 300, qrPayload: '{}' }
      return stopped
    })
    render(<RemoteSettings />)
    expect(await screen.findByText('stopped')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /페어링 QR 표시/ }))
    expect(await screen.findByText('87654321')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('remote_set_enabled', { enabled: true })
    expect(invoke).toHaveBeenCalledWith('remote_create_pairing')
  })

  it('offers one-click firewall setup when the rule is missing', async () => {
    let firewallConfigured = false
    invoke.mockImplementation(async (command: string) => {
      if (command === 'remote_get_status') return status
      if (command === 'remote_firewall_status') return firewallConfigured
      if (command === 'remote_setup_firewall') { firewallConfigured = true; return true }
      return status
    })
    render(<RemoteSettings />)
    const setup = await screen.findByRole('button', { name: '방화벽 자동 설정' })
    fireEvent.click(setup)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_setup_firewall'))
    expect(await screen.findByText(/방화벽 인바운드 규칙이 설정되어 있습니다/)).toBeInTheDocument()
  })
})
