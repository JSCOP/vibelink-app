import { Channel, invoke } from '@tauri-apps/api/core'
import type { HermesModelInfo, HermesPermissionOption, HermesRuntimeStatus } from './types'
import { useWorkspaceStore } from '../state/store'
import type { HermesPendingPrompt, HermesPlanEntry, HermesSessionInfo } from '../state/hermes'

export type HermesEvent = { generation: number } & (
  | { kind: 'started'; sessionId: string; acpSessionId: string }
  | { kind: 'sessionReplay'; sessionId: string; acpSessionId: string }
  | { kind: 'userMessage'; sessionId: string; text: string }
  | { kind: 'message'; sessionId: string; text: string }
  | { kind: 'thought'; sessionId: string; text: string }
  | { kind: 'toolCall'; sessionId: string; toolCallId: string; title: string; toolKind: string; status: string }
  | { kind: 'toolUpdate'; sessionId: string; toolCallId: string; status: string; content: string }
  | { kind: 'plan'; sessionId: string; entries: HermesPlanEntry[] }
  | { kind: 'usage'; sessionId: string; size: number; used: number }
  | { kind: 'permission'; sessionId: string; requestId: number; title: string; toolKind: string; options: HermesPermissionOption[]; diffPath?: string; oldText?: string; newText?: string }
  | { kind: 'models'; sessionId: string; available: HermesModelInfo[]; current: string }
  | { kind: 'turnEnded'; sessionId: string; stopReason: string }
  | { kind: 'error'; sessionId: string; message: string }
  | { kind: 'exited'; sessionId: string }
)

type HermesStartResult = { generation: number }


/** Setup-required failures (no provider/model configured yet) are guided inline
 *  by the agent panel's empty state, so they must not raise the global banner. */
export function isHermesSetupRequired(message: string): boolean {
  return /no llm provider configured|hermes setup|hermes model/i.test(message)
}

let registration: Promise<void> | undefined
const startPromises = new Map<string, Promise<void>>()
const sessionRefreshPromises = new Map<string, Promise<void>>()
const DEFAULT_START_TIMEOUT_MS = 60_000

export type StartHermesAgentInput = {
  sessionId: string
  commandOverride?: string | null
  workspaceFolder?: string | null
  timeoutMs?: number
  restartOnTimeout?: boolean
}


export async function startHermesOutputStream(options: { force?: boolean } = {}): Promise<void> {
  if (registration && !options.force) return registration

  const channel = new Channel<HermesEvent>((event) => {
    const store = useWorkspaceStore.getState()
    const currentGeneration = store.hermesGenerations[event.sessionId]
    if (currentGeneration !== undefined && event.generation < currentGeneration) return
    if (currentGeneration !== event.generation) store.setHermesGeneration(event.sessionId, event.generation)
    if (event.kind === 'started') {
      store.setHermesStatus(event.sessionId, 'running')
      store.setHermesCurrentSession(event.sessionId, event.acpSessionId)
      void hermesRefreshSessions(event.sessionId).catch(() => undefined)
    } else if (event.kind === 'sessionReplay') {
      store.resetHermesTranscript(event.sessionId)
      store.setHermesCurrentSession(event.sessionId, event.acpSessionId)
    } else if (event.kind === 'userMessage') {
      store.addHermesUserMessage(event.sessionId, event.text)
    } else if (event.kind === 'message') {
      store.appendHermesText(event.sessionId, 'message', event.text)
    } else if (event.kind === 'thought') {
      store.appendHermesText(event.sessionId, 'thought', event.text)
    } else if (event.kind === 'toolCall') {
      store.addHermesToolCall(event.sessionId, {
        id: event.toolCallId,
        title: event.title,
        toolKind: event.toolKind,
        status: event.status,
      })
    } else if (event.kind === 'toolUpdate') {
      store.updateHermesToolCall(event.sessionId, event.toolCallId, { status: event.status, content: event.content })
    } else if (event.kind === 'plan') {
      store.setHermesPlan(event.sessionId, event.entries)
    } else if (event.kind === 'usage') {
      store.setHermesUsage(event.sessionId, { size: event.size, used: event.used })
    } else if (event.kind === 'permission') {
      store.addHermesPermission(event.sessionId, {
        requestId: event.requestId,
        generation: event.generation,
        title: event.title,
        toolKind: event.toolKind,
        options: event.options,
        diffPath: event.diffPath,
        oldText: event.oldText,
        newText: event.newText,
      })
    } else if (event.kind === 'models') {
      store.setHermesModels(event.sessionId, { available: event.available, current: event.current })
    } else if (event.kind === 'turnEnded') {
      store.endHermesTurn(event.sessionId)
    } else if (event.kind === 'error') {
      store.appendHermesText(event.sessionId, 'message', `Hermes error: ${event.message}`)
      store.setHermesStatus(event.sessionId, 'error')
      if (!isHermesSetupRequired(event.message)) store.setError(`Hermes: ${event.message}`)
    } else if (event.kind === 'exited') {
      store.setHermesStatus(event.sessionId, 'idle')
    }
  })

  const nextRegistration = invoke<void>('init_agent_chat_output', { channel }).catch((error) => {
    if (registration === nextRegistration) registration = undefined
    throw error
  })
  registration = nextRegistration
  await nextRegistration
}

