//! Timed rounds: an item worked on against a clock, with the examiner asking follow-up
//! questions that extend or change it, as a live session would. When time runs out the round
//! ends, and goes to the grader.
//!
//! The clock only runs while the round is open in the app, which says so every few seconds.
//! A gap longer than that, such as the app closing or the phone sleeping, counts for no more
//! than [`MAX_GAP_MS`], so coming back carries on with the clock where it was. The examiner is
//! told the round was interrupted. A round left for longer than [`AWAY_MS`] ends instead, as
//! the sitting it was part of is over: it's marked on what was done, but as a round cut short
//! it doesn't count as an attempt.

use serde::{Deserialize, Serialize};

use crate::brief::Brief;
use crate::{Speaker, Turn};

/// The longest gap between two signs the round is open that counts against the clock.
pub const MAX_GAP_MS: i64 = 20_000;

/// Away from a round for longer than this, and it ends.
pub const AWAY_MS: i64 = 30 * 60_000;

/// The shortest round, for items that take only a few minutes on their own, as follow-up
/// questions take time too.
pub const MIN_MINUTES: u32 = 10;

/// How a round ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Ending {
    /// The clock ran out.
    TimeUp,
    /// The learner said they were done, before the clock ran out.
    Finished,
    /// The learner was away for so long that the sitting was over.
    Interrupted,
}

impl Ending {
    /// Whether the round counts as an attempt at its item. A round cut short by an
    /// interruption says too little about what the learner knows.
    pub fn is_attempt(self) -> bool {
        self != Self::Interrupted
    }
}

/// A round, saved as it goes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Round {
    /// The examiner's style, from the item's pack, if one was chosen.
    pub style: Option<String>,
    pub minutes: u32,
    /// When it was started, in milliseconds since 1970.
    pub started_at: i64,
    /// How much of the clock has been used, as of `seen_at`.
    pub used_ms: i64,
    /// When the app last said the round was open.
    pub seen_at: i64,
    /// How many times the learner has come back to it after a gap.
    #[serde(default)]
    pub interruptions: u32,
    /// Whether they've come back after a gap since the examiner last spoke, for it to know.
    #[serde(default)]
    pub returned: bool,
    /// The learner's working: their answer, code or notes, typed or dictated.
    #[serde(default)]
    pub work: String,
    /// What the learner and the examiner have said.
    #[serde(default)]
    pub turns: Vec<Turn>,
    #[serde(default)]
    pub ended: Option<Ending>,
    /// For a design prompt, what the examiner answers the learner's questions from, kept as the
    /// round started so it never changes during it. Never shown to the learner before the
    /// round's marked.
    #[serde(default)]
    pub brief: Option<Brief>,
}

/// The clock, as the app shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Clock {
    pub used_ms: i64,
    pub remaining_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RoundError {
    #[error("the round has ended")]
    Ended,
}

/// How long a round lasts of an item that takes `item_minutes` on its own.
pub fn minutes_for(item_minutes: u32) -> u32 {
    item_minutes.max(MIN_MINUTES)
}

impl Round {
    /// A round of an item that takes `item_minutes` on its own.
    pub fn new(item_minutes: u32, style: Option<String>, now: i64) -> Self {
        Self {
            style,
            minutes: minutes_for(item_minutes),
            started_at: now,
            used_ms: 0,
            seen_at: now,
            interruptions: 0,
            returned: false,
            work: String::new(),
            turns: Vec::new(),
            ended: None,
            brief: None,
        }
    }

    pub fn limit_ms(&self) -> i64 {
        i64::from(self.minutes) * 60_000
    }

    pub fn clock(&self) -> Clock {
        Clock {
            used_ms: self.used_ms,
            remaining_ms: (self.limit_ms() - self.used_ms).max(0),
        }
    }

    /// Notes that the round is open at `now`, running the clock, and ending the round if its
    /// time has run out or the learner was away too long. Returns whether the learner has
    /// just come back after a gap.
    pub fn seen(&mut self, now: i64) -> bool {
        if self.ended.is_some() {
            return false;
        }
        let gap = (now - self.seen_at).max(0);
        if gap > AWAY_MS {
            self.ended = Some(Ending::Interrupted);
            return false;
        }
        self.used_ms += gap.min(MAX_GAP_MS);
        self.seen_at = self.seen_at.max(now);
        let back = gap > MAX_GAP_MS;
        if back {
            self.interruptions += 1;
            self.returned = true;
        }
        if self.used_ms >= self.limit_ms() {
            self.used_ms = self.limit_ms();
            self.ended = Some(Ending::TimeUp);
        }
        back
    }

    /// How the round has ended as of `now`, if it has: as [`Round::seen`] would find it, without
    /// running the clock, for showing a round that isn't open.
    pub fn ending_at(&self, now: i64) -> Option<Ending> {
        self.ended
            .or_else(|| (now - self.seen_at > AWAY_MS).then_some(Ending::Interrupted))
    }

    /// Saves the learner's working, while the round is on.
    pub fn save_work(&mut self, work: &str, now: i64) -> Result<(), RoundError> {
        self.seen(now);
        if self.ended.is_some() {
            return Err(RoundError::Ended);
        }
        self.work = work.to_owned();
        Ok(())
    }

