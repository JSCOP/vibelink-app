const CLEAR_SEQUENCE_TEXT = [
  '\x1b[2J',
  '\x1b[3J',
  '\x1bc',
  '\x1b[H\x1b[J',
  '\x1b[H\x1b[0J',
  '\x1b[1;1H\x1b[J',
  '\x1b[1;1H\x1b[0J',
  '\x1b[f\x1b[J',
  '\x1b[f\x1b[0J',
]

const CLEAR_SEQUENCES = CLEAR_SEQUENCE_TEXT.map(asciiBytes)

export function terminalOutputAfterLastHardClear(bytes: Uint8Array): { bytes: Uint8Array; clear: boolean } {
  if (bytes.indexOf(0x1b) < 0) return { bytes, clear: false }
  const span = findLastClearSpan(bytes)
  if (!span) return { bytes, clear: false }
  const start = includeAdjacentClearPrefix(bytes, span.start)
  // Terminal-STATE changes hidden in the dropped prefix would be lost forever:
  // a dropped `ESC[?1049l` leaves xterm stuck in the alternate buffer (which
  // has no scrollback, and where the wheel handler intentionally swallows
  // scroll events) — the "pane never scrolls again after a zoom/resume repaint"
  // bug. Replay those sequences, in order, ahead of the retained clear+repaint;
  // the clear only erases screen CONTENT, so re-asserting modes is always safe.
  const preserved = terminalStateSequencesIn(bytes, start)
  const tail = bytes.subarray(start)
  if (preserved.length === 0) return { bytes: tail, clear: true }
  const merged = new Uint8Array(preserved.reduce((total, part) => total + part.byteLength, tail.byteLength))
  let offset = 0
  for (const part of preserved) {
    merged.set(part, offset)
    offset += part.byteLength
  }
  merged.set(tail, offset)
  return { bytes: merged, clear: true }
}

/** Terminal-state-changing sequences contained in a byte span that is about to
 *  be discarded (trimmed backlog). See terminalStateSequencesIn. */
export function terminalStateSequences(bytes: Uint8Array): Uint8Array[] {
  return terminalStateSequencesIn(bytes, bytes.byteLength)
}

/** Collect terminal queries that were received live but are covered by a
 * stripped daemon snapshot. Replaying only these queries lets xterm answer a
 * current ConPTY/TUI handshake without re-answering historical probes. */
export function terminalQuerySequences(bytes: Uint8Array): Uint8Array[] {
  const queries: Uint8Array[] = []
  let index = 0

  while (index < bytes.byteLength) {
    if (bytes[index] !== 0x1b) {
      index += 1
      continue
    }
    const kind = bytes[index + 1]
    if (kind === 0x5b) {
      let cursor = index + 2
      const paramsStart = cursor
      while (cursor < bytes.byteLength && bytes[cursor] >= 0x30 && bytes[cursor] <= 0x3f) cursor += 1
      const paramsEnd = cursor
      while (cursor < bytes.byteLength && bytes[cursor] >= 0x20 && bytes[cursor] <= 0x2f) cursor += 1
      const final = bytes[cursor]
      if (cursor >= bytes.byteLength || final === undefined || final < 0x40 || final > 0x7e) break
      if (csiIsTerminalQuery(
        bytes.subarray(paramsStart, paramsEnd),
        bytes.subarray(paramsEnd, cursor),
        final,
      )) {
        queries.push(bytes.subarray(index, cursor + 1))
      }
      index = cursor + 1
      continue
    }
    if (kind === 0x5d || kind === 0x50) {
      const parsed = parseTerminalStringSequence(bytes, index)
      if (!parsed) break
      const payload = bytes.subarray(parsed.payloadStart, parsed.end)
      const dcsPayload = kind === 0x50 ? stripTerminalStringTerminator(payload) : undefined
      const isQuery = kind === 0x5d
        ? isOscTerminalQuery(payload)
        : Boolean(dcsPayload
          && dcsPayload.byteLength >= 2
          && (dcsPayload[0] === 0x2b || dcsPayload[0] === 0x24)
          && dcsPayload[1] === 0x71)
      if (isQuery) queries.push(bytes.subarray(index, parsed.end))
      index = parsed.end
      continue
    }
    index += 2
  }

  return queries
}


