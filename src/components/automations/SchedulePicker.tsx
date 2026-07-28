import { useCallback, useRef, useState } from 'react'
import { CalendarClock, ChevronsUpDown } from 'lucide-react'
import type { AutomationScheduleKind } from '../../ipc/automations'
import { AnchoredPopover } from './AnchoredPopover'
import {
  defaultOnceParts,
  scheduleCadences,
  scheduleSummary,
  weekdayOptions,
  type ScheduleParts,
} from './schedulePresets'

type SchedulePickerProps = {
  kind: AutomationScheduleKind
  parts: ScheduleParts
  timezone: string
  /** Id of the visible field label; the trigger is a button, so wrapping it in a
   *  `<label>` would overwrite its accessible name with the label text. */
  labelledBy: string
  onKindChange: (kind: AutomationScheduleKind) => void
  onPartsChange: (patch: Partial<ScheduleParts>) => void
  onTimezoneChange: (timezone: string) => void
}

const hours = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0'))
const minutes = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, '0'))

export function SchedulePicker({
  kind,
  parts,
  timezone,
  labelledBy,
  onKindChange,
  onPartsChange,
  onTimezoneChange,
}: SchedulePickerProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const [hour, minute] = parts.time.split(':')
  const dismiss = useCallback(() => setOpen(false), [])

  const showClock = kind === 'daily' || kind === 'weekdays' || kind === 'weekly' || kind === 'once'

  return (
    <div className="automation-picker">
      <button
        ref={triggerRef}
        type="button"
        className="automation-picker-trigger"
        aria-haspopup="dialog"
        aria-labelledby={`${labelledBy} automation-schedule-value`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <CalendarClock size={14} aria-hidden="true" />
        <span className="automation-picker-value" id="automation-schedule-value">{scheduleSummary(kind, parts)}</span>
        <ChevronsUpDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <AnchoredPopover
          anchorRef={triggerRef}
          className="automation-picker-menu automation-schedule-menu"
          role="dialog"
          label="Schedule"
          onDismiss={dismiss}
        >
          <label>
            Repeat
            <select value={kind} onChange={(event) => onKindChange(event.target.value as AutomationScheduleKind)}>
              {scheduleCadences.map((cadence) => (
                <option key={cadence.kind} value={cadence.kind}>{cadence.label}</option>
              ))}
            </select>
          </label>

          {kind === 'weekly' ? (
            <label>
              Day
              <select value={parts.weekday} onChange={(event) => onPartsChange({ weekday: event.target.value })}>
                {weekdayOptions.map((option) => (
                  <option key={option.code} value={option.code}>{option.label}</option>
                ))}
              </select>
            </label>
          ) : null}

          {kind === 'hourly' ? (
            <label>
              Minute past the hour
              <select value={String(parts.minute)} onChange={(event) => onPartsChange({ minute: Number(event.target.value) })}>
                {minutes.map((value) => <option key={value} value={Number(value)}>:{value}</option>)}
              </select>
            </label>
          ) : null}

          {kind === 'once' ? (
            <label>
              Date
              <input
                type="date"
                value={parts.onceDate || defaultOnceParts(timezone).onceDate}
                onChange={(event) => onPartsChange({ onceDate: event.target.value })}
              />
            </label>
          ) : null}

          {showClock ? (
            <label>
              Time
              <span className="automation-clock">
                <select aria-label="Hour" value={hour} onChange={(event) => onPartsChange({ time: `${event.target.value}:${minute}` })}>
                  {hours.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
                <span aria-hidden="true">:</span>
                <select aria-label="Minute" value={minute} onChange={(event) => onPartsChange({ time: `${hour}:${event.target.value}` })}>
                  {minutes.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </span>
            </label>
          ) : null}

          {kind === 'interval' ? (
            <label>
              Interval
              <input value={parts.interval} onChange={(event) => onPartsChange({ interval: event.target.value })} placeholder="6h" />
            </label>
          ) : null}

          {kind === 'cron' ? (
            <label>
              Cron expression
              <input value={parts.cron} onChange={(event) => onPartsChange({ cron: event.target.value })} placeholder="0 9 * * 1-5" />
            </label>
          ) : null}

          <label>
            Timezone
            <input value={timezone} onChange={(event) => onTimezoneChange(event.target.value)} placeholder="Asia/Seoul" />
          </label>
        </AnchoredPopover>
      ) : null}
    </div>
  )
}
