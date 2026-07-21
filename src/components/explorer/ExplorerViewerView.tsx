import { useMemo, useState } from 'react'
import { Copy, ExternalLink, FileCode2, FileText, Folder, GitCompare, Image as ImageIcon, LoaderCircle, Maximize2, Minimize2, Terminal, TriangleAlert } from 'lucide-react'
import type { DirEntryInfo, TextFile } from '../../ipc/types'
import './ExplorerViewerView.css'

export type ExplorerViewerViewProps = {
  path: string | null
  entry: DirEntryInfo | null
  textFile: TextFile | null
  imageSrc: string | null
  loading: boolean
  error: string | null
  imageFit: boolean
  canOpenVibeLinkEditor: boolean
  canOpenExternalEditor: boolean
  canOpenDiff: boolean
  workingTreePresent: boolean
  onToggleImageFit: () => void
  onOpenVibeLinkEditor: () => void
  onOpenExternalEditor: () => void
  onOpenDiff: () => void
  onOpenTerminal: () => void
  onReveal: () => void
  onCopyPath: () => void
}

export function ExplorerViewerView({ path, entry, textFile, imageSrc, loading, error, imageFit, canOpenVibeLinkEditor, canOpenExternalEditor, canOpenDiff, workingTreePresent, onToggleImageFit, onOpenVibeLinkEditor, onOpenExternalEditor, onOpenDiff, onOpenTerminal, onReveal, onCopyPath }: ExplorerViewerViewProps) {
  const lineCount = useMemo(() => (textFile && !textFile.binary ? countLines(textFile.content) : null), [textFile])
  const [imageProbe, setImageProbe] = useState<{ src: string; width: number; height: number } | null>(null)
  const imageDims = imageSrc && imageProbe && imageProbe.src === imageSrc ? imageProbe : null

  if (!path || !entry) {
    return (
      <main className="explorer-viewer explorer-viewer-empty">
        <span className="explorer-viewer-empty-badge"><Folder size={20} /></span>
        <strong>No file selected</strong>
        <span>Select a file in the tree to preview it here.</span>
      </main>
    )
  }

  const showContent = !loading && !error

  return (
    <main className="explorer-viewer" data-explorer-viewer="true">
      <header className="explorer-viewer-header">
        <div className="explorer-viewer-title">
          <span className="explorer-viewer-file-icon" aria-hidden="true">
            {entry.isDir ? <Folder size={14} /> : imageSrc ? <ImageIcon size={14} /> : textFile?.binary ? <FileCode2 size={14} /> : <FileText size={14} />}
          </span>
          <div className="explorer-viewer-title-text">
            <strong title={entry.name}>{entry.name}</strong>
            <span className="explorer-viewer-path" title={path}>{path}</span>
          </div>
        </div>
        <div className="explorer-viewer-actions">
          {workingTreePresent && canOpenVibeLinkEditor ? <button type="button" className="explorer-viewer-primary-action" title="Open in VibeLink Editor" onClick={onOpenVibeLinkEditor}><FileText size={13} /><span>Open</span></button> : null}
          {canOpenDiff ? <button type="button" title="View diff in Git" onClick={onOpenDiff}><GitCompare size={13} /></button> : null}
          <button type="button" title="Copy path" onClick={onCopyPath}><Copy size={13} /></button>
          {workingTreePresent ? <button type="button" title="Reveal in File Explorer" onClick={onReveal}><ExternalLink size={13} /></button> : null}
          {workingTreePresent ? <button type="button" title="Open terminal here" onClick={onOpenTerminal}><Terminal size={13} /></button> : null}
          {workingTreePresent && canOpenExternalEditor ? <button type="button" title="Open in external editor" onClick={onOpenExternalEditor}><FileCode2 size={13} /></button> : null}
        </div>
      </header>
      <div className="explorer-viewer-meta">
        {!entry.isDir ? <span>{formatBytes(entry.size)}</span> : <span>Folder</span>}
        {lineCount !== null ? <span>{lineCount.toLocaleString()} {lineCount === 1 ? 'line' : 'lines'}</span> : null}
        {entry.modifiedAt ? <span title={entry.modifiedAt}>{formatWhen(entry.modifiedAt)}</span> : null}
        {entry.isSymlink ? <span>Symlink</span> : null}
      </div>
      {loading ? (
        <div className="explorer-viewer-state">
          <LoaderCircle size={15} className="explorer-viewer-spinner" aria-hidden="true" />
          <span>Loading preview…</span>
        </div>
      ) : null}
      {!loading && error ? (
        <div className="explorer-viewer-state error" role="alert">
          <TriangleAlert size={15} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}
      {showContent && !workingTreePresent ? (
        <div className="explorer-viewer-card-zone">
          <div className="explorer-binary-card">
            <span className="explorer-binary-icon"><GitCompare size={20} /></span>
            <strong>Not in the working tree</strong>
            <span>This tracked path was deleted or moved.</span>
            <span className="explorer-binary-hint">Use the Git diff to inspect the previous content.</span>
          </div>
        </div>
      ) : null}
      {showContent && workingTreePresent && entry.isDir ? (
        <div className="explorer-viewer-card-zone">
          <div className="explorer-binary-card">
            <span className="explorer-binary-icon"><Folder size={20} /></span>
            <strong>{entry.name}</strong>
            <span>Folder{entry.modifiedAt ? ` · modified ${formatWhen(entry.modifiedAt)}` : ''}</span>
            <span className="explorer-binary-hint">Expand it in the tree to browse its contents.</span>
          </div>
        </div>
      ) : null}
      {showContent && workingTreePresent && imageSrc ? (
        <section className="explorer-image-viewer">
          <div className="explorer-image-toolbar">
            <span><ImageIcon size={13} aria-hidden="true" />{imageDims ? `${imageDims.width} × ${imageDims.height} px` : 'Image'}</span>
            <button type="button" onClick={onToggleImageFit} title={imageFit ? 'Show at actual size' : 'Fit image to pane'}>
              {imageFit ? <Maximize2 size={13} /> : <Minimize2 size={13} />}
              {imageFit ? 'Actual size' : 'Fit'}
            </button>
          </div>
          <div className="explorer-image-stage" data-fit={imageFit || undefined}>
            <img
              src={imageSrc}
              alt={entry.name}
              onLoad={(event) => {
                const el = event.currentTarget
                setImageProbe({ src: imageSrc, width: el.naturalWidth, height: el.naturalHeight })
              }}
            />
          </div>
        </section>
      ) : null}
      {showContent && workingTreePresent && !imageSrc && textFile?.binary ? (
        <div className="explorer-viewer-card-zone">
          <div className="explorer-binary-card">
            <span className="explorer-binary-icon"><FileCode2 size={20} /></span>
            <strong>Binary file</strong>
            <span>{formatBytes(entry.size)}{entry.modifiedAt ? ` · ${formatWhen(entry.modifiedAt)}` : ''}</span>
            <span className="explorer-binary-hint">Preview is unavailable for this file type.</span>
            {canOpenExternalEditor ? (
              <div className="explorer-binary-card-actions">
                <button type="button" onClick={onOpenExternalEditor}><FileCode2 size={13} />Open in external editor</button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {showContent && workingTreePresent && !imageSrc && textFile && !textFile.binary ? (
        <section className="explorer-text-viewer">
          {textFile.truncated ? (
            <div className="explorer-truncated-banner">
              <TriangleAlert size={12} aria-hidden="true" />
              <span>Preview truncated at 2 MiB.</span>
            </div>
          ) : null}
          <pre tabIndex={0}><code>{textFile.content}</code></pre>
        </section>
      ) : null}
    </main>
  )
}

function countLines(content: string): number {
  if (!content) return 0
  let count = 1
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) count += 1
  }
  return count
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