/** Collect terminal-state-changing sequences from `bytes[0..end)`, in order:
 *  SM/RM and DECSET/DECRST (`CSI [?] Pm h|l` — alt screen, mouse tracking,
 *  bracketed paste, cursor visibility, ...), kitty keyboard push/pop/set
 *  (`CSI >|<|= ... u`), cursor style (`CSI Ps SP q`), keypad modes (`ESC =`,
 *  `ESC >`), charset designation (`ESC ( X` / `ESC ) X`), and the last window
 *  title (`OSC 0|2 ; ... BEL|ST`). */
function terminalStateSequencesIn(bytes: Uint8Array, end: number): Uint8Array[] {
  const preserved: Uint8Array[] = []
  let lastTitle: Uint8Array | undefined
  let index = 0

  while (index < end) {
    if (bytes[index] !== 0x1b) {
      index += 1
      continue
    }
    const kind = bytes[index + 1]
    if (kind === 0x5b) {
      // CSI
      let cursor = index + 2
      const paramsStart = cursor
      while (cursor < end && bytes[cursor] >= 0x30 && bytes[cursor] <= 0x3f) cursor += 1
      const paramsEnd = cursor
      while (cursor < end && bytes[cursor] >= 0x20 && bytes[cursor] <= 0x2f) cursor += 1
      const final = bytes[cursor]
      if (cursor >= end || final === undefined || final < 0x40 || final > 0x7e) {
        index += 2
        continue
      }
      const intermediateCount = cursor - paramsEnd
      const firstParam = bytes[paramsStart]
      const isModeToggle = (final === 0x68 || final === 0x6c) && intermediateCount === 0
      const isKittyState = final === 0x75 && intermediateCount === 0
        && (firstParam === 0x3e || firstParam === 0x3c || firstParam === 0x3d)
      const isCursorStyle = final === 0x71 && intermediateCount === 1 && bytes[paramsEnd] === 0x20
      if (isModeToggle || isKittyState || isCursorStyle) {
        preserved.push(bytes.subarray(index, cursor + 1))
      }
      index = cursor + 1
      continue
    }
    if (kind === 0x3d || kind === 0x3e) {
      // ESC = / ESC > keypad modes
      preserved.push(bytes.subarray(index, index + 2))
      index += 2
      continue
    }
    if (kind === 0x28 || kind === 0x29) {
      // ESC ( X / ESC ) X charset designation
      if (index + 2 < end) preserved.push(bytes.subarray(index, index + 3))
      index += 3
      continue
    }
    if (kind === 0x5d) {
      // OSC ... BEL | ST
      let cursor = index + 2
      while (cursor < end && bytes[cursor] !== 0x07 && !(bytes[cursor] === 0x1b && bytes[cursor + 1] === 0x5c)) cursor += 1
      if (cursor >= end) {
        index = end
        continue
      }
      const terminatorLength = bytes[cursor] === 0x07 ? 1 : 2
      const code = bytes[index + 2]
      if ((code === 0x30 || code === 0x32) && bytes[index + 3] === 0x3b) {
        lastTitle = bytes.subarray(index, cursor + terminatorLength)
      }
      index = cursor + terminatorLength
      continue
    }
    index += 2
  }

  if (lastTitle) preserved.push(lastTitle)
  return preserved
}

