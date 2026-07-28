use super::types::AutomationRecord;
use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Duration, LocalResult, NaiveDateTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use cron::Schedule;
use std::str::FromStr;

const MAX_PREVIEW_OCCURRENCES: usize = 100;
const DST_LOOKBACK_HOURS: i64 = 48;
const MAX_DST_GAP_MINUTES: usize = 48 * 60;

pub fn validate_schedule(
    kind: &str,
    value: &str,
    timezone: &str,
    dtstart: Option<u64>,
) -> Result<()> {
    parse_schedule(kind, value, timezone)?;
    if let Some(dtstart) = dtstart {
        millis_to_utc(dtstart).context("invalid schedule dtstart")?;
    }
    Ok(())
}

pub fn preview_occurrences(
    kind: &str,
    value: &str,
    timezone: &str,
    dtstart: Option<u64>,
    after_ms: u64,
    count: usize,
) -> Result<Vec<u64>> {
    if count > MAX_PREVIEW_OCCURRENCES {
        bail!("schedule preview count must be at most {MAX_PREVIEW_OCCURRENCES}, got {count}");
    }
    let mut schedule = parse_schedule(kind, value, timezone)?;
    if let ScheduleKind::Interval {
        ref mut anchor_ms, ..
    } = schedule.kind
    {
        *anchor_ms = dtstart.unwrap_or(after_ms);
        millis_to_utc(*anchor_ms).context("invalid interval anchor")?;
    }
    let mut occurrences = Vec::with_capacity(count);
    let mut cursor = after_ms;
    while occurrences.len() < count {
        let Some(next) = next_from_schedule(&schedule, cursor)? else {
            break;
        };
        if next <= cursor {
            bail!("schedule engine produced a non-monotonic occurrence");
        }
        occurrences.push(next);
        cursor = next;
    }
    Ok(occurrences)
}

pub fn next_after(record: &AutomationRecord, after_ms: u64) -> Result<Option<u64>> {
    let schedule = parse_record(record)?;
    next_from_schedule(&schedule, after_ms)
}

pub fn next_occurrences(
    record: &AutomationRecord,
    after_ms: u64,
    count: usize,
) -> Result<Vec<u64>> {
    if count > MAX_PREVIEW_OCCURRENCES {
        bail!("schedule preview count must be at most {MAX_PREVIEW_OCCURRENCES}, got {count}");
    }
    let schedule = parse_record(record)?;
    let mut occurrences = Vec::with_capacity(count);
    let mut cursor = after_ms;
    while occurrences.len() < count {
        let Some(next) = next_from_schedule(&schedule, cursor)? else {
            break;
        };
        if next <= cursor {
            bail!("schedule engine produced a non-monotonic occurrence");
        }
        occurrences.push(next);
        cursor = next;
    }
    Ok(occurrences)
}

#[derive(Clone)]
struct ParsedSchedule {
    timezone: Tz,
    kind: ScheduleKind,
}

#[derive(Clone)]
enum ScheduleKind {
    Once(u64),
    Interval { period_ms: u64, anchor_ms: u64 },
    Calendar(Schedule),
}

fn parse_record(record: &AutomationRecord) -> Result<ParsedSchedule> {
    let mut parsed = parse_schedule(
        &record.schedule_kind,
        &record.schedule_value,
        &record.timezone,
    )?;
    if let ScheduleKind::Interval {
        ref mut anchor_ms, ..
    } = parsed.kind
    {
        *anchor_ms = record.dtstart.unwrap_or(record.created_at);
        millis_to_utc(*anchor_ms).context("invalid interval anchor")?;
    }
    Ok(parsed)
}

