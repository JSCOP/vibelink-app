import { invoke } from '@tauri-apps/api/core'

export async function sendToPane(sessionId: string, paneId: string, text: string, enter = true): Promise<void> {
  await invoke('write_pane', { sessionId, paneId, data: enter ? `${text}\r` : text })
}
