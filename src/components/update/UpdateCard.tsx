import { invoke } from '@tauri-apps/api/core'
import { useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { dismissAppUpdate, getAppUpdateSnapshot, subscribeAppUpdate } from './updateStore'
import { useWorkspaceStore } from '../../state/store'
import './updateCard.css'

export function UpdateCard() {
  const status = useSyncExternalStore(subscribeAppUpdate, getAppUpdateSnapshot, getAppUpdateSnapshot)
  const sessionRestore = useWorkspaceStore((state) => state.settings.sessionRestore)
  const [installerOpened, setInstallerOpened] = useState(false)

  if (!status || typeof document === 'undefined') return null

  return createPortal(
    <section
      className="vibelink-update-card"
      role="complementary"
      aria-label="Update available"
      aria-live="polite"
    >
      <header>
        <h2>{installerOpened ? 'Update downloading' : 'Update available'}</h2>
        <button
          type="button"
          className="vibelink-update-dismiss"
          aria-label="Dismiss update"
          onClick={() => dismissAppUpdate()}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>

      {installerOpened ? (
        <p className="vibelink-update-summary">
          Run the downloaded VibeLink v{status.latestVersion} installer to finish updating.
        </p>
      ) : (
        <>
          <p className="vibelink-update-summary">VibeLink v{status.latestVersion} is ready.</p>
          <p className="vibelink-update-note">
            {sessionRestore === 'resume'
              ? 'Your terminal sessions keep running while you install.'
              : 'Start fresh is on, so quitting to install stops running terminals.'}
          </p>
          <button
            type="button"
            className="vibelink-update-link"
            onClick={() => void invoke('open_path', { path: status.releaseNotesUrl })}
          >
            Release notes
          </button>
          <button
            type="button"
            className="primary-action vibelink-update-action"
            onClick={() => {
              void invoke('open_path', { path: status.installUrl })
              setInstallerOpened(true)
            }}
          >
            Update
          </button>
        </>
      )}
    </section>,
    document.body,
  )
}
