//! Progress towards the packs' goals: each goal's skills, how well each is mastered against the
//! goal's target, how that's changed over the last few weeks, how long is left if the goal has
//! a date, and what's weakest.

use std::collections::BTreeMap;

use serde::Serialize;
use workshop_learning::schedule::DAY_MS;
use workshop_learning::{Attempt, ItemRef, Mistake, RetirementChange, Scheduler, SkillMastery};
use workshop_pack::Pack;

/// How many weeks back the trend goes.
const TREND_WEEKS: i64 = 8;

#[derive(Debug, Serialize)]
pub struct GoalProgress {
    pub id: String,
    pub name: String,
    /// The pack it's from, by name.
    pub pack: String,
    /// The mastery each skill should reach, from 0 to 1.
    pub target: f64,
    /// When it's wanted by, as the pack writes it, and how many days that is from today.
    pub by: Option<String>,
    pub days_left: Option<i64>,
    /// How far the goal is towards its target, from 0 to 1: the average of its skills' mastery,
    /// each counting for no more than the target.
    pub progress: f64,
    pub skills: Vec<GoalSkill>,
    /// The goal's average mastery as it was each week, oldest first, ending now.
    pub trend: Vec<Point>,
    /// The skills furthest from the target, weakest first, of those not there yet.
    pub weakest: Vec<String>,
    /// The kinds of mistake made most in the goal's skills lately, most first.
    pub mistakes: Vec<crate::mistakes::Count>,
}

