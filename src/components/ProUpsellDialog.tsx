import { invoke } from '@tauri-apps/api/core'
import { useWorkspaceStore } from '../state/store'

export function ProUpsellDialog({ feature, onClose }: { feature: string; onClose: () => void }) {
  const purchaseUrl = useWorkspaceStore((state) => state.license.status?.purchaseUrl)
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog-card pro-upsell-dialog" role="dialog" aria-modal="true" aria-label="VibeLink Pro required" onMouseDown={(event) => event.stopPropagation()}>
        <h2>{feature} requires VibeLink Pro</h2>
        <p>Sign in with a Moobang account that owns Pro to use agent orchestration, Kanban, task roles, worktrees, and diffs.</p>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Not now</button>
          <button type="button" onClick={() => void invoke('open_path', { path: purchaseUrl })}>Get VibeLink Pro</button>
        </div>
      </section>
    </div>
  )
}
