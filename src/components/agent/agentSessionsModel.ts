import type { AgentConversationInfo } from '../../ipc/agentHistory'
import type { PaneMeta } from '../../ipc/types'
import { codexLaunchArgv, powerShellCommand } from '../../state/profiles'

const AGENT_LABEL_BY_ID: Record<string, string> = {
  omp: 'Oh My Pi',
  codex: 'Codex',
  claude: 'Claude Code',
  opencode: 'OpenCode',
}

export function formatAgentSessionUpdatedAt(value: string | null, now = Date.now()): string {
  if (!value) return 'Time unavailable'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < 60_000) return 'Just now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d ago`
  return new Date(timestamp).toLocaleDateString()
}

export function agentConversationLabel(agent: string): string {
  return AGENT_LABEL_BY_ID[agent] ?? agent
}

export function visibleAgentConversations(conversations: AgentConversationInfo[], search: string): AgentConversationInfo[] {
  const needle = search.trim().toLocaleLowerCase()
  if (!needle) return conversations
  return conversations.filter((conversation) =>
    `${conversation.title}\n${conversation.agent}\n${conversation.cwd ?? ''}`.toLocaleLowerCase().includes(needle))
}

/** Match conversations opened from Agent Sessions back to their live panes.
 * The launch argv is persisted with PaneConfig, so this survives app restarts
 * without adding a second session-to-pane authority. */
export function agentConversationPaneIds(conversation: AgentConversationInfo, panes: readonly PaneMeta[]): string[] {
  const launch = agentResumeLaunch(conversation)
  if (!launch) return []
  const legacyCodexArgs = conversation.agent === 'codex'
    ? ['-NoLogo', '-NoExit', '-Command', powerShellCommand(['codex', 'resume', conversation.id])]
    : null
  return panes
    .filter((pane) => pane.alive
      && [launch.args, legacyCodexArgs].some((args) => args
        && pane.config.args.length === args.length
        && pane.config.args.every((value, index) => value === args[index])))
    .map((pane) => pane.id)
}

/** Build the terminal command that resumes a past agent conversation by id. */
export function agentResumeLaunch(conversation: AgentConversationInfo): { shell: string; args: string[]; title: string } | null {
  const RESUME_ARGV_BY_AGENT: Record<string, (id: string) => string[]> = {
    omp: (id) => ['omp', '-r', id],
    codex: (id) => codexLaunchArgv(['resume', id]),
    claude: (id) => ['claude', '-r', id],
  }
  const build = RESUME_ARGV_BY_AGENT[conversation.agent]
  if (!build || !conversation.id) return null
  const argv = build(conversation.id)
  return {
    shell: 'pwsh.exe',
    args: ['-NoLogo', '-NoExit', '-Command', powerShellCommand(argv)],
    title: `${agentConversationLabel(conversation.agent)}: ${conversation.title}`,
  }
}
