//! Progress towards the packs' goals: each goal's skills, how much of each is covered and how
//! well it's recalled against the goal's targets, how that's changed over the last few weeks, how
//! long is left if the goal has a date, and what's weakest.

use std::collections::BTreeMap;

use serde::Serialize;
use workshop_learning::schedule::DAY_MS;
use workshop_learning::{Clock, ItemRef, Log, Mistake, Outline, Scheduler, SkillMastery};
use workshop_pack::{Goal, Pack};

/// How many weeks back the trend goes.
const TREND_WEEKS: i64 = 8;

#[derive(Debug, Serialize)]
pub struct GoalProgress {
    pub id: String,
    pub name: String,
    /// The pack it's from, by name.
    pub pack: String,
    /// The recall each skill should reach, from 0 to 1.
    pub target: f64,
    /// The coverage each skill should reach, from 0 to 1.
    pub coverage_target: f64,
    /// When it's wanted by, as the pack writes it, and how many days that is from today.
    pub by: Option<String>,
    pub days_left: Option<i64>,
    /// How far the goal is towards its targets, from 0 to 1: the average over its skills of
    /// their coverage and recall, each counting for no more than its target.
    pub progress: f64,
    pub skills: Vec<GoalSkill>,
    /// The goal's average coverage and recall as they were each week, oldest first, ending now.
    pub trend: Vec<Point>,
    /// The skills furthest from the targets, by the lower of their coverage and recall, weakest
    /// first, of those not there yet.
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
    /// Whether both its coverage and its recall have reached the goal's targets.
    pub met: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Point {
    /// In milliseconds since 1970.
    pub at: i64,
    /// Average recall.
    pub mastery: f64,
    pub coverage: f64,
}

/// Whether a skill has reached a goal's targets: coverage and recall both.
fn met(goal: &Goal, skill: &SkillMastery) -> bool {
    skill.coverage >= goal.coverage && skill.mastery >= goal.mastery
}

/// Every goal in the packs, with how it's going at `clock`. `items` are the items there's
/// practice of, and `log` everything done, in the order it was done.
#[allow(clippy::too_many_arguments)]
pub fn progress(
    packs: &[Pack],
    items: &[ItemRef<'_>],
    outline: &Outline,
    log: Log<'_>,
    mistakes: &[Mistake],
    scheduler: &Scheduler,
    clock: Clock,
) -> Vec<GoalProgress> {
    let times: Vec<i64> = (0..=TREND_WEEKS)
        .rev()
        .map(|weeks| clock.now - weeks * 7 * DAY_MS)
        .collect();
    let history = workshop_learning::history(
        items,
        outline,
        log,
        scheduler,
        &times,
        clock.utc_offset_minutes,
    );
    let at = |index: usize| -> BTreeMap<&str, &SkillMastery> {
        history[index]
            .iter()
            .map(|mastery| (mastery.skill.as_str(), mastery))
            .collect()
    };
    let now_index = times.len() - 1;
    let current = at(now_index);
    let items_by_key = crate::mistakes::items_by_key(packs);
    let today = clock.local_day();
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
                    let mastery = current
                        .get(id.as_str())
                        .map_or_else(|| SkillMastery::none(id), |mastery| (*mastery).clone());
                    GoalSkill {
                        id: id.clone(),
                        name: name(id),
                        met: met(goal, &mastery),
                        mastery,
                    }
                })
                .collect();
            let average = |masteries: &BTreeMap<&str, &SkillMastery>,
                           measure: fn(&SkillMastery) -> f64| {
                goal.skills
                    .iter()
                    .map(|id| masteries.get(id.as_str()).map_or(0.0, |m| measure(m)))
                    .sum::<f64>()
                    / goal.skills.len() as f64
            };
            let trend = times
                .iter()
                .enumerate()
                .map(|(index, &at_time)| {
                    let masteries = at(index);
                    Point {
                        at: at_time,
                        mastery: average(&masteries, |m| m.mastery),
                        coverage: average(&masteries, |m| m.coverage),
                    }
                })
                .collect();
            let progress = skills
                .iter()
                .map(|skill| {
                    let coverage = (skill.mastery.coverage / goal.coverage).min(1.0);
                    let recall = (skill.mastery.mastery / goal.mastery).min(1.0);
                    (coverage + recall) / 2.0
                })
                .sum::<f64>()
                / skills.len() as f64;
            let mut weakest: Vec<&GoalSkill> = skills.iter().filter(|s| !s.met).collect();
            weakest.sort_by(|a, b| {
                a.mastery
                    .weakest_measure()
                    .total_cmp(&b.mastery.weakest_measure())
            });
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
                coverage_target: goal.coverage,
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
    use workshop_learning::{Attempt, Rating};

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
            daily_lessons: 1,
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
        let goals = learning
            .goals(Clock {
                now: NOW,
                utc_offset_minutes: 0,
            })
            .unwrap();
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