fn parse_schedule(kind: &str, value: &str, timezone: &str) -> Result<ParsedSchedule> {
    let timezone = parse_timezone(timezone)?;
    let value = value.trim();
    if value.is_empty() {
        bail!("schedule value is required");
    }
    let kind = match kind {
        "once" => ScheduleKind::Once(parse_once(value)?),
        "interval" => ScheduleKind::Interval {
            period_ms: parse_interval(value)?,
            anchor_ms: 0,
        },
        "hourly" => {
            let minute = parse_minute(value)?;
            ScheduleKind::Calendar(parse_five_field_cron(&format!("{minute} * * * *"))?)
        }
        "daily" => {
            let (hour, minute) = parse_hh_mm(value)?;
            ScheduleKind::Calendar(parse_five_field_cron(&format!("{minute} {hour} * * *"))?)
        }
        "weekdays" => {
            let (hour, minute) = parse_hh_mm(value)?;
            ScheduleKind::Calendar(parse_five_field_cron(&format!(
                "{minute} {hour} * * MON-FRI"
            ))?)
        }
        "weekly" => {
            let (weekday, time) = value
                .split_once('@')
                .ok_or_else(|| anyhow!("weekly schedule must use weekday@HH:MM"))?;
            if time.contains('@') {
                bail!("weekly schedule must contain exactly one '@'");
            }
            let weekday = parse_weekday(weekday)?;
            let (hour, minute) = parse_hh_mm(time)?;
            ScheduleKind::Calendar(parse_five_field_cron(&format!(
                "{minute} {hour} * * {weekday}"
            ))?)
        }
        "cron" => ScheduleKind::Calendar(parse_five_field_cron(value)?),
        other => bail!("unsupported schedule kind '{other}'"),
    };
    Ok(ParsedSchedule { timezone, kind })
}

fn next_from_schedule(schedule: &ParsedSchedule, after_ms: u64) -> Result<Option<u64>> {
    millis_to_utc(after_ms).context("invalid schedule cursor")?;
    match &schedule.kind {
        ScheduleKind::Once(instant_ms) => Ok((*instant_ms > after_ms).then_some(*instant_ms)),
        ScheduleKind::Interval {
            period_ms,
            anchor_ms,
        } => next_interval(*anchor_ms, *period_ms, after_ms).map(Some),
        ScheduleKind::Calendar(cron) => next_calendar(cron, schedule.timezone, after_ms),
    }
}

fn next_interval(anchor_ms: u64, period_ms: u64, after_ms: u64) -> Result<u64> {
    if after_ms < anchor_ms {
        return Ok(anchor_ms);
    }
    let elapsed = after_ms - anchor_ms;
    let steps = elapsed
        .checked_div(period_ms)
        .and_then(|steps| steps.checked_add(1))
        .ok_or_else(|| anyhow!("interval occurrence calculation overflowed"))?;
    let offset = period_ms
        .checked_mul(steps)
        .ok_or_else(|| anyhow!("interval occurrence calculation overflowed"))?;
    let next = anchor_ms
        .checked_add(offset)
        .ok_or_else(|| anyhow!("interval occurrence calculation overflowed"))?;
    millis_to_utc(next).context("interval occurrence is outside the supported timestamp range")?;
    Ok(next)
}

fn next_calendar(schedule: &Schedule, timezone: Tz, after_ms: u64) -> Result<Option<u64>> {
    let after_utc = millis_to_utc(after_ms)?;
    let local_cursor = after_utc
        .with_timezone(&timezone)
        .naive_local()
        .with_nanosecond(0)
        .ok_or_else(|| anyhow!("failed to normalize schedule cursor"))?;
    let lookback = local_cursor
        .checked_sub_signed(Duration::hours(DST_LOOKBACK_HOURS))
        .unwrap_or(local_cursor);
    let pseudo_start = Utc.from_utc_datetime(&lookback);
    let mut best = None;
    for candidate in schedule.after(&pseudo_start) {
        let local_candidate = candidate.naive_utc();
        if let Some(resolved) = resolve_local_after(timezone, local_candidate, after_ms)? {
            best = Some(best.map_or(resolved, |current: u64| current.min(resolved)));
        }
        if local_candidate > local_cursor && best.is_some() {
            return Ok(best);
        }
    }
    Ok(best)
}

