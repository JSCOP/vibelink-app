import { invoke } from '@tauri-apps/api/core'

export type RunStatus = 'queued' | 'planning' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type OrchestrationTaskStatus = 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked' | 'cancelled'

export type OrchestrationRun = {
  id: string
  sessionId: string
  goal: string
  status: RunStatus
  revision: number
  policy: { maxConcurrent: number }
  createdAt: number
  updatedAt: number
}

export type OrchestrationTask = {
  id: string
  runId: string
  title: string
  description: string
  status: OrchestrationTaskStatus
  position: number
  revision: number
  dependencies: string[]
  result?: unknown
}

export type OrchestrationMessage = {
  id: string
  runId: string
  taskId?: string | null
  dispatchId?: string | null
  parentId?: string | null
  senderKind: string
  messageType: string
  payload: Record<string, unknown>
  createdAt: number
}

export type DecisionGate = {
  id: string
  runId: string
  taskId?: string | null
  dispatchId?: string | null
  gateType: string
  prompt: string
  options: string[]
  status: 'pending' | 'resolved' | 'timeout' | 'cancelled'
  resolution?: string | null
  revision: number
}

type RpcEnvelope<T> = {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}
export class OrchestrationRpcError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export async function orchestrationRequest<T>(
  method: string,
  payload: unknown,
  operationId = crypto.randomUUID(),
): Promise<T> {
  const responseJson = await invoke<string>('orchestration_request', {
    method,
    payloadJson: JSON.stringify(payload),
    operationId,
  })
  const response = JSON.parse(responseJson) as RpcEnvelope<T>
  if (!response.ok || response.data === undefined) {
    throw new OrchestrationRpcError(
      response.error?.code ?? 'internal',
      response.error?.message ?? 'Orchestration request failed.',
    )
  }
  return response.data
}
