//! What's due, what's new, and how far through the week's target the learner is: what the home
//! screen offers next.

use std::collections::BTreeMap;

use serde::Serialize;
use workshop_tracks::TrackId;

use crate::schedule::{DAY_MS, ItemSchedule, Scheduler};
use crate::store::Flag;

/// How much to do, from the config.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Limits {
    /// The most reviews of items seen before today to offer in a day.
    pub daily_reviews: u32,
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
    pub minutes_this_week: u32,
}

/// One track's items, by what's to be done with them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TrackPlan {
    /// Due now and within today's limit, most overdue first.
    pub due: Vec<String>,
    /// Due, but over today's limit, so waiting for tomorrow.
    pub waiting: usize,
    /// Never attempted, those in the skills to focus on first.
    pub new: Vec<String>,
    /// Flagged as wrong, so left out.
    pub flagged: usize,
    /// When the soonest item that isn't due yet will be, if there is one.
    pub next_due: Option<i64>,
}

/// Each track's plan, for the items given. Tracks with none of them aren't included. New items
/// with any of the `focus` skills, such as those of recent mistakes, come first.
#[allow(clippy::too_many_arguments)]
pub fn plan(
    items: &[ItemRef<'_>],
    schedules: &BTreeMap<String, ItemSchedule>,
    flags: &BTreeMap<String, Flag>,
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
        match schedules.get(item.key) {
            None => plan.new.push(item.key.to_owned()),
            Some(schedule) => {
                let when = scheduler.due(schedule, limits.retention);
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
            weekly_minutes: 60,
            retention: 0.9,
        };
        let progress = Progress {
            reviews_today: 3,
            minutes_this_week: 0,
        };
        let plans = plan(
            &items,
            &schedules,
            &flags,
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
            minutes_this_week: 0,
        };
        let plans = plan(
            &items,
            &schedules,
            &flags,
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
            weekly_minutes: 60,
            retention: 0.9,
        };
        let plans = plan(
            &items,
            &BTreeMap::new(),
            &BTreeMap::new(),
            Progress::default(),
            limits,
            &["graphs".to_owned()],
            &scheduler,
            NOW,
        );
        assert_eq!(plans[review].new, ["p/b", "p/a", "p/c"]);
    }
}
