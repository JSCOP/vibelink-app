import { beforeEach, describe, expect, it, vi } from 'vitest'

const searchFindNext = vi.fn<(paneId: string, query: string, options?: unknown) => boolean>()
const searchFindPrevious = vi.fn<(paneId: string, query: string, options?: unknown) => boolean>()
const searchClear = vi.fn<(paneId: string) => void>()
const onSearchResultsChanged = vi.fn<(paneId: string, listener: (index: number, count: number) => void) => () => void>()

vi.mock('./TerminalManager', () => ({
  TerminalManager: {
    searchFindNext: (paneId: string, query: string, options?: unknown) => searchFindNext(paneId, query, options),
    searchFindPrevious: (paneId: string, query: string, options?: unknown) => searchFindPrevious(paneId, query, options),
    searchClear: (paneId: string) => searchClear(paneId),
    onSearchResultsChanged: (paneId: string, listener: (index: number, count: number) => void) => onSearchResultsChanged(paneId, listener),
  },
}))

import {
  closeTerminalSearch,
  openTerminalSearch,
  setTerminalSearchOption,
  setTerminalSearchQuery,
  terminalSearchForgetPane,
  terminalSearchNext,
  terminalSearchPrevious,
  terminalSearchStore,
} from './search'

describe('terminal search store', () => {
  beforeEach(() => {
    closeTerminalSearch()
    setTerminalSearchQuery('')
    setTerminalSearchOption('caseSensitive', false)
    setTerminalSearchOption('wholeWord', false)
    setTerminalSearchOption('regex', false)
    searchFindNext.mockReset().mockReturnValue(true)
    searchFindPrevious.mockReset().mockReturnValue(true)
    searchClear.mockReset()
    onSearchResultsChanged.mockReset().mockReturnValue(() => undefined)
  })

  it('opens for a pane, runs incremental finds, and clears decorations on close', () => {
    openTerminalSearch('pane-a')
    expect(terminalSearchStore.getSnapshot().paneId).toBe('pane-a')

    setTerminalSearchQuery('error')
    expect(searchFindNext).toHaveBeenCalledWith('pane-a', 'error', expect.objectContaining({ incremental: true }))

    closeTerminalSearch()
    expect(searchClear).toHaveBeenCalledWith('pane-a')
    expect(terminalSearchStore.getSnapshot().paneId).toBeNull()
  })

  it('keeps the query and option flags when switching panes', () => {
    openTerminalSearch('pane-a')
    setTerminalSearchQuery('warn')
    setTerminalSearchOption('caseSensitive', true)
    searchFindNext.mockClear()

    openTerminalSearch('pane-b')
    const state = terminalSearchStore.getSnapshot()
    expect(state.paneId).toBe('pane-b')
    expect(state.query).toBe('warn')
    expect(state.caseSensitive).toBe(true)

    terminalSearchNext()
    expect(searchFindNext).toHaveBeenCalledWith('pane-b', 'warn', expect.objectContaining({ caseSensitive: true }))
  })

  it('re-runs the search when an option toggles', () => {
    openTerminalSearch('pane-a')
    setTerminalSearchQuery('fail')
    searchFindNext.mockClear()

    setTerminalSearchOption('regex', true)
    expect(searchFindNext).toHaveBeenCalledWith('pane-a', 'fail', expect.objectContaining({ regex: true }))
  })

  it('clears decorations and result counts when the query empties', () => {
    openTerminalSearch('pane-a')
    setTerminalSearchQuery('fail')
    searchClear.mockClear()

    setTerminalSearchQuery('')
    expect(searchClear).toHaveBeenCalledWith('pane-a')
    expect(terminalSearchStore.getSnapshot().resultCount).toBe(0)
  })

  it('reflects addon result counts while open', () => {
    const holder: { listener?: (index: number, count: number) => void } = {}
    onSearchResultsChanged.mockImplementation((_paneId, next) => {
      holder.listener = next
      return () => undefined
    })
    openTerminalSearch('pane-a')
    holder.listener?.(2, 9)
    expect(terminalSearchStore.getSnapshot().resultIndex).toBe(2)
    expect(terminalSearchStore.getSnapshot().resultCount).toBe(9)
  })

  it('forwards previous-match navigation to the addon', () => {
    openTerminalSearch('pane-a')
    setTerminalSearchQuery('fail')
    terminalSearchPrevious()
    expect(searchFindPrevious).toHaveBeenCalledWith('pane-a', 'fail', expect.objectContaining({ regex: false }))
  })

  it('forgets a disposed pane without touching the terminal', () => {
    openTerminalSearch('pane-a')
    searchClear.mockClear()
    terminalSearchForgetPane('pane-a')
    expect(terminalSearchStore.getSnapshot().paneId).toBeNull()
    expect(searchClear).not.toHaveBeenCalled()
  })
})
