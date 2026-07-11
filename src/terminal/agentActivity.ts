export type AgentActivityActions = {
  isAgentPane: (paneId: string) => boolean
  onResponseStart: (paneId: string) => void
  onResponseComplete: (paneId: string) => void
  onUserActivity?: (paneId: string) => void
  quietMs?: number
}

type OutputParseState = {
  inOsc: boolean
  inCsi: boolean
}

type PendingAgentResponse = {
  sawOutput: boolean
  timer: number | undefined
  parse: OutputParseState
}

type PaneInputState = {
  draft: string
  inPaste: boolean
}

export const defaultAgentResponseQuietMs = 8_000
const maxDraftChars = 4096

const textDecoder = new TextDecoder()

export class AgentActivityTracker {
  private actions: AgentActivityActions = {
    isAgentPane: () => false,
    onResponseStart: () => {},
    onResponseComplete: () => {},
  }
  private pending = new Map<string, PendingAgentResponse>()
  private inputStates = new Map<string, PaneInputState>()

  setActions(actions: AgentActivityActions): void {
    this.actions = actions
  }

  noteUserInput(paneId: string, data: string): void {
    if (!this.actions.isAgentPane(paneId)) {
      this.inputStates.delete(paneId)
      return
    }
    this.actions.onUserActivity?.(paneId)
    if (this.recordUserInput(paneId, data)) this.startPendingResponse(paneId)
  }

  notePromptSubmitted(paneId: string): void {
    this.startPendingResponse(paneId)
  }

  noteOutput(paneId: string, bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return
    if (!this.actions.isAgentPane(paneId)) {
      this.clear(paneId)
      return
    }

    const pending = this.pending.get(paneId)
    if (!pending) return

    if (pending.sawOutput && bytes.indexOf(0x07) < 0) {
      updateControlParseState(bytes, pending.parse)
      this.scheduleCompletion(paneId, pending)
      return
    }

    const { text, bell } = stripTerminalControls(textDecoder.decode(bytes), pending.parse)
    if (hasAgentResponseContent(text)) pending.sawOutput = true
    if (pending.sawOutput && bell) {
      this.complete(paneId, pending)
      return
    }
    this.scheduleCompletion(paneId, pending)
  }

  clear(paneId: string): void {
    const pending = this.pending.get(paneId)
    if (pending?.timer !== undefined) globalThis.clearTimeout(pending.timer)
    this.pending.delete(paneId)
    this.inputStates.delete(paneId)
  }

  clearAll(): void {
    for (const paneId of this.pending.keys()) this.clear(paneId)
    this.inputStates.clear()
  }

  private startPendingResponse(paneId: string): void {
    if (!this.actions.isAgentPane(paneId)) return
    this.clear(paneId)
    this.pending.set(paneId, { sawOutput: false, timer: undefined, parse: { inOsc: false, inCsi: false } })
    this.actions.onResponseStart(paneId)
  }

  private recordUserInput(paneId: string, data: string): boolean {
    const state = this.inputStates.get(paneId) ?? { draft: '', inPaste: false }
    let submitted = false
    const submitDraft = () => {
      const draft = state.draft.trim()
      if (draft && !draft.startsWith('/')) submitted = true
      state.draft = ''
    }
    for (let index = 0; index < data.length; index += 1) {
      if (data.startsWith('\x1b[200~', index)) {
        state.inPaste = true
        index += 5
        continue
      }
      if (data.startsWith('\x1b[201~', index)) {
        state.inPaste = false
        index += 5
        continue
      }
      if (data.startsWith('\x1b[13u', index)) {
        if (!state.inPaste) submitDraft()
        index += 4
        continue
      }
      const code = data.charCodeAt(index)
      if (code === 0x0d || code === 0x0a) {
        if (state.inPaste) state.draft += ' '
        else submitDraft()
      } else if (code === 0x08 || code === 0x7f) {
        state.draft = state.draft.slice(0, -1)
      } else if (code === 0x1b) {
        index = skipEscapeSequence(data, index)
      } else if (code >= 0x20) {
        state.draft += data[index]
      }
    }
    state.draft = state.draft.slice(-maxDraftChars)
    this.inputStates.set(paneId, state)
    return submitted
  }

