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
  return { bytes: bytes.subarray(includeAdjacentClearPrefix(bytes, span.start)), clear: true }
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
