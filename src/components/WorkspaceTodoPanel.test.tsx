// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useWorkspaceStore } from '../state/store'
import { WorkspaceTodoPanel } from './WorkspaceTodoPanel'

const setWorkspaceTodoNote = vi.fn<(sessionId: string, note: string) => void>()
const originalSetWorkspaceTodoNote = useWorkspaceStore.getState().setWorkspaceTodoNote

const renderPanel = () => {
  render(<WorkspaceTodoPanel />)
  return screen.getByLabelText('Memo')
}

describe('WorkspaceTodoPanel memo persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setWorkspaceTodoNote.mockReset()
    useWorkspaceStore.setState({
      activeSessionId: 'workspace-1',
      error: undefined,
      workspaceTodos: {},
      workspaceTodoNotes: {},
      setWorkspaceTodoNote,
    })
  })

  afterEach(() => {
    cleanup()
    useWorkspaceStore.setState({
      activeSessionId: undefined,
      workspaceTodos: {},
      workspaceTodoNotes: {},
      setWorkspaceTodoNote: originalSetWorkspaceTodoNote,
    })
    vi.useRealTimers()
  })

  test('persists only the latest memo after 300ms of idle time', () => {
    const textarea = renderPanel()
    const note = 'x'.repeat(100)

    for (let length = 1; length <= note.length; length += 1) {
      fireEvent.change(textarea, { target: { value: note.slice(0, length) } })
    }

    act(() => vi.advanceTimersByTime(299))
    expect(setWorkspaceTodoNote).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(1))
    expect(setWorkspaceTodoNote).toHaveBeenCalledOnce()
    expect(setWorkspaceTodoNote).toHaveBeenCalledWith('workspace-1', note)
  })

  test('flushes a pending memo immediately on blur', () => {
    const textarea = renderPanel()

    fireEvent.change(textarea, { target: { value: 'Blurred memo' } })
    fireEvent.blur(textarea)

    expect(setWorkspaceTodoNote).toHaveBeenCalledOnce()
    expect(setWorkspaceTodoNote).toHaveBeenCalledWith('workspace-1', 'Blurred memo')
    act(() => vi.advanceTimersByTime(300))
    expect(setWorkspaceTodoNote).toHaveBeenCalledOnce()
  })

  test('flushes a pending memo immediately on unmount', () => {
    const { unmount } = render(<WorkspaceTodoPanel />)
    fireEvent.change(screen.getByLabelText('Memo'), { target: { value: 'Unmounted memo' } })

    unmount()

    expect(setWorkspaceTodoNote).toHaveBeenCalledOnce()
    expect(setWorkspaceTodoNote).toHaveBeenCalledWith('workspace-1', 'Unmounted memo')
  })

  test('flushes the previous workspace memo before switching drafts', () => {
    useWorkspaceStore.setState({ workspaceTodoNotes: { 'workspace-2': 'Second workspace memo' } })
    const textarea = renderPanel()
    fireEvent.change(textarea, { target: { value: 'First workspace memo' } })

    act(() => useWorkspaceStore.setState({ activeSessionId: 'workspace-2' }))

    expect(setWorkspaceTodoNote).toHaveBeenCalledOnce()
    expect(setWorkspaceTodoNote).toHaveBeenCalledWith('workspace-1', 'First workspace memo')
    expect(screen.getByLabelText('Memo')).toHaveValue('Second workspace memo')
  })

  test('flushes a pending memo immediately on pagehide', () => {
    const textarea = renderPanel()
    fireEvent.change(textarea, { target: { value: 'Hidden page memo' } })

    fireEvent(window, new Event('pagehide'))

    expect(setWorkspaceTodoNote).toHaveBeenCalledOnce()
    expect(setWorkspaceTodoNote).toHaveBeenCalledWith('workspace-1', 'Hidden page memo')
  })

  test('does not rerender without a workspace when unrelated store state changes', () => {
    useWorkspaceStore.setState({ activeSessionId: undefined })
    const onRender = vi.fn()
    render(<Profiler id="workspace-todo" onRender={onRender}><WorkspaceTodoPanel /></Profiler>)
    expect(onRender).toHaveBeenCalledOnce()

    act(() => useWorkspaceStore.setState({ error: 'Unrelated update' }))

    expect(onRender).toHaveBeenCalledOnce()
  })
})