  private complete(paneId: string, pending: PendingAgentResponse): void {
    if (this.pending.get(paneId) !== pending) return
    if (pending.timer !== undefined) globalThis.clearTimeout(pending.timer)
    pending.timer = undefined
    this.pending.delete(paneId)
    if (this.actions.isAgentPane(paneId)) this.actions.onResponseComplete(paneId)
  }

  private scheduleCompletion(paneId: string, pending: PendingAgentResponse): void {
    if (!pending.sawOutput) return
    if (pending.timer !== undefined) globalThis.clearTimeout(pending.timer)
    pending.timer = globalThis.setTimeout(() => this.complete(paneId, pending), this.actions.quietMs ?? defaultAgentResponseQuietMs)
  }
}

export function shouldTrackAgentInput(bufferType: string): boolean {
  return bufferType === 'alternate'
}

export const agentActivityTracker = new AgentActivityTracker()

export function noteAgentPromptSubmitted(paneId: string): void {
  agentActivityTracker.notePromptSubmitted(paneId)
}

type StrippedOutput = {
  text: string
  bell: boolean
}

function stripTerminalControls(text: string, state: OutputParseState): StrippedOutput {
  let out = ''
  let bell = false
  let index = 0
  while (index < text.length) {
    if (state.inOsc) {
      const current = text.charCodeAt(index)
      if (current === 0x07) {
        state.inOsc = false
      } else if (current === 0x1b && text.charCodeAt(index + 1) === 0x5c) {
        state.inOsc = false
        index += 1
      }
      index += 1
      continue
    }
    if (state.inCsi) {
      const current = text.charCodeAt(index)
      index += 1
      if (current >= 0x40 && current <= 0x7e) {
        state.inCsi = false
        out += ' '
      }
      continue
    }
    const code = text.charCodeAt(index)
    if (code === 0x1b) {
      const next = text.charCodeAt(index + 1)
      if (next === 0x5d) {
        state.inOsc = true
      } else if (next === 0x5b) {
        state.inCsi = true
      } else {
        out += ' '
      }
      index += 2
      continue
    }
    if (code === 0x07) {
      bell = true
      out += ' '
    } else if (code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f) {
      out += ' '
    } else {
      out += text[index]
    }
    index += 1
  }
  return { text: out, bell }
}

function updateControlParseState(bytes: Uint8Array, state: OutputParseState): void {
  let index = 0
  while (index < bytes.byteLength) {
    if (state.inOsc) {
      if (bytes[index] === 0x1b && bytes[index + 1] === 0x5c) {
        state.inOsc = false
        index += 2
      } else {
        index += 1
      }
      continue
    }

    if (state.inCsi) {
      const current = bytes[index]
      index += 1
      if (current >= 0x40 && current <= 0x7e) state.inCsi = false
      continue
    }

    if (bytes[index] === 0x1b) {
      const next = bytes[index + 1]
      if (next === 0x5d) {
        state.inOsc = true
      } else if (next === 0x5b) {
        state.inCsi = true
      }
      index += 2
      continue
    }

    index += 1
  }
}

function hasAgentResponseContent(text: string): boolean {
  const content = text
    .split(/[\r\n]+/)
    .filter((line) => line.trim() && !looksLikeAgentPromptLine(line))
    .join('\n')
    .replace(/[╭╮╰╯─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬\s]+/g, '')
  return content.length > 0
}

function looksLikeAgentPromptLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  return /\bGPT-\d(?:\.\d+)?[^\r\n]{0,160}(?:[•·∙]\s*\S+|▾|\d+(?:\.\d+)?[kKmM]?\/\d+(?:\.\d+)?[kKmM]?|tokens?|[>›❯▌]\s*$)/i.test(trimmed)
    || /\b(?:omp|codex|claude(?:\s+code)?)[^\r\n]{0,160}(?:[•·∙]\s*\S+|▾|\d+(?:\.\d+)?[kKmM]?\/\d+(?:\.\d+)?[kKmM]?|tokens?|[>›❯▌]\s*$)/i.test(trimmed)
}

function skipEscapeSequence(data: string, start: number): number {
  const next = data[start + 1]
  if (next === 'O') return start + 2
  if (next !== '[') return start + 1
  let index = start + 2
  while (index < data.length) {
    const code = data.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) return index
    index += 1
  }
  return data.length - 1
}
