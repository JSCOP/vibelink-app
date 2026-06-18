import { Channel, invoke } from '@tauri-apps/api/core'
import { useWorkspaceStore } from '../state/store'
import { TerminalManager } from '../terminal/TerminalManager'


type TerminalEvent =
  | { kind: 'output'; paneId: string; dataB64: string }
  | { kind: 'exited'; paneId: string; exitCode?: number | null }
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
  TerminalManager.reattachToDaemon(Object.keys(useWorkspaceStore.getState().panes))
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
