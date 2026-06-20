import { invoke } from '@tauri-apps/api/core'
import { Terminal, type FontWeight } from '@xterm/xterm'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { defaultTerminalThemeId, terminalThemeById, type TerminalThemeId } from '../state/terminalThemes'
import { preferredFontFamily, terminalFontStack } from '../state/fonts'
import { isTerminalHostMeasurable } from './geometry'
import { copyAllTerminalContents, copyTerminalSelection } from './copy'

const terminalTheme = terminalThemeById(defaultTerminalThemeId)
const MAX_FIT_ATTEMPTS = 120

type TerminalVisualSettings = {
  fontFamily: string
  fontSize: number
  terminalFontWeight: number
  scrollback: number
  terminalThemeId: TerminalThemeId
  terminalScrollbarVisible: boolean
}

const defaultTerminalSettings: TerminalVisualSettings = {
  fontFamily: preferredFontFamily,
  fontSize: 11,
  terminalFontWeight: 400,
  scrollback: 5000,
  terminalThemeId: defaultTerminalThemeId,
  terminalScrollbarVisible: false,
}

type Entry = {
  term: Terminal
  fit: FitAddon
  opened: boolean
  daemonAttached: boolean
  dataWired: boolean
  sessionId?: string
  observer?: ResizeObserver
  fitFrame?: number
  container?: HTMLElement
  titleDisposable?: { dispose: () => void }
  titleHandler?: (title: string) => void
}

