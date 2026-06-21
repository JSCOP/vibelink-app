import { Channel, invoke } from '@tauri-apps/api/core'
import type { HermesModelInfo, HermesPermissionOption } from './types'
import { useWorkspaceStore } from '../state/store'
import type { HermesPlanEntry } from '../state/hermes'

export type HermesEvent =
  | { kind: 'started'; sessionId: string; acpSessionId: string }
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

let registration: Promise<void> | undefined

export async function startHermesOutputStream(options: { force?: boolean } = {}): Promise<void> {
  if (registration && !options.force) return registration

  const channel = new Channel<HermesEvent>((event) => {
    const store = useWorkspaceStore.getState()
    if (event.kind === 'started') {
      store.setHermesStatus(event.sessionId, 'running')
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
      store.setError(`Hermes: ${event.message}`)
    } else if (event.kind === 'exited') {
      store.setHermesStatus(event.sessionId, 'idle')
    }
  })

  const nextRegistration = invoke<void>('init_hermes_output', { channel }).catch((error) => {
    if (registration === nextRegistration) registration = undefined
    throw error
  })
  registration = nextRegistration
  await nextRegistration
}
