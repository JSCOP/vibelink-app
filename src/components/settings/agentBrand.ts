/** Maps agent ids onto their brand icon in `public/agent-icons`.
 *
 *  Every AI coding agent VibeLink integrates with owns a real vendor mark; a
 *  generic glyph is only used for an agent id we do not ship an icon for. Keep
 *  the ids in sync with `src-tauri/src/app/agent_hooks.rs` (hook specs) and
 *  `src-tauri/src/app/agents.rs` (CLI probes). */
const agentIconNames: Record<string, string> = {
  amp: 'amp',
  antigravity: 'antigravity',
  claude: 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
  'command-code': 'command-code',
  copilot: 'copilot',
  cursor: 'cursor',
  devin: 'devin',
  droid: 'droid',
  gemini: 'gemini',
  grok: 'grok',
  hermes: 'hermes',
  kimi: 'kimi',
  'mimo-code': 'mimo-code',
  'oh-my-pi': 'oh-my-pi',
  omp: 'oh-my-pi',
  opencode: 'opencode',
  openai: 'codex',
  pi: 'pi',
  powershell: 'powershell',
}

export function agentIconName(agentId: string): string {
  return agentIconNames[agentId.toLowerCase()] ?? 'bot'
}
