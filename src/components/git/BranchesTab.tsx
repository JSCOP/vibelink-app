import { useGitWorkspace } from './GitWorkspaceProvider'
import { BranchCompareDetailView } from './BranchesTabView'

export function BranchesTab() {
  const { branches } = useGitWorkspace()
  return (
    <section className="git-branches-tab git-branches-detail-only" data-git-branches="true">
      <BranchCompareDetailView
        baseRef={branches.baseRef}
        headRef={branches.headRef}
        compareFiles={branches.compareFiles}
        selectedPath={branches.selectedPath}
        contents={branches.contents}
        loading={branches.contentsLoading}
        error={branches.contentsError}
        onOpenBasePicker={branches.openBasePicker}
        onOpenHeadPicker={branches.openHeadPicker}
        onCompare={branches.compare}
        onSelectFile={branches.selectFile}
      />
    </section>
  )
}
