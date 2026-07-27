/**
 * Maps an agent CLI / hook id onto the brand icon registered in
 * `state/profileIcons.ts`. Settings shows the real agent mark rather than a
 * generic robot glyph so a row is identifiable before its label is read.
 */
const agentIconNames: Record<string, string> = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
  omp: 'oh-my-pi',
  'oh-my-pi': 'oh-my-pi',
  opencode: 'opencode',
  powershell: 'powershell',
}

export function agentIconName(agentId: string): string {
  return agentIconNames[agentId.toLowerCase()] ?? 'bot'
}
