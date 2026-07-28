import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Bot, CheckCircle2, LoaderCircle, PlayCircle, Sparkles, X } from 'lucide-react'
import {
  cancelAutomationDraft,
  createAutomationDraftRequestId,
  normalizeAutomationRpcError,
  previewAutomationDraft,
  previewAutomationSchedule,
  type AutomationDraftPreview,
  type AutomationPrecheckResult,
  type AutomationRecord,
  type AutomationScheduleKind,
  type CreateAutomationInput,
} from '../../ipc/automations'
import type { WorktreeStorage } from '../../ipc/types'

const DEFAULT_SCHEDULES: Record<AutomationScheduleKind, string> = {
  once: String(Date.now() + 3_600_000),
  interval: '1h',
  hourly: '0',
  daily: '09:00',
  weekdays: '09:00',
  weekly: 'MON@09:00',
  cron: '0 9 * * 1-5',
}

const DEFAULT_STORAGE: WorktreeStorage = {
  mode: 'appData',
  drive: '',
  folderName: 'VibeLinkWorktrees',
  customRoot: '',
  groupByRepository: true,
}

export type AutomationEditorSaveInput = CreateAutomationInput & { requiresReview: boolean }

type AutomationEditorDialogProps = {
  sessionId: string
  automation: AutomationRecord | null
  onClose: () => void
  onSave: (input: AutomationEditorSaveInput) => Promise<void>
  onTestPrecheck: ((automationId: string) => Promise<AutomationPrecheckResult>) | null
}

function scheduleSummary(kind: AutomationScheduleKind, value: string, timezone: string): string {
  const trimmed = value.trim()
  if (!trimmed) return 'Enter a schedule value.'
  switch (kind) {
    case 'once': {
      const timestamp = Number(trimmed)
      return Number.isFinite(timestamp)
        ? `Once on ${new Date(timestamp).toLocaleString()} (${timezone})`
        : 'Once requires Unix epoch milliseconds.'
    }
    case 'interval': return `Every ${trimmed}, anchored when saved.`
    case 'hourly': return `Hourly at minute ${trimmed} (${timezone}).`
    case 'daily': return `Daily at ${trimmed} (${timezone}).`
    case 'weekdays': return `Weekdays at ${trimmed} (${timezone}).`
    case 'weekly': return `Weekly on ${trimmed} (${timezone}).`
    case 'cron': return `Five-field cron: ${trimmed} (${timezone}).`
  }
}

function splitNames(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function formatOccurrence(value: number): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
}

