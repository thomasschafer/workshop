//! The tracks on the home screen, of which Advent of Code is one, and where each of their steps
//! leads in the app.

use serde::Serialize;
use workshop_tracks::{Priority, Step, Track, TrackId};

use crate::calendar::{days_in, is_unlocked, todays_puzzle};
use crate::language::Puzzle;

/// Where a step or a track leads in the app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Destination {
    /// Advent of Code, with this puzzle open.
    Puzzle { puzzle: Puzzle },
    /// Advent of Code's list of puzzles, to choose one.
    PuzzleList,
    /// Practising a track's short items, such as review cards.
    Practice { track: TrackId },
    /// The Coding track: one of its items, as `pack/item`, or the list of them.
    Coding { item: Option<String> },
    /// Design prompts, answered in writing and marked by the grader: one, as `pack/item`, or
    /// the list of them.
    Design { item: Option<String> },
}

/// What the Advent of Code track is worked out from.
pub struct AdventOfCode<Stars: Fn(Puzzle) -> Option<u8>> {
    /// The puzzle open when the app was last used.
    pub last: Option<Puzzle>,
    pub has_session: bool,
    /// Now, in seconds since 1970.
    pub now: u64,
    /// The stars earned on a puzzle, if they're known without asking Advent of Code.
    pub stars: Stars,
}

impl<Stars: Fn(Puzzle) -> Option<u8>> AdventOfCode<Stars> {
    /// The track, which is never empty: there's always the practice puzzle.
    pub fn track(&self) -> Track<Destination> {
        let today = todays_puzzle(self.now).and_then(|(year, day)| Puzzle::new(year, day).ok());
        let summary = match (today, self.last) {
            (Some(today), _) => format!("Day {} of {} is out", today.day, days_in(today.year)),
            (None, Some(last)) => format!("Last opened {}", label(last)),
            (None, None) => "Puzzles from every year, by voice".to_owned(),
        };
        let destination = match self.last {
            Some(puzzle) => Destination::Puzzle { puzzle },
            None => Destination::PuzzleList,
        };
        Track::built_in(
            TrackId::AdventOfCode,
            summary,
            destination,
            Some(self.next_step(today)),
        )
    }

    /// The most sensible puzzle to go to: the one left part-way through, then today's, then the
    /// day after the last one solved, and otherwise the list to choose from.
    fn next_step(&self, today: Option<Puzzle>) -> Step<Destination> {
        let solved = |puzzle: Puzzle| (self.stars)(puzzle) == Some(2);
        if let Some(last) = self.last.filter(|&p| !solved(p)) {
            return step(last, "Where you left off", Priority::Unfinished);
        }
        if self.has_session {
            if let Some(today) = today.filter(|&p| !solved(p)) {
                return step(today, "Today's puzzle", Priority::New);
            }
            let following = self
                .last
                .filter(|p| !p.is_practice() && p.day < days_in(p.year))
                .and_then(|p| Puzzle::new(p.year, p.day + 1).ok())
                .filter(|p| is_unlocked(p.year, p.day, self.now) && !solved(*p));
            if let Some(following) = following {
                return step(following, "The next puzzle", Priority::New);
            }
        } else if !solved(Puzzle::PRACTICE) {
            return step(
                Puzzle::PRACTICE,
                "Try Workshop without an Advent of Code login",
                Priority::New,
            );
        }
        Step {
            title: "Choose a puzzle".to_owned(),
            reason: "Every year's puzzles".to_owned(),
            priority: Priority::Browse,
            destination: Destination::PuzzleList,
        }
    }
}

fn step(puzzle: Puzzle, reason: &str, priority: Priority) -> Step<Destination> {
    Step {
        title: label(puzzle),
        reason: reason.to_owned(),
        priority,
        destination: Destination::Puzzle { puzzle },
    }
}

