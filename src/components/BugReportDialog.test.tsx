// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const submitBugReport = vi.hoisted(() => vi.fn())
vi.mock('../ipc/bugReports', () => ({ submitBugReport }))
const toastSuccess = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
vi.mock('./toast/toastStore', () => ({ toast: { success: toastSuccess, error: toastError } }))

import { BugReportDialog } from './BugReportDialog'

describe('BugReportDialog', () => {
  beforeEach(() => {
    submitBugReport.mockReset()
    toastSuccess.mockReset()
    toastError.mockReset()
  })
  afterEach(cleanup)

  it('submits trimmed account-authenticated report content', async () => {
    submitBugReport.mockResolvedValue({ id: 'report-123', createdAt: '2026-07-19T00:00:00.000Z' })
    render(<BugReportDialog onClose={() => undefined} />)

    fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'terminal' } })
    fireEvent.change(screen.getByLabelText('Short summary'), { target: { value: '  Blank terminal pane  ' } })
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: '  The terminal is blank after restore.  ' } })
    fireEvent.change(screen.getByLabelText('Steps to reproduce (optional)'), { target: { value: '  Maximize and restore a pane.  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }))

    await waitFor(() => expect(submitBugReport).toHaveBeenCalledWith({
      category: 'terminal',
      title: 'Blank terminal pane',
      description: 'The terminal is blank after restore.',
      stepsToReproduce: 'Maximize and restore a pane.',
      contactAllowed: true,
    }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Bug report received · report-123'))
  })

  it('reports submission failures through an error toast', async () => {
    submitBugReport.mockRejectedValue(new Error('Daily report limit reached'))
    render(<BugReportDialog onClose={() => undefined} />)

    fireEvent.change(screen.getByLabelText('Short summary'), { target: { value: 'Cannot attach pane' } })
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'The report submission failed unexpectedly.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Error: Daily report limit reached'))
  })
})
