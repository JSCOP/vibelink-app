import { open } from '@tauri-apps/plugin-dialog'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, GitBranch, LoaderCircle, X } from 'lucide-react'
import { discoverRepos, type DiscoveredRepo } from '../../ipc/gitDiscovery'
import { useWorkspaceStore } from '../../state/store'

type ImportReposDialogProps = {
  onClose: () => void
}

function pathBasename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).at(-1) || normalized
}

export function ImportReposDialog({ onClose }: ImportReposDialogProps) {
  const onCloseRef = useRef(onClose)
  const mountedRef = useRef(true)
  const initialPickerStartedRef = useRef(false)
  const [root, setRoot] = useState<string | null>(null)
  const [repos, setRepos] = useState<DiscoveredRepo[]>([])
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set())
  const [groupName, setGroupName] = useState('')
  const [isDiscovering, setIsDiscovering] = useState(false)
  const [isImporting, setIsImporting] = useState(false)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const chooseFolder = useCallback(async (closeOnCancel: boolean) => {
    setIsDiscovering(true)
    try {
      const selected = await open({ directory: true, multiple: false, title: 'Import repos from folder' })
      if (!mountedRef.current) return
      if (typeof selected !== 'string') {
        if (closeOnCancel) onCloseRef.current()
        return
      }
      const discovered = await discoverRepos(selected)
      if (!mountedRef.current) return
      setRoot(selected)
      setRepos(discovered)
      setSelectedPaths(new Set(discovered.map((repo) => repo.path)))
      setGroupName(pathBasename(selected))
    } catch (error) {
      if (!mountedRef.current) return
      useWorkspaceStore.getState().setError(String(error))
      if (closeOnCancel) onCloseRef.current()
    } finally {
      if (mountedRef.current) setIsDiscovering(false)
    }
  }, [])

  useEffect(() => {
    if (initialPickerStartedRef.current) return
    initialPickerStartedRef.current = true
    void chooseFolder(true)
  }, [chooseFolder])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onCloseRef.current()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const selectedCount = selectedPaths.size
  const allSelected = repos.length > 0 && selectedCount === repos.length
  const canImport = selectedCount > 0 && !isDiscovering && !isImporting

  const toggleRepo = (path: string) => {
    setSelectedPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const toggleAll = () => {
    setSelectedPaths(allSelected ? new Set() : new Set(repos.map((repo) => repo.path)))
  }

  const importSelected = async (asGroup: boolean) => {
    if (!canImport || (asGroup && groupName.trim().length === 0)) return
    const selectedRepos = repos.filter((repo) => selectedPaths.has(repo.path))
    setIsImporting(true)
    try {
      const store = useWorkspaceStore.getState()
      const profileId = store.settings.defaultProfileId
      const group = asGroup ? store.createWorkspaceGroup(groupName) : null
      for (const repo of selectedRepos) {
        const session = await useWorkspaceStore.getState().createSession(pathBasename(repo.path), repo.path, profileId)
        if (group) useWorkspaceStore.getState().setWorkspaceGroup(session.id, group.id)
      }
      onCloseRef.current()
    } catch (error) {
      useWorkspaceStore.getState().setError(String(error))
    } finally {
      if (mountedRef.current) setIsImporting(false)
    }
  }

  return (
    <div className="import-repos-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="import-repos-dialog" role="dialog" aria-modal="true" aria-labelledby="import-repos-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="import-repos-header">
          <button type="button" className="import-repos-header-button" title="Choose another folder" aria-label="Choose another folder" disabled={isDiscovering || isImporting} onClick={() => void chooseFolder(false)}>
            <ArrowLeft size={17} aria-hidden="true" />
          </button>
          <div className="import-repos-heading">
            <h2 id="import-repos-title">Import repos from folder</h2>
            <p>{root ? `Found ${repos.length} repos in ${root}` : 'Choose a folder to scan for Git repositories.'}</p>
          </div>
          <button type="button" className="import-repos-header-button" title="Close" aria-label="Close" onClick={onClose}>
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <div className="import-repos-body">
          <section className="import-repos-selection" aria-label="Repositories to import">
            <div className="import-repos-selection-toolbar">
              <span>{selectedCount} / {repos.length} selected</span>
              <button type="button" disabled={repos.length === 0 || isDiscovering || isImporting} onClick={toggleAll}>
                {allSelected ? 'Select none' : 'Select all'}
              </button>
            </div>

            <div className="import-repos-list">
              {isDiscovering ? (
                <div className="import-repos-empty" role="status"><LoaderCircle className="import-repos-spinner" size={18} aria-hidden="true" /> Scanning folder…</div>
              ) : repos.length === 0 ? (
                <div className="import-repos-empty">No Git repositories found in this folder.</div>
              ) : repos.map((repo) => (
                <label key={repo.path} className="import-repos-row">
                  <input type="checkbox" checked={selectedPaths.has(repo.path)} disabled={isImporting} onChange={() => toggleRepo(repo.path)} />
                  <GitBranch size={16} aria-hidden="true" />
                  <span className="import-repos-row-copy">
                    <strong>{repo.name}</strong>
                    <small>{repo.path}</small>
                  </span>
                  {repo.isSubmodule ? <em className="import-repos-submodule-badge" title="Submodule — a separate Git repository recorded by its parent.">SUB</em> : null}
                </label>
              ))}
            </div>
          </section>

          <section className="import-repos-grouping" aria-labelledby="import-repos-grouping-title">
            <h3 id="import-repos-grouping-title">Group these repositories?</h3>
            <p>A group keeps a monorepo or related repositories together in the workspace list.</p>
            <label>
              Group name
              <input value={groupName} disabled={isImporting} onChange={(event) => setGroupName(event.target.value)} />
            </label>
          </section>
        </div>

        <footer className="import-repos-footer">
          <button type="button" className="secondary-action" disabled={!canImport} onClick={() => void importSelected(false)}>
            No, import separately
          </button>
          <button type="button" className="primary-action" disabled={!canImport || groupName.trim().length === 0} onClick={() => void importSelected(true)}>
            {isImporting ? 'Importing…' : 'Yes, import as a group'}
          </button>
        </footer>
      </section>
    </div>
  )
}
