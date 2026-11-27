//! How well each skill is known, in two measures. Mastery is the chance of recalling its taught
//! items now, on average, counting items never attempted as not known at all, and retired ones as
//! known for good; an item whose lesson hasn't been done isn't taught yet, so it's left out.
//! Coverage is how much of the skill has been taught and then recalled: the share of its topics
//! covered, or for a skill without topics, the share of its items answered right.
//!
//! Kept simple so it can grow, such as by weighting items by difficulty.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::plan::ItemRef;
use crate::schedule::{DAY_MS, ItemSchedule, Rating, Scheduler};
use crate::store::{Attempt, LessonCompletion, Retirement, RetirementChange, standings};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SkillMastery {
    pub skill: String,
    /// The average chance of recalling its taught items, from 0 to 1.
    pub mastery: f64,
    /// How much of it has been taught and then recalled, from 0 to 1.
    pub coverage: f64,
    pub items: usize,
    /// How many of its items have been attempted.
    pub attempted: usize,
    /// How many topics its outline has, or 0 for a skill without one.
    pub topics: usize,
    /// How many of its topics are covered, or for a skill without topics, how many of its items
    /// have been answered right.
    pub covered: usize,
}

impl SkillMastery {
    /// A skill with nothing to show: no items, and no topics covered.
    pub fn none(skill: &str) -> Self {
        Self {
            skill: skill.to_owned(),
            mastery: 0.0,
            coverage: 0.0,
            items: 0,
            attempted: 0,
            topics: 0,
            covered: 0,
        }
    }

    /// The lower of coverage and mastery, for telling which skills are weakest: one barely
    /// covered is as weak as one barely recalled.
    pub fn weakest_measure(&self) -> f64 {
        self.mastery.min(self.coverage)
    }
}

/// What coverage needs from the packs: each skill's topics, and the topic each lesson teaches.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Outline {
    /// The topics' ids of each skill with an outline, by the skill's id.
    pub topics: BTreeMap<String, BTreeSet<String>>,
    /// The topic each lesson that names one teaches, as (skill, topic), by the lesson's
    /// `pack/lesson` key.
    pub lessons: BTreeMap<String, (String, String)>,
}

/// The learner's log, as mastery and coverage need it, each part in the order it was made.
#[derive(Debug, Clone, Copy)]
pub struct Log<'a> {
    pub attempts: &'a [Attempt],
    pub retirements: &'a [RetirementChange],
    pub lesson_completions: &'a [LessonCompletion],
}

