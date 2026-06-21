import { Channel, invoke } from '@tauri-apps/api/core'
import { useWorkspaceStore } from '../state/store'
import { TerminalManager } from '../terminal/TerminalManager'


type TaskSignal =
  | { kind: 'done'; taskId: string; commitMsg?: string | null; paneId?: string | null }
  | { kind: 'note'; taskId: string; message: string; paneId?: string | null }
  | { kind: 'boardChanged' }

type TerminalEvent =
  | { kind: 'output'; paneId: string; dataB64: string }
  | { kind: 'exited'; paneId: string; exitCode?: number | null }
  | { kind: 'task'; sessionId: string; signal: TaskSignal }
  | { kind: 'connectionLost'; message: string }
  | { kind: 'connectionRestored' }

let registration: Promise<void> | undefined

export async function startTerminalOutputStream(options: { force?: boolean } = {}): Promise<void> {
  if (registration && !options.force) return registration

  const channel = new Channel<TerminalEvent>((event) => {
    if (event.kind === 'output') {
      TerminalManager.write(event.paneId, base64ToBytes(event.dataB64))
    } else if (event.kind === 'exited') {
      TerminalManager.markExited(event.paneId, event.exitCode)
    } else if (event.kind === 'task') {
      if (event.signal.kind === 'done') {
        useWorkspaceStore.getState().markTaskDone(event.signal.taskId, { commitMessage: event.signal.commitMsg ?? undefined })
      } else if (event.signal.kind === 'note') {
        useWorkspaceStore.getState().noteTask(event.signal.taskId, event.signal.message)
      } else {
        void reloadBoard(event.sessionId)
      }
    } else if (event.kind === 'connectionLost') {
      useWorkspaceStore.getState().setError(`Daemon connection lost: ${event.message}`)
    } else {
      void handleConnectionRestored()
    }
  })

  const nextRegistration = invoke<void>('init_terminal_output', { channel }).catch((error) => {
    if (registration === nextRegistration) registration = undefined
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

async function reloadBoard(sessionId: string): Promise<void> {
  const json = await invoke<string>('board_read', { sessionId })
  useWorkspaceStore.getState().applyBoardSnapshot(sessionId, json)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
