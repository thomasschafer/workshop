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
    /// The most lessons offered in practice in a day.
    pub daily_lessons: u32,
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
    /// The learner's local calendar day, in days since 1 January 1970.
    pub fn local_day(&self) -> i64 {
        let offset = i64::from(self.utc_offset_minutes) * 60 * 1000;
        (self.now + offset).div_euclid(DAY_MS)
    }

    /// The start of the learner's day, in milliseconds since 1970.
    pub fn day_start(&self) -> i64 {
        let offset = i64::from(self.utc_offset_minutes) * 60 * 1000;
        self.local_day() * DAY_MS - offset
    }

    /// The start of the learner's week, on Monday.
    pub fn week_start(&self) -> i64 {
        // 1 January 1970 was a Thursday, three days after a Monday.
        let since_monday = (self.local_day() + 3).rem_euclid(7);
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
    /// Full `pack/lesson` key of the lesson that teaches this item, if any.
    pub lesson: Option<&'a str>,
}

/// A lesson, as planning needs it, in pack order.
#[derive(Debug, Clone, Copy)]
pub struct LessonPlanRef<'a> {
    /// `pack/lesson`.
    pub key: &'a str,
    pub track: &'a TrackId,
    /// Full `pack/lesson` keys of lessons to do first.
    pub requires: &'a [String],
}

/// What's done so far today and this week.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Progress {
    /// Reviews today of items seen before today, which count towards the daily limit.
    pub reviews_today: u32,
    /// Items first attempted today, which count towards the daily limit of new ones.
    pub new_today: u32,
    /// Distinct lessons completed today, which count towards `daily_lessons`.
    pub lessons_today: u32,
    pub minutes_this_week: u32,
}

/// One track's items, by what's to be done with them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TrackPlan {
    /// Due now and within today's limit, most overdue first.
    pub due: Vec<String>,
    /// Due, but over today's limit, so waiting for tomorrow.
    pub waiting: usize,
    /// The track's next lesson to offer before new items, if one is eligible within today's
    /// `daily_lessons` limit.
    pub next_lesson: Option<String>,
    /// Never attempted, unlocked, and within today's limit of new items, those in the skills to
    /// focus on first. The limit is shared by every track, so each offers up to what's left of it.
    pub new: Vec<String>,
    /// Never attempted and unlocked, but over today's limit of new items, so waiting for tomorrow.
    pub new_waiting: Vec<String>,
    /// Never attempted, and held back until their lesson is done and the learner's next day begins.
    /// Left out of `new` and `new_count()`.
    pub waiting_for_lesson: Vec<String>,
    /// Flagged as wrong, so left out.
    pub flagged: usize,
    /// Retired, so never offered again.
    pub retired: usize,
    /// When the soonest item that isn't due yet will be, if there is one.
    pub next_due: Option<i64>,
}

impl TrackPlan {
    /// Whether an item has never been attempted and is unlocked (not waiting for its lesson),
    /// whether or not it's within today's limit.
    pub fn is_new(&self, key: &str) -> bool {
        self.new.iter().chain(&self.new_waiting).any(|k| k == key)
    }

    /// Whether an item has never been attempted and is held back waiting for its lesson.
    pub fn is_waiting_for_lesson(&self, key: &str) -> bool {
        self.waiting_for_lesson.iter().any(|k| k == key)
    }

