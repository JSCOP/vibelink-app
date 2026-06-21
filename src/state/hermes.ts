import type { HermesGatewayConfig, HermesModelInfo, HermesPermissionOption } from '../ipc/types'

export type HermesToolCallView = {
  id: string
  title: string
  toolKind: string
  status: string
  content: string
}

export type HermesPlanEntry = { content: string; status: string; priority: string }

export type HermesTurn = {
  role: 'user' | 'assistant'
  text: string
  thoughts: string
  toolCalls: HermesToolCallView[]
  plan?: HermesPlanEntry[]
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



export function defaultHermesGateway(platform: HermesGatewayConfig['platform'] = 'telegram'): HermesGatewayConfig {
  return {
    platform,
    tokenEnv: platform === 'telegram' ? 'TELEGRAM_BOT_TOKEN' : platform === 'discord' ? 'DISCORD_BOT_TOKEN' : 'SLACK_BOT_TOKEN',
    tokenSet: false,
    allowedUsers: '',
  }
}

