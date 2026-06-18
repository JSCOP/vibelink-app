export type TerminalSelection = {
  selectAll(): void
  getSelection(): string
}

export type ClipboardWriter = {
  writeText(text: string): Promise<void>
}

export async function copyAllTerminalContents(
  terminal: TerminalSelection,
  clipboard: ClipboardWriter | undefined = globalThis.navigator?.clipboard,
): Promise<boolean> {
  terminal.selectAll()
  const text = terminal.getSelection()
  if (!text) return false
  if (clipboard) {
    await clipboard.writeText(text)
  } else {
    copyTextWithTextarea(text)
  }
  return true
}

export async function copyTerminalSelection(
  terminal: Pick<TerminalSelection, 'getSelection'>,
  clipboard: ClipboardWriter | undefined = globalThis.navigator?.clipboard,
): Promise<boolean> {
  const text = terminal.getSelection()
  if (!text) return false
  if (clipboard) {
    await clipboard.writeText(text)
  } else {
    copyTextWithTextarea(text)
  }
  return true
}

function copyTextWithTextarea(text: string): void {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

