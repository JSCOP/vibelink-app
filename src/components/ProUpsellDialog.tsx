import { invoke } from '@tauri-apps/api/core'
import { AccountSignIn } from './AccountSignIn'
import { appLockReason, lockScreenCopy, type LockScreenAction } from '../state/lockScreenCopy'
import { useWorkspaceStore } from '../state/store'

export function ProUpsellDialog({ feature, onClose }: { feature: string; onClose: () => void }) {
  const status = useWorkspaceStore((state) => state.license.status)
  const revalidateLicense = useWorkspaceStore((state) => state.revalidateLicense)
  const signOutAccount = useWorkspaceStore((state) => state.signOutAccount)
  const purchaseUrl = status?.purchaseUrl.trim() ?? ''
  const copy = lockScreenCopy(appLockReason(status?.state), purchaseUrl.length > 0)

  const renderAction = (action: LockScreenAction, primary: boolean) => {
    if (action.kind === 'signIn') return <AccountSignIn onActivated={() => { void revalidateLicense() }} />
    const onClick = action.available
      ? action.kind === 'purchase'
        ? () => { void invoke('open_path', { path: purchaseUrl }) }
        : action.kind === 'refresh'
          ? () => { void revalidateLicense() }
          : () => { void signOutAccount() }
      : undefined
    return <button type="button" className={primary ? 'primary-action' : undefined} disabled={!action.available} onClick={onClick}>{action.label}</button>
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog-card pro-upsell-dialog" data-feature={feature} role="dialog" aria-modal="true" aria-label={copy.heading} onMouseDown={(event) => event.stopPropagation()}>
        <h2>{copy.heading}</h2>
        <p>{copy.body}</p>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Close</button>
          {renderAction(copy.primary, true)}
          {copy.secondary ? renderAction(copy.secondary, false) : null}
        </div>
        {!copy.primary.available ? <p className="settings-error" role="status">{copy.primary.unavailableReason}</p> : null}
      </section>
    </div>
  )
}
