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
  /** 24-hour `HH:MM`, used by daily/weekdays/weekly. */
  time: string
  /** Minute past the hour, used by hourly. */
  minute: number
  /** Three-letter weekday code, used by weekly. */
  weekday: string
  /** Interval expression such as `6h`, used by interval. */
  interval: string
  /** Five-field cron expression, used by cron. */
  cron: string
  /** Epoch milliseconds, used by once. */
  onceAt: number
}

export const defaultScheduleParts: ScheduleParts = {
  time: '09:00',
  minute: 0,
  weekday: 'MON',
  interval: '6h',
  cron: '0 9 * * 1-5',
  onceAt: 0,
}

/** Split a stored `scheduleValue` into the editor's per-cadence fields so
 *  switching cadence never loses the values the other cadences were using. */
export function partsFromSchedule(kind: AutomationScheduleKind, value: string): ScheduleParts {
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
      const timestamp = Number(trimmed)
      if (Number.isFinite(timestamp)) parts.onceAt = timestamp
      return parts
    }
  }
}

/** Compose the daemon-facing `scheduleValue` for the active cadence. */
export function scheduleValueFromParts(kind: AutomationScheduleKind, parts: ScheduleParts): string {
  switch (kind) {
    case 'hourly': return String(parts.minute)
    case 'daily':
    case 'weekdays': return parts.time
    case 'weekly': return `${parts.weekday}@${parts.time}`
    case 'interval': return parts.interval
    case 'cron': return parts.cron
    case 'once': return String(parts.onceAt || Date.now() + 3_600_000)
  }
}

/** Plain-language summary shown on the schedule trigger. */
export function scheduleSummary(kind: AutomationScheduleKind, parts: ScheduleParts, timezone: string): string {
  switch (kind) {
    case 'hourly': return `Every hour at :${String(parts.minute).padStart(2, '0')} (${timezone})`
    case 'daily': return `Every day at ${parts.time} (${timezone})`
    case 'weekdays': return `Mon–Fri at ${parts.time} (${timezone})`
    case 'weekly': {
      const label = weekdayOptions.find((option) => option.code === parts.weekday)?.label ?? parts.weekday
      return `Every ${label} at ${parts.time} (${timezone})`
    }
    case 'interval': return `Every ${parts.interval}, anchored when saved`
    case 'cron': return `Cron ${parts.cron} (${timezone})`
    case 'once': {
      const at = parts.onceAt || Date.now() + 3_600_000
      return `Once on ${new Date(at).toLocaleString()} (${timezone})`
    }
  }
}

/** `datetime-local` needs a zone-free `YYYY-MM-DDTHH:MM`, so the epoch is
 *  shifted by the local offset before slicing the ISO string. */
export function toDateTimeLocal(timestamp: number): string {
  const at = timestamp || Date.now() + 3_600_000
  return new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
