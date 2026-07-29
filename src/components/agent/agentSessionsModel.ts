import type { AgentConversationInfo } from '../../ipc/agentHistory'
import type { PaneMeta } from '../../ipc/types'

const AGENT_LABEL_BY_ID: Record<string, string> = {
  omp: 'Oh My Pi',
  codex: 'Codex',
  claude: 'Claude Code',
  opencode: 'OpenCode',
}

export const agentSessionDragMime = 'application/x-vibelink-agent-session'
export const agentSessionDragEndEvent = 'vibelink-agent-session-drag-end'

export type AgentSessionDragPayload = {
  shell: string
  args: string[]
  title: string
  cwd: string | null
}

let activeAgentSessionDragPayload: AgentSessionDragPayload | null = null

export function writeAgentSessionDragPayload(dataTransfer: DataTransfer, payload: AgentSessionDragPayload): void {
  const serialized = JSON.stringify({ kind: 'agent-session', version: 1, ...payload })
  activeAgentSessionDragPayload = { ...payload, args: [...payload.args] }
  dataTransfer.effectAllowed = 'copy'
  dataTransfer.setData(agentSessionDragMime, serialized)
}

export function hasAgentSessionDragPayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(agentSessionDragMime)
}

export function readAgentSessionDragPayload(dataTransfer: DataTransfer): AgentSessionDragPayload | null {
  const raw = dataTransfer.getData(agentSessionDragMime)
  if (!raw) return hasAgentSessionDragPayload(dataTransfer) && activeAgentSessionDragPayload
    ? { ...activeAgentSessionDragPayload, args: [...activeAgentSessionDragPayload.args] }
    : null
  if (raw.length > 16 * 1024) return null
  try {
    const parsed = JSON.parse(raw) as Partial<AgentSessionDragPayload> & { kind?: unknown; version?: unknown }
    if (parsed.kind !== 'agent-session' || parsed.version !== 1) return null
    if (typeof parsed.shell !== 'string' || !parsed.shell.trim()) return null
    if (typeof parsed.title !== 'string' || !parsed.title.trim()) return null
    if (!(parsed.cwd === null || typeof parsed.cwd === 'string')) return null
    if (!Array.isArray(parsed.args) || parsed.args.length > 32 || parsed.args.some((arg) => typeof arg !== 'string' || arg.length > 4096)) return null
    return { shell: parsed.shell, args: [...parsed.args], title: parsed.title, cwd: parsed.cwd }
  } catch {
    return null
  }
}

export function clearAgentSessionDragPayload(): void {
  activeAgentSessionDragPayload = null
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
  return panes
    .filter((pane) => pane.alive
      && pane.config.args.length === launch.args.length
      && pane.config.args.every((value, index) => value === launch.args[index]))
    .map((pane) => pane.id)
}

/** Build the terminal command that resumes a past agent conversation by id. */
export function agentResumeLaunch(conversation: AgentConversationInfo): { shell: string; args: string[]; title: string } | null {
  const RESUME_ARGV_BY_AGENT: Record<string, (id: string) => string[]> = {
    omp: (id) => ['omp', '-r', id],
    codex: (id) => ['codex', 'resume', id],
    claude: (id) => ['claude', '-r', id],
  }
  const build = RESUME_ARGV_BY_AGENT[conversation.agent]
  if (!build || !conversation.id) return null
  const argv = build(conversation.id)
  const command = argv.map((part) => (/^[\w./:@-]+$/.test(part) ? part : `'${part.replaceAll("'", "''")}'`)).join(' ')
  return {
    shell: 'pwsh.exe',
    args: ['-NoLogo', '-NoExit', '-Command', command],
    title: `${agentConversationLabel(conversation.agent)}: ${conversation.title}`,
  }
}