    #[test]
    fn days_left_uses_the_learners_local_calendar_day() {
        let dir = tempfile::tempdir().unwrap();
        let pack_dir = dir.path().join("dated-pack");
        std::fs::create_dir_all(pack_dir.join("items")).unwrap();
        std::fs::write(
            pack_dir.join("pack.toml"),
            r#"
id = "dated"
name = "Dated"

[[skills]]
id = "s"
name = "Skill"

[[goals]]
id = "exam"
name = "Exam"
skills = ["s"]
mastery = 0.8
by = "2026-10-15"
"#,
        )
        .unwrap();
        std::fs::write(
            pack_dir.join("items/one.md"),
            "+++\nkind = \"card\"\nskills = [\"s\"]\n+++\nQ?\n\n## Answer\n\nA.\n",
        )
        .unwrap();
        let config = LearningConfig {
            packs: vec![pack_dir],
            sample_pack: false,
            daily_reviews: 40,
            daily_new: 10,
            daily_lessons: 1,
            weekly_minutes: 90,
            desired_retention: 0.9,
        };
        let learning = Learning::open(&config, dir.path()).unwrap();

        // 2026-10-14T23:30:00Z is already 2026-10-15 at UTC+02:00.
        let oct_15_utc_ms = 20_741 * DAY_MS;
        let late_oct_14_utc = oct_15_utc_ms - 30 * 60 * 1000;
        let ahead = learning
            .goals(Clock {
                now: late_oct_14_utc,
                utc_offset_minutes: 120,
            })
            .unwrap();
        assert_eq!(ahead[0].days_left, Some(0));

        // 2026-10-15T00:30:00Z is still 2026-10-14 at UTC-05:00.
        let early_oct_15_utc = oct_15_utc_ms + 30 * 60 * 1000;
        let behind = learning
            .goals(Clock {
                now: early_oct_15_utc,
                utc_offset_minutes: -300,
            })
            .unwrap();
        assert_eq!(behind[0].days_left, Some(1));
    }

