use crate::error::{Error, Result};
use chrono::{DateTime, NaiveDate};
use regex::Regex;
use std::sync::LazyLock;

pub const DAY: i64 = 86_400_000;
pub const YEAR: f64 = DAY as f64 * 365.2425;

pub fn assert_intervals(episodes: &[crate::model::Episode]) -> Result<()> {
    let mut ordered: Vec<_> = episodes.iter().collect();
    ordered.sort_by(|a, b| a.start.cmp(&b.start).then(a.id.cmp(&b.id)));
    let mut previous: Option<&crate::model::Episode> = None;
    for current in ordered {
        if current.now < current.start {
            return Err(Error::new(
                "INVALID_TIME",
                "An episode cannot end before it starts.",
            ));
        }
        if previous
            .is_some_and(|previous| current.start == previous.start || current.start < previous.now)
        {
            return Err(Error::new(
                "INTERLEAVING_EPISODES",
                format!(
                    "The episode “{}” overlaps another episode. Episodes must occupy separate chronological slots.",
                    current.label
                ),
            ));
        }
        previous = Some(current);
    }
    Ok(())
}
const MAX_TIME: i64 = 8_640_000_000_000_000;
static ISO_INPUT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$",
    )
    .unwrap()
});

pub fn fictional_time(value: &serde_json::Value) -> Result<i64> {
    let invalid = || {
        Error::new(
            "INVALID_TIME",
            "Use YYYY-MM-DD or an ISO timestamp with an explicit time zone.",
        )
    };
    if let Some(number) = value.as_i64() {
        return if (-MAX_TIME..=MAX_TIME).contains(&number) {
            Ok(number)
        } else {
            Err(invalid())
        };
    }
    let text = value.as_str().ok_or_else(invalid)?;
    if !text.is_ascii() || !ISO_INPUT.is_match(text) {
        return Err(invalid());
    }
    if text.len() == 10 && text.as_bytes()[4] == b'-' && text.as_bytes()[7] == b'-' {
        let date = NaiveDate::parse_from_str(text, "%Y-%m-%d").map_err(|_| invalid())?;
        if date.format("%Y-%m-%d").to_string() != text {
            return Err(invalid());
        }
        return Ok(date
            .and_hms_opt(0, 0, 0)
            .ok_or_else(invalid)?
            .and_utc()
            .timestamp_millis());
    }
    let normalized = if matches!(text.as_bytes().get(16), Some(b'Z' | b'+' | b'-')) {
        format!("{}:00{}", &text[..16], &text[16..])
    } else {
        text.to_owned()
    };
    DateTime::parse_from_rfc3339(&normalized)
        .map(|date| date.timestamp_millis())
        .map_err(|_| invalid())
}

pub fn iso(value: i64) -> Result<String> {
    DateTime::from_timestamp_millis(value)
        .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(|| {
            Error::new(
                "INVALID_TIME",
                "The fictional point is outside the supported calendar.",
            )
        })
}

pub fn elapsed_description(milliseconds: i64) -> String {
    let days = milliseconds.max(0) as f64 / DAY as f64;
    if days < 1.0 {
        "earlier in the same day".into()
    } else if days < 14.0 {
        "days ago".into()
    } else if days < 60.0 {
        "weeks ago".into()
    } else if days < 365.2425 {
        "months ago".into()
    } else {
        let years = (milliseconds.max(0) as f64 / YEAR).round().max(1.0) as i64;
        if years < 2 {
            "about a year ago".into()
        } else {
            format!("about {years} years ago")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn explicit_dates_are_timezone_independent_and_calendar_valid() {
        assert_eq!(fictional_time(&json!("2024-02-29")).unwrap(), 1709164800000);
        assert!(fictional_time(&json!("2023-02-29")).is_err());
        assert!(fictional_time(&json!("2024-01-01T12:00")).is_err());
        assert_eq!(
            fictional_time(&json!("2024-01-01T12:00:00+02:00")).unwrap(),
            1704103200000
        );
        assert_eq!(
            fictional_time(&json!("2024-01-01T12:00+02:00")).unwrap(),
            1704103200000
        );
        assert!(fictional_time(&json!("2024-01-01T12:00:00.1234Z")).is_err());
        assert!(fictional_time(&json!(i64::MIN)).is_err());
    }
    #[test]
    fn fictional_years_do_not_imply_continuous_contact() {
        assert_eq!(
            elapsed_description((20.0 * YEAR) as i64),
            "about 20 years ago"
        );
    }
    #[test]
    fn native_sqlite_has_fts5() {
        assert_eq!(
            crate::storage_probe().unwrap(),
            "A cedar coat at the lighthouse"
        );
    }
}
