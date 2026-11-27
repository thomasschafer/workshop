//! How well each skill is known: the chance of recalling its items now, on average, counting
//! items never attempted as not known at all, and retired ones as known for good.
//!
//! Kept simple so it can grow, such as by weighting items by difficulty, or a goal's progress
//! from its skills' mastery.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::plan::ItemRef;
use crate::schedule::{ItemSchedule, Scheduler};
use crate::store::{Attempt, Retirement, RetirementChange, standings};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SkillMastery {
    pub skill: String,
    /// From 0 to 1.
    pub mastery: f64,
    pub items: usize,
    /// How many of its items have been attempted.
    pub attempted: usize,
}

/// Mastery of every skill the items have, in order of the skills' ids. A retired item was
/// rated easy, as a problem solved with ease, and is never reviewed again, so its recall would
/// only ever fade: it counts as recalled with certainty instead.
pub fn mastery(
    items: &[ItemRef<'_>],
    schedules: &BTreeMap<String, ItemSchedule>,
    retirements: &BTreeMap<String, Retirement>,
    scheduler: &Scheduler,
    now: i64,
) -> Vec<SkillMastery> {
    let mut skills: BTreeMap<&str, (f64, usize, usize)> = BTreeMap::new();
    for item in items {
        let retired = retirements
            .get(item.key)
            .is_some_and(|retirement| retirement.is_retired());
        let recall = schedules.get(item.key).map(|schedule| {
            if retired {
                1.0
            } else {
                scheduler.recall(schedule, now)
            }
        });
        for skill in item.skills {
            let (sum, count, attempted) = skills.entry(skill).or_default();
            *sum += recall.unwrap_or(0.0);
            *count += 1;
            *attempted += usize::from(recall.is_some());
        }
    }
    skills
        .into_iter()
        .map(|(skill, (sum, items, attempted))| SkillMastery {
            skill: skill.to_owned(),
            mastery: sum / items as f64,
            items,
            attempted,
        })
        .collect()
}

/// Mastery of every skill as it was at each of `times`, worked out from the attempts made and
/// the items retired by then, for showing how it's changed. `attempts` and `retirements` must
/// be in the order they were made.
pub fn history(
    items: &[ItemRef<'_>],
    attempts: &[Attempt],
    retirements: &[RetirementChange],
    scheduler: &Scheduler,
    times: &[i64],
) -> Vec<Vec<SkillMastery>> {
    let mut by_item: BTreeMap<&str, Vec<&Attempt>> = BTreeMap::new();
    for attempt in attempts {
        by_item.entry(&attempt.item).or_default().push(attempt);
    }
    times
        .iter()
        .map(|&at| {
            let schedules: BTreeMap<String, ItemSchedule> = by_item
                .iter()
                .filter_map(|(item, attempts)| {
                    let before = attempts
                        .iter()
                        .filter(|a| a.answered_at <= at)
                        .map(|a| (a.answered_at, a.rating));
                    scheduler
                        .replay(before)
                        .map(|schedule| ((*item).to_owned(), schedule))
                })
                .collect();
            mastery(
                items,
                &schedules,
                &standings(retirements, at),
                scheduler,
                at,
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use workshop_tracks::TrackId;

    use super::*;
    use crate::schedule::{DAY_MS, Rating};

    #[test]
    fn averages_recall_over_a_skills_items() {
        let scheduler = Scheduler::default();
        let now = 1_790_000_000_000;
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
        let seen = scheduler.review(None, now - DAY_MS, Rating::Good);
        let schedules = BTreeMap::from([("p/a".to_owned(), seen)]);
        let mastery = mastery(&items, &schedules, &BTreeMap::new(), &scheduler, now);
        let recall = scheduler.recall(&seen, now);
        assert_eq!(mastery[0].skill, "speed");
        assert_eq!(mastery[0].mastery, recall);
        assert_eq!(mastery[1].skill, "sums");
        assert_eq!(mastery[1].mastery, recall / 2.0);
        assert_eq!((mastery[1].items, mastery[1].attempted), (2, 1));
    }

    #[test]
    fn works_out_mastery_as_it_was() {
        let scheduler = Scheduler::default();
        let now = 1_790_000_000_000;
        let sums = vec!["sums".to_owned()];
        let track = TrackId::MentalMaths;
        let items = [ItemRef {
            key: "p/a",
            track: &track,
            skills: &sums,
            lesson: None,
        }];
        let attempt = |id: &str, at: i64| Attempt {
            id: id.to_owned(),
            item: "p/a".to_owned(),
            answered_at: at,
            duration_ms: 1000,
            rating: Rating::Good,
            response: None,
            seed: None,
        };
        let attempts = [attempt("1", now - 10 * DAY_MS), attempt("2", now - DAY_MS)];
        let history = history(
            &items,
            &attempts,
            &[],
            &scheduler,
            &[now - 20 * DAY_MS, now - 5 * DAY_MS, now],
        );
        assert_eq!(history[0][0].mastery, 0.0);
        let once = scheduler
            .replay([(now - 10 * DAY_MS, Rating::Good)])
            .unwrap();
        assert_eq!(
            history[1][0].mastery,
            scheduler.recall(&once, now - 5 * DAY_MS)
        );
        let twice = scheduler
            .replay([
                (now - 10 * DAY_MS, Rating::Good),
                (now - DAY_MS, Rating::Good),
            ])
            .unwrap();
        assert_eq!(history[2][0].mastery, scheduler.recall(&twice, now));
    }

    #[test]
    fn counts_a_retired_item_as_known_for_good() {
        let scheduler = Scheduler::default();
        let now = 1_790_000_000_000;
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
        let solved_at = now - 100 * DAY_MS;
        let solved = scheduler.review(None, solved_at, Rating::Easy);
        let schedules = BTreeMap::from([
            ("p/retired".to_owned(), solved),
            ("p/kept".to_owned(), solved),
        ]);
        let changes = [RetirementChange {
            id: "retirement-1".to_owned(),
            item: "p/retired".to_owned(),
            at: solved_at,
            retired: true,
        }];
        let mastery = mastery(
            &items,
            &schedules,
            &standings(&changes, now),
            &scheduler,
            now,
        );
        let faded = scheduler.recall(&solved, now);
        assert!(faded < 0.9);
        assert_eq!(mastery[0].mastery, (1.0 + faded) / 2.0);
        assert_eq!(mastery[0].attempted, 2);

        // Before it was retired, it counts as its recall did.
        let attempt = |id: &str, item: &str| Attempt {
            id: id.to_owned(),
            item: item.to_owned(),
            answered_at: solved_at,
            duration_ms: 1000,
            rating: Rating::Easy,
            response: None,
            seed: None,
        };
        let history = history(
            &items,
            &[attempt("1", "p/retired"), attempt("2", "p/kept")],
            &changes,
            &scheduler,
            &[solved_at - 1, now],
        );
        assert_eq!(history[0][0].mastery, 0.0);
        assert_eq!(history[1][0].mastery, (1.0 + faded) / 2.0);
    }
}
