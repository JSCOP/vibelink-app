// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserPanel } from './BrowserPanel'
import { activeSurfaceVisible, browserPanelReducer, createBrowserPanelState } from './state'
import type { BrowserDeviceMetrics, BrowserPanelController, BrowserPanelState, BrowserProfile, BrowserTab, PhysicalBounds } from './types'

const alpha: BrowserTab = {
  id: 'page-alpha',
  profileId: 'profile-a',
  title: 'Alpha',
  url: 'https://alpha.test',
  navigationGeneration: 1,
  loadState: 'loaded',
  canGoBack: false,
  canGoForward: false,
  requestedVisible: true,
  effectiveVisible: true,
  error: null,
  deviceMetrics: null,
  droppedFrameCount: 0,
  latestFrameSequence: null,
}

const beta: BrowserTab = {
  ...alpha,
  id: 'page-beta',
  title: 'Beta',
  url: 'https://beta.test',
  navigationGeneration: 2,
  canGoBack: true,
}

class RecordingController implements BrowserPanelController {
  readonly selected: string[] = []
  readonly closed: string[] = []
  readonly navigations: Array<{ pageId: string; input: string }> = []
  readonly surfaces: Array<{ pageId: string; bounds: PhysicalBounds | null; visible: boolean }> = []
  readonly designModes: Array<{ pageId: string; enabled: boolean }> = []
  readonly profiles: BrowserProfile[] = []
  readonly deviceMetrics: Array<{ pageId: string; metrics: BrowserDeviceMetrics | null }> = []
  readonly resolvedPermissions: string[] = []
  readonly resolvedCertificates: string[] = []
  readonly resolvedDialogs: Array<{ requestId: string; accept: boolean }> = []
  readonly captures: string[] = []

  async createTab(profileId: string): Promise<BrowserTab> {
    return { ...alpha, id: 'page-new', profileId, title: 'New Tab', url: 'about:blank', navigationGeneration: 0 }
  }

  async createProfile(kind: BrowserProfile['kind']): Promise<BrowserProfile> {
    const profile = { id: 'private-profile', kind, workspaceId: 'workspace-a' }
    this.profiles.push(profile)
    return profile
  }

  async closeTab(pageId: string): Promise<void> {
    this.closed.push(pageId)
  }

  async selectTab(pageId: string): Promise<void> {
    this.selected.push(pageId)
  }

  async navigate(pageId: string, input: string): Promise<{ url: string; navigationGeneration: number }> {
    this.navigations.push({ pageId, input })
    return { url: 'https://normalized.test/path', navigationGeneration: 3 }
  }

  async goBack(): Promise<void> {}
  async goForward(): Promise<void> {}
  async reload(): Promise<void> {}

  async setSurfaceState(pageId: string, state: { bounds: PhysicalBounds | null; visible: boolean }): Promise<void> {
    this.surfaces.push({ pageId, ...state })
  }

  async setDesignMode(pageId: string, enabled: boolean): Promise<void> {
    this.designModes.push({ pageId, enabled })
  }

  async setDeviceMetrics(pageId: string, metrics: BrowserDeviceMetrics | null): Promise<BrowserTab> {
    this.deviceMetrics.push({ pageId, metrics })
    return { ...alpha, id: pageId, deviceMetrics: metrics }
  }

  async getCaptureState(pageId: string) {
    return { pageId, pendingFrames: 1, droppedFrames: 2, latestSequence: 7, latestBytes: 128 }
  }

  async captureFrame(pageId: string) {
    this.captures.push(pageId)
    return { pageId, pendingFrames: 1, droppedFrames: 2, latestSequence: 8, latestBytes: 256 }
  }

  async resolvePermission(requestId: string): Promise<void> {
    this.resolvedPermissions.push(requestId)
  }

  async resolveCertificate(requestId: string): Promise<void> {
    this.resolvedCertificates.push(requestId)
  }

  async resolveDialog(requestId: string, accept: boolean): Promise<void> {
    this.resolvedDialogs.push({ requestId, accept })
  }
}

function initialState(): Partial<BrowserPanelState> {
  return {
    profiles: [{ id: 'profile-a', kind: 'persistent', workspaceId: null }],
    tabs: [alpha, beta],
    activePageId: alpha.id,
  }
}

