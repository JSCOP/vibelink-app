import type { HermesModelInfo, HermesPermissionOption } from '../ipc/types'

export type HermesToolCallView = {
  id: string
  title: string
  toolKind: string
  status: string
  content: string
}

export type HermesPlanEntry = { content: string; status: string; priority: string }

export type HermesTextPartKind = 'message' | 'thought'

export type HermesTranscriptPart =
  | { kind: HermesTextPartKind; text: string }
  | { kind: 'toolCall'; toolCallId: string }
  | { kind: 'plan'; entries: HermesPlanEntry[] }

export type HermesTurn = {
  role: 'user' | 'assistant'
  text: string
  thoughts: string
  toolCalls: HermesToolCallView[]
  plan?: HermesPlanEntry[]
  parts?: HermesTranscriptPart[]
}

export type PendingPermission = {
  requestId: number
  title: string
  toolKind: string
  options: HermesPermissionOption[]
  diffPath?: string
  oldText?: string
  newText?: string
}

export type HermesStatus = 'idle' | 'starting' | 'running' | 'busy' | 'error'

export type HermesModelsState = { available: HermesModelInfo[]; current: string }

export type HermesSessionInfo = {
  id: string
  title: string | null
  updatedAt: string | null
  cwd: string | null
}
