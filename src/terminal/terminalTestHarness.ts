// @vitest-environment jsdom
import { beforeEach, vi } from 'vitest'
import { useRemotePaneLeaseStore } from '../remote/paneLease'
import { TerminalManager } from './TerminalManager'
import { invokeMock, webglMock } from './terminalTestMocks'

type TerminalWithDataHandler = {
  dataHandler: ((data: string) => void) | undefined
}

function emitTerminalData(paneId: string, data: string): void {
  const manager = TerminalManager as unknown as { entries: Map<string, { term: TerminalWithDataHandler }> }
  const entry = manager.entries.get(paneId)
  if (!entry?.term.dataHandler) throw new Error(`no data handler wired for pane ${paneId}`)
  entry.term.dataHandler(data)
}

function emitTerminalTitle(paneId: string, title: string): void {
  const manager = TerminalManager as unknown as { entries: Map<string, { term: { titleHandler?: (title: string) => void } }> }
  const entry = manager.entries.get(paneId)
  if (!entry?.term.titleHandler) throw new Error(`no title handler wired for pane ${paneId}`)
  entry.term.titleHandler(title)
}

function paneWriteData(call: unknown[]): string | undefined {
  const args = call[1]
  if (!args || typeof args !== 'object' || !('data' in args) || typeof args.data !== 'string') return undefined
  return args.data
}

function makeContainer(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

const resizeObservers = new Set<StubResizeObserver>()

class StubResizeObserver {
  private target: Element | undefined
  private readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    resizeObservers.add(this)
  }

  observe(target: Element): void { this.target = target }
  unobserve(target: Element): void { if (this.target === target) this.target = undefined }
  disconnect(): void { this.target = undefined }

  emit(target: Element, width: number, height: number): void {
    if (this.target !== target) return
    this.callback([{ target, contentRect: { width, height } } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
}

function emitResize(target: Element, width: number, height: number): void {
  for (const observer of resizeObservers) observer.emit(target, width, height)
}

beforeEach(() => {
  resizeObservers.clear()
  webglMock.fail = true
  webglMock.instances.length = 0
  Reflect.set(TerminalManager, 'webviewRenderMode', '')
  invokeMock.mockReset()
  invokeMock.mockImplementation((command, args) => {
    if (command === 'subscribe_pane') {
      return Promise.resolve(terminalSnapshot(
        String(args?.paneId),
        0n,
        '',
        String(args?.sessionId),
        1n,
      ))
    }
    return Promise.resolve()
  })
  useRemotePaneLeaseStore.setState({ leases: {} })
})

vi.stubGlobal('ResizeObserver', StubResizeObserver)

function terminalSnapshot(
  paneId: string,
  outputSequence: bigint,
  text: string,
  sessionId = 'session-replay',
  paneGeneration = 9n,
) {
  return {
    sessionId,
    paneId,
    paneGeneration: paneGeneration.toString(),
    outputSequence: outputSequence.toString(),
    cols: 80,
    rows: 24,
    alive: true,
    dataBase64: btoa(text),
  }
}

// `TerminalManager` must be re-exported as a live binding. A value re-export
// snapshots the import as `undefined` under vitest's mock-hoisting transform.
export { TerminalManager } from './TerminalManager'
export { eventMock, invokeMock, webglMock } from './terminalTestMocks'

export {
  emitResize,
  emitTerminalData,
  emitTerminalTitle,
  makeContainer,
  paneWriteData,
  terminalSnapshot,
}
