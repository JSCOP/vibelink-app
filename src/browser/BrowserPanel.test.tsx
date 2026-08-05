// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { BrowserPanel } from './BrowserPanel'
import { formatBrowserAnnotation } from './agentContext'
import { activeSurfaceVisible, browserPanelReducer, createBrowserPanelState } from './state'
import type { BrowserAnnotation, BrowserContentController, BrowserContentState, BrowserDesignGrab, BrowserLifecycleEvent, BrowserPage, PhysicalBounds } from './types'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))

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
  tagName: 'button',
  selector: '#save',
  fullPath: 'html > body > button#save',
  role: 'button',
  reactComponents: '<App> <SaveButton>',
  htmlSnippet: '<button id="save">Save</button>',
  accessibleName: 'Save',
  nearbyText: ['Edit', 'Cancel'],
  ancestorPath: ['body', 'html'],
  bounds: { x: 1, y: 2, width: 100, height: 30, scaleFactorMilli: 1000 },
  text: 'Save',
  attributes: [['id', 'save']],
  computedStyles: [['display', 'block']],
  sourceHints: ['src/App.tsx'],
  comment: '',
  screenshot: null,
}

const designGrab: BrowserDesignGrab = {
  pageId: page.id,
  navigationGeneration: page.navigationGeneration,
  browserRef: annotation.browserRef,
  tagName: annotation.tagName,
  selector: annotation.selector,
  fullPath: annotation.fullPath,
  role: annotation.role,
  reactComponents: annotation.reactComponents,
  htmlSnippet: annotation.htmlSnippet,
  accessibleName: annotation.accessibleName,
  nearbyText: annotation.nearbyText,
  ancestorPath: annotation.ancestorPath,
  bounds: annotation.bounds,
  text: annotation.text,
  attributes: annotation.attributes,
  computedStyles: annotation.computedStyles,
  sourceHints: annotation.sourceHints,
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
  lifecycleHandler: ((event: BrowserLifecycleEvent) => void) | null = null
  navigations: string[] = []
  designModes: boolean[] = []
  captureCalls: Array<{ pageId: string; dir: string }> = []
  devToolsPages: string[] = []
  externalUrls: string[] = []
  async navigate(_pageId: string, input: string) { this.navigations.push(input); return { url: input, navigationGeneration: 3 } }
  async goBack() {}
  async goForward() {}
  async reload() {}
  async setSurfaceState(pageId: string, value: { bounds: PhysicalBounds | null; visible: boolean; focused: boolean }) { this.surfaces.push({ pageId, ...value }) }
  async setDesignMode(_pageId: string, enabled: boolean) { this.designModes.push(enabled) }
  async setDeviceMetrics() { return page }
  async capturePageImage(pageId: string, dir: string) { this.captureCalls.push({ pageId, dir }); return 'C:/captures/Images/browser.png' }
  async openDevTools(pageId: string) { this.devToolsPages.push(pageId) }
  async openExternal(url: string) { this.externalUrls.push(url) }
  async resolvePermission() {}
  async resolveCertificate() {}
  async resolveDialog() {}
  async createAnnotation() { return annotation }
  async detectCookieImportSource(endpoint: string) { return { endpoint, browser: 'chrome' as const, origins: ['https://example.com'] } }
  async importCookies() { return { importedCount: 1, originCount: 1, verified: true, rolledBack: false, quarantined: false } }
  async subscribeDesignGrabs(handler: (grab: BrowserDesignGrab) => void) { this.designHandler = handler; return () => { this.designHandler = null } }
  async subscribeLifecycle(handler: (event: BrowserLifecycleEvent) => void) { this.lifecycleHandler = handler; return () => { this.lifecycleHandler = null } }
}