afterEach(() => cleanup())

describe('browser panel state', () => {
  it('rejects stale navigation events and suppresses native surfaces under modal chrome', () => {
    let state = createBrowserPanelState(initialState())
    state = browserPanelReducer(state, { type: 'navigationStarted', pageId: alpha.id, input: 'example.test', generation: 2 })
    state = browserPanelReducer(state, {
      type: 'navigationCommitted',
      pageId: alpha.id,
      url: 'https://example.test',
      generation: 1,
    })
    expect(state.tabs[0]).toMatchObject({ url: 'example.test', navigationGeneration: 2, loadState: 'loading' })
    state = browserPanelReducer(state, { type: 'navigationStarted', pageId: alpha.id, input: 'stale.test', generation: 1 })
    expect(state.addressDraft).toBe('example.test')

    state = browserPanelReducer(state, { type: 'modalOpened' })
    expect(activeSurfaceVisible(state)).toBe(false)
    state = browserPanelReducer(state, { type: 'modalClosed' })
    expect(activeSurfaceVisible(state)).toBe(true)
    state = browserPanelReducer(state, {
      type: 'permissionQueued',
      request: { id: 'permission-1', pageId: alpha.id, origin: alpha.url, permission: 'camera' },
    })
    expect(activeSurfaceVisible(state)).toBe(false)
  })

  it('selects the nearest surviving tab and ignores design grabs for inactive pages', () => {
    let state = createBrowserPanelState(initialState())
    state = browserPanelReducer(state, { type: 'tabSelected', pageId: beta.id })
    state = browserPanelReducer(state, { type: 'tabClosed', pageId: beta.id })
    expect(state.activePageId).toBe(alpha.id)
    expect(state.addressDraft).toBe(alpha.url)

    state = browserPanelReducer(state, {
      type: 'designGrabbed',
      selection: {
        pageId: 'other-page',
        navigationGeneration: 1,
        snapshotId: 'snapshot-1',
        browserRef: 'ref-1',
        screenshotCrop: null,
        domAncestry: ['html', 'button'],
        accessibleName: 'Save',
        bounds: { x: 0, y: 0, width: 100, height: 30, scaleFactorMilli: 1000 },
        computedStyles: [],
        attributes: [],
        text: 'Save',
        sourceHints: [],
      },
    })
    expect(state.designSelection).toBeNull()
  })
})

