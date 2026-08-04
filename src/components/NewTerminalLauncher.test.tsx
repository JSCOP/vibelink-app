// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { Profile } from '../state/profiles'
import { NewTerminalLauncher } from './NewTerminalLauncher'

const profile: Profile = {
  id: 'powershell',
  name: 'PowerShell',
  type: 'local',
  shell: 'pwsh.exe',
  args: ['-NoLogo'],
  command: '',
  sshHost: '',
  sshUser: '',
  sshPort: null,
  sshIdentityFile: null,
  sshRemoteCommand: '',
  sshRemoteCwd: null,
  sshOptions: '',
  sshAllocateTty: true,
  env: [],
  cwd: null,
  color: '#7ee787',
  icon: 'terminal',
}

const anchorRef = { current: document.createElement('button') }

afterEach(cleanup)

function renderHtml(element: ReactElement): string {
  render(element)
  return document.body.innerHTML
}

describe('NewTerminalLauncher', () => {
  it('reopens with the committed grid preference instead of rebalancing pane count', () => {
    const html = renderHtml(
      <NewTerminalLauncher
        isOpen
        anchorRef={anchorRef}
        existingPaneCount={12}
        preferredGrid={{ cols: 6, rows: 2 }}
        profiles={[profile]}
        activeProfileId="powershell"
        onClose={() => undefined}
        onLaunch={() => undefined}
      />,
    )

    expect(html).toContain('aria-label="6×2 occupied"')
    expect(html).toContain('aria-label="1×3 available"')
    expect(html).toContain('value="6"')
    expect(html).toContain('value="2"')
    expect(html).not.toContain('value="4"')
  })

  it('renders supplied occupancy matrices with holes available and matrix dimensions committed', () => {
    const html = renderHtml(
      <NewTerminalLauncher
        isOpen
        anchorRef={anchorRef}
        existingPaneCount={6}
        preferredGrid={{ cols: 2, rows: 2 }}
        occupancyMatrix={{
          cols: 4,
          rows: 3,
          cells: [
            [true, false, true, false],
            [false, true, false, true],
            [true, false, true, false],
          ],
        }}
        profiles={[profile]}
        activeProfileId="powershell"
        onClose={() => undefined}
        onLaunch={() => undefined}
      />,
    )

    expect(html).toContain('<strong>4×3</strong>')
    expect(html).toContain('value="4"')
    expect(html).toContain('value="3"')
    expect(html).toContain('aria-label="1×1 occupied"')
    expect(html).toContain('aria-label="3×1 occupied"')
    expect(html).toContain('aria-label="2×2 occupied"')
    expect(html).toContain('aria-label="4×2 occupied"')
    expect(html).toContain('aria-label="2×1 available"')
    expect(html).toContain('aria-label="1×2 available"')
    expect(html).toContain('aria-label="4×3 available"')
    expect(html).not.toContain('aria-label="2×1 occupied"')
    expect(html).not.toContain('aria-label="2×1 selected"')
  })

  it('falls back to count-based occupancy when no matrix is available', () => {
    const html = renderHtml(
      <NewTerminalLauncher
        isOpen
        anchorRef={anchorRef}
        existingPaneCount={8}
        preferredGrid={{ cols: 5, rows: 2 }}
        occupancyMatrix={null}
        profiles={[profile]}
        activeProfileId="powershell"
        onClose={() => undefined}
        onLaunch={() => undefined}
      />,
    )

    expect(html).toContain('8 occupied · 0 new panes')
    expect(html).toContain('aria-label="4×2 occupied"')
    expect(html).toContain('aria-label="5×1 available"')
    expect(html).toContain('value="4"')
    expect(html).toContain('value="2"')
    expect(html).not.toContain('value="5"')
  })

  it('keeps the preferred 5x2 preview while a rightmost-column pane still exists', () => {
    const html = renderHtml(
      <NewTerminalLauncher
        isOpen
        anchorRef={anchorRef}
        existingPaneCount={9}
        preferredGrid={{ cols: 5, rows: 2 }}
        profiles={[profile]}
        activeProfileId="powershell"
        onClose={() => undefined}
        onLaunch={() => undefined}
      />,
    )

    expect(html).toContain('9 occupied · 1 new panes')
    expect(html).toContain('aria-label="5×1 occupied"')
    expect(html).toContain('aria-label="5×2 selected"')
    expect(html).toContain('value="5"')
    expect(html).toContain('value="2"')
  })

  it('does not lock an empty workspace to a stale preferred grid', () => {
    const html = renderHtml(
      <NewTerminalLauncher
        isOpen
        anchorRef={anchorRef}
        existingPaneCount={0}
        preferredGrid={{ cols: 6, rows: 4 }}
        profiles={[profile]}
        activeProfileId="powershell"
        onClose={() => undefined}
        onLaunch={() => undefined}
      />,
    )

    expect(html).toContain('0 occupied · 4 new panes')
    expect(html).toContain('value="2"')
    expect(html).not.toContain('value="6"')
    expect(html).not.toContain('value="4"')
  })

  // The popover portals to <body> but still bubbles React events to the window
  // tab that renders it, and that tab's click handler refocuses the terminal —
  // the focus steal closed the native <select> popup on mouseup, so no profile
  // could ever be picked.
  it('does not bubble popover clicks to the tab that renders it', () => {
    const tabClick = vi.fn()
    render(
      <div onClick={tabClick}>
        <NewTerminalLauncher
          isOpen
          anchorRef={anchorRef}
          existingPaneCount={0}
          profiles={[profile]}
          activeProfileId="powershell"
          onClose={() => undefined}
          onLaunch={() => undefined}
        />
      </div>,
    )
    const select = document.querySelector('#new-terminal-popover select')

    fireEvent.mouseDown(select!)
    fireEvent.click(select!)

    expect(tabClick).not.toHaveBeenCalled()
  })
})
