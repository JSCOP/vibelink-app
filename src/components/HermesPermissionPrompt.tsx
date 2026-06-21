import { invoke } from '@tauri-apps/api/core'
import ReactDiffViewer from 'react-diff-viewer-continued'
import type { PendingPermission } from '../state/hermes'
import { useWorkspaceStore } from '../state/store'

type HermesPermissionPromptProps = {
  sessionId: string
  permission: PendingPermission
}

export function HermesPermissionPrompt({ sessionId, permission }: HermesPermissionPromptProps) {
  const resolveHermesPermission = useWorkspaceStore((state) => state.resolveHermesPermission)
  const respond = async (optionId: string) => {
    await invoke('hermes_respond_permission', { sessionId, requestId: permission.requestId, optionId })
    resolveHermesPermission(sessionId, permission.requestId)
  }

  return (
    <section className="hermes-permission">
      <h4>{permission.title || 'Permission requested'}</h4>
      <p>{permission.toolKind}</p>
      {permission.oldText !== undefined || permission.newText !== undefined ? (
        <div className="hermes-permission-diff">
          {permission.diffPath ? <strong>{permission.diffPath}</strong> : null}
          <ReactDiffViewer oldValue={permission.oldText ?? ''} newValue={permission.newText ?? ''} splitView={false} useDarkTheme />
        </div>
      ) : null}
      <div className="hermes-permission-actions">
        {permission.options.map((option) => (
          <button key={option.optionId} type="button" onClick={() => void respond(option.optionId)}>
            {option.name || option.optionId}
          </button>
        ))}
      </div>
    </section>
  )
}
