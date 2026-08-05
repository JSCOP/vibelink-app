import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, LoaderCircle, RefreshCw, X } from 'lucide-react'
import {
  importAutomationJobs,
  normalizeAutomationRpcError,
  previewAutomationImport,
  type AutomationImportPreview,
} from '../../ipc/automations'

type AutomationImportDialogProps = {
  sessionId: string
  onClose: () => void
  onImported: () => Promise<void>
}

export function AutomationImportDialog({ sessionId, onClose, onImported }: AutomationImportDialogProps) {
  const dialogRef = useRef<HTMLElement | null>(null)
  const [preview, setPreview] = useState<AutomationImportPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await previewAutomationImport(sessionId)
      setPreview(next)
      setSelected(new Set(next.candidates.filter((candidate) => !candidate.existingAutomationId).map((candidate) => candidate.source.sourceId)))
    } catch (cause) {
      setError(normalizeAutomationRpcError(cause).message)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    // Mount/session load, not a render cascade: the spinner is already `true`
    // here, so this sets no new state before the first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  // Claim focus exactly once. `onClose` is an inline prop and `AutomationPanel`
  // re-renders on its 8 s refresh poll, so focusing from the keydown effect
  // below pulled focus off the candidate list every few seconds.
  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopImmediatePropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  const importable = useMemo(() => preview?.candidates.filter((candidate) => selected.has(candidate.source.sourceId) && !candidate.existingAutomationId) ?? [], [preview, selected])

  const runImport = async () => {
    if (importable.length === 0) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const imported = await importAutomationJobs(sessionId, {
        jobs: importable.map((candidate) => ({
          sourceId: candidate.source.sourceId,
          sourceHash: candidate.source.sourceHash,
        })),
      })
      setResult(`${imported.imported.length} imported, ${imported.skipped.length} skipped. Imported jobs are paused for review.`)
      await onImported()
      await refresh()
    } catch (cause) {
      setError(normalizeAutomationRpcError(cause).message)
    } finally {
      setBusy(false)
    }
  }

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="automation-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} className="automation-import-dialog" role="dialog" aria-modal="true" aria-labelledby="automation-import-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <header className="automation-dialog-header">
          <div><span>Read-only source</span><h2 id="automation-import-title">Import Hermes Cron jobs</h2></div>
          <button type="button" aria-label="Close Hermes Cron import" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="automation-import-toolbar">
          <p>Only jobs whose Hermes <code>workdir</code> matches this workspace appear. Source jobs are never changed.</p>
          <button type="button" disabled={loading || busy} onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</button>
        </div>
        {preview ? <small className="automation-source-path" title={preview.sourcePath}>{preview.sourcePath}</small> : null}
        <div className="automation-import-list">
          {loading ? <div className="automation-centered-state"><LoaderCircle className="spin" size={18} /> Reading Hermes jobs…</div> : null}
          {!loading && preview?.candidates.length === 0 ? <div className="automation-centered-state">No matching Hermes Cron jobs.</div> : null}
          {preview?.candidates.map((candidate) => {
            const imported = Boolean(candidate.existingAutomationId)
            const checked = selected.has(candidate.source.sourceId)
            return (
              <label key={candidate.source.sourceId} className={`automation-import-card${imported ? ' is-imported' : ''}`}>
                <input type="checkbox" checked={checked && !imported} disabled={imported || busy} onChange={(event) => {
                  setSelected((current) => {
                    const next = new Set(current)
                    if (event.target.checked) next.add(candidate.source.sourceId)
                    else next.delete(candidate.source.sourceId)
                    return next
                  })
                }} />
                <span className="automation-import-card-body">
                  <strong>{candidate.name}</strong>
                  <span>{candidate.scheduleKind} {candidate.scheduleValue} · {candidate.timezone}</span>
                  <small>{candidate.prompt}</small>
                  {imported ? <em>Already imported</em> : null}
                  {candidate.warnings.map((warning) => <em key={warning}>{warning}</em>)}
                </span>
              </label>
            )
          })}
        </div>
        {result ? <div className="automation-callout ok">{result}</div> : null}
        {error ? <div className="automation-callout error" role="alert">{error}</div> : null}
        <footer className="automation-dialog-actions">
          <button type="button" onClick={onClose}>Close</button>
          <button type="button" className="primary" disabled={importable.length === 0 || busy} onClick={() => void runImport()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />} Import {importable.length || ''}</button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
