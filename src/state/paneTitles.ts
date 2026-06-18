export type ManualPaneTitleMap = Record<string, boolean>

export function normalizePaneTitle(title: string): string | null {
  const normalized = [...title]
    .map((char) => {
      const codePoint = char.codePointAt(0) ?? 0
      return codePoint < 32 || codePoint === 127 ? ' ' : char
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized.length > 0 ? normalized : null
}

export function shouldApplyAutoTitle(paneId: string, manualTitles: ManualPaneTitleMap): boolean {
  return manualTitles[paneId] !== true
}
