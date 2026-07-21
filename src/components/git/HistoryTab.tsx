import { useGitWorkspace } from './GitWorkspaceProvider'
import { HistoryDetailView } from './HistoryTabView'

export function HistoryTab() {
  const { history } = useGitWorkspace()
  return (
    <section className="git-history-tab git-history-detail-only" data-git-history="true">
      <HistoryDetailView
        detail={history.detail}
        detailLoading={history.detailLoading}
        compareMode={history.compareMode}
        compareFiles={history.compareFiles}
        selectedPath={history.selectedPath}
        contents={history.contents}
        contentsLoading={history.contentsLoading}
        contentsError={history.contentsError}
        onSelectFile={history.selectFile}
        onCopySha={history.copySha}
        onCompareHead={history.compareHead}
        onCreateBranch={history.createBranch}
        onCreateTag={history.createTag}
      />
    </section>
  )
}
