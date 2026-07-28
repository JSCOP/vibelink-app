/** Agent TUIs animate their OSC title: OMP/Codex rewrite `π ⠇ Task` → `π ⠋ Task`
 *  on every spinner frame. Each distinct title used to become one
 *  `set_pane_title` — a BLOCKING `request_reply` on the single daemon socket that
 *  also carries every keystroke's `write_pane` — plus a `SessionChanged`
 *  broadcast that made the frontend re-run `list_sessions` + `attach_session`
 *  and rewrite the whole pane store. Measured at 32.3 invokes/s across three
 *  agent panes, that head-of-line blocking moved `write_pane` from 1.8 ms p50 to
 *  7.4 ms p50 and kept React/Dockview permanently re-rendering, which is what
 *  users perceive as stuttering, bursty typing.
 *
 *  Two guards, in order:
 *  1. Signature dedupe — a title that differs only by animation glyphs never
 *     reaches IPC at all, so an idle spinner costs nothing.
 *  2. Leading-edge debounce — a genuinely new title lands immediately, and any
 *     further changes inside the window collapse into one trailing emit, so a
 *     fast-changing real title (progress counters) cannot storm either. */
export const TITLE_COALESCE_MS = 250

/** Glyph runs terminal UIs animate in place. Braille (U+2800–U+28FF) covers the
 *  OMP/Codex/Claude spinners; the rest are the common block, arc, and ASCII
 *  wheels. Trailing dot animations (`Working.` → `Working...`) collapse too. */
const ANIMATION_GLYPHS = /[\u2800-\u28ff\u2801-\u28ff▁▂▃▄▅▆▇█▏▎▍▌▋▊▉◐◓◑◒◴◵◶◷◜◝◞◟◠◡⣾⣽⣻⢿⡿⣟⣯⣷|/\\-]+/gu

/** The part of a title that is NOT animation. Two titles sharing a signature are
 *  the same title with the spinner on a different frame. */
export function paneTitleSignature(title: string): string {
  return title
    .replace(ANIMATION_GLYPHS, ' ')
    .replace(/\.{1,6}(?=\s*$)/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

type PaneTitleState = {
  timer?: number
  /** Signature of the last title actually handed to the emitter. */
  sentSignature?: string
  /** Newest title seen since the last emit, verbatim. */
  pending?: string
  lastEmitAt?: number
}

type Scheduling = {
  now: () => number
  setTimer: (callback: () => void, delayMs: number) => number
  clearTimer: (handle: number) => void
}

const defaultScheduling: Scheduling = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (handle) => window.clearTimeout(handle),
}

export class PaneTitleCoalescer {
  private states = new Map<string, PaneTitleState>()

  constructor(private scheduling: Scheduling = defaultScheduling) {}

  /** Feed one raw OSC title. `emit` runs at most once per `TITLE_COALESCE_MS`
   *  per pane, and never at all for a spinner-only change. */
  submit(paneId: string, title: string, emit: (title: string) => void): void {
    const signature = paneTitleSignature(title)
    const state = this.states.get(paneId) ?? {}
    this.states.set(paneId, state)
    // A pure animation tick carries no information the user can act on, and the
    // previously sent title already renders identically apart from the glyph.
    if (signature === state.sentSignature) return

    state.pending = title
    if (state.timer !== undefined) return

    const now = this.scheduling.now()
    const sinceLastEmit = state.lastEmitAt === undefined ? Number.POSITIVE_INFINITY : now - state.lastEmitAt
    if (sinceLastEmit >= TITLE_COALESCE_MS) {
      this.flush(paneId, emit)
      return
    }
    state.timer = this.scheduling.setTimer(() => {
      const current = this.states.get(paneId)
      if (current) current.timer = undefined
      this.flush(paneId, emit)
    }, TITLE_COALESCE_MS - sinceLastEmit)
  }

  /** Drops a disposed pane's pending emit so a closed pane cannot rename itself
   *  after teardown. */
  clear(paneId: string): void {
    const state = this.states.get(paneId)
    if (state?.timer !== undefined) this.scheduling.clearTimer(state.timer)
    this.states.delete(paneId)
  }

  private flush(paneId: string, emit: (title: string) => void): void {
    const state = this.states.get(paneId)
    const pending = state?.pending
    if (!state || pending === undefined) return
    state.pending = undefined
    state.sentSignature = paneTitleSignature(pending)
    state.lastEmitAt = this.scheduling.now()
    emit(pending)
  }
}