fn resolve_local_after(timezone: Tz, local: NaiveDateTime, after_ms: u64) -> Result<Option<u64>> {
    match timezone.from_local_datetime(&local) {
        LocalResult::Single(candidate) => candidate_after(candidate, after_ms),
        LocalResult::Ambiguous(first, second) => choose_after(&first, &second, after_ms),
        LocalResult::None => {
            let mut adjusted = local;
            for _ in 0..MAX_DST_GAP_MINUTES {
                adjusted = adjusted
                    .checked_add_signed(Duration::minutes(1))
                    .ok_or_else(|| anyhow!("DST gap adjustment overflowed"))?;
                match timezone.from_local_datetime(&adjusted) {
                    LocalResult::Single(candidate) => return candidate_after(candidate, after_ms),
                    LocalResult::Ambiguous(first, second) => {
                        return choose_after(&first, &second, after_ms)
                    }
                    LocalResult::None => {}
                }
            }
            bail!("could not resolve nonexistent local time within 48 hours")
        }
    }
}

fn choose_after<T: TimeZone>(
    first: &DateTime<T>,
    second: &DateTime<T>,
    after_ms: u64,
) -> Result<Option<u64>> {
    let first = datetime_to_millis(first)?;
    let second = datetime_to_millis(second)?;
    Ok([first, second]
        .into_iter()
        .filter(|candidate| *candidate > after_ms)
        .min())
}

fn candidate_after<T: TimeZone>(candidate: DateTime<T>, after_ms: u64) -> Result<Option<u64>> {
    let candidate = datetime_to_millis(&candidate)?;
    Ok((candidate > after_ms).then_some(candidate))
}

fn parse_timezone(value: &str) -> Result<Tz> {
    let value = value.trim();
    if value.is_empty() {
        bail!("IANA timezone is required");
    }
    value
        .parse::<Tz>()
        .map_err(|_| anyhow!("invalid IANA timezone '{value}'"))
}

fn parse_once(value: &str) -> Result<u64> {
    let instant = DateTime::parse_from_rfc3339(value)
        .with_context(|| format!("invalid RFC3339 one-time schedule '{value}'"))?;
    datetime_to_millis(&instant)
        .context("one-time schedule is outside the supported timestamp range")
}

fn parse_interval(value: &str) -> Result<u64> {
    let seconds = value
        .parse::<u64>()
        .with_context(|| format!("interval must be a positive number of seconds, got '{value}'"))?;
    if seconds == 0 {
        bail!("interval must be a positive number of seconds");
    }
    seconds
        .checked_mul(1_000)
        .ok_or_else(|| anyhow!("interval milliseconds overflowed"))
}

fn parse_minute(value: &str) -> Result<u32> {
    let minute = value
        .parse::<u32>()
        .with_context(|| format!("hourly schedule minute must be 0..59, got '{value}'"))?;
    if minute > 59 {
        bail!("hourly schedule minute must be 0..59, got {minute}");
    }
    Ok(minute)
}

fn parse_hh_mm(value: &str) -> Result<(u32, u32)> {
    let bytes = value.as_bytes();
    if bytes.len() != 5
        || bytes[2] != b':'
        || !bytes[0].is_ascii_digit()
        || !bytes[1].is_ascii_digit()
        || !bytes[3].is_ascii_digit()
        || !bytes[4].is_ascii_digit()
    {
        bail!("schedule time must use HH:MM, got '{value}'");
    }
    let hour = value[0..2].parse::<u32>()?;
    let minute = value[3..5].parse::<u32>()?;
    if hour > 23 || minute > 59 {
        bail!("schedule time is out of range, got '{value}'");
    }
    Ok((hour, minute))
}

fn parse_weekday(value: &str) -> Result<&'static str> {
    match value.to_ascii_lowercase().as_str() {
        "sun" => Ok("SUN"),
        "mon" => Ok("MON"),
        "tue" => Ok("TUE"),
        "wed" => Ok("WED"),
        "thu" => Ok("THU"),
        "fri" => Ok("FRI"),
        "sat" => Ok("SAT"),
        _ => bail!("weekly weekday must be a three-letter name, got '{value}'"),
    }
}