export async function startHermesAgent({ sessionId, commandOverride = null, workspaceFolder = null, timeoutMs = DEFAULT_START_TIMEOUT_MS, restartOnTimeout = true }: StartHermesAgentInput): Promise<void> {
  const currentStatus = useWorkspaceStore.getState().hermesStatus[sessionId]
  if ((currentStatus === 'running' || currentStatus === 'busy') && useWorkspaceStore.getState().hermesGenerations[sessionId] !== undefined) return
  const existing = startPromises.get(sessionId)
  if (existing) return existing

  const task = startHermesAgentOnce({ sessionId, commandOverride, workspaceFolder, timeoutMs })
    .catch(async (error) => {
      if (!restartOnTimeout || !isStartTimeout(error)) throw error
      await invoke('agent_chat_stop', { sessionId }).catch(() => undefined)
      return startHermesAgentOnce({ sessionId, commandOverride, workspaceFolder, timeoutMs })
    })
    .finally(() => {
      if (startPromises.get(sessionId) === task) startPromises.delete(sessionId)
    })
  startPromises.set(sessionId, task)
  return task
}



export function getHermesRuntimeStatus(commandOverride?: string | null): Promise<HermesRuntimeStatus> {
  return invoke<HermesRuntimeStatus>('hermes_runtime_status', { commandOverride: commandOverride || null })
}

export function setHermesModel(sessionId: string, modelId: string): Promise<void> {
  return invoke('agent_chat_set_model', { sessionId, generation: requiredHermesGeneration(sessionId), modelId })
}
export async function dispatchHermesPrompt(sessionId: string, prompt: HermesPendingPrompt): Promise<void> {
  try {
    await invoke('agent_chat_send', {
      sessionId,
      generation: requiredHermesGeneration(sessionId),
      text: prompt.text,
    })
    useWorkspaceStore.getState().ackHermesPrompt(sessionId, prompt.id)
  } catch (error) {
    useWorkspaceStore.getState().releaseHermesPrompt(sessionId, prompt.id)
    throw error
  }
}


export async function hermesNewSession(input: StartHermesAgentInput): Promise<string> {
  await startHermesAgent(input)
  const generation = requiredHermesGeneration(input.sessionId)
  const acpId = await invoke<string>('agent_chat_new_session', { sessionId: input.sessionId, generation })
  if (useWorkspaceStore.getState().hermesGenerations[input.sessionId] !== generation) throw new Error('HERMES_SESSION_REPLACED')
  const store = useWorkspaceStore.getState()
  store.setHermesCurrentSession(input.sessionId, acpId)
  store.resetHermesTranscript(input.sessionId)
  void hermesRefreshSessions(input.sessionId).catch(() => undefined)
  return acpId
}

