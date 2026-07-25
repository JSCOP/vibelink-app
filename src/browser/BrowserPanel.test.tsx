// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserPanel } from './BrowserPanel'
import { activeSurfaceVisible, browserPanelReducer, createBrowserPanelState } from './state'
import type { BrowserAnnotation, BrowserContentController, BrowserContentState, BrowserDesignGrab, BrowserPage, PhysicalBounds } from './types'

const page: BrowserPage = {
  id: 'page-a',
  workspaceId: 'workspace-a',
  profileId: 'profile-a',
  title: 'Example',
  url: 'https://example.com',
  navigationGeneration: 2,
  loadState: 'loaded',
  canGoBack: true,
  canGoForward: false,
  requestedVisible: true,
  effectiveVisible: false,
  error: null,
  deviceMetrics: null,
}

const annotation: BrowserAnnotation = {
  id: 'annotation-a',
  workspaceId: 'workspace-a',
  pageId: page.id,
  navigationGeneration: page.navigationGeneration,
  url: page.url,
  browserRef: 'button#save',
  accessibleName: 'Save',
  domAncestry: ['html', 'body', 'button#save'],
  bounds: { x: 1, y: 2, width: 100, height: 30, scaleFactorMilli: 1000 },
  text: 'Save',
  attributes: [['id', 'save']],
  computedStyles: [['display', 'block']],
  sourceHints: ['src/App.tsx'],
  comment: '',
  screenshot: null,
}

function state(): BrowserContentState {
  return {
    profile: { id: 'profile-a', kind: 'workspace', workspaceId: 'workspace-a', cookieImportQuarantined: false },
    page,
    addressDraft: page.url,
    designMode: false,
    annotation: null,
    annotationComment: '',
    modalDepth: 0,
    surfaceBounds: null,
    permissionQueue: [],
    certificateQueue: [],
    dialogQueue: [],
    downloads: [],
    lastLifecycleEvent: null,
  }
}

class RecordingController implements BrowserContentController {
  surfaces: Array<{ pageId: string; bounds: PhysicalBounds | null; visible: boolean; focused: boolean }> = []
  designHandler: ((grab: BrowserDesignGrab) => void) | null = null
  async navigate(_pageId: string, input: string) { return { url: input, navigationGeneration: 3 } }
  async goBack() {}
  async goForward() {}
  async reload() {}
  async setSurfaceState(pageId: string, value: { bounds: PhysicalBounds | null; visible: boolean; focused: boolean }) { this.surfaces.push({ pageId, ...value }) }
  async setDesignMode() {}
  async setDeviceMetrics() { return page }
  async resolvePermission() {}
  async resolveCertificate() {}
  async resolveDialog() {}
  async createAnnotation() { return annotation }
  async detectCookieImportSource(endpoint: string) { return { endpoint, browser: 'chrome' as const, origins: ['https://example.com'] } }
  async importCookies() { return { importedCount: 1, originCount: 1, verified: true, rolledBack: false, quarantined: false } }
  async subscribeDesignGrabs(handler: (grab: BrowserDesignGrab) => void) { this.designHandler = handler; return () => { this.designHandler = null } }
}

afterEach(() => cleanup())

describe('browser content state', () => {
  it('invalidates an exact annotation when navigation advances', () => {
    let current = createBrowserPanelState({ ...state(), annotation })
    current = browserPanelReducer(current, { type: 'navigationStarted', input: 'https://next.example', generation: 3 })
    expect(current.annotation).toBeNull()
    expect(current.page.navigationGeneration).toBe(3)
    current = browserPanelReducer(current, { type: 'annotationCreated', annotation })
    expect(current.annotation).toBeNull()
  })

  it('uses modal depth only for the content-local native surface gate', () => {
    expect(activeSurfaceVisible(state())).toBe(true)
    expect(activeSurfaceVisible({ ...state(), modalDepth: 1 })).toBe(false)
  })
})

