import { describe, expect, it } from 'vitest'
import {
  defaultOnceParts,
  defaultScheduleParts,
  partsFromSchedule,
  scheduleSummary,
  scheduleValueFromParts,
} from './schedulePresets'

describe('schedulePresets', () => {
  it('serializes a one-time schedule as a zone-local wall clock the daemon accepts', () => {
    const parts = { ...defaultScheduleParts, onceDate: '2026-07-29', time: '05:49' }
    expect(scheduleValueFromParts('once', parts, 'Asia/Seoul')).toBe('2026-07-29T05:49')
  })

  it('round-trips local, epoch-millisecond, and RFC3339 one-time values', () => {
    expect(partsFromSchedule('once', '2026-07-29T05:49', 'Asia/Seoul')).toMatchObject({
      onceDate: '2026-07-29',
      time: '05:49',
    })
    // 2026-07-28T20:49:00Z is 2026-07-29 05:49 in Seoul; imports and drafts
    // still author the instant, not the wall clock.
    const instant = Date.UTC(2026, 6, 28, 20, 49)
    expect(partsFromSchedule('once', String(instant), 'Asia/Seoul')).toMatchObject({
      onceDate: '2026-07-29',
      time: '05:49',
    })
    expect(partsFromSchedule('once', '2026-07-28T20:49:00Z', 'Asia/Seoul')).toMatchObject({
      onceDate: '2026-07-29',
      time: '05:49',
    })
    expect(partsFromSchedule('once', '2026-07-28T20:49:00Z', 'America/New_York')).toMatchObject({
      onceDate: '2026-07-28',
      time: '16:49',
    })
  })

  it('falls back to the browser zone when the timezone field is not usable yet', () => {
    const seeded = defaultOnceParts('Asia/Seo')
    expect(seeded.onceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(seeded.time).toMatch(/^\d{2}:\d{2}$/)
  })

  it('keeps trigger summaries short and timezone-free so the picker stays one line', () => {
    expect(scheduleSummary('once', { ...defaultScheduleParts, onceDate: '2026-07-29', time: '05:49' }))
      .toBe('Once on 2026-07-29 05:49')
    expect(scheduleSummary('weekly', { ...defaultScheduleParts, weekday: 'WED', time: '18:00' }))
      .toBe('Wednesdays at 18:00')
    expect(scheduleSummary('interval', defaultScheduleParts)).toBe('Every 6h')
  })
})
