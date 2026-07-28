import { useEffect, useRef, useSyncExternalStore } from 'react'
import { CaseSensitive, ChevronDown, ChevronUp, Regex, WholeWord, X } from 'lucide-react'
import { TerminalManager } from '../terminal/TerminalManager'
import {
  closeTerminalSearch,
  setTerminalSearchOption,
  setTerminalSearchQuery,
  terminalSearchNext,
  terminalSearchPrevious,
  terminalSearchStore,
} from '../terminal/search'
import './TerminalSearchBar.css'

/** Floating in-pane buffer search. Renders nothing unless the search store is
 *  open for exactly this pane; mounted once per terminal pane shell. */
export function TerminalSearchBar({ paneId }: { paneId: string }) {
  const state = useSyncExternalStore(terminalSearchStore.subscribe, terminalSearchStore.getSnapshot, terminalSearchStore.getSnapshot)
  const inputRef = useRef<HTMLInputElement>(null)
  const open = state.paneId === paneId

  useEffect(() => {
    if (!open) return
    const input = inputRef.current
    input?.focus()
    input?.select()
  }, [open])

  if (!open) return null

  const matchLabel = !state.query
    ? ''
    : state.resultCount > 0
      ? `${state.resultIndex >= 0 ? state.resultIndex + 1 : '—'} of ${state.resultCount}`
      : 'No results'

  const close = () => {
    closeTerminalSearch()
    TerminalManager.focus(paneId)
  }

  return (
    <div className="terminal-search-bar" role="search" aria-label="Find in terminal">
      <input
        ref={inputRef}
        type="text"
        className="terminal-search-input"
        data-empty-query={state.query.length === 0 ? undefined : state.resultCount === 0 ? 'no-results' : undefined}
        placeholder="Find"
        aria-label="Find in terminal buffer"
        spellCheck={false}
        value={state.query}
        onChange={(event) => setTerminalSearchQuery(event.target.value)}
        onKeyDown={(event) => {
          // Keep pane/workspace shortcuts from firing while the bar owns input.
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            if (event.shiftKey) terminalSearchPrevious()
            else terminalSearchNext()
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            terminalSearchPrevious()
          } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            terminalSearchNext()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            close()
          }
        }}
      />
      <span className="terminal-search-count" aria-live="polite">{matchLabel}</span>
      <button type="button" className="terminal-search-button" title="Previous match (Shift+Enter)" aria-label="Previous match" disabled={state.resultCount === 0} onClick={terminalSearchPrevious}>
        <ChevronUp size={15} aria-hidden="true" />
      </button>
      <button type="button" className="terminal-search-button" title="Next match (Enter)" aria-label="Next match" disabled={state.resultCount === 0} onClick={terminalSearchNext}>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="terminal-search-button terminal-search-toggle"
        title="Match case"
        aria-label="Match case"
        aria-pressed={state.caseSensitive}
        data-active={state.caseSensitive || undefined}
        onClick={() => setTerminalSearchOption('caseSensitive', !state.caseSensitive)}
      >
        <CaseSensitive size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="terminal-search-button terminal-search-toggle"
        title="Match whole word"
        aria-label="Match whole word"
        aria-pressed={state.wholeWord}
        data-active={state.wholeWord || undefined}
        onClick={() => setTerminalSearchOption('wholeWord', !state.wholeWord)}
      >
        <WholeWord size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="terminal-search-button terminal-search-toggle"
        title="Use regular expression"
        aria-label="Use regular expression"
        aria-pressed={state.regex}
        data-active={state.regex || undefined}
        onClick={() => setTerminalSearchOption('regex', !state.regex)}
      >
        <Regex size={15} aria-hidden="true" />
      </button>
      <button type="button" className="terminal-search-button" title="Close (Escape)" aria-label="Close find" onClick={close}>
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  )
}
