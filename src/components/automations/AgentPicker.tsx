import { useCallback, useRef, useState } from 'react'
import { Check, ChevronsUpDown, TriangleAlert } from 'lucide-react'
import type { AutomationAgent } from '../../ipc/automations'
import type { AgentCliStatus } from '../../ipc/agents'
import { ProfileIcon } from '../ProfileIcon'
import { AnchoredPopover } from './AnchoredPopover'
import { automationAgentEntry, automationAgents } from './agentCatalog'

type AgentPickerProps = {
  value: AutomationAgent
  /** Detected CLI status keyed by lowercase agent id; missing means unprobed. */
  statusById: Record<string, AgentCliStatus>
  /** Id of the visible field label; the trigger is a button, not a form control,
   *  so it cannot be wrapped in a `<label>` without stealing its accessible name. */
  labelledBy: string
  onChange: (agent: AutomationAgent) => void
}

/** Agent selector showing each CLI's brand icon plus whether it is installed.
 *  Not installed is a warning, never a block: the CLI may arrive before the
 *  first scheduled run, and the daemon reports the real failure if it does not. */
export function AgentPicker({ value, statusById, labelledBy, onChange }: AgentPickerProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const selected = automationAgentEntry(value)
  const selectedMissing = statusById[value]?.installed === false
  const dismiss = useCallback(() => setOpen(false), [])

  return (
    <div className="automation-picker">
      <button
        ref={triggerRef}
        type="button"
        className="automation-picker-trigger"
        aria-haspopup="listbox"
        aria-labelledby={`${labelledBy} automation-agent-value`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ProfileIcon name={selected.icon} size={15} className="automation-agent-icon" />
        <span className="automation-picker-value" id="automation-agent-value">{selected.label}</span>
        {selectedMissing ? <TriangleAlert className="automation-agent-warning" size={13} aria-label="CLI not found on PATH" /> : null}
        <ChevronsUpDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <AnchoredPopover
          anchorRef={triggerRef}
          className="automation-picker-menu"
          role="listbox"
          label="Automation agent"
          onDismiss={dismiss}
        >
          {automationAgents.map((entry) => {
            const missing = statusById[entry.id]?.installed === false
            return (
              <button
                key={entry.id}
                type="button"
                role="option"
                aria-selected={entry.id === value}
                className="automation-picker-option"
                onClick={() => {
                  onChange(entry.id)
                  setOpen(false)
                }}
              >
                <ProfileIcon name={entry.icon} size={15} className="automation-agent-icon" />
                <span className="automation-picker-option-body">
                  <strong>{entry.label}</strong>
                  <small>{missing ? `${entry.command} not found on PATH` : entry.summary}</small>
                </span>
                {entry.id === value ? <Check size={14} aria-hidden="true" /> : null}
              </button>
            )
          })}
        </AnchoredPopover>
      ) : null}
    </div>
  )
}
