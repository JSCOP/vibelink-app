import { invoke } from '@tauri-apps/api/core'
import type { BrowserCloseResult } from './types'

export type BrowserContentPanelProps = {
  workspaceId: string
  pageId: string
  profileId: string
  active: boolean
  focused: boolean
  workspaceVisible: boolean
  onTitleChange?: (title: string) => void
}

// Workspace content integration calls this before removing the matching
// Dockview panel. A native close failure therefore leaves the UI owner intact.
export async function closeBrowserContent(workspaceId: string, pageId: string): Promise<BrowserCloseResult> {
  return invoke<BrowserCloseResult>('browser_close_tab', { workspaceId, pageId })
}
