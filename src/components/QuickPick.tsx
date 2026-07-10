import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { steppedPickerId, type PickerEntry, type PickerItem } from './pickerModel'

type QuickPickProps<Id extends string> = {
  value: Id
  ariaLabel: string
  placeholder: string
  icon: ReactNode
  /** Plural noun for the empty state, e.g. "themes" -> `No themes match "x".` */
  noMatchLabel: string
  entriesForFilter: (filter: string) => PickerEntry<Id>[]
  renderItem: (item: PickerItem<Id>) => ReactNode
  onPreview: (id: Id) => void
  onSelect: (id: Id) => void
  onCancel: () => void
}

/** VS Code-style floating quick pick: the settings dialog hides while it is
 *  open so the real workspace shows through, and every keyboard step or hover
 *  previews the highlighted item live before Enter/click commits it. */
export function QuickPick<Id extends string>({ value, ariaLabel, placeholder, icon, noMatchLabel, entriesForFilter, renderItem, onPreview, onSelect, onCancel }: QuickPickProps<Id>) {
  const [filter, setFilter] = useState('')
  const [activeId, setActiveId] = useState<Id>(value)
  const listRef = useRef<HTMLDivElement | null>(null)
  const entries = useMemo(() => entriesForFilter(filter), [entriesForFilter, filter])

  const highlight = (id: Id | null) => {
    if (!id) return
    setActiveId(id)
    onPreview(id)
  }

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeId, entries])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      highlight(steppedPickerId(entries, activeId, event.key === 'ArrowDown' ? 1 : -1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      onSelect(activeId)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
  }

  return (
    <div
      className="awt-quick-pick-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        // The picker lives inside the (visually hidden) settings backdrop;
        // stop the event or the whole settings dialog would close too.
        event.stopPropagation()
        onCancel()
      }}
    >
      <div className="awt-quick-pick" role="dialog" aria-label={ariaLabel} onMouseDown={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
        <header className="awt-quick-pick-header">
          {icon}
          <input
            autoFocus
            value={filter}
            placeholder={placeholder}
            onChange={(event) => {
              setFilter(event.target.value)
              // Keep the highlight on a visible row so arrows/Enter stay sane.
              const next = entriesForFilter(event.target.value)
              if (!next.some((entry) => entry.kind === 'item' && entry.id === activeId)) {
                highlight(steppedPickerId(next, null, 1))
              }
            }}
          />
        </header>
        <div className="awt-quick-pick-list" ref={listRef}>
          {entries.map((entry) => {
            if (entry.kind === 'header') {
              return <div key={`header:${entry.label}`} className="awt-quick-pick-category">{entry.label}</div>
            }
            return (
              <button
                key={entry.id}
                type="button"
                data-active={entry.id === activeId ? 'true' : undefined}
                onMouseEnter={() => highlight(entry.id)}
                onClick={() => onSelect(entry.id)}
              >
                {renderItem(entry)}
                {entry.id === value ? <Check size={13} aria-label="Current selection" /> : null}
              </button>
            )
          })}
          {entries.length === 0 ? <div className="awt-quick-pick-empty">No {noMatchLabel} match “{filter}”.</div> : null}
        </div>
      </div>
    </div>
  )
}
