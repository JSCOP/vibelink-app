import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { GitBranch as GitBranchIcon } from 'lucide-react'
import type { BranchInfo, ChangedFile, FileContents, RepoInfo, StashInfo, TagInfo, WorkingStatus } from '../../ipc/types'
import { QuickPick } from '../QuickPick'
import type { PickerEntry } from '../pickerModel'
import { BranchesTabView, type BranchRowAction, type BranchRowView, type StashDialogState } from './BranchesTabView'

export type BranchesTabProps = {
  sessionId: string
  workspaceFolder: string
  repoInfo: RepoInfo
  status: WorkingStatus
  onRunMutation: (operation: () => Promise<unknown>) => Promise<void>
}

type RefPicker = 'base' | 'head' | null

export function BranchesTab({ workspaceFolder, repoInfo, status, onRunMutation }: BranchesTabProps) {
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [stashes, setStashes] = useState<StashInfo[]>([])
  const [tags, setTags] = useState<TagInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [baseRef, setBaseRef] = useState(repoInfo.upstream ?? 'HEAD')
  const [headRef, setHeadRef] = useState(repoInfo.branch ?? 'HEAD')
  const [picker, setPicker] = useState<RefPicker>(null)
  const [compareFiles, setCompareFiles] = useState<ChangedFile[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [contents, setContents] = useState<FileContents | null>(null)
  const [loading, setLoading] = useState(false)
  const [stashOpen, setStashOpen] = useState(false)
  const [stashMessage, setStashMessage] = useState('')
  const [includeUntracked, setIncludeUntracked] = useState(false)

  const reload = useCallback(async () => {
    try {
      const [nextBranches, nextStashes, nextTags] = await Promise.all([
        invoke<BranchInfo[]>('git_branches', { workspaceFolder }),
        invoke<StashInfo[]>('git_stash_list', { workspaceFolder }),
        invoke<TagInfo[]>('git_tag_list', { workspaceFolder }),
      ])
      setBranches(nextBranches)
      setStashes(nextStashes)
      setTags(nextTags)
      setError(null)
    } catch (reason) {
      setError(String(reason))
    }
  }, [workspaceFolder])

  useEffect(() => { const timer = window.setTimeout(() => { void reload() }, 0); return () => window.clearTimeout(timer) }, [reload])

  const mutate = useCallback((operation: () => Promise<unknown>, after?: () => void) => {
    void onRunMutation(operation)
      .then(() => reload())
      .then(after)
      .catch((reason) => setError(String(reason)))
  }, [onRunMutation, reload])

  const branchActions = useCallback((branch: BranchInfo): BranchRowAction[] => {
    const actions: BranchRowAction[] = [
      { id: 'checkout', label: 'Checkout', onClick: () => mutate(() => invoke('git_checkout', { workspaceFolder, refName: branch.name })) },
      { id: 'merge', label: 'Merge', onClick: () => mutate(() => invoke('git_merge', { workspaceFolder, refName: branch.name })) },
      { id: 'rebase', label: 'Rebase', onClick: () => mutate(() => invoke('git_rebase', { workspaceFolder, refName: branch.name })) },
      { id: 'copy', label: 'Copy name', onClick: () => { void navigator.clipboard.writeText(branch.name) } },
      { id: 'new-from', label: 'New branch from', onClick: () => {
        const name = window.prompt('New branch name')?.trim()
        if (name) mutate(() => invoke('git_branch_create', { workspaceFolder, name, fromRef: branch.name, checkout: false }))
      } },
    ]
    if (!branch.isRemote) {
      actions.splice(3, 0,
        { id: 'rename', label: 'Rename', onClick: () => {
          const newName = window.prompt('Rename branch', branch.name)?.trim()
          if (newName && newName !== branch.name) mutate(() => invoke('git_branch_rename', { workspaceFolder, oldName: branch.name, newName }))
        } },
        { id: 'delete', label: 'Delete', danger: true, onClick: () => {
          if (!window.confirm(`Delete branch ${branch.name}?`)) return
          void onRunMutation(() => invoke('git_branch_delete', { workspaceFolder, name: branch.name, force: false }))
            .then(() => reload())
            .catch((reason) => {
              const message = String(reason)
              if (message.includes('not fully merged') && window.confirm(`${message}\nForce delete?`)) {
                mutate(() => invoke('git_branch_delete', { workspaceFolder, name: branch.name, force: true }))
              } else setError(message)
            })
        } },
      )
    }
    return actions
  }, [mutate, onRunMutation, reload, workspaceFolder])

  const localRows = useMemo<BranchRowView[]>(() => branches.filter((branch) => !branch.isRemote).map((branch) => ({ branch, actions: branchActions(branch) })), [branchActions, branches])
  const remoteRows = useMemo<BranchRowView[]>(() => branches.filter((branch) => branch.isRemote).map((branch) => ({ branch, actions: branchActions(branch) })), [branchActions, branches])
  const refNames = useMemo(() => Array.from(new Set(['HEAD', ...branches.map((branch) => branch.name), ...tags.map((tag) => tag.name)])), [branches, tags])
  const refEntries = useCallback((filter: string): PickerEntry<string>[] => refNames
    .filter((ref) => ref.toLowerCase().includes(filter.toLowerCase()))
    .map((ref) => ({ kind: 'item', id: ref, name: ref })), [refNames])

  const compare = useCallback(() => {
    setLoading(true)
    setError(null)
    void invoke<ChangedFile[]>('git_diff_refs', { workspaceFolder, baseRef, headRef })
      .then((files) => {
        setCompareFiles(files)
        setSelectedPath(files[0]?.path ?? null)
        setContents(null)
      })
      .catch((reason) => setError(String(reason)))
      .finally(() => setLoading(false))
  }, [baseRef, headRef, workspaceFolder])

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (!selectedPath) { setContents(null); return }
      setLoading(true)
      void invoke<FileContents>('git_diff_refs_file', { workspaceFolder, baseRef, headRef, path: selectedPath })
        .then((next) => { if (!cancelled) setContents(next) })
        .catch((reason) => { if (!cancelled) setError(String(reason)) })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [baseRef, headRef, selectedPath, workspaceFolder])

  const stashDialog: StashDialogState = {
    open: stashOpen,
    message: stashMessage,
    includeUntracked,
    onMessageChange: setStashMessage,
    onIncludeUntrackedChange: setIncludeUntracked,
    onSave: () => mutate(
      () => invoke('git_stash_save', { workspaceFolder, message: stashMessage, includeUntracked }),
      () => { setStashOpen(false); setStashMessage(''); setIncludeUntracked(false) },
    ),
    onClose: () => setStashOpen(false),
  }

  const workingTreeDirty = status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length > 0

  return (
    <>
      <BranchesTabView
        localRows={localRows}
        remoteRows={remoteRows}
        stashRows={stashes.map((stash) => ({
          stash,
          onApply: () => mutate(() => invoke('git_stash_apply', { workspaceFolder, index: stash.index })),
          onPop: () => mutate(() => invoke('git_stash_pop', { workspaceFolder, index: stash.index })),
          onDrop: () => { if (window.confirm(`Drop stash@{${stash.index}}?`)) mutate(() => invoke('git_stash_drop', { workspaceFolder, index: stash.index })) },
        }))}
        workingTreeDirty={workingTreeDirty}
        baseRef={baseRef}
        headRef={headRef}
        compareFiles={compareFiles}
        selectedPath={selectedPath}
        contents={contents}
        loading={loading}
        error={error}
        stashDialog={stashDialog}
        onCreateBranch={() => {
          const name = window.prompt('Branch name')?.trim()
          if (name) mutate(() => invoke('git_branch_create', { workspaceFolder, name, fromRef: null, checkout: false }))
        }}
        onOpenBasePicker={() => setPicker('base')}
        onOpenHeadPicker={() => setPicker('head')}
        onCompare={compare}
        onSelectFile={setSelectedPath}
        onOpenStash={() => setStashOpen(true)}
      />
      {picker && refNames.length > 0 ? (
        <QuickPick
          value={picker === 'base' ? baseRef : headRef}
          ariaLabel={picker === 'base' ? 'Choose base ref' : 'Choose head ref'}
          placeholder="Search refs"
          icon={<GitBranchIcon size={15} />}
          noMatchLabel="refs"
          entriesForFilter={refEntries}
          renderItem={(item) => <span>{item.name}</span>}
          onPreview={() => {}}
          onSelect={(ref) => {
            if (picker === 'base') setBaseRef(ref)
            else setHeadRef(ref)
            setPicker(null)
          }}
          onCancel={() => setPicker(null)}
        />
      ) : null}
    </>
  )
}
