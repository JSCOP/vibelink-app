export function worktreeNameSlug(name: string): string {
  return name.trim().toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function worktreeBranchName(name: string): string {
  return `vibelink/${worktreeNameSlug(name) || 'worktree'}`
}
