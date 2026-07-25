import { invoke } from '@tauri-apps/api/core'

export type DiscoveredRepo = {
  name: string
  path: string
  isSubmodule: boolean
}

export function discoverRepos(root: string, maxDepth?: number): Promise<DiscoveredRepo[]> {
  return invoke<DiscoveredRepo[]>('git_discover_repos', { root, maxDepth: maxDepth ?? null })
}
