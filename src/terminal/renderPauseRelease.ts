type MaybePausableRenderService = {
  _isPaused?: boolean
  _needsFullRefresh?: boolean
  refreshRows?: (start: number, end: number, sync?: boolean) => void
}

type TerminalWithRenderService = {
  rows?: number
  _core?: {
    _renderService?: MaybePausableRenderService
  }
}

/**
 * Forces one synchronous full-viewport repaint when xterm still considers a
 * newly-visible screen paused. Private xterm fields are guarded so upgrades
 * degrade to the caller's normal refresh path instead of breaking recovery.
 */
export function forceRepaintThroughRenderPause(terminal: unknown): boolean {
  const target = terminal as TerminalWithRenderService | null
  const service = target?._core?._renderService
  if (!service || service._isPaused !== true || typeof service.refreshRows !== 'function') return false
  if (typeof target.rows !== 'number' || target.rows < 1) return false

  service._isPaused = false
  service._needsFullRefresh = false
  try {
    service.refreshRows(0, target.rows - 1, true)
    return true
  } catch {
    return false
  }
}
