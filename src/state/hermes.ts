import type { HermesGatewayConfig, HermesModelInfo, HermesPermissionOption } from '../ipc/types'

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
  source: string
  model: string | null
  startedAt: number | null
  endedAt: number | null
  messageCount: number
  archived: boolean
}



export function defaultHermesGateway(platform: HermesGatewayConfig['platform'] = 'telegram'): HermesGatewayConfig {
  return {
    platform,
    tokenEnv: platform === 'telegram' ? 'TELEGRAM_BOT_TOKEN' : platform === 'discord' ? 'DISCORD_BOT_TOKEN' : 'SLACK_BOT_TOKEN',
    tokenSet: false,
    allowedUsers: '',
  }
}

