import type { WorkspaceCreationInput } from '../../ipc/providerIntegrations'
import { AssignedTab } from './AssignedTab'
import { GitWindowView } from './GitWindowView'
import { useGitWorkspace } from './GitWorkspaceProvider'
import { PullRequestsTab } from './PullRequestsTab'

export type WorkbenchContentPanelProps = {
  onWorkspaceInput?: (input: WorkspaceCreationInput) => void | Promise<void>
}

export function WorkbenchContentPanel({ onWorkspaceInput }: WorkbenchContentPanelProps = {}) {
  const git = useGitWorkspace()
  const reviewContent = git.sessionId && git.activeWorkspaceFolder && git.repoInfo && git.repository.hostingInfo ? (
    <PullRequestsTab
      sessionId={git.sessionId}
      workspaceFolder={git.activeWorkspaceFolder}
      repoInfo={git.repoInfo}
      hostingInfo={git.repository.hostingInfo}
      hostingError={git.repository.hostingError}
      onHostingChanged={() => git.refreshHosting(true)}
      onRepositoryChanged={git.refreshRepository}
      onRevealFile={git.selectInExplorer}
    />
  ) : null
  const assignedContent = git.sessionId ? <AssignedTab sessionId={git.sessionId} onWorkspaceInput={onWorkspaceInput} reviewContent={reviewContent} /> : null
  return <GitWindowView assignedContent={assignedContent} />
}
