import { useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { CircleHelp, ExternalLink, Globe, Info, Keyboard, MessageSquareText, RefreshCw, ScrollText, Settings2 } from 'lucide-react'
import { AnchoredPopover } from '../automations/AnchoredPopover'
import { checkAppUpdate } from '../../ipc/appUpdate'
import { setAppUpdateStatus } from '../update/updateStore'
import { useAppChromeStore } from '../../state/appChrome'
import './WorkspaceSidebarToolbar.css'

const websiteUrl = 'https://vibelink.moobang.net'
const releasesUrl = 'https://vibelink.moobang.net/releases'

type UpdateCheck =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'done'; message: string }

/**
 * Persistent strip at the bottom of the left sidebar: settings plus a help menu
 * that opens upward. It is the low-traffic app chrome that would otherwise
 * crowd the topbar, so it stays anchored where the eye already rests after
 * scanning workspaces.
 */
export function WorkspaceSidebarToolbar() {
  const openSettings = useAppChromeStore((state) => state.openSettings)
  const openBugReport = useAppChromeStore((state) => state.openBugReport)
  const helpRef = useRef<HTMLButtonElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck>({ kind: 'idle' })

  const runUpdateCheck = () => {
    if (updateCheck.kind === 'checking') return
    setUpdateCheck({ kind: 'checking' })
    void checkAppUpdate()
      .then((status) => {
        // Feeding the shared store means a hit also raises the normal update
        // card, so this menu row never becomes a second update surface.
        setAppUpdateStatus(status)
        setUpdateCheck({ kind: 'done', message: status.updateAvailable ? `v${status.latestVersion} is available` : 'Up to date' })
      })
      .catch(() => setUpdateCheck({ kind: 'done', message: 'Check failed' }))
  }

  return (
    <div className="vl-sidebar-toolbar">
      <div className="vl-sidebar-toolbar-group">
        <button
          type="button"
          className="vl-sidebar-toolbar-button"
          title="Settings"
          aria-label="Open settings"
          onClick={() => openSettings()}
        >
          <Settings2 size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          ref={helpRef}
          className={`vl-sidebar-toolbar-button${menuOpen ? ' is-open' : ''}`}
          title="Help"
          aria-label="Help and resources"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <CircleHelp size={14} aria-hidden="true" />
        </button>
      </div>
      {menuOpen ? (
        <AnchoredPopover
          anchorRef={helpRef}
          className="vl-sidebar-menu"
          role="menu"
          label="Help and resources"
          onDismiss={() => setMenuOpen(false)}
        >
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); openSettings('advanced') }}>
            <Keyboard size={14} aria-hidden="true" />
            <span>Keyboard shortcuts</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); openSettings('about') }}>
            <Info size={14} aria-hidden="true" />
            <span>About VibeLink</span>
          </button>
          <hr className="vl-sidebar-menu-separator" />
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); openBugReport() }}>
            <MessageSquareText size={14} aria-hidden="true" />
            <span>Report a bug</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void invoke('open_path', { path: websiteUrl }) }}>
            <Globe size={14} aria-hidden="true" />
            <span>VibeLink website</span>
            <ExternalLink size={12} className="vl-sidebar-menu-trailing" aria-hidden="true" />
          </button>
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void invoke('open_path', { path: releasesUrl }) }}>
            <ScrollText size={14} aria-hidden="true" />
            <span>Releases &amp; changelog</span>
            <ExternalLink size={12} className="vl-sidebar-menu-trailing" aria-hidden="true" />
          </button>
          <hr className="vl-sidebar-menu-separator" />
          <button type="button" role="menuitem" disabled={updateCheck.kind === 'checking'} onClick={runUpdateCheck}>
            <RefreshCw size={14} className={updateCheck.kind === 'checking' ? 'vl-sidebar-menu-spin' : undefined} aria-hidden="true" />
            <span>Check for updates</span>
            {updateCheck.kind === 'done' ? <span className="vl-sidebar-menu-trailing">{updateCheck.message}</span> : null}
          </button>
        </AnchoredPopover>
      ) : null}
    </div>
  )
}
