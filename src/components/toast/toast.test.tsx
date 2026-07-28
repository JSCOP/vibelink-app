// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastHost } from './ToastHost'
import { clearToasts, dismissToast, getToastSnapshot, toast } from './toastStore'

describe('toast infrastructure', () => {
  afterEach(() => {
    cleanup()
    clearToasts()
    vi.useRealTimers()
  })

  it('advances queued notifications in FIFO order', () => {
    const first = toast.info('First')
    toast.info('Second')
    toast.info('Third')
    toast.info('Fourth')

    expect(getToastSnapshot().map((item) => item.message)).toEqual(['First', 'Second', 'Third'])
    dismissToast(first)
    expect(getToastSnapshot().map((item) => item.message)).toEqual(['Second', 'Third', 'Fourth'])
  })

  it('renders at most three notifications and manual close reveals the next item', () => {
    toast.info('One')
    toast.info('Two')
    toast.info('Three')
    toast.info('Four')
    render(<ToastHost />)

    expect(screen.getAllByRole('status')).toHaveLength(3)
    expect(screen.queryByText('Four')).not.toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss notification' })[0])
    expect(screen.getAllByRole('status')).toHaveLength(3)
    expect(screen.getByText('Four')).toBeInTheDocument()
  })

  it('auto-dismisses success at four seconds and errors at six seconds', () => {
    vi.useFakeTimers()
    toast.success('Saved')
    render(<ToastHost />)

    act(() => { vi.advanceTimersByTime(3_999) })
    expect(screen.getByText('Saved')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()

    act(() => { toast.error('Failed') })
    act(() => { vi.advanceTimersByTime(5_999) })
    expect(screen.getByText('Failed')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.queryByText('Failed')).not.toBeInTheDocument()
  })

  it('pauses the dismissal timer while hovered', () => {
    vi.useFakeTimers()
    toast.info('Hover me', { durationMs: 1_000 })
    render(<ToastHost />)
    const notification = screen.getByRole('status')

    act(() => { vi.advanceTimersByTime(500) })
    fireEvent.mouseEnter(notification)
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(screen.getByText('Hover me')).toBeInTheDocument()

    fireEvent.mouseLeave(notification)
    act(() => { vi.advanceTimersByTime(499) })
    expect(screen.getByText('Hover me')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.queryByText('Hover me')).not.toBeInTheDocument()
  })

  it('runs an action and dismisses its notification', () => {
    const onAction = vi.fn()
    toast.info('Connection lost', { actionLabel: 'Retry', onAction })
    render(<ToastHost />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onAction).toHaveBeenCalledOnce()
    expect(screen.queryByText('Connection lost')).not.toBeInTheDocument()
  })
})