describe('BrowserPanel', () => {
  it('projects tab selection, navigation, creation, closure, and design-mode transitions', async () => {
    const controller = new RecordingController()
    let latest = createBrowserPanelState(initialState())
    render(<BrowserPanel controller={controller} initialState={initialState()} onStateChange={(state) => { latest = state }} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Beta' }))
    await waitFor(() => expect(controller.selected).toEqual(['page-beta']))
    await waitFor(() => expect(screen.getByLabelText('Address or search')).toHaveValue('https://beta.test'))

    const address = screen.getByLabelText('Address or search')
    fireEvent.change(address, { target: { value: 'normalized.test/path' } })
    fireEvent.submit(address.closest('form')!)
    await waitFor(() => expect(controller.navigations).toEqual([{ pageId: 'page-beta', input: 'normalized.test/path' }]))
    await waitFor(() => expect(screen.getByLabelText('Address or search')).toHaveValue('https://normalized.test/path'))
    expect(latest.tabs.find((tab) => tab.id === 'page-beta')).toMatchObject({
      navigationGeneration: 3,
      loadState: 'loaded',
      error: null,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Pick element' }))
    await waitFor(() => expect(controller.designModes).toEqual([{ pageId: 'page-beta', enabled: true }]))
    expect(screen.getByRole('button', { name: 'Picking…' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'New browser tab' }))
    expect(await screen.findByRole('tab', { name: 'New Tab' })).toBeInTheDocument()
    expect(latest.activePageId).toBe('page-new')

    fireEvent.click(screen.getByRole('button', { name: 'Close New Tab' }))
    await waitFor(() => expect(controller.closed).toEqual(['page-new']))
    await waitFor(() => expect(latest.activePageId).toBe('page-beta'))
    expect(screen.getByLabelText('Address or search')).toHaveValue('https://normalized.test/path')
  })

  it('opens a detected project preview and sends a selected element to Agent', async () => {
    const controller = new RecordingController()
    const onSendSelectionToAgent = vi.fn()
    const selection = {
      pageId: alpha.id,
      navigationGeneration: 1,
      snapshotId: 'design-1',
      browserRef: 'button#save',
      screenshotCrop: null,
      domAncestry: ['html', 'body', 'button#save'],
      accessibleName: 'Save',
      bounds: { x: 10, y: 20, width: 80, height: 32, scaleFactorMilli: 1000 },
      computedStyles: [['color', 'rgb(255, 255, 255)']] as Array<[string, string]>,
      attributes: [['id', 'save']] as Array<[string, string]>,
      text: 'Save',
      sourceHints: ['src/App.tsx'],
    }
    render(
      <BrowserPanel
        controller={controller}
        initialState={{ ...initialState(), designSelection: selection }}
        projectTargets={[{ label: 'Vite', url: 'http://localhost:5173', port: 5173, running: true, source: 'vite.config', startCommand: 'pnpm run dev' }]}
        onSendSelectionToAgent={onSendSelectionToAgent}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open live' }))
    await waitFor(() => expect(controller.navigations).toEqual([{ pageId: alpha.id, input: 'http://localhost:5173' }]))
    fireEvent.click(screen.getByRole('button', { name: 'Add to Agent' }))
    expect(onSendSelectionToAgent).toHaveBeenCalledWith(selection, 'http://localhost:5173')
  })

  it('offers an explicit project dev-server start action when preview is offline', () => {
    const controller = new RecordingController()
    const onStartProject = vi.fn()
    const target = { label: 'Vite', url: 'http://localhost:5173', port: 5173, running: false, source: 'vite.config', startCommand: 'pnpm run dev' }
    render(<BrowserPanel controller={controller} initialState={initialState()} projectTargets={[target]} onStartProject={onStartProject} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start server' }))
    expect(onStartProject).toHaveBeenCalledWith(target)
  })

  it('controls profiles, device emulation, prompts, downloads, and capture state', async () => {
    const controller = new RecordingController()
    render(<BrowserPanel controller={controller} initialState={{
      ...initialState(),
      permissionQueue: [{ id: 'permission-1', pageId: alpha.id, origin: alpha.url, permission: 'camera' }],
      certificateQueue: [{ id: 'certificate-1', pageId: alpha.id, origin: alpha.url, errorCode: 'CERT_DATE_INVALID' }],
      dialogQueue: [{ id: 'dialog-1', pageId: alpha.id, origin: alpha.url, kind: 'confirm', message: 'Continue?', defaultText: null }],
      downloads: [{ id: 'download-1', pageId: alpha.id, url: `${alpha.url}/file`, path: 'C:/safe/file.zip', success: true, error: null, updatedAtMs: 1 }],
    }} />)

    expect(await screen.findByText('1 queued · 2 dropped')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }))
    await waitFor(() => expect(controller.captures).toEqual([alpha.id]))
    expect(screen.getByLabelText('Browser security prompts')).toBeInTheDocument()
    expect(screen.getByLabelText('Browser page Alpha')).toHaveAttribute('data-native-surface-visible', 'false')
    expect(screen.getByText(/C:\/safe\/file\.zip/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Device mode'), { target: { value: 'mobile' } })
    await waitFor(() => expect(controller.deviceMetrics).toEqual([{
      pageId: alpha.id,
      metrics: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
    }]))

    fireEvent.click(screen.getByRole('button', { name: 'Private' }))
    await waitFor(() => expect(controller.profiles).toHaveLength(1))
    expect(screen.getByLabelText('Browser profile')).toHaveValue('private-profile')

    fireEvent.click(screen.getAllByRole('button', { name: 'Deny' })[0])
    fireEvent.click(screen.getAllByRole('button', { name: 'Deny' })[1])
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(controller.resolvedPermissions).toEqual(['permission-1']))
    await waitFor(() => expect(controller.resolvedCertificates).toEqual(['certificate-1']))
    await waitFor(() => expect(controller.resolvedDialogs).toEqual([{ requestId: 'dialog-1', accept: true }]))
  })
})