#[derive(Debug, Serialize)]
pub struct GoalSkill {
    pub id: String,
    pub name: String,
    #[serde(flatten)]
    pub mastery: SkillMastery,
    /// Whether it's reached the goal's target.
    pub met: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Point {
    /// In milliseconds since 1970.
    pub at: i64,
    pub mastery: f64,
}

/// Every goal in the packs, with how it's going at `now`. `items` are the items there's
/// practice of, and `attempts` and `retirements` every attempt and retirement change, in the
/// order they were made.
#[allow(clippy::too_many_arguments)]
pub fn progress(
    packs: &[Pack],
    items: &[ItemRef<'_>],
    attempts: &[Attempt],
    retirements: &[RetirementChange],
    mistakes: &[Mistake],
    scheduler: &Scheduler,
    now: i64,
) -> Vec<GoalProgress> {
    let times: Vec<i64> = (0..=TREND_WEEKS)
        .rev()
        .map(|weeks| now - weeks * 7 * DAY_MS)
        .collect();
    let history = workshop_learning::history(items, attempts, retirements, scheduler, &times);
    let at = |index: usize| -> BTreeMap<&str, &SkillMastery> {
        history[index]
            .iter()
            .map(|mastery| (mastery.skill.as_str(), mastery))
            .collect()
    };
    let now_index = times.len() - 1;
    let current = at(now_index);
    let items_by_key = crate::mistakes::items_by_key(packs);
    let today = now.div_euclid(DAY_MS);
    packs
        .iter()
        .flat_map(|pack| pack.manifest.goals.iter().map(move |goal| (pack, goal)))
        .map(|(pack, goal)| {
            let name = |id: &str| {
                pack.manifest
                    .skills
                    .iter()
                    .find(|skill| skill.id == id)
                    .map_or_else(|| id.to_owned(), |skill| skill.name.clone())
            };
            let skills: Vec<GoalSkill> = goal
                .skills
                .iter()
                .map(|id| {
                    let mastery = current.get(id.as_str()).map_or_else(
                        || SkillMastery {
                            skill: id.clone(),
                            mastery: 0.0,
                            items: 0,
                            attempted: 0,
                        },
                        |mastery| (*mastery).clone(),
                    );
                    GoalSkill {
                        id: id.clone(),
                        name: name(id),
                        met: mastery.mastery >= goal.mastery,
                        mastery,
                    }
                })
                .collect();
            let average = |masteries: &BTreeMap<&str, &SkillMastery>| {
                goal.skills
                    .iter()
                    .map(|id| masteries.get(id.as_str()).map_or(0.0, |m| m.mastery))
                    .sum::<f64>()
                    / goal.skills.len() as f64
            };
            let trend = times
                .iter()
                .enumerate()
                .map(|(index, &at_time)| Point {
                    at: at_time,
                    mastery: average(&at(index)),
                })
                .collect();
            let progress = skills
                .iter()
                .map(|skill| (skill.mastery.mastery / goal.mastery).min(1.0))
                .sum::<f64>()
                / skills.len() as f64;
            let mut weakest: Vec<&GoalSkill> = skills.iter().filter(|s| !s.met).collect();
            weakest.sort_by(|a, b| a.mastery.mastery.total_cmp(&b.mastery.mastery));
            let in_goal: Vec<Mistake> = mistakes
                .iter()
                .filter(|mistake| {
                    items_by_key
                        .get(&mistake.mistake.item)
                        .is_some_and(|item| item.skills.iter().any(|s| goal.skills.contains(s)))
                })
                .cloned()
                .collect();
            GoalProgress {
                id: goal.id.clone(),
                name: goal.name.clone(),
                pack: pack.manifest.name.clone(),
                target: goal.mastery,
                by: goal.by.clone(),
                days_left: goal.by_day().map(|day| day - today),
                progress,
                weakest: weakest.iter().take(3).map(|s| s.id.clone()).collect(),
                mistakes: crate::mistakes::common_error_types(&in_goal),
                skills,
                trend,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use workshop_learning::Rating;

    use super::*;
    use crate::config::LearningConfig;
    use crate::learning::Learning;

    const NOW: i64 = 1_790_000_000_000;

    #[test]
    fn shows_each_goals_skills_against_its_target_and_the_trend() {
        let dir = tempfile::tempdir().unwrap();
        let config = LearningConfig {
            packs: Vec::new(),
            sample_pack: false,
            daily_reviews: 40,
            daily_new: 10,
            weekly_minutes: 90,
            desired_retention: 0.9,
        };
        let learning = Learning::open(&config, dir.path()).unwrap();
        let attempt = |id: &str, item: &str, at: i64, rating| Attempt {
            id: format!("attempt-{id}"),
            item: format!("sample/{item}"),
            answered_at: at,
            duration_ms: 10_000,
            rating,
            response: None,
            seed: None,
        };
        learning
            .record(
                &[
                    attempt("1", "times-eleven", NOW - 20 * DAY_MS, Rating::Good),
                    attempt("2", "times-eleven", NOW - DAY_MS, Rating::Good),
                    attempt("3", "squares", NOW - DAY_MS, Rating::Again),
                ],
                NOW,
            )
            .unwrap();
        let goals = learning.goals(NOW).unwrap();
        let names: Vec<&str> = goals.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Quick arithmetic",
                "Probability foundations",
                "Problem solving"
            ]
        );
        let arithmetic = &goals[0];
        assert_eq!(arithmetic.target, 0.8);
        assert_eq!(arithmetic.days_left, None);
        assert_eq!(arithmetic.skills.len(), 4);
        let multiplication = &arithmetic.skills[0];
        assert_eq!(multiplication.name, "Multiplication");
        assert!(multiplication.mastery.mastery > 0.0);
        assert!(multiplication.mastery.attempted >= 1);
        assert_eq!(arithmetic.trend.len(), TREND_WEEKS as usize + 1);
        assert_eq!(arithmetic.trend[0].mastery, 0.0);
        assert!(arithmetic.trend.last().unwrap().mastery > 0.0);
        assert!(arithmetic.progress > 0.0 && arithmetic.progress < 1.0);
        // Nothing done in division or percentages, so they're weakest.
        assert!(
            arithmetic
                .weakest
                .contains(&"arithmetic.division".to_owned())
        );
        assert!(
            !arithmetic
                .weakest
                .contains(&"arithmetic.multiplication".to_owned())
        );
        assert_eq!(arithmetic.mistakes[0].error_type, "concept-gap");
        assert_eq!(goals[1].progress, 0.0);
    }
}
