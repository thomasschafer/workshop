//! Advent of Code's calendar: when each puzzle unlocks.

/// When a puzzle unlocks, in seconds since 1970: midnight US Eastern, which in December is
/// always 05:00 UTC.
pub fn unlock_time(year: u16, day: u8) -> u64 {
    let days = days_from_civil(i64::from(year), 12, i64::from(day));
    u64::try_from(days * 86_400 + 5 * 3600).expect("puzzles unlock after 1970")
}

/// Advent of Code has 12 days from 2025 onwards, and 25 before that.
pub fn days_in(year: u16) -> u8 {
    if year >= 2025 { 12 } else { 25 }
}

/// The next puzzle to unlock after `now`, during or ahead of this year's event.
pub fn next_unlock(now: u64) -> Option<(u16, u8, u64)> {
    let year = year_of(now);
    (1..=days_in(year))
        .map(|day| (year, day, unlock_time(year, day)))
        .find(|(_, _, at)| *at > now)
}

/// The puzzle that unlocked most recently, while the event is running: today's puzzle.
pub fn todays_puzzle(now: u64) -> Option<(u16, u8)> {
    let year = year_of(now);
    let year = if now >= unlock_time(year, 1) {
        year
    } else {
        year - 1
    };
    let day = (now - unlock_time(year, 1)) / 86_400 + 1;
    let day = u8::try_from(day).ok()?;
    (day <= days_in(year)).then_some((year, day))
}

pub fn is_unlocked(year: u16, day: u8, now: u64) -> bool {
    now >= unlock_time(year, day)
}

/// The calendar year a time falls in, in UTC.
fn year_of(seconds: u64) -> u16 {
    let days = i64::try_from(seconds / 86_400).expect("a time within range");
    // Days from 1970 to the start of each year, until the year that contains `days`.
    let mut year = 1970;
    while days_from_civil(year + 1, 1, 1) <= days {
        year += 1;
    }
    u16::try_from(year).expect("a year within range")
}

/// Days from 1970-01-01 to a date, by Howard Hinnant's algorithm for the proleptic Gregorian
/// calendar.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Seconds since 1970 for a UTC time, for readable tests.
    fn at(year: i64, month: i64, day: i64, hour: u64) -> u64 {
        u64::try_from(days_from_civil(year, month, day) * 86_400).unwrap() + hour * 3600
    }

    #[test]
    fn counts_days_from_1970() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        assert_eq!(days_from_civil(2026, 12, 1), 20_788);
        assert_eq!(year_of(at(2026, 12, 31, 23)), 2026);
        assert_eq!(year_of(at(2027, 1, 1, 0)), 2027);
    }

    #[test]
    fn unlocks_at_midnight_us_eastern() {
        // 2026-12-01T05:00:00Z.
        assert_eq!(unlock_time(2026, 1), 1_796_101_200);
        assert_eq!(
            next_unlock(at(2026, 12, 3, 22)),
            Some((2026, 4, unlock_time(2026, 4)))
        );
        assert_eq!(
            next_unlock(at(2026, 11, 2, 0)),
            Some((2026, 1, unlock_time(2026, 1)))
        );
        // After the last of the year's twelve days, nothing until next year.
        assert_eq!(next_unlock(at(2026, 12, 12, 6)), None);
        assert_eq!(
            next_unlock(at(2024, 12, 24, 6)).map(|(_, d, _)| d),
            Some(25)
        );
    }

    #[test]
    fn knows_todays_puzzle_while_the_event_runs() {
        assert_eq!(todays_puzzle(at(2026, 12, 1, 5)), Some((2026, 1)));
        assert_eq!(todays_puzzle(at(2026, 12, 3, 4)), Some((2026, 2)));
        assert_eq!(todays_puzzle(at(2026, 12, 12, 23)), Some((2026, 12)));
        assert_eq!(todays_puzzle(at(2026, 12, 13, 6)), None);
        assert_eq!(todays_puzzle(at(2026, 12, 1, 4)), None);
        assert_eq!(todays_puzzle(at(2027, 1, 1, 0)), None);
        assert_eq!(todays_puzzle(at(2024, 12, 25, 6)), Some((2024, 25)));
        assert!(is_unlocked(2026, 1, at(2026, 12, 1, 5)));
        assert!(!is_unlocked(2026, 2, at(2026, 12, 1, 5)));
    }
}
