import { invoke } from '@tauri-apps/api/core'
import type { WorktreeStorage } from './types'

export type AutomationJsonPrimitive = string | number | boolean | null
export type AutomationJsonValue = AutomationJsonPrimitive | AutomationJsonObject | AutomationJsonValue[]
export type AutomationJsonObject = { [key: string]: AutomationJsonValue }

export type AutomationAgent = 'hermes' | 'omp' | 'claude' | 'codex' | 'opencode'
export type AutomationScheduleKind = 'once' | 'interval' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'cron'
export type AutomationMissedRunPolicy = 'run_once_within_grace'
export type AutomationWorkspaceMode = 'new_per_run' | 'existing'
export type AutomationRunTrigger = 'scheduled' | 'manual'
export type AutomationRunStatus =
  | 'pending'
  | 'dispatching'
  | 'dispatched'
  | 'completed'
  | 'skipped_precheck'
  | 'skipped_missed'
  | 'skipped_unavailable'
  | 'skipped_needs_interactive_auth'
  | 'dispatch_failed'
  | 'cancelled'
export type AutomationWorktreeDisposition = 'live' | 'retained' | 'cleaned' | 'cleanup_failed'

export type AutomationPrecheck = {
  command: string | null
  timeoutSeconds: number
  requireWorkspace: boolean
  requireGit: boolean
}

export type AutomationSource = {
  provider: 'hermes'
  sourceId: string
  sourceHash: string
  snapshot: AutomationJsonValue
}

export type AutomationRuntimeIdentity = {
  pid: number
  processStartTime: number
  generation: number
}

export type AutomationRunWorktree = {
  path: string
  branch: string
  baseRevision: string
  disposition: AutomationWorktreeDisposition
}

export type AutomationPrecheckResult = {
  ok: boolean
  command: string | null
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  truncated: boolean
  error: string | null
}

export type AutomationOutputSnapshot = {
  finalResponse: string | null
  stdout: string
  stderr: string
  truncated: boolean
}

export type AutomationUsage = AutomationJsonObject

export type AutomationRecord = {
  id: string
  sessionId: string
  name: string
  prompt: string
  agent: AutomationAgent
  provider: string | null
  model: string | null
  useAgentDefaultModel: boolean
  toolsets: string[]
  skills: string[]
  maxTurns: number
  timeoutSeconds: number
  scheduleKind: AutomationScheduleKind
  scheduleValue: string
  timezone: string
  dtstart: number | null
  nextRunAt: number | null
  lastRunAt: number | null
  enabled: boolean
  requiresReview: boolean
  missedRunGraceMinutes: number
  missedRunPolicy: AutomationMissedRunPolicy
  workspaceMode: AutomationWorkspaceMode
  worktreeStorage: WorktreeStorage
  baseRef: string | null
  precheck: AutomationPrecheck
  source: AutomationSource | null
  createdAt: number
  updatedAt: number
}

export type AutomationRunRecord = {
  id: string
  automationId: string
  runNumber: number
  trigger: AutomationRunTrigger
  scheduledFor: number
  status: AutomationRunStatus
  runtimeIdentity: AutomationRuntimeIdentity | null
  worktree: AutomationRunWorktree | null
  precheckResult: AutomationPrecheckResult | null
  outputSnapshot: AutomationOutputSnapshot | null
  usage: AutomationUsage | null
  error: string | null
  startedAt: number | null
  finishedAt: number | null
  createdAt: number
}

export type CreateAutomationInput = {
  name: string
  prompt: string
  agent?: AutomationAgent
  scheduleKind: AutomationScheduleKind
  scheduleValue: string
  timezone: string
  provider?: string | null
  model?: string | null
  useAgentDefaultModel?: boolean
  toolsets?: string[]
  skills?: string[]
  maxTurns?: number
  timeoutSeconds?: number
  dtstart?: number | null
  enabled?: boolean
  requiresReview?: boolean
  missedRunGraceMinutes?: number
  workspaceMode?: AutomationWorkspaceMode
  worktreeStorage?: WorktreeStorage
  baseRef?: string | null
  precheck?: Partial<AutomationPrecheck>
}

export type UpdateAutomationInput = Partial<CreateAutomationInput>

export type AutomationSchedulePreviewInput = {
  scheduleKind: AutomationScheduleKind
  scheduleValue: string
  timezone: string
  dtstart?: number | null
  after?: number
  count?: number
}

export type AutomationDeleteResult = {
  id: string
  deleted: true
}

export type AutomationImportCandidate = {
  source: AutomationSource
  name: string
  prompt: string
  scheduleKind: AutomationScheduleKind
  scheduleValue: string
  timezone: string
  provider: string | null
  model: string | null
  toolsets: string[]
  skills: string[]
  maxTurns: number
  timeoutSeconds: number
  workdir: string
  warnings: string[]
  existingAutomationId: string | null
}

export type AutomationImportPreview = {
  sourcePath: string
  sourceHash: string
  candidates: AutomationImportCandidate[]
}

export type AutomationImportSelection = {
  sourceId: string
  sourceHash: string
}

export type ImportAutomationJobsInput = {
  jobs: AutomationImportSelection[]
}

export type AutomationImportResult = {
  imported: AutomationRecord[]
  skipped: Array<{ sourceId: string; reason: string }>
}

export type AutomationDraftSchedule = {
  kind: AutomationScheduleKind
  value: string
  timezone: string
}