fn parse_five_field_cron(value: &str) -> Result<Schedule> {
    if value.split_whitespace().count() != 5 {
        bail!("cron schedule must contain exactly five fields");
    }
    Schedule::from_str(&format!("0 {value}"))
        .with_context(|| format!("invalid five-field cron schedule '{value}'"))
}

fn millis_to_utc(value: u64) -> Result<DateTime<Utc>> {
    let value = i64::try_from(value).map_err(|_| anyhow!("timestamp milliseconds exceed i64"))?;
    DateTime::<Utc>::from_timestamp_millis(value)
        .ok_or_else(|| anyhow!("timestamp milliseconds are outside chrono's supported range"))
}

fn datetime_to_millis<T: TimeZone>(value: &DateTime<T>) -> Result<u64> {
    u64::try_from(value.timestamp_millis())
        .map_err(|_| anyhow!("timestamp is before the Unix epoch or outside u64 milliseconds"))
}

#[cfg(test)]
mod tests {
    use super::super::types::AutomationPrecheck;
    use super::*;
    use serde_json::json;

    fn ms(value: &str) -> u64 {
        u64::try_from(
            DateTime::parse_from_rfc3339(value)
                .unwrap()
                .timestamp_millis(),
        )
        .unwrap()
    }

    fn record(kind: &str, value: &str, timezone: &str) -> AutomationRecord {
        AutomationRecord {
            id: "automation-1".into(),
            session_id: "session-1".into(),
            name: "Schedule test".into(),
            prompt: "test".into(),
            agent: "hermes".into(),
            provider: None,
            model: None,
            use_current_hermes_default: true,
            toolsets: vec![],
            skills: vec![],
            max_turns: 10,
            timeout_seconds: 1_800,
            schedule_kind: kind.into(),
            schedule_value: value.into(),
            timezone: timezone.into(),
            dtstart: None,
            next_run_at: None,
            last_run_at: None,
            enabled: true,
            requires_review: false,
            missed_run_grace_minutes: 720,
            missed_run_policy: "run_once_within_grace".into(),
            workspace_mode: "new_per_run".into(),
            worktree_storage: json!({}),
            base_ref: None,
            precheck: AutomationPrecheck {
                command: None,
                timeout_seconds: 60,
                require_workspace: true,
                require_git: true,
            },
            source: None,
            created_at: ms("2024-01-01T00:00:00Z"),
            updated_at: ms("2024-01-01T00:00:00Z"),
        }
    }

    #[test]
    fn once_returns_the_instant_then_exhausts() {
        let record = record("once", "2024-01-02T03:04:05+09:00", "Asia/Seoul");
        let instant = ms("2024-01-01T18:04:05Z");
        assert_eq!(next_after(&record, instant - 1).unwrap(), Some(instant));
        assert_eq!(next_after(&record, instant).unwrap(), None);
    }

    #[test]
    fn interval_uses_dtstart_or_created_at_anchor() {
        let mut record = record("interval", "60", "UTC");
        record.dtstart = Some(ms("2024-01-01T00:00:30Z"));
        assert_eq!(
            next_after(&record, ms("2024-01-01T00:01:29Z")).unwrap(),
            Some(ms("2024-01-01T00:01:30Z"))
        );
        record.dtstart = None;
        assert_eq!(
            next_after(&record, record.created_at).unwrap(),
            Some(ms("2024-01-01T00:01:00Z"))
        );
    }

