import { invoke } from '@tauri-apps/api/core'
import type { WorkspaceContentActions } from '../layout/contentActions'
import { normalizeWorkspaceRelativePath } from '../layout/workspaceContentModel'
import { requestEditorNavigation, type EditorNavigationTarget } from '../editor/editorNavigation'
import { toast } from '../components/toast/toastStore'
import { useExplorerStore } from '../state/explorer'

export type TerminalOpenTarget = {
  path: string
  location?: EditorNavigationTarget
}

export type TerminalLinkOpenMode = 'internal' | 'system'

type WorkspacePathKind = 'directory' | 'textFile' | 'other'

type OpenTerminalLinkOptions = {
  activeSessionId?: string
  workspaceFolder?: string | null
  workspaceEpoch: number
  contentActions: WorkspaceContentActions | null
  openSystemPath(path: string): void | Promise<void>
  isOwnershipCurrent?(): boolean
}

const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//
const LINE_COLUMN_SUFFIX_RE = /^(.*):(\d+):(\d+)$/
const READ_SELECTOR_SUFFIX_RE = /^(.*?):(?:raw:)?(\d+)(?:(?:-(\d*))|(?:\+(\d+)))?(?:,\d+(?:-\d*)?)*(?::raw)?$/i

export function parseTerminalOpenTarget(value: string): TerminalOpenTarget {
  if (URI_SCHEME_RE.test(value)) return { path: value }

  const lineColumn = LINE_COLUMN_SUFFIX_RE.exec(value)
  if (lineColumn) {
    const lineNumber = positiveInteger(lineColumn[2])
    const column = positiveInteger(lineColumn[3])
    if (lineNumber && column && lineColumn[1]) {
      return { path: lineColumn[1], location: { lineNumber, column } }
    }
  }

  const selector = READ_SELECTOR_SUFFIX_RE.exec(value)
  if (selector) {
    const lineNumber = positiveInteger(selector[2])
    if (lineNumber && selector[1]) {
      return { path: selector[1], location: { lineNumber, column: 1 } }
    }
  }

  return { path: value }
}

export function workspaceRelativePathForTerminalTarget(path: string, workspaceFolder: string): string | null {
  if (URI_SCHEME_RE.test(path)) return null
  const target = path.trim().replaceAll('\\', '/').replace(/\/+$/, '')
  const normalizedRoot = workspaceFolder.trim().replaceAll('\\', '/')
  const root = normalizedRoot === '/' ? normalizedRoot : normalizedRoot.replace(/\/+$/, '')
  if (!target || !root) return null

  const caseInsensitive = /^[A-Za-z]:\//.test(root) || root.startsWith('//')
  const targetKey = caseInsensitive ? target.toLowerCase() : target
  const rootKey = caseInsensitive ? root.toLowerCase() : root
  if (targetKey === rootKey) return ''
  const relative = root === '/'
    ? targetKey.startsWith('/') ? target.slice(1) : null
    : targetKey.startsWith(`${rootKey}/`) ? target.slice(root.length + 1) : null
  return relative ? normalizeWorkspaceRelativePath(relative) : null
}

export async function openTerminalLinkTarget(target: TerminalOpenTarget, mode: TerminalLinkOpenMode, options: OpenTerminalLinkOptions): Promise<void> {
  const { activeSessionId, workspaceFolder, contentActions } = options
  const relPath = mode === 'internal' && workspaceFolder
    ? workspaceRelativePathForTerminalTarget(target.path, workspaceFolder)
    : null

  if (activeSessionId && relPath !== null && workspaceFolder && contentActions) {
    let kind: WorkspacePathKind | null = null
    try {
      kind = await invoke<WorkspacePathKind>('fs_path_kind', { workspaceFolder, relPath })
    } catch {
      // A stale or missing target falls through to the OS, which reports the real open error.
    }
    if (options.isOwnershipCurrent?.() === false) return

    if (kind === 'textFile') {
      const panelId = await contentActions.openContent({
        kind: 'editor',
        relPath,
        workspaceId: activeSessionId,
        workspaceEpoch: options.workspaceEpoch,
      })
      if (!panelId || options.isOwnershipCurrent?.() === false) return
      if (target.location) requestEditorNavigation(activeSessionId, relPath, target.location)
      return
    }

    if (kind === 'directory' || kind === 'other') {
      await contentActions.openContent({ kind: 'explorer', workspaceId: activeSessionId, workspaceEpoch: options.workspaceEpoch })
      if (options.isOwnershipCurrent?.() === false) return
      if (relPath) await useExplorerStore.getState().revealPath(activeSessionId, workspaceFolder, relPath)
      return
    }
  }

  try {
    await options.openSystemPath(target.path)
  } catch (error) {
    toast.error(`Could not open terminal link: ${String(error)}`)
  }
}


function positiveInteger(value: string): number | null {
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}
