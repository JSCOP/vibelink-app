import { invoke } from '@tauri-apps/api/core'

export function listWorkspaceFiles(workspaceFolder: string): Promise<string[]> {
  return invoke<string[]>('fs_list_workspace_files', { workspaceFolder })
}
