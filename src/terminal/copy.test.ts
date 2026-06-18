import { describe, expect, it, vi } from 'vitest'
import { copyAllTerminalContents } from './copy'

describe('terminal copy helpers', () => {
  it('selects all terminal text before copying it to the clipboard', async () => {
    let selected = false
    const terminal = {
      selectAll: vi.fn(() => {
        selected = true
      }),
      getSelection: vi.fn(() => selected ? 'first line\nsecond line' : ''),
    }
    const clipboard = { writeText: vi.fn(async () => undefined) }

    await expect(copyAllTerminalContents(terminal, clipboard)).resolves.toBe(true)

    expect(terminal.selectAll).toHaveBeenCalledOnce()
    expect(terminal.getSelection).toHaveBeenCalledOnce()
    expect(clipboard.writeText).toHaveBeenCalledWith('first line\nsecond line')
  })

  it('does not write to the clipboard when the selected terminal text is empty', async () => {
    const terminal = {
      selectAll: vi.fn(),
      getSelection: vi.fn(() => ''),
    }
    const clipboard = { writeText: vi.fn(async () => undefined) }

    await expect(copyAllTerminalContents(terminal, clipboard)).resolves.toBe(false)

    expect(terminal.selectAll).toHaveBeenCalledOnce()
    expect(clipboard.writeText).not.toHaveBeenCalled()
  })
})
