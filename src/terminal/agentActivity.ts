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
  /** The previous chunk ended on a lone ESC. Its introducer is the first
   *  character of the next chunk, so the sequence must not be resolved yet. */
  pendingEsc: boolean
}

type TimerHandle = number | NodeJS.Timeout
type PendingAgentResponse = {
  sawOutput: boolean
  timer: TimerHandle | undefined
  parse: OutputParseState
  /** Per-response, and fed every chunk in order, so a multibyte codepoint split
   *  across two PTY reads decodes as itself instead of U+FFFD. Released with
   *  the map entry in `clear`/`complete`. */
  decoder: TextDecoder
}

type PaneInputState = {
  draft: string
  inPaste: boolean
}

export const defaultAgentResponseQuietMs = 8_000
const maxDraftChars = 4096

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

    // Decode before any early return: the streaming decoder only reassembles a
    // split codepoint if every chunk reaches it, in order. A chunk ending on a
    // partial sequence legitimately yields ''.
    const text = pending.decoder.decode(bytes, { stream: true })

    if (pending.sawOutput && !text.includes('\u0007')) {
      // Still advance the control-sequence state, or an OSC opened here would
      // never be seen as closed. Same parser as below, just not collecting.
      stripTerminalControls(text, pending.parse, false)
      this.scheduleCompletion(paneId, pending)
      return
    }

    const { text: stripped, bell } = stripTerminalControls(text, pending.parse)
    if (hasAgentResponseContent(stripped)) pending.sawOutput = true
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

  /** Pane ids whose agent has an unfinished turn: a prompt was submitted and
   *  neither a BEL nor the output-quiet window has completed it yet. Used by
   *  the exit confirmation, which must only interrupt real in-flight work. */
  respondingPaneIds(): string[] {
    return [...this.pending.keys()]
  }

  private startPendingResponse(paneId: string): void {
    if (!this.actions.isAgentPane(paneId)) return
    this.clear(paneId)
    this.pending.set(paneId, {
      sawOutput: false,
      timer: undefined,
      parse: { inOsc: false, inCsi: false, pendingEsc: false },
      decoder: new TextDecoder(),
    })
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


export const agentActivityTracker = new AgentActivityTracker()

export function noteAgentPromptSubmitted(paneId: string): void {
  agentActivityTracker.notePromptSubmitted(paneId)
}

type StrippedOutput = {
  text: string
  bell: boolean
}

/** The single control-sequence parser. `collect: false` advances `state` without
 *  building the stripped text, for the hot path that only needs the sequence
 *  state kept current. A second byte-level state machine used to exist for that
 *  path; the two drifted apart, which is how the split-ESC bug survived. */
function stripTerminalControls(text: string, state: OutputParseState, collect = true): StrippedOutput {
  let out = ''
  let bell = false
  let index = 0
  if (state.pendingEsc && text.length > 0) {
    // The previous chunk ended on ESC; this chunk opens with its introducer.
    state.pendingEsc = false
    const introducer = text.charCodeAt(0)
    if (state.inOsc) {
      // Only `ESC \` terminates the string. Any other byte leaves the ESC
      // consumed and re-examines this character inside the OSC below.
      if (introducer === 0x5c) {
        state.inOsc = false
        index = 1
      }
    } else if (introducer === 0x5d) {
      state.inOsc = true
      index = 1
    } else if (introducer === 0x5b) {
      state.inCsi = true
      index = 1
    } else {
      if (collect) out += ' '
      index = 1
    }
  }
  while (index < text.length) {
    if (state.inOsc) {
      const current = text.charCodeAt(index)
      if (current === 0x07) {
        state.inOsc = false
      } else if (current === 0x1b) {
        if (index + 1 >= text.length) {
          state.pendingEsc = true
          break
        }
        if (text.charCodeAt(index + 1) === 0x5c) {
          state.inOsc = false
          index += 1
        }
      }
      index += 1
      continue
    }
    if (state.inCsi) {
      const current = text.charCodeAt(index)
      index += 1
      if (current >= 0x40 && current <= 0x7e) {
        state.inCsi = false
        if (collect) out += ' '
      }
      continue
    }
    const code = text.charCodeAt(index)
    if (code === 0x1b) {
      if (index + 1 >= text.length) {
        state.pendingEsc = true
        break
      }
      const next = text.charCodeAt(index + 1)
      if (next === 0x5d) {
        state.inOsc = true
      } else if (next === 0x5b) {
        state.inCsi = true
      } else if (collect) {
        out += ' '
      }
      index += 2
      continue
    }
    if (code === 0x07) {
      bell = true
      if (collect) out += ' '
    } else if (code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f) {
      if (collect) out += ' '
    } else if (collect) {
      out += text[index]
    }
    index += 1
  }
  return { text: out, bell }
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
