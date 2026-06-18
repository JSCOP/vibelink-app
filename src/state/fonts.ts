export const preferredFontFamily = 'D2CodingLigature Nerd Font Mono'

export const defaultFontChoices = [
  preferredFontFamily,
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
    for (const font of splitFontFamilyList(value)) {
      const normalized = normalizeFontName(font)
      if (!normalized || seen.has(normalized.toLocaleLowerCase())) continue
      seen.add(normalized.toLocaleLowerCase())
      choices.push(normalized)
    }
  }

  add(currentFontFamily)
  for (const font of defaultFontChoices) add(font)
  for (const font of installedFonts) add(font)

  return choices.length > 0 ? choices : defaultFontChoices
}

function splitFontFamilyList(value: string): string[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean)
}

function normalizeFontName(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\s+(Regular|Bold|Italic|Oblique|Light|Medium|SemiBold|ExtraBold|Black)$/i, '')
    .replace(/\s+/g, ' ')
  return normalized.length > 0 ? normalized : null
}
