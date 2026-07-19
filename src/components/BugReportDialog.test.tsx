// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const submitBugReport = vi.hoisted(() => vi.fn())
vi.mock('../ipc/bugReports', () => ({ submitBugReport }))

import { BugReportDialog } from './BugReportDialog'

describe('BugReportDialog', () => {
  beforeEach(() => submitBugReport.mockReset())
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
    expect(await screen.findByText('Bug report received · report-123')).toBeInTheDocument()
  })
})