export type AutomationDraftCurrentValues = {
  name: string
  prompt: string
  schedule: AutomationDraftSchedule
  precheckCommand: string | null
}

export type AutomationDraftPreviewInput = {
  requestId?: string
  request: string
  current?: AutomationDraftCurrentValues
}

export type AutomationDraftPreview = {
  requestId: string
  name: string
  prompt: string
  schedule: AutomationDraftSchedule
  precheckCommand: string | null
  notes: string[]
}

export type AutomationDraftCancellation = {
  id: string
  cancelled: boolean
}

export class AutomationRpcError extends Error {
  readonly code: string
  readonly details?: AutomationJsonValue

  constructor(code: string, message: string, details?: AutomationJsonValue) {
    super(message)
    this.name = 'AutomationRpcError'
    this.code = code
    this.details = details
  }
}

type RpcErrorLike = {
  code?: unknown
  message?: unknown
  details?: unknown
}

function rpcErrorLike(value: unknown): RpcErrorLike | null {
  return typeof value === 'object' && value !== null ? value as RpcErrorLike : null
}

function parseRpcError(value: string): RpcErrorLike | null {
  try {
    return rpcErrorLike(JSON.parse(value))
  } catch {
    return null
  }
}

function isAutomationJsonValue(value: unknown): value is AutomationJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.every(isAutomationJsonValue)
  return typeof value === 'object' && Object.values(value).every(isAutomationJsonValue)
}

export function normalizeAutomationRpcError(
  cause: unknown,
  fallbackMessage = 'Automation request failed.',
): AutomationRpcError {
  if (cause instanceof AutomationRpcError) return cause

  const rawMessage = cause instanceof Error
    ? cause.message
    : typeof cause === 'string'
      ? cause
      : fallbackMessage
  const parsed = typeof cause === 'string' ? parseRpcError(cause) : null
  const error = parsed ?? rpcErrorLike(cause)
  const code = typeof error?.code === 'string' ? error.code : 'internal_failure'
  const message = typeof error?.message === 'string' ? error.message : rawMessage
  const details = isAutomationJsonValue(error?.details) ? error.details : undefined
  return new AutomationRpcError(code, message || fallbackMessage, details)
}

// The CLI's global request timeout defaults to 10s, which aborts these two long
// daemon calls every time: draft preview runs Hermes with a hard 120s cap, and
// precheck may spend 600s in its child command before cleanup and serialization.
const DRAFT_PREVIEW_TIMEOUT_SECONDS = 180
const PRECHECK_TIMEOUT_SECONDS = 660

async function automationRequest<T>(action: string, args: string[] = [], timeoutSeconds?: number): Promise<T> {
  const globals = timeoutSeconds === undefined ? [] : ['--request-timeout-seconds', String(timeoutSeconds)]
  try {
    return await invoke<T>('cli_request', { args: [...globals, 'automation', action, ...args] })
  } catch (cause) {
    throw normalizeAutomationRpcError(cause)
  }
}

function jsonPayload(payload: object): string {
  return JSON.stringify(payload)
}

export function listAutomations(sessionId?: string): Promise<AutomationRecord[]> {
  return automationRequest('list', sessionId ? ['--workspace', sessionId] : [])
}

export function createAutomation(sessionId: string, input: CreateAutomationInput): Promise<AutomationRecord> {
  return automationRequest('create', ['--workspace', sessionId, '--json', jsonPayload(input)])
}

export function updateAutomation(id: string, input: UpdateAutomationInput): Promise<AutomationRecord> {
  return automationRequest('update', ['--id', id, '--json', jsonPayload(input)])
}

export function deleteAutomation(id: string): Promise<AutomationDeleteResult> {
  return automationRequest('delete', ['--id', id])
}

export function runAutomation(id: string): Promise<AutomationRunRecord> {
  return automationRequest('run', ['--id', id])
}

export function listAutomationRuns(id: string, limit?: number): Promise<AutomationRunRecord[]> {
  const args = ['--id', id]
  if (limit !== undefined) args.push('--limit', String(limit))
  return automationRequest('runs', args)
}

export function precheckAutomation(id: string): Promise<AutomationPrecheckResult> {
  return automationRequest('precheck', ['--id', id], PRECHECK_TIMEOUT_SECONDS)
}

export function previewAutomationSchedule(input: AutomationSchedulePreviewInput): Promise<number[]> {
  return automationRequest('schedule-preview', ['--json', jsonPayload(input)])
}

export function cancelAutomationRun(id: string): Promise<AutomationRunRecord> {
  return automationRequest('cancel', ['--id', id])
}

export function cancelAutomationDraft(id: string): Promise<AutomationDraftCancellation> {
  return automationRequest('draft-cancel', ['--id', id])
}

export function previewAutomationImport(sessionId: string): Promise<AutomationImportPreview> {
  return automationRequest('import-preview', ['--workspace', sessionId])
}

export function importAutomationJobs(
  sessionId: string,
  input: ImportAutomationJobsInput,
): Promise<AutomationImportResult> {
  return automationRequest('import', ['--workspace', sessionId, '--json', jsonPayload(input)])
}

export function createAutomationDraftRequestId(): string {
  return crypto.randomUUID()
}

export function previewAutomationDraft(
  sessionId: string,
  input: AutomationDraftPreviewInput,
): Promise<AutomationDraftPreview> {
  return automationRequest(
    'draft-preview',
    ['--workspace', sessionId, '--json', jsonPayload(input)],
    DRAFT_PREVIEW_TIMEOUT_SECONDS,
  )
}
