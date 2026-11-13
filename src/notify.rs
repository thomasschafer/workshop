//! Notifications when puzzles unlock, sent with Web Push to devices that asked for them. Off
//! unless a device turns them on.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use workshop_push::{Message, Notifier};

use crate::calendar::next_unlock;

/// What a device is told when a puzzle unlocks.
pub fn unlocked(year: u16, day: u8) -> Message {
    Message {
        title: format!("Day {day} is out"),
        body: format!("Advent of Code {year}, day {day}, has unlocked."),
        url: format!("/advent-of-code?open={year}-{day}"),
    }
}

/// Notifies subscribed devices as each puzzle unlocks, for as long as the server runs.
pub async fn notify_unlocks(notifier: &Notifier) {
    loop {
        let now = now_secs();
        let Some((year, day, at)) = next_unlock(now) else {
            // Until the next year's event, checking now and then.
            tokio::time::sleep(Duration::from_secs(24 * 60 * 60)).await;
            continue;
        };
        // In shorter steps, so a clock that changes or a computer that sleeps doesn't delay a
        // notification by much.
        let wait = at.saturating_sub(now).min(15 * 60);
        if wait > 0 {
            tokio::time::sleep(Duration::from_secs(wait)).await;
            continue;
        }
        if notifier.has_subscriptions() {
            tracing::info!("notifying devices that day {day} has unlocked");
            notifier.send_to_all(&unlocked(year, day)).await;
        }
        // Past this unlock, so the next pass finds the following one.
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_which_puzzle_unlocked_and_opens_it() {
        let message = unlocked(2026, 4);
        assert_eq!(message.title, "Day 4 is out");
        assert_eq!(message.body, "Advent of Code 2026, day 4, has unlocked.");
        assert_eq!(message.url, "/advent-of-code?open=2026-4");
    }
}
