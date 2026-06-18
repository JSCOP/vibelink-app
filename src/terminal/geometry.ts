type TerminalHostSize = {
  width: number
  height: number
}

export function isTerminalHostMeasurable(size: TerminalHostSize): boolean {
  return size.width > 0 && size.height > 0
}