    /// How many unlocked items have never been attempted, whether or not within today's limit.
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

/// Each track's plan, for the items and lessons given. Tracks with none of them aren't included.
/// New items with any of the `focus` skills, such as those of recent mistakes, come first. Retired
/// items are left out, and one brought back since it was last attempted is due from then.
///
/// Unattempted items with a `lesson` wait until that lesson has been completed before the start of
/// the learner's current day (`clock.day_start()`). Each track's `next_lesson` is the first lesson
/// in pack order that hasn't been completed, whose `requires` have all been completed, and that
/// hasn't been skipped today, provided `progress.lessons_today < limits.daily_lessons`.
#[allow(clippy::too_many_arguments)]
pub fn plan(
    items: &[ItemRef<'_>],
    lessons: &[LessonPlanRef<'_>],
    schedules: &BTreeMap<String, ItemSchedule>,
    flags: &BTreeMap<String, Flag>,
    retirements: &BTreeMap<String, Retirement>,
    lesson_completions: &BTreeMap<String, Vec<i64>>,
    lesson_skips: &BTreeMap<String, Vec<i64>>,
    progress: Progress,
    limits: Limits,
    focus: &[String],
    scheduler: &Scheduler,
    clock: Clock,
) -> BTreeMap<TrackId, TrackPlan> {
    let day_start = clock.day_start();
    let unlocked = |lesson: Option<&str>| match lesson {
        None => true,
        Some(key) => lesson_completions
            .get(key)
            .and_then(|times| times.iter().min().copied())
            .is_some_and(|first| first < day_start),
    };
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
            None => {
                if unlocked(item.lesson) {
                    plan.new.push(item.key.to_owned());
                } else {
                    plan.waiting_for_lesson.push(item.key.to_owned());
                }
            }
            Some(schedule) => {
                let when = self::due(schedule, retirement, scheduler, limits.retention)
                    .expect("retired items are left out above");
                if when <= clock.now {
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
    let is_done = |key: &str| lesson_completions.get(key).is_some_and(|ts| !ts.is_empty());
    let skipped_today = |key: &str| {
        lesson_skips
            .get(key)
            .is_some_and(|ts| ts.iter().any(|&at| at >= day_start))
    };
    let lessons_allowed = limits.daily_lessons.saturating_sub(progress.lessons_today) > 0;
    for lesson in lessons {
        let plan = plans.entry(lesson.track.clone()).or_default();
        if !lessons_allowed || plan.next_lesson.is_some() {
            continue;
        }
        if !is_done(lesson.key)
            && !skipped_today(lesson.key)
            && lesson.requires.iter().all(|req| is_done(req))
        {
            plan.next_lesson = Some(lesson.key.to_owned());
        }
    }
    plans
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use serde::Deserialize;

    use super::*;
    use crate::schedule::Rating;
    use crate::store::{Attempt, LessonCompletion, LessonSkip, Store};

    const NOW: i64 = 1_790_000_000_000;

    fn utc(now: i64) -> Clock {
        Clock {
            now,
            utc_offset_minutes: 0,
        }
    }

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
            lesson: None,
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
            daily_lessons: 1,
            weekly_minutes: 60,
            retention: 0.9,
        };
        let progress = Progress {
            reviews_today: 3,
            new_today: 0,
            lessons_today: 0,
            minutes_this_week: 0,
        };
        let plans = plan(
            &items,
            &[],
            &schedules,
            &flags,
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
            progress,
            limits,
            &[],
            &scheduler,
            utc(NOW),
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
            lessons_today: 0,
            minutes_this_week: 0,
        };
        let plans = plan(
            &items,
            &[],
            &schedules,
            &flags,
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
            done,
            limits,
            &[],
            &scheduler,
            utc(NOW),
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
                lesson: None,
            },
            ItemRef {
                key: "p/b",
                track: review,
                skills: &graphs,
                lesson: None,
            },
            ItemRef {
                key: "p/c",
                track: review,
                skills: &heaps,
                lesson: None,
            },
        ];
        let limits = Limits {
            daily_reviews: 5,
            daily_new: 10,
            daily_lessons: 1,
            weekly_minutes: 60,
            retention: 0.9,
        };
        let plans = plan(
            &items,
            &[],
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
            Progress::default(),
            limits,
            &["graphs".to_owned()],
            &scheduler,
            utc(NOW),
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
            &[],
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
            started,
            limited,
            &["graphs".to_owned()],
            &scheduler,
            utc(NOW),
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
            &[],
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
            all_started,
            limited,
            &[],
            &scheduler,
            utc(NOW),
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
            lesson: None,
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
            daily_lessons: 1,
            weekly_minutes: 60,
            retention: 0.9,
        };
        let plans = plan(
            &items,
            &[],
            &schedules,
            &BTreeMap::new(),
            &retirements,
            &BTreeMap::new(),
            &BTreeMap::new(),
            Progress::default(),
            limits,
            &[],
            &scheduler,
            utc(NOW),
        );
        let plan = &plans[coding];
        assert_eq!(plan.retired, 1);
        assert_eq!(plan.due, ["p/back"]);
        assert!(plan.new.is_empty());
        assert!(plan.next_due.is_some_and(|next| next > NOW));
    }

    #[derive(Debug, Deserialize)]
    struct SharedCase {
        name: String,
        now: i64,
        utc_offset_minutes: i32,
        limits: SharedLimits,
        kept_apart: Vec<TrackId>,
        lessons: Vec<SharedLesson>,
        items: Vec<SharedItem>,
        attempts: Vec<SharedAttempt>,
        lesson_completions: Vec<SharedCompletion>,
        lesson_skips: Vec<SharedSkip>,
        expected: BTreeMap<TrackId, SharedExpected>,
        expected_shared_minutes: Option<u32>,
        expected_apart_minutes: Option<BTreeMap<TrackId, u32>>,
    }

    #[derive(Debug, Deserialize)]
    struct SharedLimits {
        daily_reviews: u32,
        daily_new: u32,
        daily_lessons: u32,
        weekly_minutes: u32,
        retention: f64,
    }

    #[derive(Debug, Deserialize)]
    struct SharedLesson {
        key: String,
        track: TrackId,
        requires: Vec<String>,
    }

    #[derive(Debug, Deserialize)]
    struct SharedItem {
        key: String,
        track: TrackId,
        lesson: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    struct SharedAttempt {
        item: String,
        answered_at: i64,
        rating: Rating,
    }

    #[derive(Debug, Deserialize)]
    struct SharedCompletion {
        lesson: String,
        completed_at: i64,
        duration_ms: i64,
    }

    #[derive(Debug, Deserialize)]
    struct SharedSkip {
        lesson: String,
        skipped_at: i64,
    }

    #[derive(Debug, Deserialize)]
    struct SharedExpected {
        due: Vec<String>,
        new: Vec<String>,
        new_count: usize,
        next_lesson: Option<String>,
    }

    /// Runs the shared device-and-server lesson unlocking and offering cases in
    /// `tests/lessons_plan.json`, which the frontend tests check against `local.ts` too.
    #[test]
    fn matches_the_lesson_cases_shared_with_the_app() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/lessons_plan.json");
        let cases: Vec<SharedCase> =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(cases.len() >= 10);

        for case in cases {
            let store = Store::in_memory().unwrap();
            let attempts: Vec<Attempt> = case
                .attempts
                .iter()
                .enumerate()
                .map(|(i, a)| Attempt {
                    id: format!("attempt-{i:08}"),
                    item: a.item.clone(),
                    answered_at: a.answered_at,
                    duration_ms: 10_000,
                    rating: a.rating,
                    response: None,
                    seed: None,
                })
                .collect();
            store.record(&attempts, case.now).unwrap();
            let completions: Vec<LessonCompletion> = case
                .lesson_completions
                .iter()
                .enumerate()
                .map(|(i, c)| LessonCompletion {
                    id: format!("complete-{i:08}"),
                    lesson: c.lesson.clone(),
                    completed_at: c.completed_at,
                    duration_ms: c.duration_ms,
                })
                .collect();
            store
                .record_lesson_completions(&completions, case.now)
                .unwrap();
            let skips: Vec<LessonSkip> = case
                .lesson_skips
                .iter()
                .enumerate()
                .map(|(i, s)| LessonSkip {
                    id: format!("skipping-{i:08}"),
                    lesson: s.lesson.clone(),
                    skipped_at: s.skipped_at,
                })
                .collect();
            store.record_lesson_skips(&skips, case.now).unwrap();

            let clock = Clock {
                now: case.now,
                utc_offset_minutes: case.utc_offset_minutes,
            };
            let kept_apart: BTreeSet<TrackId> = case.kept_apart.iter().cloned().collect();
            let mut apart_keys: BTreeMap<String, TrackId> = BTreeMap::new();
            for item in &case.items {
                if kept_apart.contains(&item.track) {
                    apart_keys.insert(item.key.clone(), item.track.clone());
                }
            }
            for lesson in &case.lessons {
                if kept_apart.contains(&lesson.track) {
                    apart_keys.insert(lesson.key.clone(), lesson.track.clone());
                }
            }

            let progress_of = |counts: &dyn Fn(&str) -> bool| {
                let today = store.activity_of(clock.day_start(), counts).unwrap();
                let week = store.activity_of(clock.week_start(), counts).unwrap();
                Progress {
                    reviews_today: today.reviews,
                    new_today: today.new,
                    lessons_today: today.lessons,
                    minutes_this_week: (week.ms / 60_000) as u32,
                }
            };
            let shared_progress = progress_of(&|key| !apart_keys.contains_key(key));
            let apart_progress: BTreeMap<TrackId, Progress> = kept_apart
                .iter()
                .map(|track| {
                    let progress = progress_of(&|key| apart_keys.get(key) == Some(track));
                    (track.clone(), progress)
                })
                .collect();

            if let Some(expected_minutes) = case.expected_shared_minutes {
                assert_eq!(
                    shared_progress.minutes_this_week, expected_minutes,
                    "case {:?}: shared minutes",
                    case.name
                );
            }
            if let Some(expected_apart) = &case.expected_apart_minutes {
                for (track, expected_minutes) in expected_apart {
                    assert_eq!(
                        apart_progress[track].minutes_this_week, *expected_minutes,
                        "case {:?}: apart minutes for {track}",
                        case.name
                    );
                }
            }

            let schedules = store.schedules().unwrap();
            let completions_map = store.lesson_completions_by_lesson().unwrap();
            let skips_map = store.lesson_skips_by_lesson().unwrap();
            let limits = Limits {
                daily_reviews: case.limits.daily_reviews,
                daily_new: case.limits.daily_new,
                daily_lessons: case.limits.daily_lessons,
                weekly_minutes: case.limits.weekly_minutes,
                retention: case.limits.retention,
            };
            let empty_skills = Vec::new();
            let item_refs: Vec<ItemRef<'_>> = case
                .items
                .iter()
                .map(|item| ItemRef {
                    key: &item.key,
                    track: &item.track,
                    skills: &empty_skills,
                    lesson: item.lesson.as_deref(),
                })
                .collect();
            let lesson_refs: Vec<LessonPlanRef<'_>> = case
                .lessons
                .iter()
                .map(|lesson| LessonPlanRef {
                    key: &lesson.key,
                    track: &lesson.track,
                    requires: &lesson.requires,
                })
                .collect();

            let shared_items: Vec<ItemRef<'_>> = item_refs
                .iter()
                .copied()
                .filter(|item| !kept_apart.contains(item.track))
                .collect();
            let shared_lessons: Vec<LessonPlanRef<'_>> = lesson_refs
                .iter()
                .copied()
                .filter(|lesson| !kept_apart.contains(lesson.track))
                .collect();
            let mut plans = plan(
                &shared_items,
                &shared_lessons,
                &schedules,
                &BTreeMap::new(),
                &BTreeMap::new(),
                &completions_map,
                &skips_map,
                shared_progress,
                limits,
                &[],
                store.scheduler(),
                clock,
            );
            for (track, progress) in &apart_progress {
                let track_items: Vec<ItemRef<'_>> = item_refs
                    .iter()
                    .copied()
                    .filter(|item| item.track == track)
                    .collect();
                let track_lessons: Vec<LessonPlanRef<'_>> = lesson_refs
                    .iter()
                    .copied()
                    .filter(|lesson| lesson.track == track)
                    .collect();
                plans.extend(plan(
                    &track_items,
                    &track_lessons,
                    &schedules,
                    &BTreeMap::new(),
                    &BTreeMap::new(),
                    &completions_map,
                    &skips_map,
                    *progress,
                    limits,
                    &[],
                    store.scheduler(),
                    clock,
                ));
            }

            let empty = TrackPlan::default();
            for (track, expected) in &case.expected {
                let actual = plans.get(track).unwrap_or(&empty);
                assert_eq!(
                    actual.due, expected.due,
                    "case {:?}, track {track}: due",
                    case.name
                );
                assert_eq!(
                    actual.new, expected.new,
                    "case {:?}, track {track}: new",
                    case.name
                );
                assert_eq!(
                    actual.new_count(),
                    expected.new_count,
                    "case {:?}, track {track}: new_count",
                    case.name
                );
                assert_eq!(
                    actual.next_lesson, expected.next_lesson,
                    "case {:?}, track {track}: next_lesson",
                    case.name
                );
            }
        }
    }
}
