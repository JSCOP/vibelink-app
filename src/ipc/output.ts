import { Channel, invoke } from '@tauri-apps/api/core'
import { useWorkspaceStore } from '../state/store'
import { TerminalManager } from '../terminal/TerminalManager'

type TerminalEvent =
  | { kind: 'output'; paneId: string; dataB64: string }
  | { kind: 'exited'; paneId: string; exitCode?: number | null }
  | { kind: 'connectionLost'; message: string }
  | { kind: 'connectionRestored' }

let started = false

export async function startTerminalOutputStream(): Promise<void> {
  if (started) return
  started = true

  const channel = new Channel<TerminalEvent>((event) => {
    if (event.kind === 'output') {
      TerminalManager.write(event.paneId, base64ToBytes(event.dataB64))
    } else if (event.kind === 'exited') {
      TerminalManager.markExited(event.paneId, event.exitCode)
    } else if (event.kind === 'connectionLost') {
      useWorkspaceStore.getState().setError(`Daemon connection lost: ${event.message}`)
    } else {
      void useWorkspaceStore.getState().bootstrap()
    }
  })

  await invoke('init_terminal_output', { channel })
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