function csiIsTerminalQuery(params: Uint8Array, intermediates: Uint8Array, final: number): boolean {
  if (intermediates.byteLength === 0) {
    if (final === 0x63 || final === 0x6e) return true
    if (final === 0x71 && params[0] === 0x3e) return true
    if (final === 0x75 && params.byteLength === 1 && params[0] === 0x3f) return true
    if (final === 0x74) {
      const leading = leadingTerminalNumber(params)
      return leading === 14 || leading === 16 || leading === 18
    }
  }
  return final === 0x70 && intermediates.byteLength === 1 && intermediates[0] === 0x24
}

function leadingTerminalNumber(params: Uint8Array): number | undefined {
  let cursor = 0
  let value = 0
  while (cursor < params.byteLength && params[cursor] >= 0x30 && params[cursor] <= 0x39) {
    value = value * 10 + params[cursor] - 0x30
    cursor += 1
  }
  if (cursor === 0) return undefined
  const separator = params[cursor]
  return separator === undefined || separator === 0x3b || separator === 0x3a ? value : undefined
}

function parseTerminalStringSequence(bytes: Uint8Array, start: number): { end: number; payloadStart: number } | undefined {
  const payloadStart = start + 2
  let cursor = payloadStart
  while (cursor < bytes.byteLength) {
    if (bytes[cursor] === 0x07) return { end: cursor + 1, payloadStart }
    if (bytes[cursor] === 0x1b && bytes[cursor + 1] === 0x5c) return { end: cursor + 2, payloadStart }
    cursor += 1
  }
  return undefined
}

function isOscTerminalQuery(payloadWithTerminator: Uint8Array): boolean {
  const payload = stripTerminalStringTerminator(payloadWithTerminator)
  const firstSeparator = payload.indexOf(0x3b)
  if (firstSeparator < 0) return false
  let code = 0
  for (let index = 0; index < firstSeparator; index += 1) {
    const digit = payload[index]
    if (digit < 0x30 || digit > 0x39) return false
    code = code * 10 + digit - 0x30
  }
  const answerable = code === 4 || code === 5 || (code >= 10 && code <= 19) || code === 52
  if (!answerable) return false
  const args = payload.subarray(firstSeparator + 1)
  return (args.byteLength === 1 && args[0] === 0x3f)
    || (args.byteLength >= 2 && args[args.byteLength - 2] === 0x3b && args[args.byteLength - 1] === 0x3f)
}


function stripTerminalStringTerminator(payload: Uint8Array): Uint8Array {
  if (payload[payload.byteLength - 1] === 0x07) return payload.subarray(0, payload.byteLength - 1)
  if (payload.byteLength >= 2
    && payload[payload.byteLength - 2] === 0x1b
    && payload[payload.byteLength - 1] === 0x5c) {
    return payload.subarray(0, payload.byteLength - 2)
  }
  return payload
}

function includeAdjacentClearPrefix(bytes: Uint8Array, start: number): number {
  let nextStart = start
  for (;;) {
    const sequence = CLEAR_SEQUENCES.find((candidate) => {
      return nextStart >= candidate.byteLength && bytesMatch(bytes, nextStart - candidate.byteLength, candidate)
    })
    if (!sequence) return nextStart
    nextStart -= sequence.byteLength
  }
}

function findLastClearSpan(bytes: Uint8Array): { start: number; end: number } | undefined {
  let match: { start: number; end: number } | undefined
  for (const sequence of CLEAR_SEQUENCES) {
    const start = findLastSubarray(bytes, sequence)
    if (start < 0) continue
    const end = start + sequence.byteLength
    if (!match || end > match.end) match = { start, end }
  }
  return match
}

function findLastSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.byteLength === 0 || needle.byteLength > haystack.byteLength) return -1
  for (let i = haystack.byteLength - needle.byteLength; i >= 0; i -= 1) {
    if (bytesMatch(haystack, i, needle)) return i
  }
  return -1
}

function bytesMatch(haystack: Uint8Array, offset: number, needle: Uint8Array): boolean {
  for (let i = 0; i < needle.byteLength; i += 1) {
    if (haystack[offset + i] !== needle[i]) return false
  }
  return true
}

function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i)
  return bytes
}
