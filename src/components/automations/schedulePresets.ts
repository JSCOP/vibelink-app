import type { AutomationScheduleKind } from '../../ipc/automations'

/** Cadences offered in the editor. `cron`/`once`/`interval` stay reachable
 *  through Advanced so imported and power-user schedules still round-trip. */
export const scheduleCadences: { kind: AutomationScheduleKind; label: string }[] = [
  { kind: 'hourly', label: 'Every hour' },
  { kind: 'daily', label: 'Every day' },
  { kind: 'weekdays', label: 'Weekdays' },
  { kind: 'weekly', label: 'Every week' },
  { kind: 'interval', label: 'Every N hours' },
  { kind: 'once', label: 'Once' },
  { kind: 'cron', label: 'Custom cron' },
]

export const weekdayOptions = [
  { code: 'MON', label: 'Monday' },
  { code: 'TUE', label: 'Tuesday' },
  { code: 'WED', label: 'Wednesday' },
  { code: 'THU', label: 'Thursday' },
  { code: 'FRI', label: 'Friday' },
  { code: 'SAT', label: 'Saturday' },
  { code: 'SUN', label: 'Sunday' },
]

export type ScheduleParts = {
  /** 24-hour `HH:MM`, used by daily/weekdays/weekly/once. */
  time: string
  /** Minute past the hour, used by hourly. */
  minute: number
  /** Three-letter weekday code, used by weekly. */
  weekday: string
  /** Interval expression such as `6h`, used by interval. */
  interval: string
  /** Five-field cron expression, used by cron. */
  cron: string
  /** `YYYY-MM-DD` in the schedule timezone, used by once. */
  onceDate: string
}

export const defaultScheduleParts: ScheduleParts = {
  time: '09:00',
  minute: 0,
  weekday: 'MON',
  interval: '6h',
  cron: '0 9 * * 1-5',
  onceDate: '',
}

const ONCE_LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/

/** Wall clock of `timestamp` inside `timeZone`. The timezone field is free
 *  text, so an unusable zone falls back to the browser's own rather than
 *  letting `Intl` throw while the user is still typing. */
export function wallClock(timestamp: number, timeZone: string): { date: string; time: string } {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-CA', { ...options, timeZone }).formatToParts(new Date(timestamp))
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(new Date(timestamp))
  }
  const field = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return { date: `${field('year')}-${field('month')}-${field('day')}`, time: `${field('hour')}:${field('minute')}` }
}

/** Seed for a fresh one-time schedule: the next hour, in the schedule's zone. */
export function defaultOnceParts(timezone: string): { onceDate: string; time: string } {
  const { date, time } = wallClock(Date.now() + 3_600_000, timezone)
  return { onceDate: date, time }
}

/** Split a stored `scheduleValue` into the editor's per-cadence fields so
 *  switching cadence never loses the values the other cadences were using. */
export function partsFromSchedule(
  kind: AutomationScheduleKind,
  value: string,
  timezone: string,
): ScheduleParts {
  const parts = { ...defaultScheduleParts }
  const trimmed = value.trim()
  if (!trimmed) return parts
  switch (kind) {
    case 'hourly': {
      const minute = Number(trimmed)
      if (Number.isInteger(minute) && minute >= 0 && minute <= 59) parts.minute = minute
      return parts
    }
    case 'daily':
    case 'weekdays': {
      if (/^\d{1,2}:\d{2}$/.test(trimmed)) parts.time = trimmed
      return parts
    }
    case 'weekly': {
      const [weekday, time] = trimmed.split('@')
      if (weekday) parts.weekday = weekday.trim().toUpperCase()
      if (time && /^\d{1,2}:\d{2}$/.test(time.trim())) parts.time = time.trim()
      return parts
    }
    case 'interval':
      parts.interval = trimmed
      return parts
    case 'cron':
      parts.cron = trimmed
      return parts
    case 'once': {
      // Authored values are a zone-local wall clock; Hermes imports and drafts
      // still arrive as epoch millis or RFC3339, so both are projected back.
      const local = ONCE_LOCAL.exec(trimmed)
      if (local) {
        parts.onceDate = local[1]
        parts.time = local[2]
        return parts
      }
      const instant = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed)
      const { date, time } = wallClock(Number.isFinite(instant) ? instant : Date.now() + 3_600_000, timezone)
      parts.onceDate = date
      parts.time = time
      return parts
    }
  }
}

/** Compose the daemon-facing `scheduleValue` for the active cadence. */
export function scheduleValueFromParts(
  kind: AutomationScheduleKind,
  parts: ScheduleParts,
  timezone: string,
): string {
  switch (kind) {
    case 'hourly': return String(parts.minute)
    case 'daily':
    case 'weekdays': return parts.time
    case 'weekly': return `${parts.weekday}@${parts.time}`
    case 'interval': return parts.interval
    case 'cron': return parts.cron
    case 'once': return `${parts.onceDate || defaultOnceParts(timezone).onceDate}T${parts.time}`
  }
}

/** Plain-language summary shown on the schedule trigger. It stays short and
 *  timezone-free so the trigger never wraps past the pickers beside it; the
 *  zone lives in the popover and in the resolved next-run line. */
export function scheduleSummary(kind: AutomationScheduleKind, parts: ScheduleParts): string {
  switch (kind) {
    case 'hourly': return `Hourly at :${String(parts.minute).padStart(2, '0')}`
    case 'daily': return `Daily at ${parts.time}`
    case 'weekdays': return `Weekdays at ${parts.time}`
    case 'weekly': {
      const label = weekdayOptions.find((option) => option.code === parts.weekday)?.label ?? parts.weekday
      return `${label}s at ${parts.time}`
    }
    case 'interval': return `Every ${parts.interval}`
    case 'cron': return `Cron ${parts.cron}`
    case 'once': return parts.onceDate ? `Once on ${parts.onceDate} ${parts.time}` : 'Once — pick a date'
  }
}
