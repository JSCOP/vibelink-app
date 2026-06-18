import { invoke } from '@tauri-apps/api/core'
import { Terminal } from '@xterm/xterm'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { defaultTerminalThemeId, terminalThemeById, type TerminalThemeId } from '../state/terminalThemes'
import { isTerminalHostMeasurable } from './geometry'

const terminalTheme = terminalThemeById(defaultTerminalThemeId)

type TerminalVisualSettings = {
  fontFamily: string
  fontSize: number
  scrollback: number
  terminalThemeId: TerminalThemeId
}

const defaultTerminalSettings: TerminalVisualSettings = {
  fontFamily: '"D2CodingLigature Nerd Font Mono", "Cascadia Code", Consolas, monospace',
  fontSize: 11,
  scrollback: 5000,
  terminalThemeId: defaultTerminalThemeId,
}

type Entry = {
  term: Terminal
  fit: FitAddon
  webgl?: WebglAddon
  opened: boolean
  daemonAttached: boolean
  dataWired: boolean
  observer?: ResizeObserver
  fitFrame?: number
  container?: HTMLElement
  titleDisposable?: { dispose: () => void }
  titleHandler?: (title: string) => void
}


class TerminalManagerImpl {
  private entries = new Map<string, Entry>()
  private settings: TerminalVisualSettings = defaultTerminalSettings

  applySettings(settings: TerminalVisualSettings): void {
    this.settings = settings
    for (const entry of this.entries.values()) {
      entry.term.options.fontFamily = settings.fontFamily
      entry.term.options.fontSize = settings.fontSize
      entry.term.options.scrollback = settings.scrollback
      entry.term.options.theme = terminalThemeById(settings.terminalThemeId)
      this.fit(entry, 0)
    }
  }
  getOrCreate(paneId: string): Entry {
    const existing = this.entries.get(paneId)
    if (existing) return existing

    const term = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: this.settings.fontFamily,
      fontSize: this.settings.fontSize,
      lineHeight: 1.15,
      scrollback: this.settings.scrollback,
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


  attach(paneId: string, container: HTMLElement, options?: { onTitleChange?: (title: string) => void }): void {
    const entry = this.getOrCreate(paneId)
    entry.container = container

    if (!entry.opened) {
      entry.term.open(container)
      entry.opened = true
      this.tryLoadWebgl(entry)
    } else if (entry.term.element && entry.term.element.parentElement !== container) {
      container.appendChild(entry.term.element)
    }

    if (!entry.dataWired) {
      entry.term.onData((data) => {
        void invoke('write_pane', { paneId, data })
      })
      entry.term.onResize(({ cols, rows }) => {
        void invoke('resize_pane', { paneId, cols, rows })
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

    if (!entry.daemonAttached) {
      entry.daemonAttached = true
      void invoke('attach_pane', { paneId })
    }

    entry.observer?.disconnect()
    entry.observer = new ResizeObserver(() => this.fit(entry, 0))
    entry.observer.observe(container)
    this.fit(entry, 0)
  }

  reattachToDaemon(paneIds: string[]): void {
    for (const paneId of paneIds) {
      const entry = this.entries.get(paneId)
      if (!entry) continue
      entry.daemonAttached = true
      void invoke('attach_pane', { paneId })
    }
  }

  write(paneId: string, bytes: Uint8Array): void {
    const entry = this.getOrCreate(paneId)
    entry.term.write(bytes)
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
    entry.webgl?.dispose()
    entry.term.dispose()
    this.entries.delete(paneId)
  }

  private fit(entry: Entry, attempt: number): void {
    if (entry.fitFrame !== undefined) cancelAnimationFrame(entry.fitFrame)
    entry.fitFrame = requestAnimationFrame(() => {
      entry.fitFrame = undefined
      const rect = entry.container?.getBoundingClientRect()
      if (!rect || !isTerminalHostMeasurable(rect)) {
        if (attempt < 10) this.fit(entry, attempt + 1)
        return
      }
      try {
        entry.fit.fit()
        entry.term.refresh(0, Math.max(0, entry.term.rows - 1))
      } catch {
        if (attempt < 10) this.fit(entry, attempt + 1)
      }
    })
  }

  private tryLoadWebgl(entry: Entry): void {
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl.dispose()
        if (entry.webgl === webgl) entry.webgl = undefined
      })
      entry.term.loadAddon(webgl)
      entry.webgl = webgl
    } catch {
      entry.webgl = undefined
    }
  }
}

export const TerminalManager = new TerminalManagerImpl()
export { terminalTheme }
