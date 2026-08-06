// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

const focus = vi.hoisted(() => vi.fn())
vi.mock('../terminal/TerminalManager', () => ({ TerminalManager: { focus } }))

const nativeFocus = vi.hoisted(() => ({
  listener: undefined as ((event: { payload: boolean }) => void) | undefined,
  unlisten: vi.fn(),
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onFocusChanged: (listener: (event: { payload: boolean }) => void) => {
      nativeFocus.listener = listener
      return Promise.resolve(nativeFocus.unlisten)
    },
  }),
}))

const activationFallback = vi.hoisted(() => ({
  listener: undefined as ((event: { payload: undefined }) => void) | undefined,
  unlisten: vi.fn(),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (_event: string, listener: (event: { payload: undefined }) => void) => {
    activationFallback.listener = listener
    return Promise.resolve(activationFallback.unlisten)
  },
}))

const focusWebview = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ setFocus: focusWebview }),
}))

import type { DockviewApi } from 'dockview-react'
import { registerActiveContentFocusOnWindowActivation } from './activeContentFocus'

const terminalApi = {
  activePanel: {
    params: {
      schema: 1,
      kind: 'terminal',
      instanceId: 'pane-active',
      paneId: 'pane-active',
      title: 'Terminal',
      icon: 'terminal',
    },
  },
} as unknown as DockviewApi

afterEach(() => {
  focus.mockReset()
  nativeFocus.listener = undefined
  nativeFocus.unlisten.mockReset()
  activationFallback.listener = undefined
  activationFallback.unlisten.mockReset()
  focusWebview.mockClear()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function activateWindowWithFocusOn(markup: string): Promise<void> {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  document.body.innerHTML = markup
  document.querySelector<HTMLElement>('[data-focus]')?.focus()
  const dispose = registerActiveContentFocusOnWindowActivation(() => terminalApi, () => true)
  nativeFocus.listener?.({ payload: true })
  await settleActivation()
  dispose()
}

/** The WebView focus call is awaited before the terminal is focused. */
async function settleActivation(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('window activation terminal focus', () => {
  it('restores the active terminal after native window activation unless interaction is suspended', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    let allowed = false
    const dispose = registerActiveContentFocusOnWindowActivation(() => terminalApi, () => allowed)
    await Promise.resolve()

    try {
      nativeFocus.listener?.({ payload: false })
      nativeFocus.listener?.({ payload: true })
      await settleActivation()
      expect(focus).not.toHaveBeenCalled()

      allowed = true
      nativeFocus.listener?.({ payload: true })
      await settleActivation()
      expect(focus).toHaveBeenCalledOnce()
      expect(focus).toHaveBeenCalledWith('pane-active')
    } finally {
      dispose()
    }

    expect(nativeFocus.unlisten).toHaveBeenCalledOnce()
  })

  it('recovers the active terminal from the native Windows activation event', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const dispose = registerActiveContentFocusOnWindowActivation(() => terminalApi, () => true)
    await Promise.resolve()

    activationFallback.listener?.({ payload: undefined })
    await Promise.resolve()
    await Promise.resolve()

    expect(focusWebview).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledWith('pane-active')

    dispose()
    expect(activationFallback.unlisten).toHaveBeenCalledOnce()
  })

  // Opening a native <select> popup on Windows bounces OS activation off the
  // Tauri window and back, so an unguarded refocus blurred the <select> and
  // dismissed the list before the user could pick a profile.
  it('leaves focus alone while a keyboard control outside the terminal owns it', async () => {
    await activateWindowWithFocusOn('<select data-focus><option>OMP</option></select>')
    expect(focus).not.toHaveBeenCalled()
  })

  it('still restores the terminal when xterm itself holds focus', async () => {
    await activateWindowWithFocusOn('<div class="xterm"><textarea data-focus class="xterm-helper-textarea"></textarea></div>')
    expect(focus).toHaveBeenCalledWith('pane-active')
  })

  // One Alt+Tab raises BOTH activation signals. Focusing xterm's textarea alone
  // does not restore OS keyboard routing — the frameless window's WebView2 child
  // HWND has to be focused too — so when the two paths shared a pending-focus
  // guard and only the native event carried the WebView call, whichever event
  // arrived first silently dropped it: the pane looked highlighted but swallowed
  // every keystroke until the user clicked it again.
  it('focuses the WebView even when the Tauri focus event wins the activation race', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
    const dispose = registerActiveContentFocusOnWindowActivation(() => terminalApi, () => true)
    await Promise.resolve()

    try {
      nativeFocus.listener?.({ payload: true })
      activationFallback.listener?.({ payload: undefined })
      expect(frames).toHaveLength(1)
      frames[0]?.(0)
      await settleActivation()

      expect(focusWebview).toHaveBeenCalledOnce()
      expect(focus).toHaveBeenCalledOnce()
      expect(focus).toHaveBeenCalledWith('pane-active')
    } finally {
      dispose()
    }
  })

  // The recovery must not require the document to already hold focus. Windows
  // hands the frameless window activation WITHOUT moving focus into the
  // WebView2 child HWND, so `document.hasFocus()` is false at exactly this
  // moment; gating on it made the recovery refuse to run and the highlighted
  // pane stayed keyboard-dead until it was clicked. `WorkspaceView` therefore
  // passes only its interaction-suspended predicate.
  it('recovers keyboard control while the document reports no focus', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const dispose = registerActiveContentFocusOnWindowActivation(() => terminalApi, () => true)
    await Promise.resolve()

    try {
      activationFallback.listener?.({ payload: undefined })
      await settleActivation()

      expect(focusWebview).toHaveBeenCalledOnce()
      expect(focus).toHaveBeenCalledWith('pane-active')
    } finally {
      dispose()
      hasFocus.mockRestore()
    }
  })
})