export function AutomationEditorDialog({ sessionId, automation, onClose, onSave, onTestPrecheck }: AutomationEditorDialogProps) {
  const dialogRef = useRef<HTMLElement | null>(null)
  const activeDraftId = useRef<string | null>(null)
  const [name, setName] = useState(automation?.name ?? 'Daily workspace review')
  const [prompt, setPrompt] = useState(automation?.prompt ?? 'Review this workspace and report actionable issues.')
  const [scheduleKind, setScheduleKind] = useState<AutomationScheduleKind>(automation?.scheduleKind ?? 'daily')
  const [scheduleValue, setScheduleValue] = useState(automation?.scheduleValue ?? DEFAULT_SCHEDULES.daily)
  const [timezone, setTimezone] = useState(automation?.timezone ?? 'UTC')
  const [enabled, setEnabled] = useState(automation?.enabled ?? true)
  const [workspaceMode, setWorkspaceMode] = useState<'new_per_run' | 'existing'>(automation?.workspaceMode ?? 'new_per_run')
  const [storage, setStorage] = useState<WorktreeStorage>(automation?.worktreeStorage ?? DEFAULT_STORAGE)
  const [baseRef, setBaseRef] = useState(automation?.baseRef ?? '')
  const [useCurrentHermesDefault, setUseCurrentHermesDefault] = useState(automation?.useCurrentHermesDefault ?? true)
  const [provider, setProvider] = useState(automation?.provider ?? '')
  const [model, setModel] = useState(automation?.model ?? '')
  const [toolsets, setToolsets] = useState((automation?.toolsets ?? ['hermes-acp']).join(', '))
  const [skills, setSkills] = useState((automation?.skills ?? []).join(', '))
  const [maxTurns, setMaxTurns] = useState(automation?.maxTurns ?? 50)
  const [timeoutSeconds, setTimeoutSeconds] = useState(automation?.timeoutSeconds ?? 1_800)
  const [missedRunGraceMinutes, setMissedRunGraceMinutes] = useState(automation?.missedRunGraceMinutes ?? 720)
  const [precheckCommand, setPrecheckCommand] = useState(automation?.precheck.command ?? '')
  const [precheckTimeout, setPrecheckTimeout] = useState(automation?.precheck.timeoutSeconds ?? 60)
  const [requireGit, setRequireGit] = useState(automation?.precheck.requireGit ?? false)
  const [draftRequest, setDraftRequest] = useState('')
  const [draftBusy, setDraftBusy] = useState(false)
  const [draftNotes, setDraftNotes] = useState<string[]>([])
  const [occurrences, setOccurrences] = useState<number[]>([])
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const [precheckResult, setPrecheckResult] = useState<AutomationPrecheckResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = useCallback(() => {
    const draftId = activeDraftId.current
    if (draftId) void cancelAutomationDraft(draftId).catch(() => undefined)
    activeDraftId.current = null
    onClose()
  }, [onClose])

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopImmediatePropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (!(active instanceof Node) || !dialogRef.current.contains(active)) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    dialogRef.current?.focus()
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      const draftId = activeDraftId.current
      if (draftId) void cancelAutomationDraft(draftId).catch(() => undefined)
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [close])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void previewAutomationSchedule({
        scheduleKind,
        scheduleValue,
        timezone,
        dtstart: automation?.dtstart ?? null,
        count: 5,
      }).then((next) => {
        setOccurrences(next)
        setScheduleError(null)
      }).catch((cause) => {
        setOccurrences([])
        setScheduleError(normalizeAutomationRpcError(cause).message)
      })
    }, 220)
    return () => window.clearTimeout(timer)
  }, [automation?.dtstart, scheduleKind, scheduleValue, timezone])

  const sourceWarning = automation?.source
    ? `Imported from Hermes Cron job ${automation.source.sourceId}. Saving confirms review; the original job is unchanged.`
    : null
  const canSubmit = name.trim().length > 0 && prompt.trim().length > 0 && !scheduleError && !busy && !draftBusy
  const humanSchedule = useMemo(() => scheduleSummary(scheduleKind, scheduleValue, timezone), [scheduleKind, scheduleValue, timezone])

  const applyDraft = (draft: AutomationDraftPreview) => {
    setName(draft.name)
    setPrompt(draft.prompt)
    setScheduleKind(draft.schedule.kind)
    setScheduleValue(draft.schedule.value)
    setTimezone(draft.schedule.timezone)
    setPrecheckCommand(draft.precheckCommand ?? '')
    setDraftNotes(draft.notes)
  }

  const askHermes = async () => {
    if (!draftRequest.trim() || draftBusy) return
    const requestId = createAutomationDraftRequestId()
    activeDraftId.current = requestId
    setDraftBusy(true)
    setError(null)
    try {
      const draft = await previewAutomationDraft(sessionId, {
        requestId,
        request: draftRequest.trim(),
        current: {
          name,
          prompt,
          schedule: { kind: scheduleKind, value: scheduleValue, timezone },
          precheckCommand: precheckCommand.trim() || null,
        },
      })
      if (activeDraftId.current !== requestId) return
      applyDraft(draft)
    } catch (cause) {
      if (activeDraftId.current === requestId) setError(normalizeAutomationRpcError(cause).message)
    } finally {
      if (activeDraftId.current === requestId) activeDraftId.current = null
      setDraftBusy(false)
    }
  }

  const cancelDraft = async () => {
    const requestId = activeDraftId.current
    if (!requestId) return
    activeDraftId.current = null
    setDraftBusy(false)
    await cancelAutomationDraft(requestId).catch(() => undefined)
  }

  const testPrecheck = async () => {
    if (!automation || !onTestPrecheck) return
    setBusy(true)
    setError(null)
    try {
      setPrecheckResult(await onTestPrecheck(automation.id))
    } catch (cause) {
      setError(normalizeAutomationRpcError(cause).message)
    } finally {
      setBusy(false)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      await onSave({
        name: name.trim(),
        prompt: prompt.trim(),
        scheduleKind,
        scheduleValue: scheduleValue.trim(),
        timezone: timezone.trim(),
        provider: useCurrentHermesDefault ? null : provider.trim() || null,
        model: useCurrentHermesDefault ? null : model.trim() || null,
        useCurrentHermesDefault,
        toolsets: splitNames(toolsets),
        skills: splitNames(skills),
        maxTurns,
        timeoutSeconds,
        dtstart: automation?.dtstart ?? null,
        enabled,
        requiresReview: false,
        missedRunGraceMinutes,
        workspaceMode,
        worktreeStorage: storage,
        baseRef: baseRef.trim() || null,
        precheck: {
          command: precheckCommand.trim() || null,
          timeoutSeconds: precheckTimeout,
          requireWorkspace: true,
          requireGit,
        },
      })
      close()
    } catch (cause) {
      setError(normalizeAutomationRpcError(cause).message)
    } finally {
      setBusy(false)
    }
  }

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="automation-dialog-backdrop" role="presentation" onMouseDown={close}>
      <section ref={dialogRef} className="automation-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="automation-editor-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <header className="automation-dialog-header">
          <div>
            <span>{automation ? 'Edit automation' : 'New automation'}</span>
            <h2 id="automation-editor-title">{automation?.name ?? 'Schedule Hermes work'}</h2>
          </div>
          <button type="button" aria-label="Close automation editor" onClick={close}><X size={16} /></button>
        </header>
        <form className="automation-editor-form" onSubmit={(event) => void submit(event)}>
          {sourceWarning ? <div className="automation-callout warning">{sourceWarning}</div> : null}
          <section className="automation-editor-section automation-ai-draft">
            <div className="automation-section-heading"><Sparkles size={15} /><div><strong>Ask Hermes</strong><span>Generate a review-only draft. Nothing is saved or run.</span></div></div>
            <div className="automation-inline-field">
              <textarea aria-label="Ask Hermes request" value={draftRequest} onChange={(event) => setDraftRequest(event.target.value)} placeholder="Run a dependency review every weekday at 9 AM" />
              {draftBusy
                ? <button type="button" className="danger" onClick={() => void cancelDraft()}><X size={14} /> Cancel</button>
                : <button type="button" disabled={!draftRequest.trim()} onClick={() => void askHermes()}><Bot size={14} /> Draft</button>}
            </div>
            {draftNotes.length > 0 ? <ul className="automation-draft-notes">{draftNotes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
          </section>

          <section className="automation-editor-section">
            <div className="automation-section-heading"><strong>Task</strong></div>
            <label>Name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>Hermes prompt<textarea rows={5} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
          </section>

          <section className="automation-editor-section">
            <div className="automation-section-heading"><strong>Schedule</strong><span>{humanSchedule}</span></div>
            <div className="automation-field-grid three">
              <label>Pattern<select value={scheduleKind} onChange={(event) => {
                const kind = event.target.value as AutomationScheduleKind
                setScheduleKind(kind)
                setScheduleValue(DEFAULT_SCHEDULES[kind])
              }}>
                <option value="once">Once</option><option value="interval">Interval</option><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option><option value="cron">Cron</option>
              </select></label>
              <label>Value<input value={scheduleValue} onChange={(event) => setScheduleValue(event.target.value)} /></label>
              <label>Timezone<input value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Asia/Seoul" /></label>
            </div>
            {scheduleError ? <div className="automation-inline-error">{scheduleError}</div> : (
              <ol className="automation-occurrences" aria-label="Next five occurrences">{occurrences.map((occurrence) => <li key={occurrence}>{formatOccurrence(occurrence)}</li>)}</ol>
            )}
            <label className="automation-compact-field">Missed-run grace (minutes)<input type="number" min={0} max={10080} value={missedRunGraceMinutes} onChange={(event) => setMissedRunGraceMinutes(Number(event.target.value))} /></label>
          </section>

          <section className="automation-editor-section">
            <div className="automation-section-heading"><strong>Run workspace</strong><span>New isolated worktree is the safe default.</span></div>
            <div className="automation-field-grid">
              <label>Mode<select value={workspaceMode} onChange={(event) => setWorkspaceMode(event.target.value as 'new_per_run' | 'existing')}><option value="new_per_run">New worktree per run</option><option value="existing">Existing workspace</option></select></label>
              <label>Base ref<input value={baseRef} onChange={(event) => setBaseRef(event.target.value)} placeholder="HEAD" /></label>
            </div>
            {workspaceMode === 'existing' ? <div className="automation-callout warning">Existing workspace runs can modify the open checkout. Use only for explicitly non-isolated tasks.</div> : (
              <div className="automation-field-grid">
                <label>Storage<select value={storage.mode} onChange={(event) => setStorage({ ...storage, mode: event.target.value as WorktreeStorage['mode'] })}><option value="appData">VibeLink app data</option><option value="drive">Repository drive</option><option value="custom">Custom root</option></select></label>
                {storage.mode === 'custom' ? <label>Custom root<input value={storage.customRoot} onChange={(event) => setStorage({ ...storage, customRoot: event.target.value })} /></label> : null}
              </div>
            )}
          </section>

          <section className="automation-editor-section">
            <div className="automation-section-heading"><strong>Hermes runtime</strong></div>
            <label className="automation-check"><input type="checkbox" checked={useCurrentHermesDefault} onChange={(event) => setUseCurrentHermesDefault(event.target.checked)} /> Use current Hermes model</label>
            {!useCurrentHermesDefault ? <div className="automation-field-grid"><label>Provider<input value={provider} onChange={(event) => setProvider(event.target.value)} /></label><label>Model<input value={model} onChange={(event) => setModel(event.target.value)} required /></label></div> : null}
            <div className="automation-field-grid"><label>Toolsets<input value={toolsets} onChange={(event) => setToolsets(event.target.value)} placeholder="hermes-acp" /></label><label>Skills<input value={skills} onChange={(event) => setSkills(event.target.value)} placeholder="review, qa" /></label></div>
            <div className="automation-field-grid"><label>Max turns<input type="number" min={1} max={500} value={maxTurns} onChange={(event) => setMaxTurns(Number(event.target.value))} /></label><label>Hard timeout (seconds)<input type="number" min={1} max={86400} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Number(event.target.value))} /></label></div>
          </section>

          <section className="automation-editor-section">
            <div className="automation-section-heading"><strong>Precheck</strong><span>Runs before Hermes in the prepared workspace.</span></div>
            <label>Command<input value={precheckCommand} onChange={(event) => setPrecheckCommand(event.target.value)} placeholder="pnpm test --runInBand" /></label>
            <div className="automation-field-grid"><label>Timeout (seconds)<input type="number" min={1} max={3600} value={precheckTimeout} onChange={(event) => setPrecheckTimeout(Number(event.target.value))} /></label><label className="automation-check"><input type="checkbox" checked={requireGit} onChange={(event) => setRequireGit(event.target.checked)} /> Require Git repository</label></div>
            <button type="button" disabled={!automation || !precheckCommand.trim() || busy} onClick={() => void testPrecheck()}><PlayCircle size={14} /> Test saved precheck</button>
            {!automation && precheckCommand.trim() ? <small>Save the automation before testing its precheck.</small> : null}
            {precheckResult ? <div className={`automation-precheck-result ${precheckResult.ok ? 'ok' : 'failed'}`}><CheckCircle2 size={14} /><span>{precheckResult.ok ? 'Precheck passed' : precheckResult.error || precheckResult.stderr || 'Precheck failed'}</span></div> : null}
          </section>

          <label className="automation-check automation-enabled-check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enable after saving</label>
          {error ? <div className="automation-callout error" role="alert">{error}</div> : null}
          <footer className="automation-dialog-actions">
            <button type="button" onClick={close}>Cancel</button>
            <button type="submit" className="primary" disabled={!canSubmit}>{busy ? <LoaderCircle className="spin" size={14} /> : null}{automation ? 'Save changes' : 'Create automation'}</button>
          </footer>
        </form>
      </section>
    </div>,
    document.body,
  )
}
