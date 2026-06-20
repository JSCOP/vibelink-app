export type SessionMeta = {
  id: string
  name: string
  paneCount: number
  createdAt: number
  workspaceFolder?: string | null
}

export type PaneConfig = {
  paneId: string
  shell?: string | null
  args: string[]
  cwd?: string | null
  env: [string, string][]
  title?: string | null
  icon?: string | null
  cols: number
  rows: number
}

export type PaneMeta = {
  id: string
  config: PaneConfig
  alive: boolean
}

export type AttachedSession = {
  layoutJson?: string | null
  panes: PaneMeta[]
}
