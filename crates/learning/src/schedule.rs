//! When each item comes back, with [FSRS](https://github.com/open-spaced-repetition/fsrs-rs):
//! its memory of an item is worked out by replaying every attempt at it in order.
//!
//! The app schedules attempts made offline itself, with ts-fsrs, until they reach the server,
//! whose schedule is the one that counts. Both use FSRS-7's default parameters, fractional days
//! and no fixed learning steps, and `tests/fsrs.json` holds cases both must agree on.

use fsrs::{FSRS, MemoryState};
use serde::{Deserialize, Serialize};

pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// The soonest an item comes back, however badly it went: FSRS would bring back a forgotten
/// item within seconds, but a few minutes later is a better test of remembering it.
pub const MIN_INTERVAL_MS: i64 = 10 * 60 * 1000;

/// The longest an item goes without coming back, so nothing is left for years.
pub const MAX_INTERVAL_MS: i64 = 365 * DAY_MS;

/// How an attempt went, as FSRS rates it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rating {
    /// Forgotten, or answered wrongly.
    Again,
    Hard,
    Good,
    Easy,
}

impl Rating {
    pub fn number(self) -> u32 {
        match self {
            Self::Again => 1,
            Self::Hard => 2,
            Self::Good => 3,
            Self::Easy => 4,
        }
    }

    pub fn from_number(number: u32) -> Option<Self> {
        match number {
            1 => Some(Self::Again),
            2 => Some(Self::Hard),
            3 => Some(Self::Good),
            4 => Some(Self::Easy),
            _ => None,
        }
    }
}

/// What's known of the learner's memory of one item.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ItemSchedule {
    pub stability: f32,
    pub difficulty: f32,
    pub stability_fast: f32,
    /// When it was last attempted, in milliseconds since 1970.
    pub last_review: i64,
    pub reviews: u32,
    /// How many times it was forgotten after first being seen.
    pub lapses: u32,
}

impl ItemSchedule {
    fn memory(&self) -> MemoryState {
        MemoryState {
            stability: self.stability,
            difficulty: self.difficulty,
            stability_fast: self.stability_fast,
        }
    }
}

pub struct Scheduler {
    fsrs: FSRS,
}

impl Default for Scheduler {
    fn default() -> Self {
        Self {
            fsrs: FSRS::new(&[]).expect("FSRS's default parameters are valid"),
        }
    }
}

impl Scheduler {
    /// The item's memory after one more attempt, at `at` milliseconds since 1970.
    pub fn review(&self, before: Option<&ItemSchedule>, at: i64, rating: Rating) -> ItemSchedule {
        let elapsed_days =
            before.map_or(0.0, |b| (at - b.last_review).max(0) as f32 / DAY_MS as f32);
        let next = self
            .fsrs
            .next_states_with_elapsed_days(before.map(ItemSchedule::memory), 0.9, elapsed_days)
            .expect("FSRS steps any valid memory state");
        let state = match rating {
            Rating::Again => next.again,
            Rating::Hard => next.hard,
            Rating::Good => next.good,
            Rating::Easy => next.easy,
        };
        ItemSchedule {
            stability: state.memory.stability,
            difficulty: state.memory.difficulty,
            stability_fast: state.memory.stability_fast,
            last_review: at,
            reviews: before.map_or(0, |b| b.reviews) + 1,
            lapses: before.map_or(0, |b| b.lapses)
                + u32::from(before.is_some() && rating == Rating::Again),
        }
    }

    /// The item's memory after these attempts, which must be in the order they were made.
    pub fn replay(
        &self,
        attempts: impl IntoIterator<Item = (i64, Rating)>,
    ) -> Option<ItemSchedule> {
        attempts.into_iter().fold(None, |before, (at, rating)| {
            Some(self.review(before.as_ref(), at, rating))
        })
    }

    /// When the item should next be attempted, for recall to have fallen to `retention`.
    pub fn due(&self, schedule: &ItemSchedule, retention: f64) -> i64 {
        let days = self
            .fsrs
            .next_interval_for_state(schedule.memory(), retention as f32);
        let interval = (f64::from(days) * DAY_MS as f64) as i64;
        schedule.last_review + interval.clamp(MIN_INTERVAL_MS, MAX_INTERVAL_MS)
    }

