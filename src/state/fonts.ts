export const defaultFontChoices = [
  'D2CodingLigature Nerd Font Mono',
  'Cascadia Code',
  'Cascadia Mono',
  'Consolas',
  'JetBrains Mono',
  'Fira Code',
  'monospace',
]

export function normalizeFontChoices(installedFonts: string[], currentFontFamily: string): string[] {
  const choices: string[] = []
  const seen = new Set<string>()

  const add = (value: string): void => {
    const normalized = normalizeFontName(value)
    if (!normalized || seen.has(normalized.toLocaleLowerCase())) return
    seen.add(normalized.toLocaleLowerCase())
    choices.push(normalized)
  }

  for (const font of installedFonts) add(font)
  for (const font of defaultFontChoices) add(font)
  add(currentFontFamily)

  return choices.length > 0 ? choices : defaultFontChoices
}

function normalizeFontName(value: string): string | null {
  const normalized = value.trim().replace(/^['"]|['"]$/g, '').replace(/\s+/g, ' ')
  return normalized.length > 0 ? normalized : null
}