export async function hermesResumeSession(input: StartHermesAgentInput, acpSessionId: string): Promise<void> {
  await startHermesAgent(input)
  const generation = requiredHermesGeneration(input.sessionId)
  await invoke('agent_chat_resume_session', { sessionId: input.sessionId, generation, acpSessionId })
  if (useWorkspaceStore.getState().hermesGenerations[input.sessionId] !== generation) throw new Error('HERMES_SESSION_REPLACED')
  useWorkspaceStore.getState().setHermesCurrentSession(input.sessionId, acpSessionId)
}

export function hermesRefreshSessions(sessionId: string): Promise<void> {
  const existing = sessionRefreshPromises.get(sessionId)
  if (existing) return existing
  const generation = requiredHermesGeneration(sessionId)
  const task = invoke<HermesSessionInfo[]>('agent_chat_list_sessions', { sessionId, generation })
    .then((list) => {
      if (useWorkspaceStore.getState().hermesGenerations[sessionId] !== generation) throw new Error('HERMES_SESSION_REPLACED')
      useWorkspaceStore.getState().setHermesSessions(sessionId, list)
    })
    .finally(() => {
      if (sessionRefreshPromises.get(sessionId) === task) sessionRefreshPromises.delete(sessionId)
    })
  sessionRefreshPromises.set(sessionId, task)
  return task
}

async function startHermesAgentOnce({ sessionId, commandOverride, workspaceFolder, timeoutMs }: Required<Pick<StartHermesAgentInput, 'sessionId' | 'timeoutMs'>> & Pick<StartHermesAgentInput, 'commandOverride' | 'workspaceFolder'>): Promise<void> {
  const store = useWorkspaceStore.getState()
  await startHermesOutputStream({ force: true })
  store.setHermesStatus(sessionId, 'starting')
  const result = await invoke<HermesStartResult>('agent_chat_start', { sessionId, commandOverride: commandOverride || null, workspaceFolder: workspaceFolder ?? null })
  store.setHermesGeneration(sessionId, result.generation)
  await waitForHermesReady(sessionId, result.generation, timeoutMs)
}

function waitForHermesReady(sessionId: string, generation: number, timeoutMs: number): Promise<void> {
  const state = useWorkspaceStore.getState()
  const currentGeneration = state.hermesGenerations[sessionId]
  const currentStatus = state.hermesStatus[sessionId]
  if (currentGeneration === generation && currentStatus === 'running') return Promise.resolve()
  if (currentGeneration === generation && currentStatus === 'error') return Promise.reject(new Error('Hermes ACP startup failed'))
  if (currentGeneration !== undefined && currentGeneration !== generation) return Promise.reject(new Error('HERMES_SESSION_REPLACED'))

  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      unsubscribe()
      reject(new Error(`Hermes ACP session did not become ready within ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    const unsubscribe = useWorkspaceStore.subscribe((nextState) => {
      if (nextState.hermesGenerations[sessionId] !== generation) {
        globalThis.clearTimeout(timeout)
        unsubscribe()
        reject(new Error('HERMES_SESSION_REPLACED'))
        return
      }
      const status = nextState.hermesStatus[sessionId]
      if (status === 'running') {
        globalThis.clearTimeout(timeout)
        unsubscribe()
        resolve()
      } else if (status === 'error') {
        globalThis.clearTimeout(timeout)
        unsubscribe()
        reject(new Error('Hermes ACP startup failed'))
      }
    })
  })
}


function requiredHermesGeneration(sessionId: string): number {
  const generation = useWorkspaceStore.getState().hermesGenerations[sessionId]
  if (generation === undefined) throw new Error('Hermes ACP session is not ready')
  return generation
}

function isStartTimeout(error: unknown): boolean {
  return String(error).includes('did not become ready')
}
