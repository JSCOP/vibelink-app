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
  vi.unstubAllGlobals()
})

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
      expect(focus).not.toHaveBeenCalled()

      allowed = true
      nativeFocus.listener?.({ payload: true })
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
})
