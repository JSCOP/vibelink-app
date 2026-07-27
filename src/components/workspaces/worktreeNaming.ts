export function worktreeBranchName(name: string): string {
  const slug = name.trim().toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `vibelink/${slug || 'worktree'}`
}
