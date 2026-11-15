//! What's due, what's new, and how far through the week's target the learner is: what the home
//! screen offers next.

use std::collections::BTreeMap;

use serde::Serialize;
use workshop_tracks::TrackId;

use crate::schedule::{DAY_MS, ItemSchedule, Scheduler};
use crate::store::{Flag, Retirement};

/// How much to do, from the config.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Limits {
    /// The most reviews of items seen before today to offer in a day.
    pub daily_reviews: u32,
    /// The most items never seen before to start in a day.
    pub daily_new: u32,
    pub weekly_minutes: u32,
    pub retention: f64,
}

/// Now, and where the learner's days begin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Clock {
    /// Milliseconds since 1970.
    pub now: i64,
    /// How far the learner's time is ahead of UTC, in minutes, such as 60 in Paris in winter.
    pub utc_offset_minutes: i32,
}

impl Clock {
    /// The start of the learner's day, in milliseconds since 1970.
    pub fn day_start(&self) -> i64 {
        let offset = i64::from(self.utc_offset_minutes) * 60 * 1000;
        (self.now + offset).div_euclid(DAY_MS) * DAY_MS - offset
    }

    /// The start of the learner's week, on Monday.
    pub fn week_start(&self) -> i64 {
        let offset = i64::from(self.utc_offset_minutes) * 60 * 1000;
        let day = (self.now + offset).div_euclid(DAY_MS);
        // 1 January 1970 was a Thursday, three days after a Monday.
        let since_monday = (day + 3).rem_euclid(7);
        self.day_start() - since_monday * DAY_MS
    }
}

/// An item, as planning needs it.
#[derive(Debug, Clone, Copy)]
pub struct ItemRef<'a> {
    /// `pack/item`.
    pub key: &'a str,
    pub track: &'a TrackId,
    pub skills: &'a [String],
}

/// What's done so far today and this week.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Progress {
    /// Reviews today of items seen before today, which count towards the daily limit.
    pub reviews_today: u32,
    /// Items first attempted today, which count towards the daily limit of new ones.
    pub new_today: u32,
    pub minutes_this_week: u32,
}

/// One track's items, by what's to be done with them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TrackPlan {
    /// Due now and within today's limit, most overdue first.
    pub due: Vec<String>,
    /// Due, but over today's limit, so waiting for tomorrow.
    pub waiting: usize,
    /// Never attempted and within today's limit of new items, those in the skills to focus on
    /// first. The limit is shared by every track, so each offers up to what's left of it.
    pub new: Vec<String>,
    /// Never attempted, but over today's limit of new items, so waiting for tomorrow.
    pub new_waiting: Vec<String>,
    /// Flagged as wrong, so left out.
    pub flagged: usize,
    /// Retired, so never offered again.
    pub retired: usize,
    /// When the soonest item that isn't due yet will be, if there is one.
    pub next_due: Option<i64>,
}

impl TrackPlan {
    /// Whether an item has never been attempted, whether or not it's within today's limit.
    pub fn is_new(&self, key: &str) -> bool {
        self.new.iter().chain(&self.new_waiting).any(|k| k == key)
    }

    /// How many items have never been attempted, whether or not within today's limit.
    pub fn new_count(&self) -> usize {
        self.new.len() + self.new_waiting.len()
    }
}

/// When an item that's been attempted is due, or None if it's retired: as its schedule says,
/// unless it was brought back since it was last attempted, which makes it due from then.
pub fn due(
    schedule: &ItemSchedule,
    retirement: Option<Retirement>,
    scheduler: &Scheduler,
    retention: f64,
) -> Option<i64> {
    match retirement {
        Some(Retirement::Retired { .. }) => None,
        Some(Retirement::BroughtBack { at }) if at > schedule.last_review => Some(at),
        _ => Some(scheduler.due(schedule, retention)),
    }
}

