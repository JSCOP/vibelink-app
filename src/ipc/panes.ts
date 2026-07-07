import { invoke } from '@tauri-apps/api/core'
import { noteAgentPromptSubmitted } from '../terminal/agentActivity'

export async function sendToPane(sessionId: string, paneId: string, text: string, enter = true): Promise<void> {
  await invoke('write_pane', { sessionId, paneId, data: enter ? `${text}\r` : text })
}

export async function submitAgentPrompt(sessionId: string, paneId: string): Promise<void> {
  await invoke('write_pane', { sessionId, paneId, data: '\r' })
  noteAgentPromptSubmitted(paneId)
}
