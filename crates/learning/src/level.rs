//! How hard a skill's problems should be: a level from 1 to 5, on the same scale as the
//! difficulty packs give items, that rises as problems are found easy and falls as they're
//! forgotten, for the author to write new problems at.

use std::collections::BTreeMap;
use std::ops::RangeInclusive;

use serde::Serialize;

use crate::schedule::Rating;
use crate::store::Attempt;

/// The levels, as packs' difficulties go: 1 is a warm-up and 5 among the hardest.
pub const LEVELS: RangeInclusive<u8> = 1..=5;

/// Where a skill starts, and the difficulty of a problem whose pack doesn't give one.
pub const MIDDLE: u8 = 3;

/// A skill's level, and the ratings it came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SkillLevel {
    pub level: u8,
    /// How many of its problems were rated easy, and forgotten.
    pub easy: usize,
    pub again: usize,
}

/// A problem, as levels need it: its skills and how hard it is.
#[derive(Debug, Clone, Copy)]
pub struct Problem<'a> {
    pub skills: &'a [String],
    pub difficulty: Option<u8>,
}

/// Each skill's level, from the attempts at problems, which must be in the order they were
/// made. `problem` gives the problem an attempt is at, or None for an attempt at anything else.
///
/// A skill starts at the middle. A problem rated easy lifts its skills to one above its
/// difficulty, if that's higher, and one forgotten lowers them to one below it, if that's
/// lower, so a level settles just above what's found easy and below what's forgotten. Only
/// skills with an attempt at a problem have a level.
pub fn levels<'a>(
    attempts: &[Attempt],
    problem: impl Fn(&str) -> Option<Problem<'a>>,
) -> BTreeMap<String, SkillLevel> {
    let mut levels: BTreeMap<String, SkillLevel> = BTreeMap::new();
    for attempt in attempts {
        let Some(problem) = problem(&attempt.item) else {
            continue;
        };
        let difficulty = problem
            .difficulty
            .unwrap_or(MIDDLE)
            .clamp(*LEVELS.start(), *LEVELS.end());
        for skill in problem.skills {
            let level = levels.entry(skill.clone()).or_insert(SkillLevel {
                level: MIDDLE,
                easy: 0,
                again: 0,
            });
            match attempt.rating {
                Rating::Easy => {
                    level.level = level.level.max(difficulty + 1).min(*LEVELS.end());
                    level.easy += 1;
                }
                Rating::Again => {
                    level.level = level.level.min(difficulty - 1).max(*LEVELS.start());
                    level.again += 1;
                }
                Rating::Hard | Rating::Good => {}
            }
        }
    }
    levels
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attempt(item: &str, rating: Rating) -> Attempt {
        Attempt {
            id: format!("attempt-{item}"),
            item: item.to_owned(),
            answered_at: 1_790_000_000_000,
            duration_ms: 1000,
            rating,
            response: None,
            seed: None,
        }
    }

    #[test]
    fn rises_with_easy_problems_and_falls_with_forgotten_ones() {
        let graphs = vec!["graphs".to_owned()];
        let both = vec!["graphs".to_owned(), "heaps".to_owned()];
        let problem = |item: &str| match item {
            "p/warm-up" => Some(Problem {
                skills: &graphs,
                difficulty: Some(1),
            }),
            "p/usual" => Some(Problem {
                skills: &both,
                difficulty: None,
            }),
            "p/hard" => Some(Problem {
                skills: &graphs,
                difficulty: Some(5),
            }),
            _ => None,
        };
        let level = |attempts: &[Attempt]| levels(attempts, problem);

        // A warm-up found easy says nothing new, at the middle.
        assert_eq!(
            level(&[attempt("p/warm-up", Rating::Easy)])["graphs"].level,
            3
        );
        // A middling one found easy lifts both its skills, and the hardest can't go higher.
        let lifted = level(&[
            attempt("p/usual", Rating::Easy),
            attempt("p/hard", Rating::Easy),
        ]);
        assert_eq!(lifted["graphs"].level, 5);
        assert_eq!(lifted["graphs"].easy, 2);
        assert_eq!(lifted["heaps"].level, 4);
        // Forgetting a hard one brings it down to just below it; a warm-up, to the bottom.
        assert_eq!(
            level(&[
                attempt("p/usual", Rating::Easy),
                attempt("p/hard", Rating::Again),
            ])["graphs"]
                .level,
            4
        );
        let fallen = level(&[
            attempt("p/warm-up", Rating::Again),
            attempt("p/warm-up", Rating::Again),
        ]);
        assert_eq!(
            fallen["graphs"],
            SkillLevel {
                level: 1,
                easy: 0,
                again: 2,
            }
        );
        // Good and hard leave it, and attempts at anything else don't count.
        let steady = level(&[
            attempt("p/usual", Rating::Good),
            attempt("p/card", Rating::Easy),
        ]);
        assert_eq!(steady["graphs"].level, 3);
        assert!(!steady.contains_key("card"));
    }
}
