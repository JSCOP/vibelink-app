// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { MarkdownPreview } from './MarkdownPreview'

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue('aW1hZ2U=')
})
afterEach(cleanup)

test('renders tables and code while escaping HTML and loading relative images', async () => {
  const { container } = render(
    <MarkdownPreview
      workspaceFolder="C:/repo"
      relPath="docs/README.md"
      content={'| Name | Value |\n| --- | --- |\n| Safe | Yes |\n\n```ts\nconst safe = true\n```\n\n<script>alert(1)</script>\n<iframe src="https://example.com"></iframe>\n\n[bad](ftp://example.com) [good](https://example.com)\n\n![Shot](images/shot.png)'}
    />,
  )

  expect(container.querySelector('table')).toBeTruthy()
  expect(container.querySelector('code')?.textContent).toContain('const safe = true')
  expect(container.querySelector('script')).toBeNull()
  expect(container.querySelector('iframe')).toBeNull()
  expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeTruthy()
  expect(screen.getByText('bad').closest('a')).not.toHaveAttribute('href')
  expect(screen.getByRole('link', { name: 'good' })).toHaveAttribute('href', 'https://example.com')
  await waitFor(() => expect(screen.getByAltText('Shot')).toHaveAttribute('src', 'data:image/png;base64,aW1hZ2U='))
  expect(invoke).toHaveBeenCalledWith('fs_read_image', { workspaceFolder: 'C:/repo', relPath: 'docs/images/shot.png' })
})
