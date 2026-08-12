// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { SerializeAddon } from '@xterm/addon-serialize'
import { findUrlMatches } from './links'

async function captureAndRestore(source: string): Promise<Terminal> {
  const origin = new Terminal({ cols: 80, rows: 10, scrollback: 200, allowProposedApi: true })
  const addon = new SerializeAddon()
  origin.loadAddon(addon)
  await new Promise<void>((resolve) => origin.write(source, resolve))
  const snapshot = addon.serialize({ scrollback: 200, excludeAltBuffer: true })
  origin.dispose()

  // Exactly what a reattach does: a fresh emulator parses the snapshot.
  const restored = new Terminal({ cols: 80, rows: 10, scrollback: 200, allowProposedApi: true })
  await new Promise<void>((resolve) => restored.write(snapshot, resolve))
  return restored
}

function lineText(term: Terminal, row: number): string {
  return term.buffer.active.getLine(row)?.translateToString(true).trimEnd() ?? ''
}

describe('what a rendered snapshot preserves', () => {
  it('keeps plain URLs verbatim, so restored output stays clickable through our own link provider', async () => {
    const restored = await captureAndRestore('see https://example.com/plain for details\r\n')

    const line = lineText(restored, 0)
    expect(line).toBe('see https://example.com/plain for details')
    expect(findUrlMatches(line).map((match) => match.text)).toEqual(['https://example.com/plain'])

    restored.dispose()
  })

  /** A KNOWN, deliberate limitation, pinned so an addon bump that changes it is
   *  noticed instead of silently altering restore fidelity.
   *
   *  `@xterm/addon-serialize` 0.14.0 does not emit OSC 8, so a hyperlink whose
   *  display text differs from its target loses the target across a restart; the
   *  text and its styling survive. Orca solved this by rebuilding the addon
   *  bundle from patched source (`774bbc78`); the injection point is the string
   *  serializer's `_nextCell`, reading `cell.extended.urlId` and resolving it
   *  through `terminal._core._oscLinkService.getLinkData`. We deliberately do
   *  NOT hand-edit a minified vendor bundle for this: every URL these panes
   *  actually print is plain text, which the test above proves still works. */
  it('does not carry an OSC 8 target across a capture, and says so out loud', async () => {
    const restored = await captureAndRestore('open \x1b]8;;https://example.com/target\x07the report\x1b]8;;\x07 now\r\n')

    expect(lineText(restored, 0)).toBe('open the report now')
    // The target is gone: nothing in the restored buffer can resolve it.
    expect(findUrlMatches(lineText(restored, 0))).toEqual([])

    restored.dispose()
  })
})