    /// How likely the learner is to recall the item at `now`, from 0 to 1.
    pub fn recall(&self, schedule: &ItemSchedule, now: i64) -> f64 {
        let days = (now - schedule.last_review).max(0) as f32 / DAY_MS as f32;
        f64::from(self.fsrs.current_retrievability(schedule.memory(), days))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Serialize, Deserialize)]
    struct Case {
        /// Days after the one before, and how it went.
        attempts: Vec<(f64, Rating)>,
        stability: f32,
        difficulty: f32,
        stability_fast: f32,
        /// Days from the last attempt until it's due, at a retention of 0.9.
        due_in_days: f64,
    }

    const FIXTURE: &str = "tests/fsrs.json";

    fn sequences() -> Vec<Vec<(f64, Rating)>> {
        use Rating::*;
        vec![
            vec![(0.0, Good)],
            vec![(0.0, Again)],
            vec![(0.0, Easy)],
            vec![(0.0, Hard)],
            vec![(0.0, Good), (3.0, Good), (9.5, Good)],
            vec![(0.0, Good), (0.01, Again), (1.0, Good)],
            vec![(0.0, Again), (0.007, Again), (0.5, Hard), (2.25, Easy)],
            vec![(0.0, Easy), (40.0, Again), (0.2, Good)],
        ]
    }

    fn run(attempts: &[(f64, Rating)]) -> Case {
        let scheduler = Scheduler::default();
        let mut at = 1_700_000_000_000i64;
        let timed: Vec<(i64, Rating)> = attempts
            .iter()
            .map(|&(days, rating)| {
                at += (days * DAY_MS as f64) as i64;
                (at, rating)
            })
            .collect();
        let schedule = scheduler.replay(timed).unwrap();
        Case {
            attempts: attempts.to_vec(),
            stability: schedule.stability,
            difficulty: schedule.difficulty,
            stability_fast: schedule.stability_fast,
            due_in_days: (scheduler.due(&schedule, 0.9) - schedule.last_review) as f64
                / DAY_MS as f64,
        }
    }

    /// The cases the app's scheduler is checked against too. To change them, run with
    /// `UPDATE_FIXTURES=1` and check what changed.
    #[test]
    fn matches_the_cases_shared_with_the_app() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE);
        let cases: Vec<Case> = sequences().iter().map(|s| run(s)).collect();
        if std::env::var_os("UPDATE_FIXTURES").is_some() {
            std::fs::write(&path, serde_json::to_string_pretty(&cases).unwrap() + "\n").unwrap();
        }
        let expected: Vec<Case> =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(expected.len(), cases.len());
        for (expected, case) in expected.iter().zip(&cases) {
            assert_eq!(expected.attempts, case.attempts);
            assert!(
                (expected.stability - case.stability).abs() < 1e-4,
                "{case:?}"
            );
            assert!(
                (expected.difficulty - case.difficulty).abs() < 1e-4,
                "{case:?}"
            );
            assert!(
                (expected.stability_fast - case.stability_fast).abs() < 1e-4,
                "{case:?}"
            );
            assert!(
                (expected.due_in_days - case.due_in_days).abs() < 1e-3,
                "{case:?}"
            );
        }
    }

    #[test]
    fn brings_back_what_was_forgotten_sooner() {
        let scheduler = Scheduler::default();
        let good = scheduler.review(None, 0, Rating::Good);
        let again = scheduler.review(None, 0, Rating::Again);
        assert!(scheduler.due(&good, 0.9) > scheduler.due(&again, 0.9));
        assert_eq!(scheduler.due(&again, 0.9), MIN_INTERVAL_MS);
        // A higher retention brings items back sooner.
        assert!(scheduler.due(&good, 0.95) < scheduler.due(&good, 0.9));
    }

    #[test]
    fn counts_reviews_and_lapses() {
        let scheduler = Scheduler::default();
        let schedule = scheduler
            .replay([
                (0, Rating::Again),
                (DAY_MS, Rating::Good),
                (5 * DAY_MS, Rating::Again),
            ])
            .unwrap();
        assert_eq!(schedule.reviews, 3);
        // Forgetting it the first time it's seen isn't a lapse.
        assert_eq!(schedule.lapses, 1);
        assert_eq!(scheduler.replay([]), None);
    }

    #[test]
    fn recall_fades_with_time() {
        let scheduler = Scheduler::default();
        let schedule = scheduler.review(None, 0, Rating::Good);
        let soon = scheduler.recall(&schedule, DAY_MS);
        let later = scheduler.recall(&schedule, 30 * DAY_MS);
        assert!(soon > later && later > 0.0 && soon <= 1.0);
        let due = scheduler.due(&schedule, 0.9);
        assert!((scheduler.recall(&schedule, due) - 0.9).abs() < 0.01);
    }

    #[test]
    fn numbers_ratings_as_fsrs_does() {
        for rating in [Rating::Again, Rating::Hard, Rating::Good, Rating::Easy] {
            assert_eq!(Rating::from_number(rating.number()), Some(rating));
        }
        assert_eq!(Rating::from_number(0), None);
    }
}
