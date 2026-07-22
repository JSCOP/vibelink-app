import { invoke } from '@tauri-apps/api/core'

/** A past agent conversation transcript discovered on disk (omp / Codex / Claude). */
export type AgentConversationInfo = {
  id: string
  title: string
  agent: string
  updatedAt: string | null
  cwd: string | null
  path: string
}

/**
 * List past agent conversations (omp, Codex, Claude Code) for a workspace folder.
 * Reads the CLIs' on-disk JSONL transcripts; returns compact title metadata sorted
 * most-recent first. Returns [] when no transcripts exist or the backend is
 * unavailable (e.g. web preview).
 */
export async function listAgentConversations(workspaceFolder: string | null): Promise<AgentConversationInfo[]> {
  try {
    return await invoke<AgentConversationInfo[]>('agent_conversations_list', { workspaceFolder })
  } catch {
    return []
  }
}
