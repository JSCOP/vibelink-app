// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Crashable({ shouldCrash }: { shouldCrash: () => boolean }) {
  if (shouldCrash()) throw new Error('transient failure')
  return <span>Panel recovered</span>
}

describe('ErrorBoundary recovery', () => {
  it('lets the user retry a transient panel failure', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let crash = true
    render(<ErrorBoundary label="Workbench panel"><Crashable shouldCrash={() => crash} /></ErrorBoundary>)

    expect(screen.getByRole('alert').textContent).toContain('Workbench panel crashed')
    crash = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry Workbench panel' }))

    expect(screen.getByText('Panel recovered')).toBeTruthy()
  })

  it('automatically retries when its reset identity changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let crash = true
    const view = render(<ErrorBoundary label="Workspace" resetKey="session-a"><Crashable shouldCrash={() => crash} /></ErrorBoundary>)

    expect(screen.getByRole('alert')).toBeTruthy()
    crash = false
    view.rerender(<ErrorBoundary label="Workspace" resetKey="session-b"><Crashable shouldCrash={() => crash} /></ErrorBoundary>)

    expect(screen.getByText('Panel recovered')).toBeTruthy()
  })
})
