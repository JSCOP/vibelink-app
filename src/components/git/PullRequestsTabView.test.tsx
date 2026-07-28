// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PullRequestsTabView, type PullRequestsTabViewProps } from './PullRequestsTabView'

const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }
afterEach(cleanup)
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })

function props(overrides: Partial<PullRequestsTabViewProps> = {}): PullRequestsTabViewProps {
  return {
    provider: 'github', host: 'github.com', tokenPresent: true, loading: false, error: null,
    prs: [{ number: 42, title: 'Ship hosting', author: 'octocat', sourceBranch: 'feature/hosting', targetBranch: 'main', draft: false, url: 'https://github.com/JSCOP/vibelink-app/pull/42', state: 'open' }],
    ciByNumber: { 42: { state: 'success', checks: [] } }, selectedNumber: null, detail: null, files: [], selectedPath: null, contents: null, diffLoading: false, reviewHunks: null, selectedReviewHunkId: null, reviewHunkComments: [],
    mode: 'list', token: '', deviceCode: null, created: null, createTitle: '', createBody: '', createTarget: 'main', createTargets: ['main'], createDraft: false, sourceBranch: 'feature/hosting', needsPush: false,
    onRefresh: vi.fn(), onTokenChange: vi.fn(), onSaveToken: vi.fn(), onDeviceSignIn: vi.fn(), onOpenUrl: vi.fn(), onCopyUrl: (url) => { void navigator.clipboard.writeText(url) }, onSelectPr: vi.fn(), onSelectFile: vi.fn(), onSelectReviewHunk: vi.fn(), onCommentReviewHunk: vi.fn(), onCommentReviewLine: vi.fn(), onModeChange: vi.fn(), onCreateTitleChange: vi.fn(), onCreateBodyChange: vi.fn(), onCreateTargetChange: vi.fn(), onCreateDraftChange: vi.fn(), onPushBranch: vi.fn(), onCreate: vi.fn(), onMergeAndCleanup: vi.fn(),
    ...overrides,
  }
}

describe('PullRequestsTabView', () => {
  beforeEach(() => vi.clearAllMocks())

  test('renders open and copy URL buttons on every pull request row', () => {
    const onOpenUrl = vi.fn()
    render(<PullRequestsTabView {...props({ onOpenUrl })} />)
    fireEvent.click(screen.getByTitle('Open URL'))
    expect(onOpenUrl).toHaveBeenCalledWith('https://github.com/JSCOP/vibelink-app/pull/42')
    fireEvent.click(screen.getByTitle('Copy URL'))
    expect(clipboard.writeText).toHaveBeenCalledWith('https://github.com/JSCOP/vibelink-app/pull/42')
  })

  test('keeps the created URL visible with open and copy actions', () => {
    const url = 'https://github.com/JSCOP/vibelink-app/pull/43'
    render(<PullRequestsTabView {...props({ prs: [], created: { number: 43, url } })} />)
    expect(screen.getByText(/PR #43 created/)).toBeTruthy()
    fireEvent.click(screen.getByTitle('Copy URL'))
    expect(clipboard.writeText).toHaveBeenCalledWith(url)
  })

  test('shows sign-in state for an authentication error', () => {
    render(<PullRequestsTabView {...props({ tokenPresent: false, error: 'AUTH: token rejected' })} />)
    expect(screen.getByText('Sign in to github.com')).toBeTruthy()
    expect(screen.getByText('token rejected')).toBeTruthy()
  })

  test('exposes merge and cleanup only for a concrete non-draft provider head', () => {
    const onMergeAndCleanup = vi.fn()
    const detail = { ...props().prs[0], body: '', headSha: 'abc123', checks: [] }
    render(<PullRequestsTabView {...props({ selectedNumber: 42, detail, onMergeAndCleanup })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Merge and clean up' }))
    expect(onMergeAndCleanup).toHaveBeenCalledOnce()
  })

})