describe('BrowserPanel', () => {
  it('renders one native page with no internal browser tab strip or capture counter', async () => {
    const controller = new RecordingController()
    const { container } = render(<BrowserPanel controller={controller} initialState={state()} active focused workspaceVisible />)
    expect(container.querySelector('.browser-tabs')).toBeNull()
    expect(screen.queryByLabelText('New browser tab')).toBeNull()
    expect(screen.queryByLabelText('Browser capture state')).toBeNull()
    expect(screen.getByText('Workspace')).toBeInTheDocument()
    await waitFor(() => expect(controller.surfaces.some((surface) => surface.pageId === page.id)).toBe(true))
  })

  it('routes annotations to the explicit Agent and exact live pane destinations', async () => {
    const controller = new RecordingController()
    const deliver = vi.fn(async () => undefined)
    render(
      <BrowserPanel
        controller={controller}
        initialState={{ ...state(), annotation }}
        active
        focused
        workspaceVisible
        liveAgentPanes={[{ paneId: 'pane-codex', title: 'Codex', role: 'Reviewer' }]}
        onDeliverAnnotation={deliver}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'VibeLink Agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
    await waitFor(() => expect(deliver).toHaveBeenNthCalledWith(1, annotation, { kind: 'agent' }))
    expect(deliver).toHaveBeenNthCalledWith(2, annotation, { kind: 'terminal', paneId: 'pane-codex', title: 'Codex', role: 'Reviewer' })
  })

  it('calls a stable onTitleChange only when the title actually changes, never every render', async () => {
    const controller = new RecordingController()
    // A stable callback (the real fix keeps this identity constant). Re-rendering
    // with unchanged props must NOT re-invoke it — an unstable callback here was
    // what drove updateParameters → re-render → infinite "Maximum update depth".
    const onTitleChange = vi.fn()
    const { rerender } = render(<BrowserPanel controller={controller} initialState={state()} active focused workspaceVisible onTitleChange={onTitleChange} />)
    await waitFor(() => expect(onTitleChange).toHaveBeenCalledWith('Example'))
    const callsAfterMount = onTitleChange.mock.calls.length
    rerender(<BrowserPanel controller={controller} initialState={state()} active focused workspaceVisible onTitleChange={onTitleChange} />)
    rerender(<BrowserPanel controller={controller} initialState={state()} active={false} focused workspaceVisible onTitleChange={onTitleChange} />)
    // Title never changed across re-renders, so no additional invocations.
    expect(onTitleChange.mock.calls.length).toBe(callsAfterMount)
  })

  it('waits for the Dockview overlay to settle before publishing the native surface', async () => {
    // Dockview re-shows a hidden content panel by unhiding/repositioning its
    // render overlay over the FOLLOWING frames. Until that settles,
    // `measureSurface` correctly refuses to measure and returns null. A
    // fixed-length activation burst could therefore spend every frame on a
    // still-hidden overlay and give up, leaving the native child hidden behind
    // this panel's opaque host — a loaded page the user only saw as blank.
    //
    // Model exactly that: unmeasurable for more frames than the old burst had,
    // then measurable.
    const rect = { x: 300, y: 100, width: 800, height: 600, top: 100, left: 300, right: 1100, bottom: 700 }
    const settleAfterCalls = 40
    let calls = 0
    const measure = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => {
      calls += 1
      const settled = calls > settleAfterCalls
      const value = settled ? rect : { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }
      return { ...value, toJSON: () => value } as DOMRect
    })
    const clientRects = vi.spyOn(Element.prototype, 'getClientRects')
      .mockReturnValue({ length: 1 } as unknown as DOMRectList)
    try {
      const controller = new RecordingController()
      const props = { controller, initialState: state(), focused: true, workspaceVisible: true }
      render(<BrowserPanel {...props} active />)
      // `measureSurface` clips to the viewport, so assert on a real positive
      // surface rather than the raw mock width.
      await waitFor(
        () => expect(controller.surfaces.some((surface) => surface.visible && (surface.bounds?.width ?? 0) > 0)).toBe(true),
        { timeout: 4000 },
      )
    } finally {
      measure.mockRestore()
      clientRects.mockRestore()
    }
  })
})