class TerminalManagerImpl {
  private entries = new Map<string, Entry>()
  private settings: TerminalVisualSettings = defaultTerminalSettings

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.resumeRendering()
      })
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', () => this.resumeRendering())
    }
  }

  applySettings(settings: TerminalVisualSettings): void {
    const fontChanged = this.settings.fontFamily !== settings.fontFamily || this.settings.fontSize !== settings.fontSize || this.settings.terminalFontWeight !== settings.terminalFontWeight
    const themeChanged = this.settings.terminalThemeId !== settings.terminalThemeId
    this.settings = settings
    for (const entry of this.entries.values()) {
      entry.term.options.fontFamily = terminalFontStack(settings.fontFamily)
      entry.term.options.fontSize = settings.fontSize
      entry.term.options.fontWeight = terminalFontWeight(settings.terminalFontWeight)
      entry.term.options.fontWeightBold = terminalBoldFontWeight(settings.terminalFontWeight)
      entry.term.options.scrollback = settings.scrollback
      entry.term.options.theme = terminalThemeById(settings.terminalThemeId)
      this.applyScrollbarVisibility(entry)
      if (fontChanged) this.fitAfterFontsLoad(entry)
      if (fontChanged || themeChanged) this.redrawAfterNextFrame(entry)
      this.fit(entry, 0, true)
    }
  }
  getOrCreate(paneId: string): Entry {
    const existing = this.entries.get(paneId)
    if (existing) return existing

    const term = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: terminalFontStack(this.settings.fontFamily),
      fontSize: this.settings.fontSize,
      fontWeight: terminalFontWeight(this.settings.terminalFontWeight),
      fontWeightBold: terminalBoldFontWeight(this.settings.terminalFontWeight),
      lineHeight: 1.15,
      scrollback: this.settings.scrollback,
      minimumContrastRatio: 1,
      theme: terminalThemeById(this.settings.terminalThemeId),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new SearchAddon())
    term.loadAddon(new WebLinksAddon())
    term.loadAddon(new Unicode11Addon())
    term.loadAddon(new ClipboardAddon())
    term.unicode.activeVersion = '11'

    const entry: Entry = { term, fit, opened: false, daemonAttached: false, dataWired: false }
    this.entries.set(paneId, entry)
    return entry
  }


  attach(paneId: string, container: HTMLElement, options: { sessionId?: string; onTitleChange?: (title: string) => void } = {}): void {
    const entry = this.getOrCreate(paneId)
    const previousSessionId = entry.sessionId
    entry.sessionId = options.sessionId
    entry.container = container
    this.applyScrollbarVisibility(entry)

    if (!entry.opened) {
      entry.term.open(container)
      entry.opened = true
    } else if (entry.term.element && entry.term.element.parentElement !== container) {
      container.appendChild(entry.term.element)
      this.redraw(entry)
    }

    if (!entry.dataWired) {
      entry.term.onData((data) => {
        const sessionId = entry.sessionId
        if (sessionId) void invoke('write_pane', { sessionId, paneId, data })
      })
      entry.term.onResize(({ cols, rows }) => {
        const sessionId = entry.sessionId
        if (sessionId) void invoke('resize_pane', { sessionId, paneId, cols, rows })
      })
      entry.dataWired = true
    }

    if (entry.titleHandler !== options?.onTitleChange) {
      entry.titleDisposable?.dispose()
      entry.titleHandler = options?.onTitleChange
      entry.titleDisposable = options?.onTitleChange
        ? entry.term.onTitleChange((title) => options.onTitleChange?.(title))
        : undefined
    }

    if (options.sessionId && (!entry.daemonAttached || previousSessionId !== options.sessionId)) {
      entry.daemonAttached = true
      void invoke('attach_pane', { sessionId: options.sessionId, paneId })
    }

    entry.observer?.disconnect()
    entry.observer = new ResizeObserver(() => this.fit(entry, 0))
    entry.observer.observe(container)
    this.reflowEntry(entry, true)
    this.fitAfterFontsLoad(entry)
  }

  reattachToDaemon(sessionId: string | undefined, paneIds: string[]): void {
    if (!sessionId) return
    for (const paneId of paneIds) {
      const entry = this.entries.get(paneId)
      if (!entry) continue
      entry.sessionId = sessionId
      entry.daemonAttached = true
      void invoke('attach_pane', { sessionId, paneId })
    }
  }

  write(paneId: string, bytes: Uint8Array): void {
    const entry = this.getOrCreate(paneId)
    entry.term.write(bytes)
  }

  copyContentsToClipboard(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    void copyAllTerminalContents(entry.term)
  }

  copySelectionToClipboard(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    void copyTerminalSelection(entry.term)
  }

  focus(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    entry.term.focus()
    this.reflowEntry(entry, true)
  }

  reflow(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    this.reflowEntry(entry)
  }

  reflowAll(forceFit = false): void {
    for (const entry of this.entries.values()) {
      this.reflowEntry(entry, forceFit)
    }
  }

  resumeRendering(): void {
    this.reflowAll(true)
  }

  containsEventTarget(paneId: string, target: EventTarget | null): boolean {
    const entry = this.entries.get(paneId)
    return entry?.container !== undefined && target instanceof Node && entry.container.contains(target)
  }

  markExited(paneId: string, exitCode?: number | null): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    const suffix = exitCode == null ? '' : ` (${exitCode})`
    entry.term.write(`\r\n\x1b[31m[process exited${suffix}]\x1b[0m\r\n`)
  }

  dispose(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    entry.observer?.disconnect()
    if (entry.fitFrame !== undefined) cancelAnimationFrame(entry.fitFrame)
    entry.titleDisposable?.dispose()
    entry.term.dispose()
    this.entries.delete(paneId)
  }

  private applyScrollbarVisibility(entry: Entry): void {
    entry.container?.classList.toggle('terminal-scrollbar-hidden', !this.settings.terminalScrollbarVisible)
  }

  private redraw(entry: Entry): void {
    if (!entry.opened) return
    entry.term.refresh(0, Math.max(0, entry.term.rows - 1))
  }

  private redrawAfterNextFrame(entry: Entry): void {
    this.redraw(entry)
    requestAnimationFrame(() => this.redraw(entry))
  }

  private reflowEntry(entry: Entry, forceFit = false): void {
    this.redraw(entry)
    this.fit(entry, 0, forceFit)
    requestAnimationFrame(() => this.redraw(entry))
  }

  private fitAfterFontsLoad(entry: Entry): void {
    const fonts = document.fonts
    if (!fonts) return
    void fonts.ready.then(() => this.fit(entry, 0, true))
  }


  private fit(entry: Entry, attempt: number, force = false): void {
    if (entry.fitFrame !== undefined) cancelAnimationFrame(entry.fitFrame)
    entry.fitFrame = requestAnimationFrame(() => {
      entry.fitFrame = undefined
      const rect = entry.container?.getBoundingClientRect()
      if (!rect || !isTerminalHostMeasurable(rect)) {
        if (attempt < MAX_FIT_ATTEMPTS) this.fit(entry, attempt + 1, force)
        return
      }
      try {
        const proposed = entry.fit.proposeDimensions()
        const cols = proposed?.cols ?? entry.term.cols
        const rows = proposed?.rows ?? entry.term.rows
        if (force || entry.term.cols !== cols || entry.term.rows !== rows) {
          entry.fit.fit()
        }
        this.redrawAfterNextFrame(entry)
      } catch {
        if (attempt < MAX_FIT_ATTEMPTS) this.fit(entry, attempt + 1, force)
      }
    })
  }

}

function terminalFontWeight(weight: number): FontWeight {
  return String(weight) as FontWeight
}

function terminalBoldFontWeight(weight: number): FontWeight {
  return String(Math.min(900, Math.max(weight, 700))) as FontWeight
}

export const TerminalManager = new TerminalManagerImpl()
export { terminalTheme }