    /// A pack with a skill outlined in topics, taught by a lesson with one card, and a skill
    /// without topics with one card, both in one goal with the given extra lines.
    fn outlined(dir: &std::path::Path, goal: &str) -> Learning {
        let pack_dir = dir.join("outlined");
        std::fs::create_dir_all(pack_dir.join("items")).unwrap();
        std::fs::write(
            pack_dir.join("pack.toml"),
            format!(
                r#"
id = "outlined"
name = "Outlined"

[[skills]]
id = "os"
name = "Operating systems"
topics = [
  {{ id = "processes", name = "Processes" }},
  {{ id = "paging", name = "Paging" }},
]

[[skills]]
id = "files"
name = "File systems"

[[goals]]
id = "systems"
name = "Systems"
skills = ["os", "files"]
{goal}
"#
            ),
        )
        .unwrap();
        std::fs::write(
            pack_dir.join("items/processes.md"),
            "+++\nkind = \"lesson\"\nskills = [\"os\"]\ntopic = \"os/processes\"\n[[sources]]\ntitle = \"Ref\"\nurl = \"https://example.com\"\n+++\nSummary.\n## Forking\nText.\n## Explain\nWhy?\n## Explain answer\nBecause.\n",
        )
        .unwrap();
        std::fs::write(
            pack_dir.join("items/fork.md"),
            "+++\nkind = \"card\"\nskills = [\"os\"]\nlesson = \"processes\"\n+++\nQ?\n\n## Answer\n\nA.\n",
        )
        .unwrap();
        std::fs::write(
            pack_dir.join("items/inodes.md"),
            "+++\nkind = \"card\"\nskills = [\"files\"]\n+++\nQ?\n\n## Answer\n\nA.\n",
        )
        .unwrap();
        let config = LearningConfig {
            packs: vec![pack_dir],
            sample_pack: false,
            daily_reviews: 40,
            daily_new: 10,
            daily_lessons: 1,
            weekly_minutes: 90,
            desired_retention: 0.9,
        };
        let learning = Learning::open(&config, dir).unwrap();
        learning
            .store()
            .record_lesson_completions(
                &[workshop_learning::LessonCompletion {
                    id: "done-processes".to_owned(),
                    lesson: "outlined/processes".to_owned(),
                    completed_at: NOW - 3 * DAY_MS,
                    duration_ms: 60_000,
                }],
                NOW,
            )
            .unwrap();
        let attempt = |id: &str, item: &str| Attempt {
            id: id.to_owned(),
            item: format!("outlined/{item}"),
            answered_at: NOW - 60_000,
            duration_ms: 10_000,
            rating: Rating::Easy,
            response: None,
            seed: None,
        };
        learning
            .record(
                &[
                    attempt("attempt-fork", "fork"),
                    attempt("attempt-inodes", "inodes"),
                ],
                NOW,
            )
            .unwrap();
        learning
    }

    fn utc() -> Clock {
        Clock {
            now: NOW,
            utc_offset_minutes: 0,
        }
    }

    #[test]
    fn reaches_a_goal_only_with_coverage_and_recall_both_there() {
        // Coverage defaults to the goal's mastery: half of the topics aren't enough.
        let dir = tempfile::tempdir().unwrap();
        let goals = outlined(dir.path(), "mastery = 0.5").goals(utc()).unwrap();
        let systems = &goals[0];
        assert_eq!((systems.target, systems.coverage_target), (0.5, 0.5));
        let os = &systems.skills[0];
        assert_eq!((os.mastery.topics, os.mastery.covered), (2, 1));
        assert_eq!(os.mastery.coverage, 0.5);
        assert!(os.mastery.mastery > 0.9, "{:?}", os.mastery);
        assert!(os.met);
        let files = &systems.skills[1];
        assert_eq!(files.mastery.coverage, 1.0);
        assert!(files.met);
        assert!(systems.weakest.is_empty());

        // A goal asking for more coverage than recall isn't reached by recall alone.
        let dir = tempfile::tempdir().unwrap();
        let goals = outlined(dir.path(), "mastery = 0.5\ncoverage = 0.9")
            .goals(utc())
            .unwrap();
        let systems = &goals[0];
        assert_eq!(systems.coverage_target, 0.9);
        assert!(!systems.skills[0].met);
        assert!(systems.skills[1].met);
        assert_eq!(systems.weakest, ["os"]);
        // Half way on coverage, all the way on recall.
        let expected = ((0.5 / 0.9 + 1.0) / 2.0 + 1.0) / 2.0;
        assert!(
            (systems.progress - expected).abs() < 1e-9,
            "{}",
            systems.progress
        );
        let now = systems.trend.last().unwrap();
        assert_eq!(now.coverage, 0.75);
        assert!(now.mastery > 0.9);
        assert_eq!(systems.trend[0].coverage, 0.0);
    }
}
