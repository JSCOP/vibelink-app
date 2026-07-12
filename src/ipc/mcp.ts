import { invoke } from '@tauri-apps/api/core'

export type McpCheckReport = {
  spawnOk: boolean
  initializeOk: boolean
  toolCount: number
  error?: string | null
}

export function runMcpSelfCheck(sessionId: string): Promise<McpCheckReport> {
  return invoke<McpCheckReport>('mcp_self_check', { sessionId })
}