    #[test]
    fn hourly_daily_weekdays_and_weekly_are_supported() {
        assert_eq!(
            next_after(&record("hourly", "15", "UTC"), ms("2024-01-01T10:15:00Z")).unwrap(),
            Some(ms("2024-01-01T11:15:00Z"))
        );
        assert_eq!(
            next_after(
                &record("daily", "09:30", "Asia/Seoul"),
                ms("2024-01-01T00:29:59Z")
            )
            .unwrap(),
            Some(ms("2024-01-01T00:30:00Z"))
        );
        assert_eq!(
            next_after(
                &record("weekdays", "09:00", "UTC"),
                ms("2024-01-05T09:00:00Z")
            )
            .unwrap(),
            Some(ms("2024-01-08T09:00:00Z"))
        );
        assert_eq!(
            next_after(
                &record("weekly", "mOn@08:45", "UTC"),
                ms("2024-01-01T08:45:00Z")
            )
            .unwrap(),
            Some(ms("2024-01-08T08:45:00Z"))
        );
    }

    #[test]
    fn cron_supports_lists_ranges_steps_and_next_five() {
        let record = record("cron", "0,30 9-10 * * MON-FRI", "UTC");
        assert_eq!(
            next_occurrences(&record, ms("2024-01-01T08:59:59Z"), 5).unwrap(),
            vec![
                ms("2024-01-01T09:00:00Z"),
                ms("2024-01-01T09:30:00Z"),
                ms("2024-01-01T10:00:00Z"),
                ms("2024-01-01T10:30:00Z"),
                ms("2024-01-02T09:00:00Z")
            ]
        );
        validate_schedule("cron", "*/15 9-17 * * 1-5", "UTC", None).unwrap();
    }

    #[test]
    fn validation_rejects_invalid_values_and_timezones() {
        for (kind, value) in [
            ("once", "tomorrow"),
            ("interval", "0"),
            ("hourly", "60"),
            ("daily", "9:00"),
            ("weekdays", "24:00"),
            ("weekly", "monday@09:00"),
            ("cron", "* * * *"),
            ("cron", "61 * * * *"),
            ("unknown", "value"),
        ] {
            assert!(validate_schedule(kind, value, "UTC", None).is_err());
        }
        assert!(validate_schedule("daily", "09:00", "Not/AZone", None).is_err());
        assert!(validate_schedule("daily", "09:00", "", None).is_err());
        assert!(validate_schedule("once", "1960-01-01T00:00:00Z", "UTC", None).is_err());
    }

    #[test]
    fn spring_forward_nonexistent_time_advances_to_first_valid_minute() {
        let record = record("daily", "02:30", "America/New_York");
        assert_eq!(
            next_after(&record, ms("2024-03-10T06:00:00Z")).unwrap(),
            Some(ms("2024-03-10T07:00:00Z"))
        );
    }

    #[test]
    fn fall_back_chooses_first_ambiguous_instant_still_after_cursor() {
        let record = record("daily", "01:30", "America/New_York");
        assert_eq!(
            next_after(&record, ms("2024-11-03T04:00:00Z")).unwrap(),
            Some(ms("2024-11-03T05:30:00Z"))
        );
        assert_eq!(
            next_after(&record, ms("2024-11-03T05:45:00Z")).unwrap(),
            Some(ms("2024-11-03T06:30:00Z"))
        );
    }

    #[test]
    fn cron_preview_matches_repeated_next_after() {
        let record = record("cron", "*/20 8-9 * * MON-FRI", "Europe/Berlin");
        let cursor = ms("2024-04-01T05:00:00Z");
        let preview = next_occurrences(&record, cursor, 5).unwrap();
        let mut repeated = Vec::new();
        let mut after = cursor;
        for _ in 0..5 {
            let next = next_after(&record, after).unwrap().unwrap();
            repeated.push(next);
            after = next;
        }
        assert_eq!(preview, repeated);
    }

    #[test]
    fn preview_is_bounded_and_checked_millis_do_not_wrap() {
        let rec = record("hourly", "0", "UTC");
        assert!(next_occurrences(&rec, rec.created_at, 101).is_err());
        assert!(next_after(&rec, u64::MAX).is_err());
        let mut interval = record("interval", "18446744073709552", "UTC");
        interval.dtstart = Some(0);
        assert!(next_after(&interval, 0).is_err());
    }
}
