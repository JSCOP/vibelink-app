import { useState } from 'react'
import { Bug, X } from 'lucide-react'
import { submitBugReport, type BugReportInput } from '../ipc/bugReports'
import { toast } from './toast/toastStore'

const categories: { value: BugReportInput['category']; label: string }[] = [
  { value: 'crash', label: 'Crash or freeze' },
  { value: 'terminal', label: 'Terminal' },
  { value: 'agent', label: 'Agent / Hermes' },
  { value: 'account', label: 'Account / sign-in' },
  { value: 'billing', label: 'Purchase / billing' },
  { value: 'remote', label: 'Remote / mobile' },
  { value: 'other', label: 'Other' },
]

export function BugReportDialog({ onClose }: { onClose: () => void }) {
  const [category, setCategory] = useState<BugReportInput['category']>('other')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [stepsToReproduce, setStepsToReproduce] = useState('')
  const [contactAllowed, setContactAllowed] = useState(true)
  const [busy, setBusy] = useState(false)

  const submit = () => {
    setBusy(true)
    void submitBugReport({
      category,
      title: title.trim(),
      description: description.trim(),
      stepsToReproduce: stepsToReproduce.trim() || null,
      contactAllowed,
    }).then((report) => {
      setTitle('')
      setDescription('')
      setStepsToReproduce('')
      toast.success(`Bug report received · ${report.id}`)
      setBusy(false)
    }, (error: unknown) => {
      toast.error(String(error))
      setBusy(false)
    })
  }

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="settings-dialog bug-report-dialog" role="dialog" aria-modal="true" aria-labelledby="bug-report-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-dialog-header">
          <div>
            <p className="settings-eyebrow">VibeLink support</p>
            <h2 id="bug-report-title"><Bug size={17} /> Report a bug</h2>
          </div>
          <button type="button" className="settings-close" title="Close bug report" onClick={onClose}><X size={14} /></button>
        </header>
        <form onSubmit={(event) => { event.preventDefault(); void submit() }} className="bug-report-form">
          <section className="settings-card vibelink-settings-group-body">
            <label>
              Area
              <select value={category} onChange={(event) => setCategory(event.target.value as BugReportInput['category'])}>
                {categories.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label>
              Short summary
              <input value={title} onChange={(event) => setTitle(event.target.value)} minLength={4} maxLength={120} required placeholder="What went wrong?" />
            </label>
            <label>
              What happened?
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} minLength={10} maxLength={4000} required rows={7} placeholder="Describe the actual result and what you expected." />
            </label>
            <label>
              Steps to reproduce (optional)
              <textarea value={stepsToReproduce} onChange={(event) => setStepsToReproduce(event.target.value)} maxLength={4000} rows={5} placeholder={'1. Open…\n2. Click…\n3. See…'} />
            </label>
            <label className="bug-report-contact">
              <input type="checkbox" checked={contactAllowed} onChange={(event) => setContactAllowed(event.target.checked)} />
              <span>Allow support to reply to my Moobang account email.</span>
            </label>
            <p className="vibelink-settings-note">Limit: 20 reports per account per day. VibeLink attaches only its version and Windows platform. Logs, terminal output, workspace paths, and tokens are never attached automatically.</p>
          </section>
          <footer className="settings-dialog-footer">
            <span>Do not include passwords, tokens, or private terminal output.</span>
            <div className="vibelink-settings-actions">
              <button type="button" className="secondary-action" onClick={onClose}>Cancel</button>
              <button type="submit" className="primary-action" disabled={busy}>{busy ? 'Submitting…' : 'Submit report'}</button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  )
}
