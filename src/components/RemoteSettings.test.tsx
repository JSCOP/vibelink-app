// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,qr') } }))

import QRCode from 'qrcode'

import { RemoteSettings } from './RemoteSettings'

const status = {
  enabled: true,
  running: true,
  port: 42811,
  lanEnabled: true,
  fingerprint: 'abcdefghijklmnopqrstuvwxyz',
  hosts: ['192.168.1.10'],
  devices: [{ id: 'device-1', name: 'Pixel', createdAt: 1, lastSeenAt: 2 }],
}

const commands = () => invoke.mock.calls.map(([command]) => command as string)
const indexOf = (command: string) => commands().indexOf(command)

describe('RemoteSettings', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockImplementation(async (command: string) => {
      if (command === 'remote_get_status') return status
      if (command === 'remote_firewall_status') return true
      if (command === 'remote_create_pairing_v2' || command === 'remote_create_pairing') return { code: '12345678', expiresAt: Math.floor(Date.now() / 1000) + 300, qrPayload: '{}' }
      if (command === 'remote_revoke_device') return null
      return status
    })
  })

  afterEach(() => cleanup())

  it('renders native status and creates a pairing QR', async () => {
    render(<RemoteSettings />)
    expect(await screen.findByText('running')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'QR 생성' }))
    expect(await screen.findByText('12345678')).toBeInTheDocument()
    expect(screen.getByAltText('VibeLink Mobile pairing QR')).toHaveAttribute('src', 'data:image/png;base64,qr')
    expect(screen.getByAltText('VibeLink Mobile pairing QR')).toHaveStyle({ flex: '0 1 240px', width: '240px' })
    expect(invoke).toHaveBeenCalledWith('remote_create_pairing_v2')
    // Camera-readable contract: full 4-module quiet zone and a large bitmap.
    expect(QRCode.toDataURL).toHaveBeenCalledWith('{}', { margin: 4, width: 720 })
  })

  it('revokes a paired device and refreshes status', async () => {
    render(<RemoteSettings />)
    const revoke = await screen.findByRole('button', { name: 'Revoke Pixel' })
    fireEvent.click(revoke)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_revoke_device', { deviceId: 'device-1' }))
    await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === 'remote_get_status')).toHaveLength(2))
  })

  it('queries the firewall rule for the current port on mount', async () => {
    render(<RemoteSettings />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_firewall_status', { port: 42811 }))
    // A read-only status query must never escalate on its own.
    expect(commands()).not.toContain('remote_setup_firewall')
  })

  it('installs the port rule before enabling LAN access', async () => {
    const localOnly = { ...status, lanEnabled: false, hosts: ['127.0.0.1'] }
    let ruleInstalled = false
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'remote_get_status') return localOnly
      if (command === 'remote_firewall_status') return ruleInstalled
      if (command === 'remote_setup_firewall') { ruleInstalled = true; return true }
      if (command === 'remote_set_lan_enabled' && args?.lanEnabled === true) return status
      return localOnly
    })
    render(<RemoteSettings />)
    const pair = await screen.findByRole('button', { name: 'QR 생성' })
    expect(pair).toBeDisabled()
    fireEvent.click(screen.getByRole('switch', { name: 'LAN / VPN' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_set_lan_enabled', { lanEnabled: true }))
    expect(invoke).toHaveBeenCalledWith('remote_setup_firewall', { port: 42811 })
    // The rule must exist before the native call that opens a LAN socket.
    expect(indexOf('remote_setup_firewall')).toBeLessThan(indexOf('remote_set_lan_enabled'))
  })

  it('does not enable LAN access when firewall setup is cancelled', async () => {
    const localOnly = { ...status, lanEnabled: false, hosts: ['127.0.0.1'] }
    invoke.mockImplementation(async (command: string) => {
      if (command === 'remote_get_status') return localOnly
      if (command === 'remote_firewall_status') return false
      if (command === 'remote_setup_firewall') throw new Error('관리자 승인이 필요합니다.')
      return localOnly
    })
    render(<RemoteSettings />)
    await screen.findByRole('switch', { name: 'LAN / VPN' })
    fireEvent.click(screen.getByRole('switch', { name: 'LAN / VPN' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_setup_firewall', { port: 42811 }))
    expect(await screen.findByText(/관리자 승인이 필요합니다/)).toBeInTheDocument()
    expect(commands()).not.toContain('remote_set_lan_enabled')
  })

  it('does not enable LAN access when the rule is reported missing after setup', async () => {
    const localOnly = { ...status, lanEnabled: false, hosts: ['127.0.0.1'] }
    invoke.mockImplementation(async (command: string) => {
      if (command === 'remote_get_status') return localOnly
      if (command === 'remote_firewall_status') return false
      if (command === 'remote_setup_firewall') return false
      return localOnly
    })
    render(<RemoteSettings />)
    await screen.findByRole('switch', { name: 'LAN / VPN' })
    fireEvent.click(screen.getByRole('switch', { name: 'LAN / VPN' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_setup_firewall', { port: 42811 }))
    expect(await screen.findByText(/LAN 접속을 시작하지 않았습니다/)).toBeInTheDocument()
    expect(commands()).not.toContain('remote_set_lan_enabled')
  })

  it('installs the rule before starting a stopped LAN server', async () => {
    const stopped = { ...status, enabled: true, running: false }
    let ruleInstalled = false
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'remote_get_status') return stopped
      if (command === 'remote_firewall_status') return ruleInstalled
      if (command === 'remote_setup_firewall') { ruleInstalled = true; return true }
      if (command === 'remote_set_enabled' && args?.enabled === true) return status
      return stopped
    })
    render(<RemoteSettings />)
    expect(await screen.findByText('stopped')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: '원격 서버' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_set_enabled', { enabled: true }))
    expect(invoke).toHaveBeenCalledWith('remote_setup_firewall', { port: 42811 })
    expect(indexOf('remote_setup_firewall')).toBeLessThan(indexOf('remote_set_enabled'))
  })

  it('never requests elevation when disabling LAN access or the server', async () => {
    render(<RemoteSettings />)
    await screen.findByRole('switch', { name: 'LAN / VPN' })
    fireEvent.click(screen.getByRole('switch', { name: 'LAN / VPN' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_set_lan_enabled', { lanEnabled: false }))
    fireEvent.click(screen.getByRole('switch', { name: '원격 서버' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_set_enabled', { enabled: false }))
    expect(commands()).not.toContain('remote_setup_firewall')
  })

  it('auto-starts a stopped server behind the rule check before creating the pairing QR', async () => {
    const stopped = { ...status, enabled: false, running: false }
    let ruleInstalled = false
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'remote_get_status') return stopped
      if (command === 'remote_firewall_status') return ruleInstalled
      if (command === 'remote_setup_firewall') { ruleInstalled = true; return true }
      if (command === 'remote_set_enabled' && args?.enabled === true) return status
      if (command === 'remote_create_pairing_v2') return { code: '87654321', expiresAt: Math.floor(Date.now() / 1000) + 300, qrPayload: '{}' }
      return stopped
    })
    render(<RemoteSettings />)
    expect(await screen.findByText('stopped')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'QR 생성' }))
    expect(await screen.findByText('87654321')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('remote_set_enabled', { enabled: true })
    expect(invoke).toHaveBeenCalledWith('remote_create_pairing_v2')
    expect(indexOf('remote_setup_firewall')).toBeLessThan(indexOf('remote_set_enabled'))
    expect(indexOf('remote_set_enabled')).toBeLessThan(indexOf('remote_create_pairing_v2'))
  })

  it('does not auto-start the server for a QR when firewall setup is cancelled', async () => {
    const stopped = { ...status, enabled: false, running: false }
    invoke.mockImplementation(async (command: string) => {
      if (command === 'remote_get_status') return stopped
      if (command === 'remote_firewall_status') return false
      if (command === 'remote_setup_firewall') throw new Error('관리자 승인이 필요합니다.')
      return stopped
    })
    render(<RemoteSettings />)
    expect(await screen.findByText('stopped')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'QR 생성' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_setup_firewall', { port: 42811 }))
    expect(commands()).not.toContain('remote_set_enabled')
    expect(commands()).not.toContain('remote_create_pairing_v2')
  })

  it('installs a rule for the requested port before restarting a LAN server on it', async () => {
    const moved = { ...status, port: 42999 }
    let ruleInstalled = false
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'remote_get_status') return status
      if (command === 'remote_firewall_status') return args?.port === 42999 ? ruleInstalled : true
      if (command === 'remote_setup_firewall') { ruleInstalled = true; return true }
      if (command === 'remote_set_port') return moved
      return status
    })
    render(<RemoteSettings />)
    const input = await screen.findByLabelText('Remote port')
    fireEvent.change(input, { target: { value: '42999' } })
    fireEvent.click(screen.getByRole('button', { name: '적용' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_set_port', { port: 42999 }))
    // The NEW port is the one that gets bound, so it is the one that needs a rule.
    expect(invoke).toHaveBeenCalledWith('remote_setup_firewall', { port: 42999 })
    expect(indexOf('remote_setup_firewall')).toBeLessThan(indexOf('remote_set_port'))
  })

  it('does not apply a new LAN port when firewall setup is cancelled', async () => {
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'remote_get_status') return status
      if (command === 'remote_firewall_status') return args?.port !== 42999
      if (command === 'remote_setup_firewall') throw new Error('관리자 승인이 필요합니다.')
      return status
    })
    render(<RemoteSettings />)
    const input = await screen.findByLabelText('Remote port')
    fireEvent.change(input, { target: { value: '42999' } })
    fireEvent.click(screen.getByRole('button', { name: '적용' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_setup_firewall', { port: 42999 }))
    expect(commands()).not.toContain('remote_set_port')
  })

  it('changes a local-only port without touching the firewall', async () => {
    const localOnly = { ...status, lanEnabled: false, hosts: ['127.0.0.1'] }
    invoke.mockImplementation(async (command: string) => {
      if (command === 'remote_get_status') return localOnly
      if (command === 'remote_firewall_status') return false
      if (command === 'remote_set_port') return { ...localOnly, port: 42999 }
      return localOnly
    })
    render(<RemoteSettings />)
    const input = await screen.findByLabelText('Remote port')
    fireEvent.change(input, { target: { value: '42999' } })
    fireEvent.click(screen.getByRole('button', { name: '적용' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_set_port', { port: 42999 }))
    expect(commands()).not.toContain('remote_setup_firewall')
  })

  it('offers one-click firewall setup for the current port when the rule is missing', async () => {
    let ruleInstalled = false
    invoke.mockImplementation(async (command: string) => {
      if (command === 'remote_get_status') return status
      if (command === 'remote_firewall_status') return ruleInstalled
      if (command === 'remote_setup_firewall') { ruleInstalled = true; return true }
      return status
    })
    render(<RemoteSettings />)
    const setup = await screen.findByRole('button', { name: '방화벽 설정' })
    fireEvent.click(setup)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_setup_firewall', { port: 42811 }))
    expect(await screen.findByText('설정됨 · 42811')).toBeInTheDocument()
  })

  it('keeps the rule warning tied to the port actually in use', async () => {
    const moved = { ...status, port: 42999 }
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'remote_get_status') return status
      // Only the original port carries a rule; the new one does not.
      if (command === 'remote_firewall_status') return args?.port === 42811
      if (command === 'remote_setup_firewall') return true
      if (command === 'remote_set_port') return moved
      return status
    })
    render(<RemoteSettings />)
    expect(await screen.findByText('설정됨 · 42811')).toBeInTheDocument()
    const input = screen.getByLabelText('Remote port')
    fireEvent.change(input, { target: { value: '42999' } })
    fireEvent.click(screen.getByRole('button', { name: '적용' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_set_port', { port: 42999 }))
    expect(await screen.findByText('설정됨 · 42999')).toBeInTheDocument()
  })

  it('rejects a privileged port before any native call', async () => {
    render(<RemoteSettings />)
    const input = await screen.findByLabelText('Remote port')
    fireEvent.change(input, { target: { value: '80' } })
    fireEvent.click(screen.getByRole('button', { name: '적용' }))
    expect(await screen.findByText(/1024–65535/)).toBeInTheDocument()
    expect(commands()).not.toContain('remote_setup_firewall')
    expect(commands()).not.toContain('remote_set_port')
  })

  it('requires explicit LAN opt in before pairing', async () => {
    const localOnly = { ...status, lanEnabled: false, hosts: ['127.0.0.1'] }
    invoke.mockImplementation(async (command: string) => {
      if (command === 'remote_get_status') return localOnly
      if (command === 'remote_firewall_status') return false
      return localOnly
    })
    render(<RemoteSettings />)
    const pair = await screen.findByRole('button', { name: 'QR 생성' })
    expect(pair).toBeDisabled()
    expect(screen.getByRole('button', { name: '레거시 v1' })).toBeDisabled()
  })
})