/// Mastery and coverage of every skill the items have or the outline gives topics, in order of
/// the skills' ids, as they are at `now`. Learner's days, for when a lesson's items count
/// towards covering its topic, begin `utc_offset_minutes` ahead of UTC's.
pub fn mastery(
    items: &[ItemRef<'_>],
    outline: &Outline,
    log: Log<'_>,
    scheduler: &Scheduler,
    now: i64,
    utc_offset_minutes: i32,
) -> Vec<SkillMastery> {
    history(items, outline, log, scheduler, &[now], utc_offset_minutes)
        .pop()
        .expect("one time, so one moment")
}

/// Mastery and coverage of every skill as they were at each of `times`, worked out from what
/// had been done by then, for showing how they've changed.
pub fn history(
    items: &[ItemRef<'_>],
    outline: &Outline,
    log: Log<'_>,
    scheduler: &Scheduler,
    times: &[i64],
    utc_offset_minutes: i32,
) -> Vec<Vec<SkillMastery>> {
    let mut by_item: BTreeMap<&str, Vec<&Attempt>> = BTreeMap::new();
    for attempt in log.attempts {
        by_item.entry(&attempt.item).or_default().push(attempt);
    }
    let day = |at: i64| (at + i64::from(utc_offset_minutes) * 60 * 1000).div_euclid(DAY_MS);
    times
        .iter()
        .map(|&at| {
            let schedules: BTreeMap<&str, ItemSchedule> = by_item
                .iter()
                .filter_map(|(item, attempts)| {
                    let before = attempts
                        .iter()
                        .filter(|a| a.answered_at <= at)
                        .map(|a| (a.answered_at, a.rating));
                    scheduler.replay(before).map(|schedule| (*item, schedule))
                })
                .collect();
            let retirements = standings(log.retirements, at);
            // When each item was last answered right, counting a retired item as answered right
            // when it was retired.
            let last_right = |key: &str| -> Option<i64> {
                let answered = by_item.get(key).and_then(|attempts| {
                    attempts
                        .iter()
                        .filter(|a| a.answered_at <= at && a.rating != Rating::Again)
                        .map(|a| a.answered_at)
                        .max()
                });
                let retired = match retirements.get(key) {
                    Some(Retirement::Retired { at }) => Some(*at),
                    _ => None,
                };
                answered.max(retired)
            };
            let mut first_done: BTreeMap<&str, i64> = BTreeMap::new();
            for completion in log.lesson_completions {
                if completion.completed_at <= at {
                    first_done
                        .entry(&completion.lesson)
                        .and_modify(|first| *first = (*first).min(completion.completed_at))
                        .or_insert(completion.completed_at);
                }
            }
            // The lessons whose topics are covered: done, and with an item of theirs answered
            // right on a later day than they were first done.
            let lessons_covered: BTreeSet<&str> = items
                .iter()
                .filter_map(|item| {
                    let lesson = item.lesson?;
                    let done = *first_done.get(lesson)?;
                    let right = last_right(item.key)?;
                    (day(right) > day(done)).then_some(lesson)
                })
                .collect();
            let topics_covered: BTreeSet<(&str, &str)> = lessons_covered
                .iter()
                .filter_map(|lesson| outline.lessons.get(*lesson))
                .map(|(skill, topic)| (skill.as_str(), topic.as_str()))
                .collect();

            #[derive(Default)]
            struct Tally {
                recall: f64,
                taught: usize,
                items: usize,
                attempted: usize,
                right: usize,
            }
            let mut skills: BTreeMap<&str, Tally> = outline
                .topics
                .keys()
                .map(|skill| (skill.as_str(), Tally::default()))
                .collect();
            for item in items {
                let schedule = schedules.get(item.key);
                let retired = retirements
                    .get(item.key)
                    .is_some_and(|retirement| retirement.is_retired());
                let taught = schedule.is_some()
                    || retired
                    || item
                        .lesson
                        .is_none_or(|lesson| first_done.contains_key(lesson));
                let recall = match schedule {
                    _ if retired => 1.0,
                    Some(schedule) => scheduler.recall(schedule, at),
                    None => 0.0,
                };
                let right = last_right(item.key).is_some();
                for skill in item.skills {
                    let tally = skills.entry(skill).or_default();
                    tally.items += 1;
                    tally.attempted += usize::from(schedule.is_some());
                    tally.right += usize::from(right);
                    if taught {
                        tally.recall += recall;
                        tally.taught += 1;
                    }
                }
            }
            skills
                .into_iter()
                .map(|(skill, tally)| {
                    let topics = outline.topics.get(skill).map_or(0, BTreeSet::len);
                    let (covered, out_of) = if topics > 0 {
                        let covered = outline.topics[skill]
                            .iter()
                            .filter(|topic| topics_covered.contains(&(skill, topic.as_str())))
                            .count();
                        (covered, topics)
                    } else {
                        (tally.right, tally.items)
                    };
                    SkillMastery {
                        skill: skill.to_owned(),
                        mastery: share(tally.recall, tally.taught),
                        coverage: share(covered as f64, out_of),
                        items: tally.items,
                        attempted: tally.attempted,
                        topics,
                        covered,
                    }
                })
                .collect()
        })
        .collect()
}

fn share(part: f64, whole: usize) -> f64 {
    if whole == 0 { 0.0 } else { part / whole as f64 }
}

#[cfg(test)]
mod tests {
    use workshop_tracks::TrackId;

    use super::*;
    use crate::schedule::DAY_MS;

    /// 2026-09-21 at 12:00 UTC.
    const NOW: i64 = 1_789_992_000_000;

    fn attempt(id: &str, item: &str, at: i64, rating: Rating) -> Attempt {
        Attempt {
            id: id.to_owned(),
            item: item.to_owned(),
            answered_at: at,
            duration_ms: 1000,
            rating,
            response: None,
            seed: None,
        }
    }

    fn completion(id: &str, lesson: &str, at: i64) -> LessonCompletion {
        LessonCompletion {
            id: id.to_owned(),
            lesson: lesson.to_owned(),
            completed_at: at,
            duration_ms: 60_000,
        }
    }

    fn log<'a>(
        attempts: &'a [Attempt],
        retirements: &'a [RetirementChange],
        lesson_completions: &'a [LessonCompletion],
    ) -> Log<'a> {
        Log {
            attempts,
            retirements,
            lesson_completions,
        }
    }

    fn at_utc(
        items: &[ItemRef<'_>],
        outline: &Outline,
        log: Log<'_>,
        now: i64,
    ) -> Vec<SkillMastery> {
        mastery(items, outline, log, &Scheduler::default(), now, 0)
    }

    #[test]
    fn averages_recall_over_a_skills_items() {
        let scheduler = Scheduler::default();
        let both = vec!["sums".to_owned(), "speed".to_owned()];
        let sums = vec!["sums".to_owned()];
        let track = TrackId::MentalMaths;
        let items = [
            ItemRef {
                key: "p/a",
                track: &track,
                skills: &both,
                lesson: None,
            },
            ItemRef {
                key: "p/b",
                track: &track,
                skills: &sums,
                lesson: None,
            },
        ];
        let attempts = [attempt("1", "p/a", NOW - DAY_MS, Rating::Good)];
        let mastery = at_utc(&items, &Outline::default(), log(&attempts, &[], &[]), NOW);
        let seen = scheduler.review(None, NOW - DAY_MS, Rating::Good);
        let recall = scheduler.recall(&seen, NOW);
        assert_eq!(mastery[0].skill, "speed");
        assert_eq!(mastery[0].mastery, recall);
        assert_eq!(mastery[1].skill, "sums");
        assert_eq!(mastery[1].mastery, recall / 2.0);
        assert_eq!((mastery[1].items, mastery[1].attempted), (2, 1));
    }

    #[test]
    fn works_out_mastery_as_it_was() {
        let scheduler = Scheduler::default();
        let sums = vec!["sums".to_owned()];
        let track = TrackId::MentalMaths;
        let items = [ItemRef {
            key: "p/a",
            track: &track,
            skills: &sums,
            lesson: None,
        }];
        let attempts = [
            attempt("1", "p/a", NOW - 10 * DAY_MS, Rating::Good),
            attempt("2", "p/a", NOW - DAY_MS, Rating::Good),
        ];
        let history = history(
            &items,
            &Outline::default(),
            log(&attempts, &[], &[]),
            &scheduler,
            &[NOW - 20 * DAY_MS, NOW - 5 * DAY_MS, NOW],
            0,
        );
        assert_eq!(history[0][0].mastery, 0.0);
        assert_eq!(history[0][0].coverage, 0.0);
        let once = scheduler
            .replay([(NOW - 10 * DAY_MS, Rating::Good)])
            .unwrap();
        assert_eq!(
            history[1][0].mastery,
            scheduler.recall(&once, NOW - 5 * DAY_MS)
        );
        assert_eq!(history[1][0].coverage, 1.0);
        let twice = scheduler
            .replay([
                (NOW - 10 * DAY_MS, Rating::Good),
                (NOW - DAY_MS, Rating::Good),
            ])
            .unwrap();
        assert_eq!(history[2][0].mastery, scheduler.recall(&twice, NOW));
    }

    #[test]
    fn counts_a_retired_item_as_known_for_good() {
        let scheduler = Scheduler::default();
        let graphs = vec!["graphs".to_owned()];
        let track = TrackId::Coding;
        let items = [
            ItemRef {
                key: "p/retired",
                track: &track,
                skills: &graphs,
                lesson: None,
            },
            ItemRef {
                key: "p/kept",
                track: &track,
                skills: &graphs,
                lesson: None,
            },
        ];
        let solved_at = NOW - 100 * DAY_MS;
        let solved = scheduler.review(None, solved_at, Rating::Easy);
        let attempts = [
            attempt("1", "p/retired", solved_at, Rating::Easy),
            attempt("2", "p/kept", solved_at, Rating::Easy),
        ];
        let changes = [RetirementChange {
            id: "retirement-1".to_owned(),
            item: "p/retired".to_owned(),
            at: solved_at,
            retired: true,
        }];
        let outline = Outline::default();
        let mastery = at_utc(&items, &outline, log(&attempts, &changes, &[]), NOW);
        let faded = scheduler.recall(&solved, NOW);
        assert!(faded < 0.9);
        assert_eq!(mastery[0].mastery, (1.0 + faded) / 2.0);
        assert_eq!(mastery[0].attempted, 2);

        // Before it was retired, it counts as its recall did.
        let history = history(
            &items,
            &outline,
            log(&attempts, &changes, &[]),
            &scheduler,
            &[solved_at - 1, NOW],
            0,
        );
        assert_eq!(history[0][0].mastery, 0.0);
        assert_eq!(history[1][0].mastery, (1.0 + faded) / 2.0);
    }

    #[test]
    fn leaves_out_items_whose_lesson_isnt_done() {
        let scheduler = Scheduler::default();
        let heaps = vec!["heaps".to_owned()];
        let track = TrackId::Review;
        let items = [
            ItemRef {
                key: "p/plain",
                track: &track,
                skills: &heaps,
                lesson: None,
            },
            ItemRef {
                key: "p/taught",
                track: &track,
                skills: &heaps,
                lesson: Some("p/lesson"),
            },
        ];
        let attempts = [attempt("1", "p/plain", NOW - DAY_MS, Rating::Good)];
        let recall = scheduler.recall(&scheduler.review(None, NOW - DAY_MS, Rating::Good), NOW);
        let outline = Outline::default();

        // The lesson isn't done, so its item isn't taught yet, and doesn't count as unknown.
        let before = at_utc(&items, &outline, log(&attempts, &[], &[]), NOW);
        assert_eq!(before[0].mastery, recall);
        assert_eq!((before[0].items, before[0].attempted), (2, 1));

        // Once it's done, its item counts, as not known until it's attempted.
        let done = [completion("c", "p/lesson", NOW - 2 * DAY_MS)];
        let after = at_utc(&items, &outline, log(&attempts, &[], &done), NOW);
        assert_eq!(after[0].mastery, recall / 2.0);

        // An item attempted before its lesson was done still counts as it's known.
        let early = [
            attempts[0].clone(),
            attempt("2", "p/taught", NOW - DAY_MS, Rating::Good),
        ];
        let attempted = at_utc(&items, &outline, log(&early, &[], &[]), NOW);
        assert_eq!(attempted[0].mastery, recall);
    }

    #[test]
    fn covers_a_skill_without_topics_by_its_items_answered_right() {
        let sums = vec!["sums".to_owned()];
        let track = TrackId::MentalMaths;
        let keys = ["p/a", "p/b", "p/c", "p/d"];
        let items: Vec<ItemRef<'_>> = keys
            .iter()
            .map(|key| ItemRef {
                key,
                track: &track,
                skills: &sums,
                lesson: None,
            })
            .collect();
        let attempts = [
            // Wrong, then right: answered right.
            attempt("1", "p/a", NOW - 3 * DAY_MS, Rating::Again),
            attempt("2", "p/a", NOW - 2 * DAY_MS, Rating::Hard),
            // Only ever wrong: not.
            attempt("3", "p/b", NOW - 2 * DAY_MS, Rating::Again),
            // Retired, which counts as answered right.
            attempt("4", "p/c", NOW - 2 * DAY_MS, Rating::Again),
        ];
        let changes = [RetirementChange {
            id: "retire-c".to_owned(),
            item: "p/c".to_owned(),
            at: NOW - DAY_MS,
            retired: true,
        }];
        let outline = Outline::default();
        let skills = at_utc(&items, &outline, log(&attempts, &changes, &[]), NOW);
        assert_eq!(skills[0].topics, 0);
        assert_eq!(skills[0].covered, 2);
        assert_eq!(skills[0].coverage, 0.5);

        // Brought back, it's no longer counted as answered right.
        let back = [
            changes[0].clone(),
            RetirementChange {
                id: "back-c".to_owned(),
                item: "p/c".to_owned(),
                at: NOW - 1000,
                retired: false,
            },
        ];
        let skills = at_utc(&items, &outline, log(&attempts, &back, &[]), NOW);
        assert_eq!(skills[0].coverage, 0.25);

        // No items at all: nothing covered.
        let none = at_utc(&[], &outline, log(&[], &[], &[]), NOW);
        assert!(none.is_empty());
    }

    #[test]
    fn covers_a_topic_once_its_lesson_is_done_and_recalled_on_a_later_day() {
        let os = vec!["os".to_owned()];
        let track = TrackId::Review;
        let items = [
            ItemRef {
                key: "p/fork-card",
                track: &track,
                skills: &os,
                lesson: Some("p/processes"),
            },
            ItemRef {
                key: "p/exec-card",
                track: &track,
                skills: &os,
                lesson: Some("p/processes"),
            },
            ItemRef {
                key: "p/paging-card",
                track: &track,
                skills: &os,
                lesson: Some("p/virtual-memory"),
            },
            // An item with no lesson doesn't cover a topic, however well it's known.
            ItemRef {
                key: "p/loose-card",
                track: &track,
                skills: &os,
                lesson: None,
            },
        ];
        let outline = Outline {
            topics: BTreeMap::from([(
                "os".to_owned(),
                BTreeSet::from([
                    "processes".to_owned(),
                    "virtual-memory".to_owned(),
                    "scheduling".to_owned(),
                    "file-systems".to_owned(),
                ]),
            )]),
            lessons: BTreeMap::from([
                (
                    "p/processes".to_owned(),
                    ("os".to_owned(), "processes".to_owned()),
                ),
                (
                    "p/virtual-memory".to_owned(),
                    ("os".to_owned(), "virtual-memory".to_owned()),
                ),
            ]),
        };
        let day_start = NOW - 12 * 60 * 60 * 1000;
        let lesson_done = day_start - DAY_MS + 9 * 60 * 60 * 1000;
        let done = [
            completion("c1", "p/processes", lesson_done),
            // Done again today: the first time is what counts.
            completion("c2", "p/processes", NOW - 1000),
            completion("c3", "p/virtual-memory", lesson_done),
        ];
        let loose = attempt("0", "p/loose-card", lesson_done, Rating::Easy);

        // Done, but none of its items answered yet: not covered.
        let skills = at_utc(
            &items,
            &outline,
            log(std::slice::from_ref(&loose), &[], &done),
            NOW,
        );
        assert_eq!((skills[0].topics, skills[0].covered), (4, 0));
        assert_eq!(skills[0].coverage, 0.0);

        // Answered right the same day the lesson was first done: not yet.
        let same_day = [
            loose.clone(),
            attempt("1", "p/fork-card", lesson_done + 60_000, Rating::Good),
        ];
        let skills = at_utc(&items, &outline, log(&same_day, &[], &done), NOW);
        assert_eq!(skills[0].covered, 0);

        // Answered right on a later day: covered. Answered wrong doesn't count.
        let later = [
            same_day[0].clone(),
            same_day[1].clone(),
            attempt("2", "p/exec-card", day_start + 1000, Rating::Hard),
            attempt("3", "p/paging-card", day_start + 1000, Rating::Again),
        ];
        let skills = at_utc(&items, &outline, log(&later, &[], &done), NOW);
        assert_eq!(skills[0].covered, 1);
        assert_eq!(skills[0].coverage, 0.25);

        // A retired item counts as answered right when it was retired.
        let retired = [RetirementChange {
            id: "3".to_owned(),
            item: "p/paging-card".to_owned(),
            at: day_start + 1000,
            retired: true,
        }];
        let skills = at_utc(&items, &outline, log(&later, &retired, &done), NOW);
        assert_eq!(skills[0].covered, 2);
        assert_eq!(skills[0].coverage, 0.5);

        // The learner's day decides what's later: an hour behind UTC, the lesson and the answer
        // just after UTC's midnight were on the same day.
        let behind = mastery(
            &items,
            &outline,
            log(&later, &[], &done),
            &Scheduler::default(),
            NOW,
            -60,
        );
        assert_eq!(behind[0].covered, 0);

        // As it was before the lesson was done, nothing was covered.
        let history = history(
            &items,
            &outline,
            log(&later, &retired, &done),
            &Scheduler::default(),
            &[lesson_done - 1, NOW],
            0,
        );
        assert_eq!(history[0][0].covered, 0);
        assert_eq!(history[1][0].covered, 2);
    }

    #[test]
    fn includes_a_skill_with_topics_and_no_items() {
        let outline = Outline {
            topics: BTreeMap::from([(
                "networks".to_owned(),
                BTreeSet::from(["routing".to_owned()]),
            )]),
            lessons: BTreeMap::new(),
        };
        let skills = at_utc(&[], &outline, log(&[], &[], &[]), NOW);
        assert_eq!(
            skills,
            [SkillMastery {
                topics: 1,
                ..SkillMastery::none("networks")
            }]
        );
    }
}
