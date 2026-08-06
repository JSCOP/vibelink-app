export type SnapshotCursorQuery = 'standard' | 'private'

export function snapshotCursorQueries(bytes: Uint8Array): SnapshotCursorQuery[] {
  const queries: SnapshotCursorQuery[] = []
  for (let index = 0; index + 3 < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x1b || bytes[index + 1] !== 0x5b) continue
    const privateQuery = bytes[index + 2] === 0x3f
    const parameterOffset = privateQuery ? index + 3 : index + 2
    if (bytes[parameterOffset] !== 0x36 || bytes[parameterOffset + 1] !== 0x6e) continue
    queries.push(privateQuery ? 'private' : 'standard')
    index = parameterOffset + 1
  }
  return queries
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39
}

export function hasCursorResponse(input: readonly string[], query: SnapshotCursorQuery): boolean {
  return input.some((value) => {
    for (let start = 0; start < value.length - 5; start += 1) {
      if (value.charCodeAt(start) !== 0x1b || value.charCodeAt(start + 1) !== 0x5b) continue
      let cursor = start + 2
      if (query === 'private') {
        if (value.charCodeAt(cursor) !== 0x3f) continue
        cursor += 1
      } else if (value.charCodeAt(cursor) === 0x3f) {
        continue
      }

      const rowStart = cursor
      while (isAsciiDigit(value.charCodeAt(cursor))) cursor += 1
      if (cursor === rowStart || value.charCodeAt(cursor) !== 0x3b) continue
      cursor += 1

      const columnStart = cursor
      while (isAsciiDigit(value.charCodeAt(cursor))) cursor += 1
      if (cursor > columnStart && value.charCodeAt(cursor) === 0x52) return true
    }
    return false
  })
}
