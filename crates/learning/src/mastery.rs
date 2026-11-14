//! How well each skill is known: the chance of recalling its items now, on average, counting
//! items never attempted as not known at all.
//!
//! Kept simple so it can grow, such as by weighting items by difficulty, or a goal's progress
//! from its skills' mastery.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::plan::ItemRef;
use crate::schedule::{ItemSchedule, Scheduler};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SkillMastery {
    pub skill: String,
    /// From 0 to 1.
    pub mastery: f64,
    pub items: usize,
    /// How many of its items have been attempted.
    pub attempted: usize,
}

/// Mastery of every skill the items have, in order of the skills' ids.
pub fn mastery(
    items: &[ItemRef<'_>],
    schedules: &BTreeMap<String, ItemSchedule>,
    scheduler: &Scheduler,
    now: i64,
) -> Vec<SkillMastery> {
    let mut skills: BTreeMap<&str, (f64, usize, usize)> = BTreeMap::new();
    for item in items {
        let recall = schedules
            .get(item.key)
            .map(|schedule| scheduler.recall(schedule, now));
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
            },
            ItemRef {
                key: "p/b",
                track: &track,
                skills: &sums,
            },
        ];
        let seen = scheduler.review(None, now - DAY_MS, Rating::Good);
        let schedules = BTreeMap::from([("p/a".to_owned(), seen)]);
        let mastery = mastery(&items, &schedules, &scheduler, now);
        let recall = scheduler.recall(&seen, now);
        assert_eq!(mastery[0].skill, "speed");
        assert_eq!(mastery[0].mastery, recall);
        assert_eq!(mastery[1].skill, "sums");
        assert_eq!(mastery[1].mastery, recall / 2.0);
        assert_eq!((mastery[1].items, mastery[1].attempted), (2, 1));
    }
}
