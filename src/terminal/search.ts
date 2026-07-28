import { TerminalManager, type TerminalSearchOptions } from './TerminalManager'

export type TerminalSearchState = {
  /** Pane the search bar is open for; null when closed. */
  paneId: string | null
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  /** 0-based active result index; -1 when the addon hit its highlight limit. */
  resultIndex: number
  resultCount: number
}

const CLOSED_STATE: TerminalSearchState = {
  paneId: null,
  query: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  resultIndex: -1,
  resultCount: 0,
}

let state: TerminalSearchState = CLOSED_STATE
const listeners = new Set<() => void>()
let resultsUnsubscribe: (() => void) | null = null

const emit = () => {
  for (const listener of listeners) listener()
}

const setState = (patch: Partial<TerminalSearchState>) => {
  state = { ...state, ...patch }
  emit()
}

const searchOptions = (): TerminalSearchOptions => ({
  caseSensitive: state.caseSensitive,
  wholeWord: state.wholeWord,
  regex: state.regex,
})

const unsubscribeResults = () => {
  resultsUnsubscribe?.()
  resultsUnsubscribe = null
}

const runSearch = (direction: 'next' | 'previous') => {
  const { paneId, query } = state
  if (!paneId) return
  if (!query) {
    TerminalManager.searchClear(paneId)
    setState({ resultIndex: -1, resultCount: 0 })
    return
  }
  const found = direction === 'next'
    ? TerminalManager.searchFindNext(paneId, query, { ...searchOptions(), incremental: true })
    : TerminalManager.searchFindPrevious(paneId, query, searchOptions())
  if (!found) setState({ resultIndex: -1, resultCount: 0 })
}

export const terminalSearchStore = {
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  getSnapshot: (): TerminalSearchState => state,
}

export function openTerminalSearch(paneId: string): void {
  if (state.paneId === paneId) return
  closeTerminalSearch()
  setState({ ...CLOSED_STATE, paneId, query: state.query, caseSensitive: state.caseSensitive, wholeWord: state.wholeWord, regex: state.regex })
  resultsUnsubscribe = TerminalManager.onSearchResultsChanged(paneId, (resultIndex, resultCount) => {
    if (state.paneId === paneId) setState({ resultIndex, resultCount })
  })
}

export function closeTerminalSearch(): void {
  if (!state.paneId) return
  TerminalManager.searchClear(state.paneId)
  unsubscribeResults()
  state = { ...CLOSED_STATE, query: state.query, caseSensitive: state.caseSensitive, wholeWord: state.wholeWord, regex: state.regex }
  emit()
}

export function setTerminalSearchQuery(query: string): void {
  setState({ query })
  runSearch('next')
}

export function terminalSearchNext(): void {
  runSearch('next')
}

export function terminalSearchPrevious(): void {
  runSearch('previous')
}

export function setTerminalSearchOption(option: 'caseSensitive' | 'wholeWord' | 'regex', value: boolean): void {
  setState({ [option]: value })
  // Option changes invalidate the current match position; re-run from the top
  // so the shown match always honors the active flags.
  if (state.query) runSearch('next')
}

/** Pane teardown hook: drop the open bar state when its pane disappears.
 *  The terminal itself is already disposed, so no decorations need clearing. */
export function terminalSearchForgetPane(paneId: string): void {
  if (state.paneId !== paneId) return
  unsubscribeResults()
  state = { ...state, paneId: null }
  emit()
}
