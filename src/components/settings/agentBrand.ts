/** Maps hook ids onto an available brand or semantic profile icon. */
const agentIconNames: Record<string, string> = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
  gemini: 'sparkles',
  antigravity: 'rocket',
  amp: 'zap',
  opencode: 'opencode',
  'mimo-code': 'file-code',
  cursor: 'code',
  pi: 'terminal-square',
  omp: 'oh-my-pi',
  'oh-my-pi': 'oh-my-pi',
  droid: 'bot',
  'command-code': 'command',
  grok: 'flame',
  copilot: 'git-branch',
  hermes: 'messages-square',
  devin: 'bot',
  kimi: 'sparkles',
  powershell: 'powershell',
}

export function agentIconName(agentId: string): string {
  return agentIconNames[agentId.toLowerCase()] ?? 'bot'
}
