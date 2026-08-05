import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  CheckCircle2,
  ChevronDown,
  LoaderCircle,
  PlayCircle,
  X,
} from 'lucide-react'
import {
  cancelAutomationDraft,
  createAutomationDraftRequestId,
  normalizeAutomationRpcError,
  previewAutomationDraft,
  previewAutomationSchedule,
  type AutomationAgent,
  type AutomationDraftPreview,
  type AutomationPrecheckResult,
  type AutomationRecord,
  type AutomationScheduleKind,
  type CreateAutomationInput,
} from '../../ipc/automations'
import type { WorktreeStorage } from '../../ipc/types'
import { useWorkspaceStore } from '../../state/store'
import { ProfileIcon } from '../ProfileIcon'
import { AgentPicker } from './AgentPicker'
import { SchedulePicker } from './SchedulePicker'
import { automationAgentEntry, defaultAutomationAgent } from './agentCatalog'
import {
  defaultOnceParts,
  partsFromSchedule,
  scheduleValueFromParts,
  type ScheduleParts,
} from './schedulePresets'

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

function splitNames(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

export function AutomationEditorDialog({ sessionId, automation, onClose, onSave, onTestPrecheck }: AutomationEditorDialogProps) {
  const dialogRef = useRef<HTMLElement | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)
  // Captured during the first render, before React's commit moves focus into
  // the dialog, so closing returns focus to whatever opened it.
  const openerRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  const activeDraftId = useRef<string | null>(null)
  const agentClis = useWorkspaceStore((state) => state.agentClis)
  const [name, setName] = useState(automation?.name ?? '')
  const [prompt, setPrompt] = useState(automation?.prompt ?? '')
  const [agent, setAgent] = useState<AutomationAgent>(automation?.agent ?? defaultAutomationAgent)
  const [scheduleKind, setScheduleKind] = useState<AutomationScheduleKind>(automation?.scheduleKind ?? 'daily')
  const [timezone, setTimezone] = useState(automation?.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'))
  const [scheduleParts, setScheduleParts] = useState<ScheduleParts>(() => partsFromSchedule(
    automation?.scheduleKind ?? 'daily',
    automation?.scheduleValue ?? '09:00',
    automation?.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
  ))
  const [enabled, setEnabled] = useState(automation?.enabled ?? true)
  const [workspaceMode, setWorkspaceMode] = useState<'new_per_run' | 'existing'>(automation?.workspaceMode ?? 'new_per_run')
  const [storage, setStorage] = useState<WorktreeStorage>(automation?.worktreeStorage ?? DEFAULT_STORAGE)
  const [baseRef, setBaseRef] = useState(automation?.baseRef ?? '')
  const [useAgentDefaultModel, setUseAgentDefaultModel] = useState(automation?.useAgentDefaultModel ?? true)
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
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [draftRequest, setDraftRequest] = useState('')
  const [draftBusy, setDraftBusy] = useState(false)
  const [draftNotes, setDraftNotes] = useState<string[]>([])
  const [occurrences, setOccurrences] = useState<number[]>([])
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const [precheckResult, setPrecheckResult] = useState<AutomationPrecheckResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const agentEntry = automationAgentEntry(agent)
  const scheduleValue = useMemo(
    () => scheduleValueFromParts(scheduleKind, scheduleParts, timezone),
    [scheduleKind, scheduleParts, timezone],
  )
  const agentStatusById = useMemo(
    () => Object.fromEntries(agentClis.map((status) => [status.id.toLowerCase(), status])),
    [agentClis],
  )

  const close = useCallback(() => {
    const draftId = activeDraftId.current
    if (draftId) void cancelAutomationDraft(draftId).catch(() => undefined)
    activeDraftId.current = null
    onClose()
  }, [onClose])

  // Why: focus bookkeeping must run EXACTLY once. `onClose` is an inline prop
  // and `AutomationPanel` re-renders on its 8 s refresh poll, so keying this on
  // `close` tore the effect down and set it up again mid-typing: the cleanup
  // restored focus to the opener, the setup pulled it onto the dialog shell,
  // and an in-flight Hermes draft was cancelled. The keyboard trap below is a
  // separate effect because re-registering a listener is harmless.
  useEffect(() => {
    const opener = openerRef.current
    // The name field is the first thing to fill in, so it owns the caret. Only
    // claim it when focus is still outside the dialog: React StrictMode
    // double-invokes this effect in dev, and a blind focus() would yank the
    // caret out of whatever the user already started typing in.
    if (!dialogRef.current?.contains(document.activeElement)) (nameRef.current ?? dialogRef.current)?.focus()
    return () => {
      const draftId = activeDraftId.current
      if (draftId) void cancelAutomationDraft(draftId).catch(() => undefined)
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Why: the dialog and each picker popover both listen on window capture,
      // and the dialog registered first. Returning early — without
      // `stopImmediatePropagation` — lets the open popover's listener run and
      // consume Escape, so one press closes the popover, not the whole dialog.
      if (event.key === 'Escape' && document.querySelector('.automation-picker-menu')) return
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
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [close])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void previewAutomationSchedule({
        scheduleKind,
        scheduleValue,
        timezone,
        dtstart: automation?.dtstart ?? null,
        count: 3,
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

  // Why: `once` is the only cadence whose default would sit in the past, so
  // selecting it seeds the next hour instead of today's stale 09:00.
  const changeScheduleKind = (next: AutomationScheduleKind) => {
    setScheduleKind(next)
    if (next === 'once') {
      setScheduleParts((current) => (current.onceDate ? current : { ...current, ...defaultOnceParts(timezone) }))
    }
  }

  const applyDraft = (draft: AutomationDraftPreview) => {
    setName(draft.name)
    setPrompt(draft.prompt)
    setScheduleKind(draft.schedule.kind)
    setScheduleParts(partsFromSchedule(draft.schedule.kind, draft.schedule.value, draft.schedule.timezone))
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
        agent,
        scheduleKind,
        scheduleValue,
        timezone: timezone.trim(),
        provider: useAgentDefaultModel ? null : provider.trim() || null,
        model: useAgentDefaultModel ? null : model.trim() || null,
        useAgentDefaultModel,
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
        {/* `autoComplete="off"` keeps WebView2's saved-form-data popup from
            covering the prompt while the name field is being typed in. */}
        <form className="automation-editor-form" autoComplete="off" onSubmit={(event) => void submit(event)}>
          <header className="automation-dialog-header">
            <div className="automation-dialog-heading">
              <span id="automation-editor-title">{automation ? 'Edit automation' : 'New automation'}</span>
              <input ref={nameRef} className="automation-name-input" aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Weekday repo audit" />
            </div>
            <button type="button" aria-label="Close automation editor" onClick={close}><X size={16} /></button>
          </header>

          <div className="automation-editor-body">
            {sourceWarning ? <div className="automation-callout warning">{sourceWarning}</div> : null}

            <label className="automation-prompt-field">
              Prompt
              <textarea rows={9} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Review this workspace and report actionable issues." />
            </label>
            <p className="automation-field-hint">Sent to {agentEntry.label} on every run, inside the workspace prepared below.</p>

            <div className="automation-inline-field">
              <textarea aria-label="Ask Hermes request" value={draftRequest} onChange={(event) => setDraftRequest(event.target.value)} placeholder="Or describe it: run a dependency review every weekday at 9 AM" />
              {draftBusy
                ? <button type="button" className="danger" onClick={() => void cancelDraft()}><X size={14} /> Cancel</button>
                : <button type="button" disabled={!draftRequest.trim()} onClick={() => void askHermes()}><ProfileIcon name="hermes" size={14} /> Draft</button>}
            </div>
            {draftNotes.length > 0 ? <ul className="automation-draft-notes">{draftNotes.map((note) => <li key={note}>{note}</li>)}</ul> : null}

            <div className="automation-precheck-row">
              <label>Precheck<input className="automation-mono-input" value={precheckCommand} onChange={(event) => setPrecheckCommand(event.target.value)} placeholder="pnpm test --runInBand" /></label>
              <label>Timeout (seconds)<input type="number" min={1} max={3600} value={precheckTimeout} onChange={(event) => setPrecheckTimeout(Number(event.target.value))} /></label>
            </div>

            <button type="button" className="automation-advanced-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((current) => !current)}>
              <ChevronDown size={14} className={advancedOpen ? 'is-open' : undefined} aria-hidden="true" />
              Advanced settings
            </button>

            {advancedOpen ? (
              <div className="automation-advanced">
                <section className="automation-editor-section">
                  <div className="automation-section-heading"><strong>{agentEntry.label} runtime</strong><span>{agentEntry.summary}</span></div>
                  <label className="automation-check"><input type="checkbox" checked={useAgentDefaultModel} onChange={(event) => setUseAgentDefaultModel(event.target.checked)} /> Use the agent's configured model</label>
                  {!useAgentDefaultModel ? (
                    <div className="automation-field-grid">
                      <label>Model<input value={model} onChange={(event) => setModel(event.target.value)} placeholder={agentEntry.modelPlaceholder} required /></label>
                      <label>Provider<input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="optional" /></label>
                    </div>
                  ) : null}
                  {agentEntry.supportsToolsets ? (
                    <div className="automation-field-grid">
                      <label>Toolsets<input value={toolsets} onChange={(event) => setToolsets(event.target.value)} placeholder="hermes-acp" /></label>
                      <label>Skills<input value={skills} onChange={(event) => setSkills(event.target.value)} placeholder="review, qa" /></label>
                    </div>
                  ) : null}
                  <div className="automation-field-grid">
                    {agentEntry.supportsToolsets ? <label>Max turns<input type="number" min={1} max={500} value={maxTurns} onChange={(event) => setMaxTurns(Number(event.target.value))} /></label> : null}
                    <label>Hard timeout (seconds)<input type="number" min={1} max={86400} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Number(event.target.value))} /></label>
                  </div>
                </section>

                <section className="automation-editor-section">
                  <div className="automation-section-heading"><strong>Workspace</strong></div>
                  <div className="automation-field-grid">
                    <label>Base ref<input value={baseRef} onChange={(event) => setBaseRef(event.target.value)} placeholder="HEAD" disabled={workspaceMode === 'existing'} /></label>
                    <label>Storage<select value={storage.mode} disabled={workspaceMode === 'existing'} onChange={(event) => setStorage({ ...storage, mode: event.target.value as WorktreeStorage['mode'] })}><option value="appData">VibeLink app data</option><option value="drive">Repository drive</option><option value="custom">Custom root</option></select></label>
                  </div>
                  {storage.mode === 'custom' && workspaceMode !== 'existing' ? <label>Custom root<input value={storage.customRoot} onChange={(event) => setStorage({ ...storage, customRoot: event.target.value })} /></label> : null}
                </section>

                <section className="automation-editor-section">
                  <div className="automation-section-heading"><strong>Precheck</strong><span>Runs before the agent in the prepared workspace.</span></div>
                  <label className="automation-check"><input type="checkbox" checked={requireGit} onChange={(event) => setRequireGit(event.target.checked)} /> Require Git repository</label>
                  <button type="button" disabled={!automation || !precheckCommand.trim() || busy} onClick={() => void testPrecheck()}><PlayCircle size={14} /> Test saved precheck</button>
                  {!automation && precheckCommand.trim() ? <small>Save the automation before testing its precheck.</small> : null}
                  {precheckResult ? <div className={`automation-precheck-result ${precheckResult.ok ? 'ok' : 'failed'}`}><CheckCircle2 size={14} /><span>{precheckResult.ok ? 'Precheck passed' : precheckResult.error || precheckResult.stderr || 'Precheck failed'}</span></div> : null}
                </section>
              </div>
            ) : null}
          </div>

          <footer className="automation-editor-footer">
            <div className="automation-primary-grid">
              <div className="automation-labeled-control">
                <span id="automation-agent-label">Agent</span>
                <AgentPicker
                  value={agent}
                  statusById={agentStatusById}
                  labelledBy="automation-agent-label"
                  onChange={setAgent}
                />
              </div>
              <div className="automation-labeled-control">
                <span id="automation-schedule-label">Schedule</span>
                <SchedulePicker
                  kind={scheduleKind}
                  parts={scheduleParts}
                  timezone={timezone}
                  labelledBy="automation-schedule-label"
                  onKindChange={changeScheduleKind}
                  onPartsChange={(patch) => setScheduleParts((current) => ({ ...current, ...patch }))}
                  onTimezoneChange={setTimezone}
                />
              </div>
              <label>
                Run in
                <select value={workspaceMode} onChange={(event) => setWorkspaceMode(event.target.value as 'new_per_run' | 'existing')}>
                  <option value="new_per_run">New worktree per run</option>
                  <option value="existing">This workspace</option>
                </select>
              </label>
              <label>
                Missed-run grace (minutes)
                <input type="number" min={0} max={10080} value={missedRunGraceMinutes} onChange={(event) => setMissedRunGraceMinutes(Number(event.target.value))} />
              </label>
            </div>

            {scheduleError
              ? <div className="automation-inline-error">{scheduleError}</div>
              : occurrences.length > 0
                ? <p className="automation-next-runs">Next: {occurrences.map((value) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })).join(' · ')} · {timezone}</p>
                : scheduleKind === 'once'
                  ? <div className="automation-inline-error">That time has already passed in {timezone}. Pick a later date or time.</div>
                  : null}

            {workspaceMode === 'existing' ? <div className="automation-callout warning">Runs here modify the open checkout. Use only for tasks that must not be isolated.</div> : null}
            {error ? <div className="automation-callout error" role="alert">{error}</div> : null}

            <div className="automation-dialog-actions">
              <label className="automation-check automation-enabled-check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enable after saving</label>
              <button type="button" onClick={close}>Cancel</button>
              <button type="submit" className="primary" disabled={!canSubmit}>{busy ? <LoaderCircle className="spin" size={14} /> : <ProfileIcon name={agentEntry.icon} size={14} />}{automation ? 'Save changes' : 'Create automation'}</button>
            </div>
          </footer>
        </form>
      </section>
    </div>,
    document.body,
  )
}