beforeEach(() => {
  vi.mocked(invoke).mockClear()
  window.localStorage.removeItem('vibelink.browser.importHintHidden')
})
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

  it('defaults element grabs to copy intent and switches intent explicitly', () => {
    let current = createBrowserPanelState(state())
    expect(current.grabIntent).toBe('copy')
    current = browserPanelReducer(current, { type: 'grabIntentChanged', intent: 'annotate' })
    expect(current.grabIntent).toBe('annotate')
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

  it('renders Orca toolbar controls in the required order', () => {
    const controller = new RecordingController()
    const { container } = render(<BrowserPanel controller={controller} initialState={state()} active focused workspaceVisible />)
    const toolbar = container.querySelector('.browser-toolbar')
    const controls = [...(toolbar?.children ?? [])]
      .filter((element) => element.matches('button, .browser-address-shell, .browser-overflow'))
      .map((element) => element.getAttribute('aria-label') ?? (element.classList.contains('browser-address-shell') ? 'Address' : element.querySelector('button')?.getAttribute('aria-label')))
    expect(controls).toEqual([
      'Back',
      'Forward',
      'Reload',
      'Address',
      'Import browser data',
      'Grab page element',
      'Annotate page element',
      'Draw on screenshot',
      'Open browser devtools',
      'Open in default browser',
      'Browser page options',
    ])
  })

  it('copies grab intent immediately but leaves annotate intent editable', async () => {
    const controller = new RecordingController()
    render(<BrowserPanel controller={controller} initialState={state()} active focused workspaceVisible />)
    await waitFor(() => expect(controller.designHandler).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Grab page element' }))
    await waitFor(() => expect(controller.designModes).toContain(true))
    controller.designHandler?.(designGrab)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('clipboard_write_text', { text: formatBrowserAnnotation(annotation) }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Grab page element' })).toHaveAttribute('aria-pressed', 'false'))

    // Annotate intent must NOT copy on its own: the page emits no comment, so
    // the aside is where the user writes one before it reaches the clipboard.
    fireEvent.click(screen.getByRole('button', { name: 'Annotate page element' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Annotate page element' })).toHaveAttribute('aria-pressed', 'true'))
    await waitFor(() => expect(controller.designHandler).not.toBeNull())
    vi.mocked(invoke).mockClear()
    controller.designHandler?.(designGrab)

    const comment = await screen.findByLabelText('Annotation comment')
    expect(comment).toHaveValue('')
    expect(invoke).not.toHaveBeenCalledWith('clipboard_write_text', expect.anything())

    fireEvent.change(comment, { target: { value: 'Needs spacing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('clipboard_write_text', {
      text: formatBrowserAnnotation({ ...annotation, comment: 'Needs spacing' }),
    }))
  })

  it('disarms design mode on Escape and when the pane loses focus', async () => {
    const controller = new RecordingController()
    const props = { controller, initialState: state(), active: true, workspaceVisible: true }
    const { rerender } = render(<BrowserPanel {...props} focused />)
    const grabButton = screen.getByRole('button', { name: 'Grab page element' })
    fireEvent.click(grabButton)
    await waitFor(() => expect(grabButton).toHaveAttribute('aria-pressed', 'true'))
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(grabButton).toHaveAttribute('aria-pressed', 'false'))

    fireEvent.click(grabButton)
    await waitFor(() => expect(grabButton).toHaveAttribute('aria-pressed', 'true'))
    rerender(<BrowserPanel {...props} focused={false} />)
    await waitFor(() => expect(grabButton).toHaveAttribute('aria-pressed', 'false'))
  })

  it('opens native toolbar actions and the existing screenshot annotator', async () => {
    const controller = new RecordingController()
    render(<BrowserPanel controller={controller} initialState={state()} captureDir="C:/captures" active focused workspaceVisible />)
    fireEvent.click(screen.getByRole('button', { name: 'Open browser devtools' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open in default browser' }))
    fireEvent.click(screen.getByRole('button', { name: 'Draw on screenshot' }))
    await waitFor(() => expect(controller.devToolsPages).toEqual([page.id]))
    expect(controller.externalUrls).toEqual([page.url])
    expect(controller.captureCalls).toEqual([{ pageId: page.id, dir: 'C:/captures' }])
    expect(await screen.findByRole('dialog', { name: 'Mark up capture' })).toBeInTheDocument()
  })

  it('hides and persists the import hint after a verified import', async () => {
    const controller = new RecordingController()
    render(<BrowserPanel controller={controller} initialState={state()} active focused workspaceVisible />)
    fireEvent.click(screen.getByRole('button', { name: 'Import browser data' }))
    fireEvent.click(screen.getByRole('button', { name: 'Detect' }))
    const origin = await screen.findByLabelText('https://example.com')
    fireEvent.click(origin)
    fireEvent.click(screen.getByLabelText(/I consent to importing cookies/))
    fireEvent.click(screen.getByRole('button', { name: 'Import and verify' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Import browser data' })).toBeNull())
    expect(JSON.parse(window.localStorage.getItem('vibelink.browser.importHintHidden') ?? '[]')).toContain('profile-a')
  })

  it('copies an annotation to the OS clipboard instead of pushing it at an agent', async () => {
    const controller = new RecordingController()
    render(<BrowserPanel controller={controller} initialState={{ ...state(), annotation }} active focused workspaceVisible />)
    // Only a clipboard action exists now; the old agent/pane destinations are gone.
    expect(screen.queryByRole('button', { name: 'VibeLink Agent' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    // Copy MUST go through the native command: the guest WebView2 owns the OS
    // focus, so `navigator.clipboard` would throw "Document is not focused".
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('clipboard_write_text', { text: formatBrowserAnnotation(annotation) }))
    expect(await screen.findByText('Annotation copied to the clipboard.')).toBeInTheDocument()
  })

  it('adopts a blocked target="_blank" popup into this pane instead of dropping the click', async () => {
    // Real sites (naver.com's 메일/카페/뉴스 shortcuts) are ordinary
    // `target="_blank"` links. WebView2 denies every popup, so without this the
    // buttons were completely dead.
    const controller = new RecordingController()
    render(<BrowserPanel controller={controller} initialState={state()} active focused workspaceVisible />)
    await waitFor(() => expect(controller.lifecycleHandler).not.toBeNull())
    controller.lifecycleHandler?.({
      sequence: 1,
      pageId: page.id,
      navigationGeneration: page.navigationGeneration,
      kind: 'popup_requested',
      url: 'https://mail.naver.com/',
      detail: 'popup blocked pending explicit tab creation',
      timestampMs: 0,
    })
    await waitFor(() => expect(controller.navigations).toContain('https://mail.naver.com/'))
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
