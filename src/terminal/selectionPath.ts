const LOCAL_PATH_PREFIX = /^(?:[a-zA-Z]:[\\/]|\\\\|~[\\/]|\/)/
const TRAILING_PUNCTUATION = /[.,;:!?)}\]]+$/

export function pathFromTerminalSelection(selection: string): string | null {
  let value = selection.replace(/\r?\n/g, '').trim()
  if (value.length < 2) return null

  const first = value[0]
  const last = value[value.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
    value = value.slice(1, -1).trim()
  }

  value = value.replace(TRAILING_PUNCTUATION, '').trim()
  if (!LOCAL_PATH_PREFIX.test(value)) return null
  if (/[<>|*?\0]/.test(value)) return null
  return value
}
