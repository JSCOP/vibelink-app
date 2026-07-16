import { invoke } from '@tauri-apps/api/core'
import { LockKeyhole } from 'lucide-react'
import { useWorkspaceStore } from '../state/store'

export function ProLockedPanel({ feature }: { feature: string }) {
  const status = useWorkspaceStore((state) => state.license.status)
  return (
    <div className="pro-locked-panel">
      <LockKeyhole size={28} />
      <h2>{feature} requires VibeLink Pro</h2>
      <p>Your saved layout and data stay in place. Sign in with the Moobang account that owns Pro to restore this panel.</p>
      <button type="button" onClick={() => void invoke('open_path', { path: status?.purchaseUrl })}>Get VibeLink Pro</button>
    </div>
  )
}
