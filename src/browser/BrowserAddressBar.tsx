import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, RefObject } from 'react'
import { Globe, Search } from 'lucide-react'
import { buildBrowserAddressBarSuggestions } from './addressBarSuggestions'
import { readBrowserUrlHistory } from './browserUrlHistory'

type BrowserAddressBarProps = {
  value: string
  pageUrl: string
  /** Owned by the panel so focus survives re-renders and pane activation. */
  inputRef: RefObject<HTMLInputElement>
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  onDropdownVisibilityChange: (visible: boolean) => void
}

function displayUrl(url: string): string {
  return url === 'about:blank' ? '' : url
}

export function BrowserAddressBar({ value, pageUrl, inputRef, onChange, onSubmit, onDropdownVisibilityChange }: BrowserAddressBarProps) {
  const [inputValue, setInputValue] = useState(displayUrl(value))
  const [query, setQuery] = useState(displayUrl(value))
  const [history, setHistory] = useState(readBrowserUrlHistory)
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const typedQuery = useRef<string | null>(null)
  const blurTimer = useRef<number | null>(null)
  const suggestions = useMemo(() => buildBrowserAddressBarSuggestions(history, query), [history, query])

  useEffect(() => {
    if (focused) return
    const next = displayUrl(pageUrl)
    setInputValue(next)
    setQuery(next)
  }, [focused, pageUrl])

  useEffect(() => () => {
    if (blurTimer.current !== null) window.clearTimeout(blurTimer.current)
  }, [])

  useEffect(() => {
    onDropdownVisibilityChange(open && suggestions.length > 0)
  }, [onDropdownVisibilityChange, open, suggestions.length])

  useEffect(() => () => onDropdownVisibilityChange(false), [onDropdownVisibilityChange])

  const restoreTypedQuery = () => {
    if (typedQuery.current === null) return
    const typed = typedQuery.current
    typedQuery.current = null
    setInputValue(typed)
    setQuery(typed)
    onChange(typed)
  }

  const previewSuggestion = (index: number) => {
    const suggestion = suggestions[index]
    if (!suggestion) return
    if (typedQuery.current === null) typedQuery.current = query
    setHighlightedIndex(index)
    setInputValue(suggestion.url)
    onChange(suggestion.url)
  }

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    typedQuery.current = null
    setQuery(inputValue)
    setOpen(false)
    onSubmit(inputValue)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      restoreTypedQuery()
      setOpen(false)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
      return
    }
    if (!open || suggestions.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      previewSuggestion(highlightedIndex < suggestions.length - 1 ? highlightedIndex + 1 : 0)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      previewSuggestion(typedQuery.current === null
        ? suggestions.length - 1
        : highlightedIndex > 0 ? highlightedIndex - 1 : suggestions.length - 1)
    }
  }

  const selectSuggestion = (url: string) => {
    typedQuery.current = null
    setInputValue(url)
    setQuery(url)
    setOpen(false)
    onChange(url)
    onSubmit(url)
  }

  return (
    <div className="browser-address-shell">
      <form className="browser-address-form" onClick={() => inputRef.current?.focus()} onSubmit={submit}>
        <Globe className="browser-address-icon" size={16} aria-hidden="true" />
        <input
          ref={inputRef}
          className="browser-address-input"
          aria-label="Address or search"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="browser-address-suggestions"
          aria-expanded={open}
          value={inputValue}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          onFocus={(event) => {
            if (blurTimer.current !== null) window.clearTimeout(blurTimer.current)
            blurTimer.current = null
            setFocused(true)
            setHistory(readBrowserUrlHistory())
            setQuery(inputValue)
            setHighlightedIndex(0)
            setOpen(true)
            event.currentTarget.select()
          }}
          onBlur={() => {
            if (blurTimer.current !== null) window.clearTimeout(blurTimer.current)
            blurTimer.current = window.setTimeout(() => {
              blurTimer.current = null
              restoreTypedQuery()
              setOpen(false)
              setFocused(false)
            }, 200)
          }}
          onChange={(event) => {
            const next = event.target.value
            typedQuery.current = null
            setInputValue(next)
            setQuery(next)
            setHighlightedIndex(0)
            setOpen(true)
            onChange(next)
          }}
          onKeyDown={handleKeyDown}
        />
      </form>
      {open && suggestions.length > 0 ? (
        <div id="browser-address-suggestions" className="browser-address-suggestions" role="listbox">
          {suggestions.map((suggestion, index) => {
            const Icon = suggestion.isSearch ? Search : Globe
            return (
              <button
                key={`${suggestion.isSearch ? 'search' : 'history'}:${suggestion.url}`}
                type="button"
                role="option"
                aria-selected={index === highlightedIndex}
                className={`browser-address-suggestion${index === highlightedIndex ? ' is-highlighted' : ''}`}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => selectSuggestion(suggestion.url)}
              >
                <Icon className="browser-address-suggestion-icon" size={14} aria-hidden="true" />
                <span className="browser-address-suggestion-copy">
                  <span className="browser-address-suggestion-title">{suggestion.title}</span>
                  <span className="browser-address-suggestion-subtitle">{suggestion.subtitle}</span>
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
