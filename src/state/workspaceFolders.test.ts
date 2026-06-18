import { describe, expect, it } from 'vitest'
import { normalizeWorkspaceFolderHistory, rememberWorkspaceFolder, toggleFavoriteWorkspaceFolder } from './workspaceFolders'

describe('workspace folder history', () => {
  it('keeps recent folders unique with newest first', () => {
    const history = rememberWorkspaceFolder({ recent: ['C:/old', 'E:/repo'], favorites: [] }, 'E:/repo')

    expect(history.recent).toEqual(['E:/repo', 'C:/old'])
  })

  it('normalizes recent and favorite folders', () => {
    expect(normalizeWorkspaceFolderHistory({ recent: ['  E:/repo  ', '', 3], favorites: ['C:/Users/js', 'E:/repo'] })).toEqual({
      recent: ['E:/repo'],
      favorites: ['C:/Users/js', 'E:/repo'],
    })
  })

  it('toggles favorite folders without removing recent history', () => {
    const added = toggleFavoriteWorkspaceFolder({ recent: ['E:/repo'], favorites: [] }, 'E:/repo')
    const removed = toggleFavoriteWorkspaceFolder(added, 'E:/repo')

    expect(added).toEqual({ recent: ['E:/repo'], favorites: ['E:/repo'] })
    expect(removed).toEqual({ recent: ['E:/repo'], favorites: [] })
  })
})