    /// Adds what the learner said, while the round is on.
    pub fn say(&mut self, text: &str, now: i64) -> Result<(), RoundError> {
        self.seen(now);
        if self.ended.is_some() {
            return Err(RoundError::Ended);
        }
        self.turns.push(Turn {
            speaker: Speaker::Learner,
            text: text.trim().to_owned(),
            at: now,
        });
        Ok(())
    }

    /// Adds the examiner's reply, which is kept even if the clock ran out while it was being
    /// written, as the learner asked for it in time.
    pub fn examiner_said(&mut self, text: &str, now: i64) {
        self.returned = false;
        self.turns.push(Turn {
            speaker: Speaker::Coach,
            text: text.trim().to_owned(),
            at: now,
        });
    }

    /// Ends the round at the learner's word, unless it's already over.
    pub fn finish(&mut self, now: i64) -> Ending {
        self.seen(now);
        *self.ended.get_or_insert(Ending::Finished)
    }

    /// The round as the grader reads it: the working, then what was said.
    pub fn transcript(&self) -> String {
        let mut out = String::new();
        match self.work.trim() {
            "" => out.push_str("Working: (none written)\n"),
            work => out.push_str(&format!("Working:\n{work}\n")),
        }
        if !self.turns.is_empty() {
            out.push_str("\nWhat was said:\n");
            for turn in &self.turns {
                let who = match turn.speaker {
                    Speaker::Learner => "Learner",
                    Speaker::Coach => "Examiner",
                };
                out.push_str(&format!("{who}: {}\n", turn.text));
            }
        }
        out.trim_end().to_owned()
    }

    /// Whether the learner did anything to mark.
    pub fn has_work(&self) -> bool {
        !self.work.trim().is_empty() || self.turns.iter().any(|t| t.speaker == Speaker::Learner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: i64 = 1_790_000_000_000;
    const MINUTE: i64 = 60_000;

    #[test]
    fn rounds_last_at_least_ten_minutes() {
        assert_eq!(Round::new(3, None, START).minutes, 10);
        assert_eq!(Round::new(30, None, START).minutes, 30);
    }

    #[test]
    fn runs_the_clock_while_its_open() {
        let mut round = Round::new(10, Some("steady".to_owned()), START);
        for second in (10..=60).step_by(10) {
            assert!(!round.seen(START + second * 1000));
        }
        assert_eq!(round.clock().used_ms, MINUTE);
        assert_eq!(round.clock().remaining_ms, 9 * MINUTE);
        // The same moment again, or one from a clock that's gone back, adds nothing.
        round.seen(START + 30_000);
        assert_eq!(round.clock().used_ms, MINUTE);
    }

    #[test]
    fn carries_on_where_the_clock_was_after_the_app_closes() {
        let mut round = Round::new(10, None, START);
        for second in (10..=60).step_by(10) {
            round.seen(START + second * 1000);
        }
        // Closed for ten minutes: it counts no more than a short gap.
        assert!(round.seen(START + 11 * MINUTE));
        assert_eq!(round.used_ms, MINUTE + MAX_GAP_MS);
        assert_eq!(round.interruptions, 1);
        assert!(round.returned);
        assert_eq!(round.ended, None);
        round.examiner_said("Welcome back.", START + 11 * MINUTE + 1000);
        assert!(!round.returned);
        round
            .save_work("p = 1/6", START + 11 * MINUTE + 5000)
            .unwrap();
        assert_eq!(round.work, "p = 1/6");
    }

    #[test]
    fn ends_when_time_runs_out() {
        let mut round = Round::new(10, None, START);
        let mut now = START;
        while round.ended.is_none() {
            now += 10_000;
            round.seen(now);
        }
        assert_eq!(round.ended, Some(Ending::TimeUp));
        assert_eq!(round.clock().remaining_ms, 0);
        assert_eq!(round.used_ms, 10 * MINUTE);
        assert_eq!(round.say("one more thing", now), Err(RoundError::Ended));
        assert_eq!(round.save_work("late", now), Err(RoundError::Ended));
        assert_eq!(round.finish(now), Ending::TimeUp);
        assert!(Ending::TimeUp.is_attempt());
    }

    #[test]
    fn ends_as_interrupted_after_a_long_time_away() {
        let mut round = Round::new(20, None, START);
        round.say("Is the input sorted?", START + 5000).unwrap();
        round.examiner_said("No.", START + 8000);
        // Away from when it was last open, the learner's question.
        assert_eq!(round.ending_at(START + 5000 + AWAY_MS), None);
        assert_eq!(
            round.ending_at(START + 5000 + AWAY_MS + 1),
            Some(Ending::Interrupted)
        );
        round.seen(START + 8000 + AWAY_MS + 1);
        assert_eq!(round.ended, Some(Ending::Interrupted));
        // The time away isn't counted.
        assert_eq!(round.used_ms, 5000);
        assert!(!Ending::Interrupted.is_attempt());
        assert!(round.has_work());
        assert_eq!(
            round.transcript(),
            "Working: (none written)\n\nWhat was said:\nLearner: Is the input sorted?\nExaminer: No."
        );
    }

    #[test]
    fn can_be_finished_early() {
        let mut round = Round::new(10, None, START);
        assert!(!round.has_work());
        round.save_work("  It's 1/6.  ", START + 1000).unwrap();
        assert_eq!(round.finish(START + 2000), Ending::Finished);
        assert_eq!(round.transcript(), "Working:\nIt's 1/6.");
        // Once over, it stays as it ended.
        assert_eq!(round.finish(START + AWAY_MS * 2), Ending::Finished);
    }
}
