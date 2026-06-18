import { useState } from 'react'
import { X } from 'lucide-react'
import { TEMPLATES } from '../layout/templates'

type WorkspaceCreateDialogProps = {
  onCreate: (name: string, templateId: string) => void
  onClose: () => void
}

export function WorkspaceCreateDialog({ onCreate, onClose }: WorkspaceCreateDialogProps) {
  const [name, setName] = useState('')
  const [templateId, setTemplateId] = useState('2x2')

  const submit = () => {
    onCreate(name.trim(), templateId)
  }

  return (
    <div className="workspace-create-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="workspace-create-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-create-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="workspace-create-header">
          <div>
            <p className="settings-eyebrow">New workspace</p>
            <h2 id="workspace-create-title">Choose a starting grid</h2>
          </div>
          <button type="button" className="settings-close" title="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <label className="workspace-create-name">
          Name
          <input autoFocus value={name} placeholder="Workspace" onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit() }} />
        </label>

        <div className="workspace-template-grid">
          {TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              className={template.id === templateId ? 'selected' : ''}
              onClick={() => setTemplateId(template.id)}
            >
              <span>{template.label}</span>
              <small>{template.cols * template.rows} panes</small>
            </button>
          ))}
        </div>

        <footer className="workspace-create-footer">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-action" onClick={submit}>Create workspace</button>
        </footer>
      </section>
    </div>
  )
}
