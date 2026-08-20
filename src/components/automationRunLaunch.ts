import { listAgentConversations } from '../ipc/agentHistory'
import { agentResumeLaunch } from './agent/agentSessionsModel'

/** How to open an automation run in a terminal pane so the user can watch it.
 *  When the run's agent left a resumable transcript in its worktree, we resume
 *  that conversation; otherwise we open a plain shell in the worktree so the
 *  user can inspect what the run did (files, git status) or re-run by hand. */
export type AutomationRunLaunch = {
  cwd: string
  shell?: string | null
  args?: string[]
  title: string
}

export async function resolveAutomationRunLaunch(
  worktreePath: string,
  fallbackTitle: string,
): Promise<AutomationRunLaunch> {
  const conversations = await listAgentConversations(worktreePath).catch(() => [])
  for (const conversation of conversations) {
    const launch = agentResumeLaunch(conversation)
    if (launch) return { cwd: worktreePath, shell: launch.shell, args: launch.args, title: launch.title }
  }
  // Hermes (and any agent without a resume transcript here): a shell at the
  // worktree still shows the actual result of the run.
  return { cwd: worktreePath, title: fallbackTitle }
}
