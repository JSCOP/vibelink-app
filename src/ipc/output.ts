import { Channel, invoke } from '@tauri-apps/api/core'
import { useWorkspaceStore } from '../state/store'
import { TerminalManager } from '../terminal/TerminalManager'
import { agentActivityTracker } from '../terminal/agentActivity'


type TaskSignal =
  | { kind: 'done'; taskId: string; commitMsg?: string | null; resultSummary?: string | null; paneId?: string | null }
  | { kind: 'note'; taskId: string; message: string; paneId?: string | null }
  | { kind: 'paneConfigured'; paneId: string; title?: string | null; role?: string | null }
  | { kind: 'paneCompleted'; paneId: string; agent?: string | null }
  | { kind: 'boardChanged' }

type TerminalEvent =
  | { kind: 'exited'; paneId: string; exitCode?: number | null }
  | { kind: 'resized'; paneId: string; cols: number; rows: number }
  | { kind: 'sessionChanged'; sessionId: string }
  | { kind: 'task'; sessionId: string; signal: TaskSignal }
  | { kind: 'connectionLost'; message: string }
  | { kind: 'connectionRestored' }

let registration: Promise<void> | undefined
const sessionReloadTimers = new Map<string, number>()
let outputSocket: WebSocket | undefined
const paneIdDecoder = new TextDecoder()

export async function startTerminalOutputStream(options: { force?: boolean } = {}): Promise<void> {
  if (registration && !options.force) return registration

  const channel = new Channel<TerminalEvent>((event) => {
    if (event.kind === 'exited') {
      TerminalManager.markExited(event.paneId, event.exitCode)
    } else if (event.kind === 'resized') {
      TerminalManager.adoptRemoteResize(event.paneId, event.cols, event.rows)
    } else if (event.kind === 'sessionChanged') {
      scheduleSessionReload(event.sessionId)
    } else if (event.kind === 'task') {
      if (event.signal.kind === 'done') {
        const store = useWorkspaceStore.getState()
        const assignedPaneId = store.kanban.tasks[event.signal.taskId]?.assignedPaneId
        const paneId = event.signal.paneId ?? assignedPaneId
        if (paneId) {
          agentActivityTracker.clear(paneId)
          store.markPaneResponseComplete(paneId, 'task-done', event.sessionId)
        }
      } else if (event.signal.kind === 'paneCompleted') {
        // Authoritative and workspace-scoped: this must survive the originating
        // pane being detached from the frontend after a workspace switch.
        agentActivityTracker.clear(event.signal.paneId)
        useWorkspaceStore.getState().markPaneResponseComplete(event.signal.paneId, 'agent-hook', event.sessionId)
      } else if (event.signal.kind === 'paneConfigured') {
        useWorkspaceStore.getState().applyPaneConfiguration(event.signal.paneId, {
          title: event.signal.title ?? undefined,
          role: event.signal.role ?? undefined,
        })
      } else {
        void reloadBoard(event.sessionId)
      }
    } else if (event.kind === 'connectionLost') {
      useWorkspaceStore.getState().setError(`Daemon connection lost: ${event.message}`)
    } else {
      void handleConnectionRestored()
    }
  })

  let nextRegistration: Promise<void> = Promise.resolve()
  nextRegistration = (async () => {
    await invoke<void>('init_terminal_output', { channel })
    const port = await invoke<number>('terminal_ws_port')
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    if (registration !== nextRegistration) {
      socket.close()
      return
    }
    socket.binaryType = 'arraybuffer'
    socket.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return
      const bytes = new Uint8Array(event.data)
      if (bytes.byteLength < 2) return
      const idLen = (bytes[0] << 8) | bytes[1]
      const cursorOffset = 2 + idLen
      const dataOffset = cursorOffset + 16
      if (bytes.byteLength < dataOffset) return
      const paneId = paneIdDecoder.decode(bytes.subarray(2, cursorOffset))
      const cursor = new DataView(event.data)
      const paneGeneration = cursor.getBigUint64(cursorOffset, false)
      const outputSequence = cursor.getBigUint64(cursorOffset + 8, false)
      TerminalManager.writeSequenced(
        paneId,
        paneGeneration,
        outputSequence,
        bytes.subarray(dataOffset),
      )
    }
    socket.onclose = () => {
      if (outputSocket === socket) outputSocket = undefined
    }
    const previousSocket = outputSocket
    outputSocket = socket
    previousSocket?.close()
  })().catch((error) => {
    if (registration === nextRegistration) {
      registration = undefined
      outputSocket?.close()
      outputSocket = undefined
    }
    throw error
  })
  registration = nextRegistration
  await nextRegistration
}


async function handleConnectionRestored(): Promise<void> {
  await startTerminalOutputStream({ force: true })
  await useWorkspaceStore.getState().bootstrap()
  const state = useWorkspaceStore.getState()
  TerminalManager.reattachToDaemon(state.activeSessionId, Object.keys(state.panes))
}

function scheduleSessionReload(sessionId: string): void {
  const existing = sessionReloadTimers.get(sessionId)
  if (existing !== undefined) window.clearTimeout(existing)
  const timer = window.setTimeout(() => {
    sessionReloadTimers.delete(sessionId)
    void reloadSession(sessionId)
  }, 100)
  sessionReloadTimers.set(sessionId, timer)
}

async function reloadSession(sessionId: string): Promise<void> {
  try {
    const state = useWorkspaceStore.getState()
    await Promise.all([state.refreshSessions(), state.refreshWorktrees(), state.refreshAttentionSnapshot()])
    if (useWorkspaceStore.getState().activeSessionId === sessionId) {
      await useWorkspaceStore.getState().refreshAttachedSession(sessionId)
    }
  } catch (caught) {
    useWorkspaceStore.getState().setError(String(caught))
  }
}

async function reloadBoard(sessionId: string): Promise<void> {
  const license = useWorkspaceStore.getState().license
  if (!license.ready || !license.status?.entitled) return
  const json = await invoke<string>('board_read', { sessionId })
  useWorkspaceStore.getState().applyBoardSnapshot(sessionId, json)
}

