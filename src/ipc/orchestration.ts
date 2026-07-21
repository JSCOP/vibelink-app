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

export type OrchestrationWorktree = {
  baseRevision: string
  branch: string
  worktreePath: string
}

export type ResourceDisposition = 'not_created' | 'live' | 'cleaned' | 'retained' | 'cleanup_failed' | 'unknown'

export type DispatchLaunchClaim = {
  operationId: string
  commandDigest: string
  profile?: string | null
  worktreeMode: 'reuse' | 'worktree'
}

export type DispatchResource = {
  sessionId: string
  repositoryRoot?: string | null
  relativePrefix: string
  launchPath?: string | null
  agentInstanceId?: string | null
  paneId?: string | null
  rootPid?: number | null
  processStartedAt?: number | null
  processGeneration?: number | null
  worktree?: OrchestrationWorktree | null
  paneDisposition: ResourceDisposition
  worktreeDisposition: ResourceDisposition
  cleanupReason?: string | null
  cleanupError?: string | null
}

export type DispatchLaunchRequest = {
  runId: string
  expectedRunRevision: number
  command: string
  profile?: string
  worktreeMode?: 'reuse' | 'worktree'
}

export type DispatchLaunchOutcome = {
  dispatchId: string
  taskId: string
  attempt: number
  status: 'launched' | 'existing' | 'failed'
  agentInstanceId?: string | null
  paneId?: string | null
  runtimeIdentity?: string | null
  processGeneration?: number | null
  worktree?: OrchestrationWorktree | null
  resources?: DispatchResource | null
  failureCode?: string | null
  error?: string | null
}

export type DispatchLaunchResult = {
  run: OrchestrationRun
  launches: DispatchLaunchOutcome[]
  newlyReadyTaskIds: string[]
  newlyBlockedTaskIds: string[]
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
  operationId: string = crypto.randomUUID(),
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

export function launchReadyOrchestrationTasks(
  request: DispatchLaunchRequest,
  operationId: string = crypto.randomUUID(),
): Promise<DispatchLaunchResult> {
  return orchestrationRequest<DispatchLaunchResult>('dispatch.launch', request, operationId)
}