/// How a puzzle is named in the app, such as "2017 · day 4".
fn label(puzzle: Puzzle) -> String {
    if puzzle.is_practice() {
        "Practice puzzle".to_owned()
    } else {
        format!("{} · day {}", puzzle.year, puzzle.day)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::calendar::unlock_time;

    fn puzzle(year: u16, day: u8) -> Puzzle {
        Puzzle::new(year, day).unwrap()
    }

    /// Mid-November 2026, between events.
    const NOVEMBER: u64 = 1_794_700_000;

    fn advent_of_code(
        last: Option<Puzzle>,
        has_session: bool,
        now: u64,
        stars: &[(Puzzle, u8)],
    ) -> Track<Destination> {
        let stars: HashMap<Puzzle, u8> = stars.iter().copied().collect();
        AdventOfCode {
            last,
            has_session,
            now,
            stars: |p| stars.get(&p).copied(),
        }
        .track()
    }

    fn next(track: &Track<Destination>) -> (Destination, Priority) {
        let step = track.next.as_ref().unwrap();
        (step.destination.clone(), step.priority)
    }

    #[test]
    fn carries_on_with_the_puzzle_left_part_way_through() {
        let last = puzzle(2024, 3);
        let track = advent_of_code(Some(last), true, NOVEMBER, &[(last, 1)]);
        assert_eq!(
            next(&track),
            (Destination::Puzzle { puzzle: last }, Priority::Unfinished)
        );
        assert_eq!(track.next.as_ref().unwrap().title, "2024 · day 3");
        assert_eq!(track.destination, Destination::Puzzle { puzzle: last });
        assert_eq!(track.summary, "Last opened 2024 · day 3");
    }

    #[test]
    fn a_puzzle_whose_stars_are_unknown_counts_as_unfinished() {
        let last = puzzle(2024, 3);
        let track = advent_of_code(Some(last), true, NOVEMBER, &[]);
        assert_eq!(
            next(&track),
            (Destination::Puzzle { puzzle: last }, Priority::Unfinished)
        );
    }

    #[test]
    fn offers_todays_puzzle_once_the_last_is_solved() {
        let last = puzzle(2026, 1);
        let now = unlock_time(2026, 2) + 60;
        let track = advent_of_code(Some(last), true, now, &[(last, 2)]);
        assert_eq!(
            next(&track),
            (
                Destination::Puzzle {
                    puzzle: puzzle(2026, 2)
                },
                Priority::New
            )
        );
        assert_eq!(track.summary, "Day 2 of 12 is out");
    }

    #[test]
    fn offers_the_day_after_the_last_one_solved() {
        let last = puzzle(2023, 7);
        let track = advent_of_code(Some(last), true, NOVEMBER, &[(last, 2)]);
        assert_eq!(
            next(&track),
            (
                Destination::Puzzle {
                    puzzle: puzzle(2023, 8)
                },
                Priority::New
            )
        );
        // Unless that's solved too, or there isn't one.
        let both_solved = advent_of_code(
            Some(last),
            true,
            NOVEMBER,
            &[(last, 2), (puzzle(2023, 8), 2)],
        );
        assert_eq!(
            next(&both_solved),
            (Destination::PuzzleList, Priority::Browse)
        );
        let end = puzzle(2025, 12);
        let after_the_end = advent_of_code(Some(end), true, NOVEMBER, &[(end, 2)]);
        assert_eq!(
            next(&after_the_end),
            (Destination::PuzzleList, Priority::Browse)
        );
    }

    #[test]
    fn without_a_login_offers_the_practice_puzzle() {
        let track = advent_of_code(None, false, NOVEMBER, &[]);
        assert_eq!(
            next(&track),
            (
                Destination::Puzzle {
                    puzzle: Puzzle::PRACTICE
                },
                Priority::New
            )
        );
        assert_eq!(track.next.as_ref().unwrap().title, "Practice puzzle");
        assert_eq!(track.destination, Destination::PuzzleList);
        let practised = advent_of_code(
            Some(Puzzle::PRACTICE),
            false,
            NOVEMBER,
            &[(Puzzle::PRACTICE, 2)],
        );
        assert_eq!(
            next(&practised),
            (Destination::PuzzleList, Priority::Browse)
        );
    }

    #[test]
    fn otherwise_leads_to_the_list_of_puzzles() {
        let track = advent_of_code(None, true, NOVEMBER, &[]);
        assert_eq!(next(&track), (Destination::PuzzleList, Priority::Browse));
        assert_eq!(track.name, "Advent of Code");
    }

    #[test]
    fn says_where_a_step_leads_for_the_app() {
        let json = serde_json::to_value(Destination::Puzzle {
            puzzle: puzzle(2024, 3),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "puzzle", "puzzle": { "year": 2024, "day": 3 } })
        );
        assert_eq!(
            serde_json::to_value(Destination::PuzzleList).unwrap(),
            serde_json::json!({ "kind": "puzzle_list" })
        );
        assert_eq!(
            serde_json::to_value(Destination::Practice {
                track: TrackId::MentalMaths
            })
            .unwrap(),
            serde_json::json!({ "kind": "practice", "track": "mental-maths" })
        );
        assert_eq!(
            serde_json::to_value(Destination::Coding {
                item: Some("sample/islands".to_owned())
            })
            .unwrap(),
            serde_json::json!({ "kind": "coding", "item": "sample/islands" })
        );
    }
}
