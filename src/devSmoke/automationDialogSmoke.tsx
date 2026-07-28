import { createRoot } from 'react-dom/client'
import { AutomationEditorDialog } from '../components/automations/AutomationEditorDialog'
import { useWorkspaceStore } from '../state/store'
import '../styles/theme.css'
import '../App.css'
import '../styles/automations.css'

useWorkspaceStore.setState({
  agentClis: [
    { id: 'hermes', displayName: 'Hermes', installed: true, auth: 'unknown', loginHint: 'hermes' },
    { id: 'omp', displayName: 'Oh My Pi', installed: true, auth: 'unknown', loginHint: 'omp' },
    { id: 'claude', displayName: 'Claude Code', installed: true, auth: 'loggedIn', loginHint: 'claude' },
    { id: 'codex', displayName: 'Codex', installed: false, auth: 'unknown', loginHint: 'codex login' },
    { id: 'opencode', displayName: 'OpenCode', installed: true, auth: 'unknown', loginHint: 'opencode auth login' },
  ],
})

createRoot(document.getElementById('root')!).render(
  <AutomationEditorDialog
    sessionId="smoke-session"
    automation={null}
    onClose={() => undefined}
    onSave={async () => undefined}
    onTestPrecheck={null}
  />,
)
