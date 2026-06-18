import { invoke } from '@tauri-apps/api/core'
import { Terminal } from '@xterm/xterm'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'

const terminalTheme = {
  background: '#0b0f14',
  foreground: '#d6deeb',
  cursor: '#7ee787',
  cursorAccent: '#0b0f14',
  selectionBackground: '#264f78',
  black: '#0b0f14',
  red: '#ff6b6b',
  green: '#7ee787',
  yellow: '#f2cc60',
  blue: '#79c0ff',
  magenta: '#d2a8ff',
  cyan: '#76e3ea',
  white: '#d6deeb',
  brightBlack: '#5c6773',
  brightRed: '#ff8f8f',
  brightGreen: '#9ff5b7',
  brightYellow: '#f7dc84',
  brightBlue: '#9ecbff',
  brightMagenta: '#e2c5ff',
  brightCyan: '#9af0f5',
  brightWhite: '#ffffff',
}

type Entry = {
  term: Terminal
  fit: FitAddon
  webgl?: WebglAddon
  opened: boolean
  daemonAttached: boolean
  dataWired: boolean
  observer?: ResizeObserver
  container?: HTMLElement
}

class TerminalManagerImpl {
  private entries = new Map<string, Entry>()

  getOrCreate(paneId: string): Entry {
    const existing = this.entries.get(paneId)
    if (existing) return existing

    const term = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 5000,
      theme: terminalTheme,
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

  attach(paneId: string, container: HTMLElement): void {
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

    if (!entry.daemonAttached) {
      entry.daemonAttached = true
      void invoke('attach_pane', { paneId })
    }

    entry.observer?.disconnect()
    entry.observer = new ResizeObserver(() => this.fit(entry))
    entry.observer.observe(container)
    this.fit(entry)
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
    entry.webgl?.dispose()
    entry.term.dispose()
    this.entries.delete(paneId)
  }

  private fit(entry: Entry): void {
    requestAnimationFrame(() => {
      try {
        entry.fit.fit()
      } catch {
        // xterm can throw while dockview is measuring hidden containers.
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