/// Each track's plan, for the items given. Tracks with none of them aren't included. New items
/// with any of the `focus` skills, such as those of recent mistakes, come first. Retired items
/// are left out, and one brought back since it was last attempted is due from then.
#[allow(clippy::too_many_arguments)]
pub fn plan(
    items: &[ItemRef<'_>],
    schedules: &BTreeMap<String, ItemSchedule>,
    flags: &BTreeMap<String, Flag>,
    retirements: &BTreeMap<String, Retirement>,
    progress: Progress,
    limits: Limits,
    focus: &[String],
    scheduler: &Scheduler,
    now: i64,
) -> BTreeMap<TrackId, TrackPlan> {
    let mut plans: BTreeMap<TrackId, TrackPlan> = BTreeMap::new();
    let mut due: Vec<(i64, &str, &TrackId)> = Vec::new();
    for item in items {
        let plan = plans.entry(item.track.clone()).or_default();
        if flags.contains_key(item.key) {
            plan.flagged += 1;
            continue;
        }
        let retirement = retirements.get(item.key).copied();
        if retirement.is_some_and(Retirement::is_retired) {
            plan.retired += 1;
            continue;
        }
        match schedules.get(item.key) {
            None => plan.new.push(item.key.to_owned()),
            Some(schedule) => {
                let when = self::due(schedule, retirement, scheduler, limits.retention)
                    .expect("retired items are left out above");
                if when <= now {
                    due.push((when, item.key, item.track));
                } else if plan.next_due.is_none_or(|next| when < next) {
                    plan.next_due = Some(when);
                }
            }
        }
    }
    for plan in plans.values_mut() {
        let in_focus = |key: &String| {
            items
                .iter()
                .find(|item| item.key == key)
                .is_some_and(|item| item.skills.iter().any(|skill| focus.contains(skill)))
        };
        // Stable, so otherwise they stay in the packs' order.
        plan.new.sort_by_key(|key| !in_focus(key));
        let allowed_new = limits.daily_new.saturating_sub(progress.new_today) as usize;
        if plan.new.len() > allowed_new {
            plan.new_waiting = plan.new.split_off(allowed_new);
        }
    }
    due.sort();
    let allowed = limits.daily_reviews.saturating_sub(progress.reviews_today) as usize;
    for (index, (_, key, track)) in due.into_iter().enumerate() {
        let plan = plans.get_mut(track).expect("every item's track has a plan");
        if index < allowed {
            plan.due.push(key.to_owned());
        } else {
            plan.waiting += 1;
        }
    }
    plans
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schedule::Rating;

    const NOW: i64 = 1_790_000_000_000;

    #[test]
    fn finds_the_learners_day_and_week() {
        // 2026-09-21, a Monday, at 23:30 UTC.
        let late_monday = 1_790_033_400_000;
        let utc = Clock {
            now: late_monday,
            utc_offset_minutes: 0,
        };
        assert_eq!(utc.day_start(), 1_789_948_800_000);
        assert_eq!(utc.week_start(), utc.day_start());
        // An hour ahead, it's already Tuesday.
        let ahead = Clock {
            now: late_monday,
            utc_offset_minutes: 60,
        };
        assert_eq!(ahead.day_start(), 1_789_948_800_000 + DAY_MS - 3_600_000);
        assert_eq!(ahead.week_start(), 1_789_948_800_000 - 3_600_000);
        // Behind UTC, still Monday.
        let behind = Clock {
            now: late_monday,
            utc_offset_minutes: -300,
        };
        assert_eq!(behind.day_start(), 1_789_948_800_000 + 300 * 60_000);
        assert_eq!(behind.week_start(), behind.day_start());
    }

    #[test]
    fn offers_due_items_within_the_daily_limit_then_new_ones() {
        let scheduler = Scheduler::default();
        let review = &TrackId::Review;
        let maths = &TrackId::MentalMaths;
        let skills = Vec::new();
        let item = |key, track| ItemRef {
            key,
            track,
            skills: &skills,
        };
        let items = [
            item("p/old", review),
            item("p/older", review),
            item("p/sum", maths),
            item("p/new", review),
            item("p/wrong", review),
            item("p/fresh", maths),
        ];
        let seen = |days_ago: i64| scheduler.review(None, NOW - days_ago * DAY_MS, Rating::Good);
        let schedules = BTreeMap::from([
            ("p/old".to_owned(), seen(30)),
            ("p/older".to_owned(), seen(60)),
            ("p/sum".to_owned(), seen(40)),
            (
                "p/fresh".to_owned(),
                scheduler.review(None, NOW, Rating::Good),
            ),
        ]);
        let flags = BTreeMap::from([(
            "p/wrong".to_owned(),
            Flag {
                at: NOW,
                note: None,
            },
        )]);
        let limits = Limits {
            daily_reviews: 5,
            daily_new: 10,
            weekly_minutes: 60,
            retention: 0.9,
        };
        let progress = Progress {
            reviews_today: 3,
            new_today: 0,
            minutes_this_week: 0,
        };
        let plans = plan(
            &items,
            &schedules,
            &flags,
            &BTreeMap::new(),
            progress,
            limits,
            &[],
            &scheduler,
            NOW,
        );
        // Two more reviews today: the most overdue two.
        assert_eq!(plans[review].due, ["p/older"]);
        assert_eq!(plans[maths].due, ["p/sum"]);
        assert_eq!(plans[review].waiting, 1);
        assert_eq!(plans[review].new, ["p/new"]);
        assert_eq!(plans[review].flagged, 1);
        assert!(plans[maths].next_due.is_some_and(|next| next > NOW));

        let done = Progress {
            reviews_today: 10,
            new_today: 0,
            minutes_this_week: 0,
        };
        let plans = plan(
            &items,
            &schedules,
            &flags,
            &BTreeMap::new(),
            done,
            limits,
            &[],
            &scheduler,
            NOW,
        );
        assert!(plans[review].due.is_empty());
        assert_eq!(plans[review].waiting, 2);
    }

    #[test]
    fn puts_new_items_in_skills_to_focus_on_first() {
        let scheduler = Scheduler::default();
        let review = &TrackId::Review;
        let heaps = vec!["heaps".to_owned()];
        let graphs = vec!["graphs".to_owned()];
        let items = [
            ItemRef {
                key: "p/a",
                track: review,
                skills: &heaps,
            },
            ItemRef {
                key: "p/b",
                track: review,
                skills: &graphs,
            },
            ItemRef {
                key: "p/c",
                track: review,
                skills: &heaps,
            },
        ];
        let limits = Limits {
            daily_reviews: 5,
            daily_new: 10,
            weekly_minutes: 60,
            retention: 0.9,
        };
        let plans = plan(
            &items,
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
            Progress::default(),
            limits,
            &["graphs".to_owned()],
            &scheduler,
            NOW,
        );
        assert_eq!(plans[review].new, ["p/b", "p/a", "p/c"]);

        // Within today's limit of new items, the first of them; the rest wait for tomorrow.
        let limited = Limits {
            daily_new: 3,
            ..limits
        };
        let started = Progress {
            new_today: 1,
            ..Progress::default()
        };
        let plans = plan(
            &items,
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
            started,
            limited,
            &["graphs".to_owned()],
            &scheduler,
            NOW,
        );
        assert_eq!(plans[review].new, ["p/b", "p/a"]);
        assert_eq!(plans[review].new_waiting, ["p/c"]);
        assert!(plans[review].is_new("p/c"));
        assert_eq!(plans[review].new_count(), 3);
        let all_started = Progress {
            new_today: 5,
            ..Progress::default()
        };
        let plans = plan(
            &items,
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
            all_started,
            limited,
            &[],
            &scheduler,
            NOW,
        );
        assert!(plans[review].new.is_empty());
        assert_eq!(plans[review].new_waiting.len(), 3);
    }

    #[test]
    fn leaves_retired_items_out_and_brings_back_the_ones_brought_back() {
        let scheduler = Scheduler::default();
        let coding = &TrackId::Coding;
        let skills = Vec::new();
        let item = |key| ItemRef {
            key,
            track: coding,
            skills: &skills,
        };
        let items = [item("p/retired"), item("p/back"), item("p/again")];
        // Solved yesterday, so none would be due yet.
        let solved = scheduler.review(None, NOW - DAY_MS, Rating::Easy);
        let schedules = BTreeMap::from([
            ("p/retired".to_owned(), solved),
            ("p/back".to_owned(), solved),
            ("p/again".to_owned(), solved),
        ]);
        let retirements = BTreeMap::from([
            (
                "p/retired".to_owned(),
                Retirement::Retired { at: NOW - DAY_MS },
            ),
            (
                "p/back".to_owned(),
                Retirement::BroughtBack { at: NOW - 60_000 },
            ),
            // Brought back, then attempted since, so it's as its schedule says.
            (
                "p/again".to_owned(),
                Retirement::BroughtBack {
                    at: NOW - 2 * DAY_MS,
                },
            ),
        ]);
        let limits = Limits {
            daily_reviews: 5,
            daily_new: 10,
            weekly_minutes: 60,
            retention: 0.9,
        };
        let plans = plan(
            &items,
            &schedules,
            &BTreeMap::new(),
            &retirements,
            Progress::default(),
            limits,
            &[],
            &scheduler,
            NOW,
        );
        let plan = &plans[coding];
        assert_eq!(plan.retired, 1);
        assert_eq!(plan.due, ["p/back"]);
        assert!(plan.new.is_empty());
        assert!(plan.next_due.is_some_and(|next| next > NOW));
    }
}
