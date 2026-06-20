import { Grid3X3, Plus } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TEMPLATES } from '../layout/templates'

type LaunchRequest = {
  templateId?: string
  cols: number
  rows: number
}

type NewTerminalLauncherProps = {
  isOpen: boolean
  disabled?: boolean
  onToggle: () => void
  onClose: () => void
  onLaunch: (request: LaunchRequest) => void
}

export function NewTerminalLauncher({ isOpen, disabled, onToggle, onClose, onLaunch }: NewTerminalLauncherProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [cols, setCols] = useState(2)
  const [rows, setRows] = useState(2)
  const [popoverPosition, setPopoverPosition] = useState({ top: 42, right: 12 })

  useEffect(() => {
    if (!isOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node | null)) return
      onClose()
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [isOpen, onClose])

  useLayoutEffect(() => {
    if (!isOpen) return

    const updatePosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (!rect) return
      setPopoverPosition({
        top: Math.round(rect.bottom + 5),
        right: Math.max(8, Math.round(window.innerWidth - rect.right)),
      })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    return () => window.removeEventListener('resize', updatePosition)
  }, [isOpen])

  const launchCustom = () => {
    onLaunch({ cols: clampGridValue(cols), rows: clampGridValue(rows) })
  }

  return (
    <div ref={rootRef} className="new-terminal-launcher">
      <button ref={buttonRef} type="button" className="topbar-text-button" disabled={disabled} title="Create terminals from a template" onClick={onToggle}>
        <Plus size={14} /> New
      </button>
      {isOpen ? (
        <section className="new-terminal-popover" style={popoverPosition} aria-label="New terminal template">
          <header className="new-terminal-popover-header">
            <Grid3X3 size={14} />
            <span>Template</span>
          </header>
          <div className="new-terminal-template-grid">
            {TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => onLaunch({ templateId: template.id, cols: template.cols, rows: template.rows })}
              >
                <span>{template.label}</span>
                <small>{template.cols * template.rows} panes</small>
              </button>
            ))}
          </div>
          <div className="new-terminal-custom">
            <label>
              X
              <input type="number" min="1" max="8" value={cols} onChange={(event) => setCols(Number(event.target.value))} />
            </label>
            <label>
              Y
              <input type="number" min="1" max="8" value={rows} onChange={(event) => setRows(Number(event.target.value))} />
            </label>
            <button type="button" className="primary-action" onClick={launchCustom}>Create</button>
          </div>
        </section>
      ) : null}
    </div>
  )
}

function clampGridValue(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(8, Math.floor(value)))
}
