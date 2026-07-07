import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
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

describe('NewTerminalLauncher', () => {
  it('reopens with the committed grid preference instead of rebalancing pane count', () => {
    const html = renderToString(
      <NewTerminalLauncher
        isOpen
        existingPaneCount={12}
        preferredGrid={{ cols: 6, rows: 2 }}
        profiles={[profile]}
        activeProfileId="powershell"
        onToggle={() => undefined}
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
    const html = renderToString(
      <NewTerminalLauncher
        isOpen
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
        onToggle={() => undefined}
        onClose={() => undefined}
        onLaunch={() => undefined}
      />,
    )

    expect(html).toContain('<strong>4<!-- -->×<!-- -->3</strong>')
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
    const html = renderToString(
      <NewTerminalLauncher
        isOpen
        existingPaneCount={8}
        preferredGrid={{ cols: 5, rows: 2 }}
        occupancyMatrix={null}
        profiles={[profile]}
        activeProfileId="powershell"
        onToggle={() => undefined}
        onClose={() => undefined}
        onLaunch={() => undefined}
      />,
    )

    expect(html).toContain('8<!-- --> occupied · <!-- -->0<!-- --> new panes')
    expect(html).toContain('aria-label="4×2 occupied"')
    expect(html).toContain('aria-label="5×1 available"')
    expect(html).toContain('value="4"')
    expect(html).toContain('value="2"')
    expect(html).not.toContain('value="5"')
  })

  it('keeps the preferred 5x2 preview while a rightmost-column pane still exists', () => {
    const html = renderToString(
      <NewTerminalLauncher
        isOpen
        existingPaneCount={9}
        preferredGrid={{ cols: 5, rows: 2 }}
        profiles={[profile]}
        activeProfileId="powershell"
        onToggle={() => undefined}
        onClose={() => undefined}
        onLaunch={() => undefined}
      />,
    )

    expect(html).toContain('9<!-- --> occupied · <!-- -->1<!-- --> new panes')
    expect(html).toContain('aria-label="5×1 occupied"')
    expect(html).toContain('aria-label="5×2 selected"')
    expect(html).toContain('value="5"')
    expect(html).toContain('value="2"')
  })

  it('does not lock an empty workspace to a stale preferred grid', () => {
    const html = renderToString(
      <NewTerminalLauncher
        isOpen
        existingPaneCount={0}
        preferredGrid={{ cols: 6, rows: 4 }}
        profiles={[profile]}
        activeProfileId="powershell"
        onToggle={() => undefined}
        onClose={() => undefined}
        onLaunch={() => undefined}
      />,
    )

    expect(html).toContain('0<!-- --> occupied · <!-- -->4<!-- --> new panes')
    expect(html).toContain('value="2"')
    expect(html).not.toContain('value="6"')
    expect(html).not.toContain('value="4"')
  })
})
